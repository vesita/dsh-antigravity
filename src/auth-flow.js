import http from 'node:http'
import { randomBytes } from 'node:crypto'
import {
  DEFAULT_REDIRECT_URI,
  exchangeCodeForTokens,
  getAuthorizationUrl,
  parseRedirectUri,
  resolveOAuthClient
} from './auth.js'

/**
 * One browser-driven OAuth attempt, shared by the web settings UI, the
 * authorization flow, and the CLI.
 *
 * The manager owns a loopback listener for the configured redirect URI, hands
 * back the consent URL immediately, and settles once Google redirects to the
 * callback with a code. Only one attempt runs at a time: a second `begin()`
 * returns the URL already in flight instead of opening a second listener.
 *
 * @module dsh-antigravity/auth-flow
 */

/** Attempt lifetime before the listener is abandoned. */
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000

export class LoginManager {
  #options
  #pending = null
  #lastError = null
  #disposed = false

  /**
   * @param options - `{ clientId, clientSecret, redirectUri, timeoutMs, onNotice, onSuccess, logger }`.
   */
  constructor(options = {}) {
    this.#options = options
  }

  /** Update the OAuth client facts after a settings change. */
  configure(options = {}) {
    this.#options = { ...this.#options, ...options }
  }

  /** Snapshot the current attempt for a status read. */
  status() {
    return {
      pending: this.#pending !== null,
      url: this.#pending?.url ?? null,
      error: this.#lastError
    }
  }

  /**
   * Start an attempt (or return the one already running).
   *
   * @returns the Google consent URL the human must open.
   */
  async begin() {
    if (this.#disposed) throw new Error('登录管理器已销毁')
    if (this.#pending) return this.#pending.url

    const redirectUri = this.#options.redirectUri || DEFAULT_REDIRECT_URI
    const { host, port, pathname } = parseRedirectUri(redirectUri)
    const state = randomBytes(16).toString('hex')
    const { clientId, clientSecret } = resolveOAuthClient(this.#options)
    const url = getAuthorizationUrl({ clientId, clientSecret, redirectUri, state })

    let settleResolve
    let settleReject
    const settled = new Promise((resolve, reject) => {
      settleResolve = resolve
      settleReject = reject
    })

    const server = http.createServer()
    const pending = { url, state, server, promise: settled, resolve: settleResolve, reject: settleReject }
    this.#pending = pending
    this.#lastError = null

    const finish = (error, creds) => {
      if (this.#pending !== pending) return
      this.#pending = null
      if (timer !== undefined) clearTimeout(timer)
      try {
        server.close()
      } catch {
        /* already closed */
      }
      if (error) {
        this.#lastError = error.message
        settleReject(error)
      } else {
        settleResolve(creds)
      }
    }

    const timer = setTimeout(() => {
      finish(new Error('登录超时，请重试'))
    }, this.#options.timeoutMs || DEFAULT_TIMEOUT_MS)
    if (typeof timer.unref === 'function') timer.unref()

    server.on('request', async (req, res) => {
      const requestUrl = new URL(req.url || '/', `http://${req.headers.host || `${host}:${port}`}`)
      if (requestUrl.pathname !== pathname) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
        res.end('未找到请求资源')
        return
      }

      const error = requestUrl.searchParams.get('error')
      const code = requestUrl.searchParams.get('code')
      const returnedState = requestUrl.searchParams.get('state')

      if (error) {
        respond(res, 400, '授权失败', `Google 返回错误：${error}。您可以关闭此标签页。`)
        finish(new Error(`授权失败：${error}`))
        return
      }
      if (!code) {
        respond(res, 400, '授权失败', '回调缺少授权码。您可以关闭此标签页。')
        return
      }
      if (returnedState !== state) {
        respond(res, 400, '授权失败', 'state 校验失败，请重新发起登录。')
        finish(new Error('OAuth state 校验失败'))
        return
      }

      try {
        const creds = await exchangeCodeForTokens(code, {
          clientId,
          clientSecret,
          redirectUri,
          signal: undefined
        })
        await this.#options.onSuccess?.(creds)
        respond(
          res,
          200,
          '登录成功',
          `已关联项目 <b>${escapeHtml(creds.projectId || '')}</b>${creds.email ? `<br/>账号：${escapeHtml(creds.email)}` : ''}<p>您可以关闭此标签页并返回 DSH。</p>`
        )
        this.#options.onNotice?.({ message: 'Google Antigravity 登录成功', url: undefined })
        finish(null, creds)
      } catch (exchangeError) {
        respond(res, 500, '换取令牌失败', escapeHtml(exchangeError.message))
        finish(exchangeError)
      }
    })

    server.on('error', (serverError) => {
      const message =
        serverError.code === 'EADDRINUSE'
          ? `本地回调端口 ${port} 已被占用，请关闭占用该端口的程序后重试`
          : `启动本地回调监听失败：${serverError.message}`
      finish(new Error(message))
    })

    await new Promise((resolve, reject) => {
      server.once('listening', resolve)
      server.once('error', reject)
      server.listen(port, host)
    }).catch((listenError) => {
      finish(listenError)
      throw listenError
    })

    return url
  }

  /**
   * Await the attempt currently in flight.
   *
   * @returns the credential facts, or `null` when no attempt is running.
   */
  completion() {
    return this.#pending?.promise ?? Promise.resolve(null)
  }

  /** Abandon the attempt in flight, if any. */
  cancel() {
    if (!this.#pending) return
    const pending = this.#pending
    this.#pending = null
    try {
      pending.server.close()
    } catch {
      /* already closed */
    }
    pending.reject(new Error('登录已取消'))
  }

  /** Permanently withdraw the manager. */
  dispose() {
    this.#disposed = true
    this.cancel()
  }
}

function respond(res, status, title, body) {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' })
  res.end(
    `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"/><title>${escapeHtml(title)}</title>` +
      '<style>body{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;background:#111;color:#eee;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}' +
      'main{max-width:32rem;padding:2rem;border-radius:16px;background:#1b1b1f;box-shadow:0 8px 30px rgba(0,0,0,.4)}h2{margin-top:0}</style>' +
      `</head><body><main><h2>${escapeHtml(title)}</h2><p>${body}</p></main></body></html>`
  )
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch])
}
