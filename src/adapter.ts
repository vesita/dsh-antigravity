import { randomUUID } from 'node:crypto'
import { EMPTY_RESPONSE_CODE, LlmAdapter, LlmError } from '@deepseek-ai/dsh-llm'
import type {
  ContentBlock,
  FinishReason,
  GenerateOptions,
  LlmModelInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  Message,
  ReasoningEffortId,
  ResolvedRetryPolicy,
  StreamChunk,
  TokenUsage,
  ToolCallBlock,
  ToolResultBlock
} from '@deepseek-ai/dsh-llm'
import { MODEL_CATALOG, REASONING_EFFORTS, modelInfoOf, resolveModelSpec } from './models.js'
import type { ModelSpec } from './models.js'
import { toAntigravityToolSchema } from './tool-schema.js'
import type { AntigravityCredentials } from './auth.js'

/**
 * Native DSH `LlmAdapter` over the Antigravity `v1internal:streamGenerateContent`
 * endpoint.
 *
 * The adapter owns no credentials and no settings: every fact it needs arrives
 * through the resolver functions the plugin installs (models, credentials,
 * endpoint, project, reasoning default, image bytes). That keeps one adapter
 * instance valid across live settings edits and makes the class testable
 * without a Cordis context.
 *
 * One call may walk several accounts. The adapter never decides *which* account
 * is which: it asks the credential layer for one, and when that account is
 * rejected for a reason another account would not share (quota, credential) it
 * reports the failure and asks again with the failed id excluded. The pool
 * decides who is next.
 *
 * @module dsh-antigravity/adapter
 */

/** Antigravity endpoints, tried in order when settings name no explicit one. */
export const DEFAULT_ENDPOINTS = [
  'https://daily-cloudcode-pa.googleapis.com',
  'https://daily-cloudcode-pa.sandbox.googleapis.com',
  'https://cloudcode-pa.googleapis.com'
]

/**
 * Message DSH shows when no account can serve a call at all.
 *
 * Kept as one constant because it is also the text a user reads after every
 * account in the pool has been tried.
 */
const MISSING_CREDENTIAL_MESSAGE =
  '未找到 google-antigravity 认证凭据。请在 DSH 的「设置 → 模型 → Google Antigravity」中登录后重试。'

/** Hard ceiling on how many accounts one call may walk through. */
const MAX_ACCOUNT_ATTEMPTS = 8

/** One image resolved to inline request bytes. */
export interface ResolvedImage {
  mimeType: string
  base64: string
}

/** Resolve one durable attachment reference into inline image bytes. */
export type ImageResolver = (ref: unknown) => Promise<ResolvedImage | null>

/**
 * One settled provider call, as the usage collector consumes it.
 *
 * The adapter observes its own stream and hands this over exactly once per
 * call, whether the call succeeded, failed, or was aborted — a settled call is
 * what the accounting needs, and the reason travels alongside it.
 */
export interface CallObservation {
  /** Call completion time, epoch ms. */
  time: number
  /** DSH-facing model id the caller asked for. */
  model: string
  /** Session the call belongs to, empty when the caller is not session-bound. */
  sessionId: string
  /** Request start → first content chunk, ms; null when no content ever arrived. */
  ttftMs: number | null
  /** Request start → stream end, ms. */
  durationMs: number
  /** `stop` / `tool-calls` / `max-tokens` / `error` / `aborted`. */
  stopReason: string
  /** Provider failure text; empty on success. */
  errorMessage: string
  /** Provider-reported usage, or null when the call never reported any. */
  tokens: TokenUsage | null
  /** Registry id of the account that served the call, when one was attributed. */
  accountId?: string
  /** Human label of that account (its email), when one was attributed. */
  accountLabel?: string
  /** How many accounts this one call walked through before it settled. */
  accountAttempts?: number
}

/** One account-scoped failure the adapter hands back to the credential pool. */
export interface AdapterFailureInfo {
  /** Id of the account that failed. */
  accountId?: string
  /** Only `quota` and `auth` are worth another account; `other` is not. */
  kind: 'quota' | 'auth' | 'other'
  /** Provider text, kept for the settings card. */
  message: string
  /** Reset time of an exhausted quota, epoch ms, when the body carried one. */
  cooldownUntil?: number
}

/** Every fact the adapter reads, supplied by the mounting plugin. */
export interface AdapterOptions {
  /** Active catalog, read fresh on every call so settings edits apply live. */
  resolveModels?: () => ModelSpec[] | undefined
  /**
   * Credential facts for the provider route.
   *
   * @param signal - abort signal.
   * @param exclude - accounts already tried for this call, so a failover walks
   *   the pool rather than returning to the account that just failed.
   */
  resolveCredentials?: (
    signal?: AbortSignal,
    exclude?: ReadonlySet<string>
  ) => Promise<AntigravityCredentials | undefined>
  /** Configured endpoint, when settings name one. */
  resolveEndpoint?: () => string | undefined
  /** Configured billing project, when settings name one. */
  resolveProjectId?: () => string | undefined
  /** Default reasoning effort the caller left unset. */
  resolveReasoningEffort?: () => ReasoningEffortId | undefined
  /** Settings-owned retry policy. */
  resolveRetryPolicy?: () => ResolvedRetryPolicy | undefined
  /** Resolve one attachment reference into inline image bytes. */
  resolveImage?: ImageResolver
  /**
   * Called once per failed account attempt, so the pool can park an exhausted
   * account instead of handing it to the next call.
   */
  reportFailure?: (info: AdapterFailureInfo) => void
  /**
   * Called once per settled call with what the stream reported.
   *
   * Observation is deliberately fire-and-forget and fully guarded: an
   * accounting failure must never turn a working model call into a broken one.
   */
  observe?: (observation: CallObservation) => void
}

/**
 * Antigravity extension fields this adapter reads that DSH's core content
 * vocabulary does not model: the replayed tool-call signature Antigravity
 * requires, and the legacy `name` some tool-result producers attach beside the
 * call id.
 */
type ProviderToolCallBlock = ToolCallBlock & { thoughtSignature?: string }
type ProviderToolResultBlock = ToolResultBlock & { name?: string }

/** A content block as the request builders read it: only its text projection matters. */
type TextBearingBlock = ContentBlock & { text?: string }

/** Model-facing content: DSH passes blocks, one-shot callers may pass a bare string. */
type MessageContent = string | readonly TextBearingBlock[]

/** One part of an Antigravity `GenerateContent` request. */
interface AntigravityPart {
  text?: string
  functionCall?: { name?: string; args?: unknown; id?: string }
  functionResponse?: { name: string; response: unknown; id?: string }
  inlineData?: { mimeType: string; data: string }
  thoughtSignature?: string
}

/** One role-tagged turn in an Antigravity `GenerateContent` request. */
interface AntigravityContent {
  role: string
  parts: AntigravityPart[]
}

/** Gemini thinking controls this adapter emits. */
interface ThinkingConfig {
  includeThoughts: boolean
  thinkingLevel?: string
}

/** Generation controls this adapter emits. */
interface GenerationConfig {
  thinkingConfig?: ThinkingConfig
  temperature?: number
  maxOutputTokens?: number
  stopSequences?: string[]
}

/** The `request` field of an Antigravity payload. */
interface AntigravityRequest {
  contents: AntigravityContent[]
  systemInstruction?: { parts: { text: string }[] }
  tools?: { functionDeclarations: { name: string; description: string; parameters: Record<string, unknown> }[] }[]
  generationConfig?: GenerationConfig
}

/** Gemini `usageMetadata` as the endpoint reports it. */
interface GeminiUsageMetadata {
  cachedContentTokenCount?: number
  thoughtsTokenCount?: number
  promptTokenCount?: number
  candidatesTokenCount?: number
  totalTokenCount?: number
}

export class GoogleAntigravityAdapter extends LlmAdapter {
  /** Resolver functions installed by the mounting plugin. */
  readonly options: AdapterOptions

  /**
   * @param options - `{ resolveModels, resolveCredentials, resolveEndpoint, resolveProjectId, resolveReasoningEffort, resolveRetryPolicy, resolveImage }`.
   */
  constructor(options: AdapterOptions = {}) {
    super()
    this.options = options
  }

  /** The active catalog, read fresh on every call so settings edits apply live. */
  #catalog(): ModelSpec[] {
    const models = this.options.resolveModels?.()
    return Array.isArray(models) && models.length > 0 ? models : MODEL_CATALOG
  }

  providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: 'Google Antigravity' }
  }

  providerRetryPolicy(): ResolvedRetryPolicy | undefined {
    // 策略由 settings 全权决定；它没给就返回 `undefined`，让 dsh-llm 自己解析完整的
    // 冻结默认值（`mode` + `maxRetries` + `retryableCodes` + `maxDelayMs`）。
    //
    // **绝不**在这里手写半条字面量：`dsh-llm-retry` 在首次调用失败时就读
    // `policy.retryableCodes.includes(failure.code)`（dsh-llm-retry/lib/index.js:160），
    // 缺 `retryableCodes` 的策略会抛 `Cannot read properties of undefined (reading
    // 'includes')`，把 provider 的真实故障**盖成** UNKNOWN —— 实测就是一次 TRANSPORT
    // 故障（「连接任何 Google Antigravity 端点均失败」）被 TypeError 掩盖。
    // `mode: 'always'` 合法地不带 `retryableCodes`（消费方在该分支根本不读它），原样透传。
    const resolved = this.options.resolveRetryPolicy?.()
    if (resolved === undefined || resolved.mode === 'always') return resolved
    if (!Array.isArray(resolved.retryableCodes) || resolved.retryableCodes.length === 0) return undefined
    return resolved
  }

  async listModels(provider: string): Promise<LlmModelInfo[]> {
    return this.#catalog().map(spec => modelInfoOf(spec, provider))
  }

  async resolveModel(provider: string, modelId: string): Promise<LlmResolvedModelInfo> {
    // The runtime only asks about concrete, non-empty model ids, which always
    // resolve against the catalog's permissive fallback.
    const spec = resolveModelSpec(modelId, this.#catalog()) as ModelSpec
    return {
      provider,
      id: spec.id,
      name: spec.name || spec.id,
      ...(spec.description === undefined ? {} : { description: spec.description }),
      context: { contextWindow: spec.contextWindow || 1048576 },
      defaultMaxTokens: spec.maxTokens || 65536,
      inputModalities: [...(spec.inputModalities || ['text'])],
      ...(spec.reasoning === false
        ? {}
        : {
            reasoning: {
              efforts: REASONING_EFFORTS,
              defaultEffort: this.options.resolveReasoningEffort?.() || ('high' as ReasoningEffortId)
            }
          })
    }
  }

  async *stream(options: GenerateOptions): AsyncGenerator<StreamChunk, void, unknown> {
    const startedAt = Date.now()
    const observe = this.options.observe
    let ttftMs: number | null = null
    let usage: TokenUsage | null = null
    let finish: FinishReason | undefined
    let failure = ''
    let settled = false
    let accountId: string | undefined
    let accountLabel: string | undefined
    let accountAttempts = 0

    try {
      const catalog = this.#catalog()
      const spec = resolveModelSpec(options.model, catalog)
      const wireModel = spec?.wireId || options.model

      const endpoints = this.#endpoints()
      const request = await buildRequest(options, spec, this.options.resolveImage)
      const tried = new Set<string>()
      let lastError: unknown = null
      let response: Response | null = null

      // One attempt per account. A quota or credential rejection is neither the
      // endpoint's fault nor the request's — with a second account installed it
      // just means the wrong account was picked, so the pool is asked for the
      // next one instead of surfacing a failure the user cannot act on.
      for (;;) {
        let creds: AntigravityCredentials | undefined
        try {
          creds = await this.#credentials(options.signal, tried)
        } catch (error) {
          // An account already failed for a reason the user can act on (quota,
          // a rejected grant). Whatever went wrong while looking for the *next*
          // account must not replace that: the first failure is the diagnosis.
          if (lastError !== null) throw lastError
          throw error
        }
        if (creds === undefined) {
          if (lastError !== null) throw lastError
          throw new LlmError(MISSING_CREDENTIAL_MESSAGE, 'MISSING_CREDENTIAL')
        }
        const identity = creds.accountId ?? creds.email ?? ''
        // A credential layer that ignores `exclude` (a lone account, a test
        // double) would otherwise be asked forever: stop instead of looping.
        if (tried.size > 0 && (identity === '' || tried.has(identity))) {
          throw lastError ?? new LlmError(MISSING_CREDENTIAL_MESSAGE, 'MISSING_CREDENTIAL')
        }
        if (tried.size >= MAX_ACCOUNT_ATTEMPTS) throw lastError
        tried.add(identity === '' ? `#${tried.size}` : identity)
        accountAttempts += 1
        accountId = creds.accountId ?? accountId
        accountLabel = creds.email ?? creds.projectId ?? accountLabel

        const payload = {
          project: creds.projectId || this.options.resolveProjectId?.() || 'aicode-consumers',
          model: wireModel,
          requestId: `agent/${randomUUID()}/${Date.now()}/${randomUUID()}/1`,
          request,
          userAgent: 'antigravity',
          requestType: 'agent'
        }

        try {
          response = await this.#openStream(endpoints, creds.access, payload, options.signal)
          break
        } catch (error) {
          lastError = error
          try {
            this.options.reportFailure?.(failureInfoOf(creds, error))
          } catch {
            /* accounting must never break a model call */
          }
          // A transport or request failure repeats identically on every
          // account, so it is reported as-is.
          if (!accountScoped(error)) throw error
          if (options.signal?.aborted) throw error
        }
      }

      for await (const chunk of parseStream(response, spec)) {
        // Time to first token measures the first piece of model output. Usage
        // and finish chunks are bookkeeping, and a block-start carries no
        // content of its own, so none of them may start the clock.
        if (
          ttftMs === null
          && (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta' || chunk.type === 'tool-call-delta')
        ) {
          ttftMs = Date.now() - startedAt
        }
        if (chunk.type === 'usage') usage = chunk.usage
        else if (chunk.type === 'finish') finish = chunk.reason
        yield chunk
      }
      settled = true
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error)
      throw error
    } finally {
      // The generator settles exactly once: on normal completion, on a thrown
      // provider failure, or when the consumer stops early (an abort). All
      // three are worth accounting for, so the report lives in `finally`.
      if (observe !== undefined) {
        try {
          observe({
            time: Date.now(),
            model: options.model,
            sessionId: options.sessionId === undefined ? '' : String(options.sessionId),
            ttftMs,
            durationMs: Date.now() - startedAt,
            stopReason: failure !== '' ? 'error' : settled ? String(finish?.kind ?? 'stop') : 'aborted',
            errorMessage: failure,
            tokens: usage,
            ...(accountId === undefined ? {} : { accountId }),
            ...(accountLabel === undefined ? {} : { accountLabel }),
            ...(accountAttempts > 1 ? { accountAttempts } : {})
          })
        } catch {
          /* accounting must never break a model call */
        }
      }
    }
  }

  /**
   * Ask the credential layer for an account.
   *
   * @param signal - abort signal.
   * @param exclude - accounts already tried for this call.
   * @returns credential facts, or `undefined` when nothing is left to try.
   */
  async #credentials(
    signal?: AbortSignal,
    exclude?: ReadonlySet<string>
  ): Promise<AntigravityCredentials | undefined> {
    try {
      const creds = await this.options.resolveCredentials?.(signal, exclude)
      if (!creds || !creds.access) return undefined
      return creds
    } catch (error) {
      if (error instanceof LlmError) throw error
      if (signal?.aborted) throw new LlmError('Antigravity 请求已被取消', 'ABORTED', { cause: error })
      // A credential layer that failed for a reason of its own — every refresh
      // token rejected, the account registry unreadable — knows more about it
      // than this adapter does, so its message is what the caller reads. Only a
      // layer that explicitly offered nothing gets "not signed in", which would
      // otherwise send the user to re-login over a token that only needed
      // refreshing.
      throw new LlmError(
        error instanceof Error && error.message !== '' ? error.message : MISSING_CREDENTIAL_MESSAGE,
        'MISSING_CREDENTIAL',
        { cause: error }
      )
    }
  }

  #endpoints(): string[] {
    const configured = this.options.resolveEndpoint?.()
    if (typeof configured === 'string' && configured.length > 0) {
      return [configured, ...DEFAULT_ENDPOINTS.filter(endpoint => endpoint !== configured)]
    }
    return DEFAULT_ENDPOINTS
  }

  async #openStream(
    endpoints: string[],
    accessToken: string,
    payload: unknown,
    signal?: AbortSignal
  ): Promise<Response> {
    let lastError: unknown = null
    for (const base of endpoints) {
      if (signal?.aborted) throw new LlmError('Antigravity 请求已被取消', 'ABORTED')
      const url = `${base.replace(/\/+$/, '')}/v1internal:streamGenerateContent?alt=sse`
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
            Accept: 'text/event-stream',
            'User-Agent': 'antigravity'
          },
          body: JSON.stringify(payload),
          signal
        })
        if (res.ok && res.body) return res
        const body = await res.text().catch(() => '')
        const error = new LlmError(
          res.status === 429 ? quotaMessage(base, res.status, body) : `Antigravity 端点 ${base} 返回 ${res.status}: ${body.slice(0, 500)}`,
          httpCode(res.status)
        ) as LlmError & { retryAtMs?: number }
        // A 429 body usually says when the quota resets. Keep that as a fact on
        // the error so the pool can park this account for exactly that long
        // instead of guessing, and so the next call goes elsewhere.
        if (res.status === 429) {
          const retryAt = parseQuotaResetMs(body)
          if (retryAt !== undefined) error.retryAtMs = retryAt
        }
        lastError = error
        // Authentication and quota failures are not endpoint-specific.
        if (res.status === 401 || res.status === 403 || res.status === 429) break
      } catch (error) {
        if (signal?.aborted) throw new LlmError('Antigravity 请求已被取消', 'ABORTED', { cause: error })
        lastError = error
      }
    }
    throw lastError instanceof LlmError
      ? lastError
      : new LlmError('连接任何 Google Antigravity 端点均失败', 'TRANSPORT', { cause: lastError })
  }
}

/**
 * Whether a failure is specific to the *account* rather than to the request,
 * the endpoints, or the network.
 *
 * Only these are worth another account: a request the endpoint rejected is
 * rejected identically by every account, and retrying it would multiply a bad
 * request by the size of the pool.
 *
 * @param error - the failure a stream attempt produced.
 * @returns whether the pool should be asked for the next account.
 */
function accountScoped(error: unknown): boolean {
  const code = (error as { code?: unknown } | null | undefined)?.code
  return code === 'QUOTA_EXCEEDED' || code === 'INVALID_CREDENTIAL'
}

/** Project one failed attempt into the fact the credential pool records. */
function failureInfoOf(creds: AntigravityCredentials, error: unknown): AdapterFailureInfo {
  const code = (error as { code?: unknown } | null | undefined)?.code
  const kind: AdapterFailureInfo['kind'] =
    code === 'QUOTA_EXCEEDED' ? 'quota' : code === 'INVALID_CREDENTIAL' ? 'auth' : 'other'
  const retryAt = (error as { retryAtMs?: unknown } | null | undefined)?.retryAtMs
  return {
    ...(creds.accountId === undefined ? {} : { accountId: creds.accountId }),
    kind,
    message: error instanceof Error ? error.message : String(error),
    ...(kind === 'quota' && typeof retryAt === 'number' ? { cooldownUntil: retryAt } : {})
  }
}

/**
 * Read the quota reset delay out of a 429 body.
 *
 * Google states it in prose — `Resets in 1h31m29s` — and that is the only place
 * the fact exists, so it is parsed rather than guessed at. Anything unexpected
 * returns `undefined` and leaves the pool to its conservative default.
 *
 * @param body - raw 429 response text.
 * @param now - clock, epoch ms.
 * @returns the reset instant, epoch ms, or `undefined` when the body is silent.
 */
export function parseQuotaResetMs(body: string, now: number = Date.now()): number | undefined {
  const match = /Resets in\s+(?:([0-9]+)h)?(?:([0-9]+)m)?(?:([0-9]+(?:\.[0-9]+)?)s)?/i.exec(String(body || ''))
  if (match === null) return undefined
  const ms = Math.round((Number(match[1] || 0) * 3600 + Number(match[2] || 0) * 60 + Number(match[3] || 0)) * 1000)
  // `Resets in 0s` is a real answer meaning "the quota is back": it must be kept
  // as a zero-length wait, because dropping it here would let the pool fall back
  // to its conservative default and park a healthy account for ten minutes.
  return ms >= 0 ? now + ms : undefined
}

function httpCode(status: number): string {
  if (status === 401 || status === 403) return 'INVALID_CREDENTIAL'
  if (status === 429) return 'QUOTA_EXCEEDED'
  if (status >= 500) return 'TRANSPORT'
  return 'INVALID_REQUEST'
}

/**
 * Turn a 429 response body into something a human can act on.
 *
 * Measured against this deployment's own usage database (16195 rows): every 429
 * the provider returned was quota exhaustion, not transient throttling —
 * `"Resource has been exhausted (e.g. check quota)"`, or
 * `"Individual quota reached. Please upgrade your subscription… Resets in 1h31m29s."`
 * So the body already carries the two facts that matter (it is quota, and when it
 * resets); the raw JSON blob was just burying them.
 *
 * Deliberately **not** changing the code to `RATE_LIMIT`: that would put these
 * failures into `dsh-llm-retry`'s retryable set and spend the retry budget on a
 * wait measured in minutes-to-hours. Surfacing the wait is the useful fix; the
 * raw body is kept (truncated) so nothing is hidden.
 *
 * The parsed reset instant also travels on the error (`retryAtMs`) so the
 * multi-account pool can park this account for exactly that long — and with a
 * second account installed, the call itself already moved on to it.
 *
 * @param base - endpoint that answered.
 * @param status - HTTP status (always 429 here).
 * @param body - raw response text.
 * @returns one actionable sentence.
 */
function quotaMessage(base: string, status: number, body: string): string {
  const raw = String(body || '')
  const head = `Antigravity 端点 ${base} 返回 ${status}`
  const isQuota = /QUOTA_EXHAUSTED|Individual quota reached|Resource has been exhausted/i.test(raw)
  if (!isQuota) return `${head}: ${raw.slice(0, 500)}`
  // Same shape as {@link parseQuotaResetMs}: hours, minutes and seconds are each
  // optional, because Google writes `45m` as readily as `1h31m29s`, and a regex
  // that demands seconds silently drops the human-readable half of the message.
  const reset = /Resets in\s+(?:([0-9]+)h)?(?:([0-9]+)m)?(?:([0-9]+(?:\.[0-9]+)?)s)?/i.exec(raw)
  const when = reset === null ? '' : `，约 ${reset[0].replace(/^Resets in\s+/i, '')} 后重置`
  return `${head}：配额已用尽${when}。这不是退避重试能解决的（不会自动重试）；请等重置、或升级订阅。原始响应：${raw.slice(0, 300)}`
}

// ---------------------------------------------------------------------------
// Request construction
// ---------------------------------------------------------------------------

/**
 * Convert one DSH request into the Antigravity `GenerateContent` body.
 *
 * @param options - DSH `GenerateOptions`.
 * @param spec - the resolved catalog entry.
 * @param resolveImage - optional `(ref) => Promise<{ mimeType, base64 } | null>`.
 * @returns the `request` field of the Antigravity payload.
 */
export async function buildRequest(
  options: GenerateOptions,
  spec: ModelSpec | null,
  resolveImage?: ImageResolver
): Promise<AntigravityRequest> {
  let systemText = typeof options.system === 'string' ? options.system : ''
  const toolNames = collectToolCallNames(options.messages || [])
  const contents: AntigravityContent[] = []

  const push = (role: string, parts: AntigravityPart[]) => {
    if (parts.length === 0) return
    const last = contents[contents.length - 1]
    if (last && last.role === role) last.parts.push(...parts)
    else contents.push({ role, parts })
  }

  for (const message of options.messages || []) {
    if (message.role === 'system') {
      const text = textOf(message.content)
      if (text) systemText = systemText ? `${systemText}\n\n${text}` : text
      continue
    }

    if (message.role === 'assistant') {
      push('model', await assistantParts(message.content, resolveImage))
      continue
    }

    push('user', await userParts(message, toolNames, resolveImage))
  }

  const request: AntigravityRequest = { contents }
  if (systemText) request.systemInstruction = { parts: [{ text: systemText }] }

  if (Array.isArray(options.tools) && options.tools.length > 0) {
    request.tools = [
      {
        functionDeclarations: options.tools.map(tool => ({
          name: tool.name,
          description: tool.description || '',
          // The endpoint rejects the whole request over one undefined keyword, so
          // every declaration is projected before it goes on the wire.
          parameters: toAntigravityToolSchema(tool.parameters)
        }))
      }
    ]
  }

  const generationConfig: GenerationConfig = {}
  if (spec?.reasoning !== false) {
    generationConfig.thinkingConfig = { includeThoughts: true }
    const effort = options.reasoningEffort
    if ((effort === 'low' || effort === 'high') && /^gemini-3/.test(String(spec?.id || ''))) {
      generationConfig.thinkingConfig.thinkingLevel = effort
    }
    if (effort === 'off') generationConfig.thinkingConfig.includeThoughts = false
  }
  if (options.temperature !== undefined) generationConfig.temperature = options.temperature
  if (options.maxTokens !== undefined) generationConfig.maxOutputTokens = options.maxTokens
  else if (spec?.maxTokens) generationConfig.maxOutputTokens = spec.maxTokens
  if (Array.isArray(options.stop) && options.stop.length > 0) generationConfig.stopSequences = [...options.stop]
  if (Object.keys(generationConfig).length > 0) request.generationConfig = generationConfig

  if (contents.length === 0) contents.push({ role: 'user', parts: [{ text: 'Hello' }] })
  return request
}

/** Map every assistant tool-call id to its function name across the whole history. */
function collectToolCallNames(messages: Message[]): Map<string, string> {
  const names = new Map<string, string>()
  for (const message of messages) {
    if (message.role !== 'assistant' || !Array.isArray(message.content)) continue
    for (const block of message.content) {
      if (block.type === 'tool-call' && block.id) names.set(block.id, block.name)
    }
  }
  return names
}

async function assistantParts(content: MessageContent | null | undefined, resolveImage?: ImageResolver): Promise<AntigravityPart[]> {
  const parts: AntigravityPart[] = []
  if (typeof content === 'string') {
    if (content) parts.push({ text: content })
    return parts
  }
  if (!Array.isArray(content)) return parts

  for (const block of content) {
    if (block.type === 'text') {
      if (block.text) parts.push({ text: block.text })
    } else if (block.type === 'tool-call') {
      parts.push({
        functionCall: {
          name: block.name,
          args: parseArguments(block.arguments),
          ...(block.id ? { id: block.id } : {})
        },
        // Antigravity requires a signature on replayed calls; this sentinel is
        // the documented escape hatch when the original one was not retained.
        thoughtSignature: (block as ProviderToolCallBlock).thoughtSignature || 'skip_thought_signature_validator'
      })
    }
    // `reasoning` blocks are model-private; they are not replayed.
  }
  return parts
}

async function userParts(
  message: Message,
  toolNames: Map<string, string>,
  resolveImage?: ImageResolver
): Promise<AntigravityPart[]> {
  const parts: AntigravityPart[] = []
  const content = message.content
  if (typeof content === 'string') {
    if (content) parts.push({ text: content })
    return parts
  }
  if (!Array.isArray(content)) return parts

  for (const block of content) {
    if (block.type === 'text') {
      if (block.text) parts.push({ text: block.text })
    } else if (block.type === 'image') {
      const inline = await imagePart(block.attachment, resolveImage)
      if (inline) parts.push(inline)
    } else if (block.type === 'tool-result') {
      const callId = block.toolCallId || (message.source as { callId?: string })?.callId
      const name = (callId && toolNames.get(callId)) || (block as ProviderToolResultBlock).name || 'tool'
      const output = resultText(block.content)
      parts.push({
        functionResponse: {
          name,
          response: block.isError ? { error: output } : { output },
          ...(callId ? { id: callId } : {})
        }
      })
    }
  }
  return parts
}

async function imagePart(ref: unknown, resolveImage?: ImageResolver): Promise<AntigravityPart | null> {
  if (!ref) return null
  if (resolveImage === undefined) return null
  try {
    const resolved = await resolveImage(ref)
    if (!resolved || !resolved.base64) return null
    return { inlineData: { mimeType: resolved.mimeType || 'image/png', data: resolved.base64 } }
  } catch {
    return null
  }
}

function parseArguments(raw: unknown): unknown {
  if (raw === undefined || raw === null || raw === '') return {}
  if (typeof raw === 'object') return raw
  try {
    const parsed = JSON.parse(raw as string)
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function resultText(content: MessageContent | null | undefined): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.map(part => part?.text || '').join('\n')
  if (content === undefined || content === null) return ''
  return JSON.stringify(content)
}

function textOf(content: MessageContent | null | undefined): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.map(part => part?.text || '').join('\n')
  return ''
}

// ---------------------------------------------------------------------------
// Stream parsing
// ---------------------------------------------------------------------------

/**
 * Translate one Antigravity SSE response into DSH `StreamChunk`s.
 *
 * @param response - the `fetch` response whose body is `text/event-stream`.
 * @param spec - the resolved catalog entry, used only for capacity defaults.
 */
export async function* parseStream(
  response: Response,
  spec: ModelSpec | null
): AsyncGenerator<StreamChunk, void, unknown> {
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let blockIndex = 0
  let active: { type: 'text' | 'reasoning'; text: string } | null = null
  let finishReason: 'stop' | 'max-tokens' = 'stop'
  let usage: TokenUsage | null = null
  let sawToolCall = false

  const endActive = (): StreamChunk | null => {
    if (active === null) return null
    // The block type is a member of the same union DSH models; the assertion
    // only narrows the `text`/`reasoning` pair this adapter actually emits.
    const block = { type: active.type, text: active.text } as ContentBlock
    const chunk: StreamChunk = { type: 'block-end', index: blockIndex++, block }
    active = null
    return chunk
  }

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })

      const lines = buffer.split('\n')
      buffer = lines.pop() || ''

      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed.startsWith('data:')) continue
        const raw = trimmed.slice(5).trim()
        if (!raw || raw === '[DONE]') continue

        let event: any
        try {
          event = JSON.parse(raw)
        } catch {
          continue
        }

        const payload = event.response ?? event
        const candidate = payload?.candidates?.[0]
        if (payload?.usageMetadata) usage = mapUsage(payload.usageMetadata)
        if (!candidate) continue

        if (candidate.finishReason === 'MAX_TOKENS') finishReason = 'max-tokens'
        else if (candidate.finishReason === 'SAFETY' || candidate.finishReason === 'RECITATION') finishReason = 'stop'

        for (const part of candidate.content?.parts || []) {
          if (part.functionCall) {
            const ended = endActive()
            if (ended) yield ended
            sawToolCall = true
            const callId = part.functionCall.id || `call_${randomUUID().slice(0, 8)}`
            const args = JSON.stringify(part.functionCall.args || {})
            yield { type: 'block-start', index: blockIndex, blockType: 'tool-call' }
            yield { type: 'tool-call-delta', index: blockIndex, id: callId, name: part.functionCall.name, argumentsDelta: args }
            yield {
              type: 'block-end',
              index: blockIndex++,
              block: { type: 'tool-call', id: callId, name: part.functionCall.name, arguments: args }
            }
            continue
          }

          const kind = part.thought === true ? 'reasoning' : part.text ? 'text' : null
          if (kind === null) continue

          if (active === null || active.type !== kind) {
            const ended = endActive()
            if (ended) yield ended
            active = { type: kind, text: '' }
            yield { type: 'block-start', index: blockIndex, blockType: kind }
          }
          active.text += part.text
          yield kind === 'reasoning'
            ? { type: 'reasoning-delta', index: blockIndex, text: part.text }
            : { type: 'text-delta', index: blockIndex, text: part.text }
        }
      }
    }
  } finally {
    reader.releaseLock()
  }

  const ended = endActive()
  if (ended) yield ended
  if (usage) yield { type: 'usage', usage }
  // 空回答必须变成**可重试的失败**，绝不许当成正常结束：一条零内容的 `stop` 会让
  // agent loop 提交一条空的 assistant 消息、把 turn 记成 `completed`，于是委派它的
  // 父会话只看到「成功但什么都没有」，而重试一次都不会跑（本路由实测：子代理空收尾、
  // `outputTokens: 0`、turn `completed`、`model-retry` 事件为零）。
  // `EMPTY_RESPONSE` 本来就在 dsh-llm 的默认可重试码里（dsh-llm/lib/index.js:232-242），
  // 消费处是 dsh-llm-retry（lib/index.js:160），所以 `providerRetryPolicy` 一行都不用动 ——
  // 这也顺便避开了那个「半条字面量掩盖真实故障」的陷阱。
  // 文案与行为与生态先例逐字一致：
  // dsh-llm-deepseek/lib/index.js:1238-1246 与 dsh-llm-pi-ai/lib/index.js:1399-1407。
  if (blockIndex === 0 && finishReason === 'stop') {
    yield {
      type: 'finish',
      reason: {
        kind: 'error',
        failure: {
          message: 'model returned a completed response with no content',
          code: EMPTY_RESPONSE_CODE
        }
      } as FinishReason
    }
    return
  }
  // A completed tool call must run even when the same turn also hit the output
  // cap, so tool-calls outranks max-tokens.
  const kind = sawToolCall ? 'tool-calls' : finishReason
  yield { type: 'finish', reason: { kind } as FinishReason }
}

/**
 * Map Gemini `usageMetadata` onto DSH's disjoint token accounting.
 *
 * Gemini folds cached prompt tokens into `promptTokenCount` and reports
 * thoughts separately, so input/output are split the way DSH expects.
 *
 * @param metadata - Gemini usage metadata.
 * @returns a `TokenUsage`.
 */
export function mapUsage(metadata: GeminiUsageMetadata): TokenUsage {
  const cached = metadata.cachedContentTokenCount || 0
  const thoughts = metadata.thoughtsTokenCount || 0
  const prompt = metadata.promptTokenCount || 0
  const candidates = metadata.candidatesTokenCount || 0
  const inputTokens = Math.max(0, prompt - cached)
  const outputTokens = candidates + thoughts
  return {
    inputTokens,
    outputTokens,
    ...(cached > 0 ? { cacheReadTokens: cached } : {}),
    ...(thoughts > 0 ? { reasoningTokens: thoughts } : {}),
    totalTokens: metadata.totalTokenCount || inputTokens + cached + outputTokens
  }
}
