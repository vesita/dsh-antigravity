import z from '@deepseek-ai/schemastery'
import { RetryPolicySchema } from '@deepseek-ai/dsh-llm'
import { GoogleAntigravityAdapter } from './adapter.js'
import { LoginManager } from './auth-flow.js'
import {
  CREDENTIAL_KEY,
  clearCredentials,
  getValidCredentials,
  loadCredentials,
  saveCredentials,
  writeCredentialRecord
} from './auth.js'
import { MODEL_CATALOG, MODEL_MODALITIES, REASONING_EFFORTS } from './models.js'
import { createProxyServer } from './proxy.js'

/**
 * DSH host plugin for the Google Antigravity provider route.
 *
 * Ownership boundaries:
 * - the plugin owns the `llm-antigravity` settings namespace and the
 *   `google-antigravity` provider route (registered natively through
 *   `ctx.llm.registerAdapter`, never through `llm-pi-ai`);
 * - credentials live in `ctx.credentials` (with a private file fallback) under
 *   the `dsh-antigravity/google-antigravity` record key;
 * - sign-in is offered both as a DSH authorization flow (headless/ACP) and as
 *   loopback HTTP routes consumed by this package's browser half.
 *
 * @module dsh-antigravity
 */

export const name = 'dsh-antigravity'
export const inject = ['llm']

/** Settings namespace this plugin owns. */
const NS = 'llm-antigravity'
/** The single provider route this plugin serves. */
const PROVIDER = 'google-antigravity'
/** Loopback route prefix for the browser half. */
const ROUTE_PREFIX = '/dsh-antigravity/auth'

const modelSchema = z.object({
  id: z.string().required(),
  wireId: z.string(),
  name: z.string(),
  description: z.string(),
  contextWindow: z.number().step(1).min(1).default(1048576),
  maxTokens: z.number().step(1).min(1).default(65536),
  reasoning: z.boolean().default(true),
  inputModalities: z.array(z.union(MODEL_MODALITIES)).min(1).default(['text'])
})

export const Config = z.object({
  models: z.array(modelSchema).default(MODEL_CATALOG),
  endpoint: z.string().default('https://daily-cloudcode-pa.googleapis.com'),
  projectId: z.string(),
  clientId: z.string(),
  clientSecret: z.string(),
  redirectUri: z.string().default('http://127.0.0.1:51121/oauth-callback'),
  reasoningEffort: z.union(REASONING_EFFORTS.map(effort => effort.id)),
  retryPolicy: RetryPolicySchema,
  proxy: z
    .object({
      enabled: z.boolean().default(false),
      host: z.string().default('127.0.0.1'),
      port: z.number().step(1).min(1).max(65535).default(8045)
    })
    .default({ enabled: false, host: '127.0.0.1', port: 8045 })
})

export function apply(ctx, config = {}) {
  let current = () => config
  let proxyServer = null
  let proxyKey = null

  const catalog = () => {
    const models = current().models
    return Array.isArray(models) && models.length > 0 ? models : MODEL_CATALOG
  }
  const credentialsService = () => ctx.get('credentials')
  const oauthOptions = () => ({
    clientId: current().clientId,
    clientSecret: current().clientSecret,
    redirectUri: current().redirectUri
  })

  const resolveCredentials = signal =>
    getValidCredentials(credentialsService(), { ...oauthOptions(), signal })

  const resolveImage = async (ref, signal) => {
    const attachments = ctx.get('attachments')
    if (attachments === undefined) return null
    const stored = await attachments.readImage(ref, signal)
    return {
      mimeType: stored.ref?.mediaType || ref.mediaType || 'image/png',
      base64: Buffer.from(stored.data).toString('base64')
    }
  }

  // -------------------------------------------------------------------------
  // Sign-in
  // -------------------------------------------------------------------------
  const login = new LoginManager({
    ...oauthOptions(),
    onSuccess: async creds => {
      await saveCredentials(credentialsService(), creds)
    }
  })
  ctx.effect(() => () => login.dispose(), 'dsh-antigravity: login manager')

  // -------------------------------------------------------------------------
  // Provider route (native adapter) + settings-owned directory entry
  // -------------------------------------------------------------------------
  const adapter = new GoogleAntigravityAdapter({
    resolveModels: catalog,
    resolveCredentials,
    resolveEndpoint: () => current().endpoint,
    resolveProjectId: () => current().projectId,
    resolveReasoningEffort: () => current().reasoningEffort,
    resolveRetryPolicy: () => current().retryPolicy,
    resolveImage
  })

  const adapterHandle = ctx.llm.registerAdapter([PROVIDER], adapter)
  const directoryHandle = ctx.llm.registerConfigurableProviders([
    {
      provider: PROVIDER,
      displayName: 'Google Antigravity',
      settingsNs: NS,
      settingsPath: [],
      declared: false
    }
  ])

  // -------------------------------------------------------------------------
  // Optional OpenAI-compatible proxy
  // -------------------------------------------------------------------------
  const reconcileProxy = () => {
    const proxy = current().proxy
    const enabled = proxy?.enabled === true
    const key = enabled ? `${proxy.host}:${proxy.port}` : null

    if (!enabled) {
      if (proxyServer) {
        proxyServer.close()
        proxyServer = null
        proxyKey = null
        ctx.logger?.info?.('dsh-antigravity: 兼容代理已停止')
      }
      return
    }
    if (proxyServer && proxyKey === key) return
    if (proxyServer) {
      proxyServer.close()
      proxyServer = null
    }

    const server = createProxyServer({
      resolveModels: catalog,
      resolveCredentials,
      resolveEndpoint: () => current().endpoint,
      resolveProjectId: () => current().projectId
    })
    server.on('error', error => {
      ctx.logger?.warn?.(`dsh-antigravity: 兼容代理错误 (${key}): ${error.message}`)
      if (proxyServer === server) {
        proxyServer = null
        proxyKey = null
      }
    })
    server.listen(proxy.port, proxy.host, () => {
      proxyServer = server
      proxyKey = key
      ctx.logger?.info?.(`dsh-antigravity: OpenAI 兼容代理已监听 http://${key}/v1`)
    })
  }

  // -------------------------------------------------------------------------
  // Settings section
  // -------------------------------------------------------------------------
  ctx.inject(['settings'], settingsCtx => {
    settingsCtx.settings.installSection(ctx, NS, Config, config, {
      setSource: source => {
        current = source
        login.configure(oauthOptions())
      },
      onChange: () => {
        login.configure(oauthOptions())
        reconcileProxy()
      },
      validate: value => {
        if (!Array.isArray(value.models) || value.models.length === 0) {
          throw new Error('llm-antigravity: models 不能为空；至少保留一个模型')
        }
      }
    })
    login.configure(oauthOptions())
    reconcileProxy()
  })

  // -------------------------------------------------------------------------
  // Authorization flow (headless / ACP / any other surface)
  // -------------------------------------------------------------------------
  ctx.inject(['authorization'], authorized => {
    authorized.authorization.registerFlow({
      key: CREDENTIAL_KEY,
      label: 'Google Antigravity',
      methods: [{ id: 'oauth', label: '使用 Google 账号登录' }],
      async run(session) {
        const url = await login.begin()
        session.notify({ message: '请在浏览器中打开此链接完成 Google 账号授权。', url })
        const creds = await login.completion()
        if (!creds) throw new Error('登录未完成')
        // The seam verifies the record was committed during this attempt.
        await writeCredentialRecord(credentialsService(), creds)
      }
    })
  })

  // -------------------------------------------------------------------------
  // Loopback routes for the browser half
  // -------------------------------------------------------------------------
  ctx.inject(['webServer'], webCtx => {
    const guard = (req, res) => {
      const connection = ctx.get('connection')
      if (connection === undefined) return false
      const rejection = connection.requestRejection(req)
      if (rejection === undefined) return false
      res.statusCode = rejection
      res.end()
      return true
    }

    const status = async () => {
      const snapshot = login.status()
      try {
        // Resolve (and refresh, when possible) so the card never claims a live
        // session on the strength of an expired access token.
        const creds = await getValidCredentials(credentialsService(), oauthOptions())
        return {
          authenticated: true,
          email: creds.email ?? null,
          projectId: creds.projectId ?? 'aicode-consumers',
          expires: typeof creds.expires === 'number' ? creds.expires : null,
          timeLeftSeconds: typeof creds.expires === 'number' ? Math.max(0, Math.round((creds.expires - Date.now()) / 1000)) : null,
          pending: snapshot.pending,
          loginUrl: snapshot.url,
          error: null
        }
      } catch (error) {
        let stored = null
        try {
          stored = await loadCredentials(credentialsService())
        } catch {
          stored = null
        }
        return {
          authenticated: false,
          expired: Boolean(stored?.access),
          email: stored?.email ?? null,
          projectId: stored?.projectId ?? null,
          pending: snapshot.pending,
          loginUrl: snapshot.url,
          error: snapshot.error ?? error.message
        }
      }
    }

    webCtx.effect(
      () =>
        webCtx.webServer.register({
          kind: 'exact',
          path: `${ROUTE_PREFIX}/status`,
          handler: async (req, res) => {
            if (guard(req, res)) return
            if (req.method !== 'GET') return methodNotAllowed(res, 'GET')
            sendJson(res, 200, await status())
          }
        }),
      `dsh-antigravity: GET ${ROUTE_PREFIX}/status`
    )

    webCtx.effect(
      () =>
        webCtx.webServer.register({
          kind: 'exact',
          path: `${ROUTE_PREFIX}/login`,
          handler: async (req, res) => {
            if (guard(req, res)) return
            if (req.method !== 'POST') return methodNotAllowed(res, 'POST')
            try {
              const url = await login.begin()
              sendJson(res, 200, { url, pending: true })
            } catch (error) {
              sendJson(res, 500, { error: error.message })
            }
          }
        }),
      `dsh-antigravity: POST ${ROUTE_PREFIX}/login`
    )

    webCtx.effect(
      () =>
        webCtx.webServer.register({
          kind: 'exact',
          path: `${ROUTE_PREFIX}/cancel`,
          handler: (req, res) => {
            if (guard(req, res)) return
            if (req.method !== 'POST') return methodNotAllowed(res, 'POST')
            login.cancel()
            sendJson(res, 200, { pending: false })
          }
        }),
      `dsh-antigravity: POST ${ROUTE_PREFIX}/cancel`
    )

    webCtx.effect(
      () =>
        webCtx.webServer.register({
          kind: 'exact',
          path: `${ROUTE_PREFIX}/logout`,
          handler: async (req, res) => {
            if (guard(req, res)) return
            if (req.method !== 'POST') return methodNotAllowed(res, 'POST')
            login.cancel()
            await clearCredentials(credentialsService())
            sendJson(res, 200, { authenticated: false })
          }
        }),
      `dsh-antigravity: POST ${ROUTE_PREFIX}/logout`
    )
  })

  ctx.effect(() => () => {
    try {
      adapterHandle?.()
    } catch {
      /* already released */
    }
    try {
      directoryHandle?.()
    } catch {
      /* already released */
    }
    if (proxyServer) {
      proxyServer.close()
      proxyServer = null
    }
  }, 'dsh-antigravity: registration teardown')
}

function sendJson(res, statusCode, payload) {
  if (res.headersSent) return
  const body = JSON.stringify(payload)
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  })
  res.end(body)
}

function methodNotAllowed(res, allowed) {
  res.setHeader('Allow', allowed)
  sendJson(res, 405, { error: `仅支持 ${allowed}` })
}

export { GoogleAntigravityAdapter } from './adapter.js'
export default { name, inject, apply, Config }
