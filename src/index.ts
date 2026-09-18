import z from '@deepseek-ai/schemastery'
import { RetryPolicySchema } from '@deepseek-ai/dsh-llm'
import type { ReasoningEffortId, ResolvedRetryPolicy } from '@deepseek-ai/dsh-llm'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { GoogleAntigravityAdapter } from './adapter.js'
import type { ResolvedImage } from './adapter.js'
import { LoginManager } from './auth-flow.js'
import { CREDENTIAL_KEY, dshHome, writeCredentialRecord } from './auth.js'
import type { AntigravityCredentials, CredentialsSeam } from './auth.js'
import { AccountPool } from './accounts.js'
import type { AccountStrategy, AccountView } from './accounts.js'
import { MODEL_CATALOG, MODEL_MODALITIES, REASONING_EFFORTS } from './models.js'
import type { ModelSpec } from './models.js'
import { createProxyServer } from './proxy.js'
import { UsageCollector } from './usage-collector.js'
import type { SessionFacts } from './usage-collector.js'
import { DEFAULT_PRICING, registerUsageRoutes } from './usage-routes.js'
import { backfillFromSessions } from './usage-backfill.js'
import { UsageStore } from './usage-store.js'
import type { ModelPrice } from './usage-model.js'

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

/**
 * The version of the code that is **actually loaded**, read from the installed
 * `package.json` at import time rather than typed in here.
 *
 * Why it matters: this plugin is installed from a tarball, and `pnpm` treats a
 * `file:` dependency as satisfied when the path matches — replacing the tarball
 * at the same version does **not** refresh `node_modules` (measured: `install`
 * says "Lockfile is up to date", `install --force` reuses the cached copy, and
 * deleting `node_modules/<pkg>` alone is not enough either). So the source tree
 * can say one version while the running copy is another, and there was no way
 * to tell which one you were talking to.
 *
 * Reading it from the package file means the two can never disagree: whatever
 * this returns **is** what is loaded. It is logged at load and exposed on
 * `/status` for exactly that question.
 */
export const version: string = (() => {
  try {
    const parsed = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version?: unknown }
    return typeof parsed.version === 'string' && parsed.version !== '' ? parsed.version : 'unknown'
  } catch {
    // A missing/renamed package file must not take the provider down.
    return 'unknown'
  }
})()

/** Settings namespace this plugin owns. */
const NS = 'llm-antigravity'
/** The single provider route this plugin serves. */
const PROVIDER = 'google-antigravity'
/** Loopback route prefix for the browser half. */
const ROUTE_PREFIX = '/dsh-antigravity/auth'
/** Loopback route prefix for the usage panel API. */
const USAGE_ROUTE_PREFIX = '/dsh-antigravity/usage'

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
  /**
   * How the credential pool picks between installed accounts.
   *
   * `round-robin` spreads consecutive calls across every ready account, which
   * is what keeps one subscription's quota from being spent while another sits
   * idle; `active-first` drains the active account and only then moves on. Both
   * park an account whose quota the provider says is exhausted and both fail
   * over mid-call.
   */
  accountStrategy?: AccountStrategy
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
  /**
   * Usage accounting owned by this plugin.
   *
   * Recording is on by default: a provider plugin that silently counts nothing
   * is indistinguishable from a broken one, and the data is local-only.
   */
  usage?: {
    enabled?: boolean
    /** Drop calls older than this many days; 0 keeps everything. */
    retentionDays?: number
    /** Per-model price overrides, USD per 1M tokens, merged over the built-ins. */
    pricing?: Array<{ model: string; input?: number; output?: number; cacheRead?: number; cacheWrite?: number }>
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
  /**
   * Version of the loaded code (see {@link version}). Present so "which build am
   * I actually running" is answerable without guessing from the source tree.
   */
  version?: string
  email?: string | null
  projectId?: string | null
  expires?: number | null
  timeLeftSeconds?: number | null
  pending?: boolean
  loginUrl?: string | null
  error?: string | null
  expired?: boolean
  /** Every installed account, secret-free, in registry order. */
  accounts?: AccountView[]
  /** Id of the account a fresh sign-in landed on. */
  activeAccountId?: string | null
  /** How the pool orders accounts that are all ready. */
  strategy?: AccountStrategy
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

const priceOverrideSchema = z.object({
  model: z.string().required(),
  input: z.number().default(0),
  output: z.number().default(0),
  cacheRead: z.number().default(0),
  cacheWrite: z.number().default(0)
})

export const Config = z.object({
  account: z.string(),
  accountStrategy: z.union(['round-robin', 'active-first']).default('round-robin'),
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
    .default({ enabled: false, host: '127.0.0.1', port: 8045 }),
  usage: z
    .object({
      enabled: z.boolean().default(true),
      retentionDays: z.number().step(1).min(0).default(0),
      pricing: z.array(priceOverrideSchema).default([])
    })
    .default({ enabled: true, retentionDays: 0, pricing: [] })
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

  // Say which build this is, once, at load. This is the only place the running
  // version becomes visible in a deployment: `dsh-antigravity: v0.3.4 已加载`.
  // Without it, "源码改了但装的是旧 tarball" is invisible from inside.
  ctx.logger?.info?.(`dsh-antigravity: v${version} 已加载（provider ${PROVIDER}）`)

  // -------------------------------------------------------------------------
  // Usage accounting
  // -------------------------------------------------------------------------
  let usageStore: UsageStore | null = null
  try {
    usageStore = new UsageStore(path.join(dshHome(), 'antigravity-usage.db'))
  } catch (error: any) {
    ctx.logger?.warn?.(`dsh-antigravity: 用量库无法打开，统计功能已禁用：${error.message}`)
  }

  const usageEnabled = (): boolean => usageStore !== null && current().usage?.enabled !== false

  /** Merge the settings price overrides over the built-in table. */
  const pricingTable = (): Record<string, ModelPrice> => {
    const overrides = current().usage?.pricing
    if (!Array.isArray(overrides) || overrides.length === 0) return DEFAULT_PRICING
    const table: Record<string, ModelPrice> = { ...DEFAULT_PRICING }
    for (const entry of overrides) {
      if (entry === null || entry === undefined || typeof entry.model !== 'string' || entry.model === '') continue
      const base = table[entry.model] ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
      table[entry.model] = {
        input: numberOrNull(entry.input) ?? base.input,
        output: numberOrNull(entry.output) ?? base.output,
        cacheRead: numberOrNull(entry.cacheRead) ?? base.cacheRead,
        cacheWrite: numberOrNull(entry.cacheWrite) ?? base.cacheWrite
      }
    }
    return table
  }

  /**
   * Session facts the adapter cannot see. Read through the optional `sessions`
   * seam and degraded to empty facts when it is absent, so accounting never
   * depends on a service a deployment may not mount.
   */
  const resolveSessionFacts = (sessionId: string): SessionFacts => {
    const sessions = ctx.get('sessions')
    const session = sessions?.get?.(sessionId)
    const header = session?.header ?? session?.meta ?? {}
    const cwd = typeof header.cwd === 'string' ? header.cwd : ''
    const delegated =
      header.origin === 'subagent' || header.parentSession !== undefined || Number(header.delegationDepth) > 0
    return { cwd, agentType: delegated ? 'subagent' : 'main' }
  }

  const collector =
    usageStore === null
      ? null
      : new UsageCollector({
          store: usageStore,
          enabled: usageEnabled,
          resolveSession: resolveSessionFacts,
          warn: (message: string) => ctx.logger?.warn?.(`dsh-antigravity: ${message}`)
        })

  /** Apply the retention window; runs at load and on every settings change. */
  const pruneUsage = (): void => {
    if (usageStore === null) return
    const days = Number(current().usage?.retentionDays ?? 0)
    if (!Number.isFinite(days) || days <= 0) return
    try {
      usageStore.prune(Date.now() - days * 86_400_000)
    } catch (error: any) {
      ctx.logger?.warn?.(`dsh-antigravity: 用量清理失败：${error.message}`)
    }
  }

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

  /**
   * The only credential reader on the model route.
   *
   * It owns the account list, refreshes what is about to expire, parks what the
   * provider said is exhausted, and hands the adapter one account per attempt —
   * which is what makes a second Google account a failover target rather than
   * just a second row in settings.
   */
  const pool = new AccountPool({
    credentials: credentialsService,
    oauth: () => ({ clientId: current().clientId, clientSecret: current().clientSecret }),
    strategy: () => current().accountStrategy ?? 'round-robin',
    warn: (message: string) => ctx.logger?.warn?.(message)
  })

  const resolveCredentials = (signal?: AbortSignal, exclude?: ReadonlySet<string>) =>
    pool.resolve(signal, exclude)

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
   * Label the provider row carries. With several accounts installed the active
   * one still names the row, and the count says the row stands for more than
   * that one account.
   */
  const markerLabel = (): string => {
    const count = pool.count()
    const active = pool.activeLabel()
    if (active === undefined || active === '') return 'google'
    return count > 1 ? `${active}（共 ${count} 个账号）` : active
  }

  /**
   * Publish the settings marker that installs the provider row. Without it the
   * entry stays dormant in the 「添加提供方」 select, which is the default state:
   * a provider nobody signed in to owns no row in Settings → Models.
   */
  const markAccountInstalled = async (): Promise<void> => {
    const settings = settingsService()
    if (settings === undefined) return
    const label = markerLabel()
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
   * Keep the marker and the credentials in step. The marker *is* how the
   * account is installed, so its removal — the row's native 「移除」, or a hand
   * edit of `settings.yaml` — removes every account too.
   *
   * Only the set → unset transition counts: a grant installed by the standalone
   * CLI never had a marker, and an unrelated settings edit must not delete it.
   *
   * Carried out after a short grace period, because this is the one irreversible
   * path in the plugin — what it deletes are refresh tokens that exist nowhere
   * else. A settings reload that lands while the file is being written also
   * reads as "the marker is gone", and that flicker must not cost the user every
   * account. The presence of any marker again cancels the wipe, and
   * `AccountPool.clear` keeps one generation of backup besides.
   */
  const removalGraceMs = 1000
  let removalTimer: ReturnType<typeof setTimeout> | null = null
  const reconcileAccount = (): void => {
    const account = current().account
    const removed = previousAccount !== undefined && account === undefined
    previousAccount = account
    if (removalTimer !== null) {
      clearTimeout(removalTimer)
      removalTimer = null
    }
    if (!removed) return
    removalTimer = setTimeout(() => {
      removalTimer = null
      void pool.clear()
    }, removalGraceMs)
    removalTimer.unref?.()
  }

  // -------------------------------------------------------------------------
  // Sign-in
  // -------------------------------------------------------------------------
  const login = new LoginManager({
    ...oauthOptions(),
    onSuccess: async (creds: AntigravityCredentials) => {
      // Signing in again with an email already on file refreshes that entry
      // instead of adding a duplicate; a new email appends one.
      await pool.add(creds)
      await markAccountInstalled()
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
    resolveImage,
    // A quota or credential rejection is the pool's problem, not the call's:
    // reporting it parks that account so the next call does not walk into it.
    reportFailure: info => pool.reportFailure(info),
    // Recording is a side effect of serving a call: the collector swallows its
    // own failures, so a broken database can never break the model route.
    observe: observation => {
      collector?.observe(observation)
    }
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
        pruneUsage()
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
    pruneUsage()
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
        await pool.add(creds)
        // The seam verifies the record was committed during this attempt.
        await writeCredentialRecord(credentialsService(), creds)
        await markAccountInstalled()
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

    /** Whole-pool snapshot shared by every status-shaped response. */
    const poolSnapshot = () => ({
      version,
      accounts: pool.list(),
      activeAccountId: pool.activeId() ?? null,
      strategy: pool.strategy()
    })

    const status = async (): Promise<StatusPayload> => {
      const snapshot = login.status()
      const base = { ...poolSnapshot(), pending: snapshot.pending, loginUrl: snapshot.url }
      try {
        // Resolve (and refresh, when possible) so the card never claims a live
        // session on the strength of an expired access token. The *active*
        // account is read, not a rotated one: opening settings must not spend a
        // round-robin turn.
        const creds = await pool.resolveActive()
        if (creds === undefined) throw new Error('未找到 google-antigravity 认证凭据')
        // An account installed outside this card — a grant the CLI wrote, or one
        // that predates the marker — has no row to sit in. Reading the card is
        // the moment that becomes visible, so install the marker here rather
        // than writing settings during plugin load.
        await markAccountInstalled()
        return {
          ...base,
          authenticated: true,
          email: creds.email ?? null,
          projectId: creds.projectId ?? 'aicode-consumers',
          expires: typeof creds.expires === 'number' ? creds.expires : null,
          timeLeftSeconds: typeof creds.expires === 'number' ? Math.max(0, Math.round((creds.expires - Date.now()) / 1000)) : null,
          error: null
        }
      } catch (error) {
        const accounts = base.accounts
        return {
          ...base,
          authenticated: false,
          // A stored account that no longer resolves is the "expired" state the
          // card used to derive from a leftover grant.
          expired: accounts.length > 0,
          email: accounts[0]?.email ?? null,
          projectId: accounts[0]?.projectId ?? null,
          error: snapshot.error ?? error.message
        }
      }
    }

    /** Read a JSON request body, capped so a stray client cannot balloon memory. */
    const readJsonBody = async (req: IncomingMessage): Promise<any> => {
      const chunks: Buffer[] = []
      let size = 0
      for await (const chunk of req) {
        const buffer = Buffer.from(chunk as any)
        size += buffer.length
        if (size > 64 * 1024) return {}
        chunks.push(buffer)
      }
      if (chunks.length === 0) return {}
      try {
        return JSON.parse(Buffer.concat(chunks).toString('utf8'))
      } catch {
        return {}
      }
    }

    /**
     * Register one auth route with the guard, the method check and a failure
     * answer already in place.
     *
     * Every body here can reject — a registry write can fail, a token refresh
     * can throw — and a rejection that escapes the handler leaves the browser
     * waiting for a response that never comes, with nothing in the page to say
     * why. One shape for all of them means the answer is always a status code.
     */
    const route = (
      method: 'GET' | 'POST',
      path: string,
      handler: (req: IncomingMessage, res: ServerResponse) => Promise<void> | void
    ): void => {
      webCtx.effect(
        () =>
          webCtx.webServer.register({
            kind: 'exact',
            path,
            handler: async (req: IncomingMessage, res: ServerResponse) => {
              if (guard(req, res)) return
              if (req.method !== method) return methodNotAllowed(res, method)
              try {
                await handler(req, res)
              } catch (error: any) {
                if (!res.headersSent) sendJson(res, 500, { error: error?.message ?? String(error) })
              }
            }
          }),
        `dsh-antigravity: ${method} ${path}`
      )
    }

    /**
     * Keep the settings marker in step with the account list after a change.
     *
     * The provider row survives while any account remains; only the last
     * removal withdraws the marker, which is what makes the row disappear and
     * the next sign-in start from 「添加提供方」 again.
     */
    const afterAccountChange = async (): Promise<void> => {
      if (pool.count() === 0) await unmarkAccount()
      else await markAccountInstalled()
    }

    route('GET', `${ROUTE_PREFIX}/status`, async (req, res) => {
      sendJson(res, 200, await status())
    })

    route('POST', `${ROUTE_PREFIX}/login`, async (req, res) => {
      const url = await login.begin()
      sendJson(res, 200, { url, pending: true })
    })

    route('POST', `${ROUTE_PREFIX}/cancel`, (req, res) => {
      login.cancel()
      sendJson(res, 200, { pending: false })
    })

    route('POST', `${ROUTE_PREFIX}/logout`, async (req, res) => {
      login.cancel()
      // Signs the *active* account out and leaves the rest installed: with
      // several accounts, 「退出登录」 on one row must not silently discard the
      // others.
      await pool.signOut()
      await afterAccountChange()
      sendJson(res, 200, await status())
    })

    route('GET', `${ROUTE_PREFIX}/accounts`, async (req, res) => {
      await pool.ready()
      sendJson(res, 200, poolSnapshot())
    })

    /** Read the `id` a mutation names, or answer 404 when it is not there. */
    const accountId = async (req: IncomingMessage): Promise<string> => {
      const body = await readJsonBody(req)
      return typeof body?.id === 'string' ? body.id : ''
    }

    route('POST', `${ROUTE_PREFIX}/accounts/active`, async (req, res) => {
      const id = await accountId(req)
      if (id === '' || !(await pool.setActive(id))) {
        sendJson(res, 404, { error: '未找到该账号' })
        return
      }
      await markAccountInstalled()
      sendJson(res, 200, await status())
    })

    route('POST', `${ROUTE_PREFIX}/accounts/remove`, async (req, res) => {
      const id = await accountId(req)
      if (id === '' || !(await pool.remove(id))) {
        sendJson(res, 404, { error: '未找到该账号' })
        return
      }
      await afterAccountChange()
      sendJson(res, 200, await status())
    })

    // -----------------------------------------------------------------------
    // Usage panel API — same loopback guard as the auth routes, so the
    // statistics are never readable from outside the browser session.
    // -----------------------------------------------------------------------
    if (usageStore !== null) {
      const store = usageStore
      registerUsageRoutes({
        store,
        pricing: pricingTable,
        enabled: usageEnabled,
        retentionDays: () => current().usage?.retentionDays ?? 0,
        prefix: USAGE_ROUTE_PREFIX,
        guard,
        /**
         * The panel is only offered to a user who actually has an account:
         * without one this provider could not have accounted for anything, and
         * an eternally empty statistics page is just noise in Settings. True
         * while either the settings marker or a stored grant exists.
         */
        authenticated: async () => {
          if (current().account !== undefined) return true
          try {
            await pool.ready()
            return pool.configured()
          } catch {
            return false
          }
        },
        /**
         * Fold the calls already sitting in this machine's session logs into
         * the store, so the panel shows history instead of starting empty. The
         * logs carry no latency or stop reason; the scan says so rather than
         * inventing them.
         *
         * The per-file revision check is what makes this safe to run on every
         * panel open: an unchanged log is skipped after a stat, so only what
         * actually moved gets decompressed.
         */
        backfill: async () => {
          const result = await backfillFromSessions({
            sessionsRoot: path.join(dshHome(), 'sessions'),
            provider: PROVIDER,
            importRow: (key, record) => collector?.import(key, record) ?? false,
            isCurrent: (file, mtimeMs, size) => store.isFileCurrent(file, mtimeMs, size),
            markProcessed: (file, mtimeMs, size) => store.markFile(file, mtimeMs, size)
          })
          ctx.logger?.info?.(
            `dsh-antigravity: 用量统计扫描 ${result.files} 个会话文件（跳过 ${result.unchanged}，导入 ${result.imported}，匹配 ${result.matched}）`
          )
          return {
            imported: result.imported,
            scanned: result.scanned,
            files: result.files,
            matched: result.matched,
            failed: result.failed.length
          }
        },
        register: (path, method, handler) => {
          webCtx.effect(
            () => webCtx.webServer.register({ kind: 'exact', path, handler }),
            `dsh-antigravity: ${method} ${path}`
          )
        }
      })
    }
  })

  ctx.effect(() => () => {
    if (removalTimer !== null) {
      clearTimeout(removalTimer)
      removalTimer = null
    }
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
    usageStore?.close()
  }, 'dsh-antigravity: registration teardown')
}

/** Read an optional finite non-negative number, or null when unusable. */
function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
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
