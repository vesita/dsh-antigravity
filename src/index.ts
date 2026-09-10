import z from '@deepseek-ai/schemastery'
import { RetryPolicySchema } from '@deepseek-ai/dsh-llm'
import type { ReasoningEffortId, ResolvedRetryPolicy } from '@deepseek-ai/dsh-llm'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import { GoogleAntigravityAdapter } from './adapter.js'
import type { ResolvedImage } from './adapter.js'
import { LoginManager } from './auth-flow.js'
import {
  CREDENTIAL_KEY,
  clearCredentials,
  getValidCredentials,
  loadCredentials,
  saveCredentials,
  writeCredentialRecord
} from './auth.js'
import type { AntigravityCredentials, CredentialsSeam } from './auth.js'
import { MODEL_CATALOG, MODEL_MODALITIES, REASONING_EFFORTS } from './models.js'
import type { ModelSpec } from './models.js'
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
 * - the provider row is installed by the `llm-antigravity.account` settings
 *   marker, which this plugin writes on sign-in and withdraws on removal, so
 *   the entry is dormant in 「添加提供方」 until an account actually exists;
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

/**
 * The resolved `llm-antigravity` settings section, as the settings service
 * hands it back after schema defaulting.
 */
interface AntigravitySettings {
  /**
   * Directory marker: present exactly while an account is installed here. It
   * carries a human-readable label, not a credential — the grant itself lives
   * in `ctx.credentials`. Its presence is what makes the provider row appear in
   * Settings → Models, so this plugin writes it when a sign-in lands and clears
   * it when the account is removed.
   */
  account?: string
  models?: ModelSpec[]
  endpoint?: string
  projectId?: string
  clientId?: string
  clientSecret?: string
  redirectUri?: string
  reasoningEffort?: ReasoningEffortId
  retryPolicy?: ResolvedRetryPolicy
  proxy?: {
    enabled?: boolean
    host?: string
    port?: number
  }
}

/** Attachment reference as the image resolver reads it. */
interface ImageRef {
  mediaType?: string
}

/**
 * Minimal structural view of the `ctx.settings` service: the path-op write the
 * models page itself uses, which is how this plugin installs and withdraws the
 * `account` marker.
 */
interface SettingsSeam {
  mutate(
    ns: string,
    ops: Array<{ op: 'set'; path: string[]; value: unknown } | { op: 'unset'; path: string[] }>,
    expectedRevision?: number
  ): Promise<unknown>
}

/** Shape of the `/status` payload the browser half consumes. */
interface StatusPayload {
  authenticated: boolean
  email?: string | null
  projectId?: string | null
  expires?: number | null
  timeLeftSeconds?: number | null
  pending?: boolean
  loginUrl?: string | null
  error?: string | null
  expired?: boolean
}

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
  account: z.string(),
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

/**
 * The Cordis context stays structurally open here: the routes this plugin
 * consumes (`credentials`, `attachments`, `connection`, `webServer`, `settings`,
 * `authorization`) are all optional seams resolved through `ctx.get`/`ctx.inject`.
 */
export function apply(ctx: any, config: AntigravitySettings = {}): void {
  let current: () => AntigravitySettings = () => config
  let proxyServer: Server | null = null
  let proxyKey: string | null = null
  /** Last observed value of the `account` marker, for set → unset detection. */
  let previousAccount: string | undefined

  const catalog = (): ModelSpec[] => {
    const models = current().models
    return Array.isArray(models) && models.length > 0 ? models : MODEL_CATALOG
  }
  const credentialsService = (): CredentialsSeam | undefined => ctx.get('credentials')
  const settingsService = (): SettingsSeam | undefined => ctx.get('settings')
  const oauthOptions = () => ({
    clientId: current().clientId,
    clientSecret: current().clientSecret,
    redirectUri: current().redirectUri
  })

  const resolveCredentials = (signal?: AbortSignal): Promise<AntigravityCredentials> =>
    getValidCredentials(credentialsService(), { ...oauthOptions(), signal })

  const resolveImage = async (ref: ImageRef, signal?: AbortSignal): Promise<ResolvedImage | null> => {
    const attachments = ctx.get('attachments')
    if (attachments === undefined) return null
    const stored = await attachments.readImage(ref, signal)
    return {
      mimeType: stored.ref?.mediaType || ref.mediaType || 'image/png',
      base64: Buffer.from(stored.data).toString('base64')
    }
  }

  // -------------------------------------------------------------------------
  // Account marker (the provider row's installation record)
  // -------------------------------------------------------------------------
  /**
   * Publish the settings marker that installs the provider row. Without it the
   * entry stays dormant in the 「添加提供方」 select, which is the default state:
   * a provider nobody signed in to owns no row in Settings → Models.
   */
  const markAccountInstalled = async (creds: AntigravityCredentials): Promise<void> => {
    const settings = settingsService()
    if (settings === undefined) return
    const label = creds.email || creds.projectId || 'google'
    if (current().account === label) return
    try {
      await settings.mutate(NS, [{ op: 'set', path: ['account'], value: label }])
    } catch (error: any) {
      // The grant is already committed, so a marker write that fails must not
      // fail the sign-in: the next status read retries it.
      ctx.logger?.warn?.(`dsh-antigravity: 无法写入账户标记：${error.message}`)
    }
  }

  /** Withdraw the marker; the row disappears, which is the removal half of the loop. */
  const unmarkAccount = async (): Promise<void> => {
    if (current().account === undefined) return
    const settings = settingsService()
    if (settings === undefined) return
    try {
      await settings.mutate(NS, [{ op: 'unset', path: ['account'] }])
    } catch {
      /* gone already, or the settings provider is read-only */
    }
  }

  /**
   * Keep the marker and the grant in step. The marker *is* how the account is
   * installed, so its removal — this plugin's 退出登录, the row's native
   * 「移除」, or a hand edit of `settings.yaml` — removes the grant too.
   *
   * Only the set → unset transition counts: a grant installed by the standalone
   * CLI never had a marker, and an unrelated settings edit must not delete it.
   */
  const reconcileAccount = (): void => {
    const account = current().account
    const removed = previousAccount !== undefined && account === undefined
    previousAccount = account
    if (removed) void clearCredentials(credentialsService())
  }

  // -------------------------------------------------------------------------
  // Sign-in
  // -------------------------------------------------------------------------
  const login = new LoginManager({
    ...oauthOptions(),
    onSuccess: async (creds: AntigravityCredentials) => {
      await saveCredentials(credentialsService(), creds)
      await markAccountInstalled(creds)
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
      // A non-empty path is what keeps this entry dormant until the account
      // marker exists: `configured` is false without it, so the provider is
      // listed in 「添加提供方」 instead of owning a row from the start.
      settingsPath: ['account'],
      declared: false
    }
  ])

  // -------------------------------------------------------------------------
  // Optional OpenAI-compatible proxy
  // -------------------------------------------------------------------------
  const reconcileProxy = (): void => {
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
      setSource: (source: () => AntigravitySettings) => {
        current = source
        login.configure(oauthOptions())
      },
      onChange: () => {
        login.configure(oauthOptions())
        reconcileProxy()
        reconcileAccount()
      },
      validate: (value: AntigravitySettings) => {
        if (!Array.isArray(value.models) || value.models.length === 0) {
          throw new Error('llm-antigravity: models 不能为空；至少保留一个模型')
        }
      }
    })
    login.configure(oauthOptions())
    previousAccount = current().account
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
        await markAccountInstalled(creds)
      }
    })
  })

  // -------------------------------------------------------------------------
  // Loopback routes for the browser half
  // -------------------------------------------------------------------------
  ctx.inject(['webServer'], webCtx => {
    const guard = (req: IncomingMessage, res: ServerResponse): boolean => {
      const connection = ctx.get('connection')
      if (connection === undefined) return false
      const rejection = connection.requestRejection(req)
      if (rejection === undefined) return false
      res.statusCode = rejection
      res.end()
      return true
    }

    const status = async (): Promise<StatusPayload> => {
      const snapshot = login.status()
      try {
        // Resolve (and refresh, when possible) so the card never claims a live
        // session on the strength of an expired access token.
        const creds = await getValidCredentials(credentialsService(), oauthOptions())
        // An account installed outside this card — a grant the CLI wrote, or one
        // that predates the marker — has no row to sit in. Reading the card is
        // the moment that becomes visible, so install the marker here rather
        // than writing settings during plugin load.
        await markAccountInstalled(creds)
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
        let stored: AntigravityCredentials | null = null
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
          handler: async (req: IncomingMessage, res: ServerResponse) => {
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
          handler: async (req: IncomingMessage, res: ServerResponse) => {
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
          handler: (req: IncomingMessage, res: ServerResponse) => {
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
          handler: async (req: IncomingMessage, res: ServerResponse) => {
            if (guard(req, res)) return
            if (req.method !== 'POST') return methodNotAllowed(res, 'POST')
            login.cancel()
            await clearCredentials(credentialsService())
            // Closing the loop: without the marker the provider row goes away,
            // so the next sign-in starts from 「添加提供方」 again.
            await unmarkAccount()
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

function sendJson(res: ServerResponse, statusCode: number, payload: unknown): void {
  if (res.headersSent) return
  const body = JSON.stringify(payload)
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  })
  res.end(body)
}

function methodNotAllowed(res: ServerResponse, allowed: string): void {
  res.setHeader('Allow', allowed)
  sendJson(res, 405, { error: `仅支持 ${allowed}` })
}

export { GoogleAntigravityAdapter } from './adapter.js'
export default { name, inject, apply, Config }
