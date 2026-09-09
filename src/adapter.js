import { randomUUID } from 'node:crypto'
import { LlmAdapter, LlmError } from '@deepseek-ai/dsh-llm'
import { MODEL_CATALOG, REASONING_EFFORTS, modelInfoOf, resolveModelSpec } from './models.js'

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
 * @module dsh-antigravity/adapter
 */

/** Antigravity endpoints, tried in order when settings name no explicit one. */
export const DEFAULT_ENDPOINTS = [
  'https://daily-cloudcode-pa.googleapis.com',
  'https://daily-cloudcode-pa.sandbox.googleapis.com',
  'https://cloudcode-pa.googleapis.com'
]

export class GoogleAntigravityAdapter extends LlmAdapter {
  /**
   * @param options - `{ resolveModels, resolveCredentials, resolveEndpoint, resolveProjectId, resolveReasoningEffort, resolveRetryPolicy, resolveImage }`.
   */
  constructor(options = {}) {
    super()
    this.options = options
  }

  /** The active catalog, read fresh on every call so settings edits apply live. */
  #catalog() {
    const models = this.options.resolveModels?.()
    return Array.isArray(models) && models.length > 0 ? models : MODEL_CATALOG
  }

  providerInfo(provider) {
    return { id: provider, name: 'Google Antigravity' }
  }

  providerRetryPolicy() {
    return this.options.resolveRetryPolicy?.() ?? { mode: 'normal', maxRetries: 3 }
  }

  async listModels(provider) {
    return this.#catalog().map(spec => modelInfoOf(spec, provider))
  }

  async resolveModel(provider, modelId) {
    const spec = resolveModelSpec(modelId, this.#catalog())
    return {
      provider,
      id: spec.id,
      name: spec.name || spec.id,
      ...spec.description === undefined ? {} : { description: spec.description },
      context: { contextWindow: spec.contextWindow || 1048576 },
      defaultMaxTokens: spec.maxTokens || 65536,
      inputModalities: [...(spec.inputModalities || ['text'])],
      ...spec.reasoning === false
        ? {}
        : {
            reasoning: {
              efforts: REASONING_EFFORTS,
              defaultEffort: this.options.resolveReasoningEffort?.() || 'high'
            }
          }
    }
  }

  async *stream(options) {
    const catalog = this.#catalog()
    const spec = resolveModelSpec(options.model, catalog)
    const wireModel = spec?.wireId || options.model

    const creds = await this.#credentials(options.signal)
    const endpoints = this.#endpoints()
    const request = await buildRequest(options, spec, this.options.resolveImage)
    const payload = {
      project: creds.projectId || this.options.resolveProjectId?.() || 'aicode-consumers',
      model: wireModel,
      requestId: `agent/${randomUUID()}/${Date.now()}/${randomUUID()}/1`,
      request,
      userAgent: 'antigravity',
      requestType: 'agent'
    }

    const response = await this.#openStream(endpoints, creds.access, payload, options.signal)
    yield* parseStream(response, spec)
  }

  async #credentials(signal) {
    try {
      const creds = await this.options.resolveCredentials?.(signal)
      if (!creds || !creds.access) throw new Error('no credentials')
      return creds
    } catch (error) {
      throw new LlmError(
        '未找到 google-antigravity 认证凭据。请在 DSH 的「设置 → 模型 → Google Antigravity」中登录后重试。',
        'MISSING_CREDENTIAL',
        { cause: error }
      )
    }
  }

  #endpoints() {
    const configured = this.options.resolveEndpoint?.()
    if (typeof configured === 'string' && configured.length > 0) {
      return [configured, ...DEFAULT_ENDPOINTS.filter(endpoint => endpoint !== configured)]
    }
    return DEFAULT_ENDPOINTS
  }

  async #openStream(endpoints, accessToken, payload, signal) {
    let lastError = null
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
        lastError = new LlmError(`Antigravity 端点 ${base} 返回 ${res.status}: ${body.slice(0, 500)}`, httpCode(res.status))
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

function httpCode(status) {
  if (status === 401 || status === 403) return 'INVALID_CREDENTIAL'
  if (status === 429) return 'QUOTA_EXCEEDED'
  if (status >= 500) return 'TRANSPORT'
  return 'INVALID_REQUEST'
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
export async function buildRequest(options, spec, resolveImage) {
  let systemText = typeof options.system === 'string' ? options.system : ''
  const toolNames = collectToolCallNames(options.messages || [])
  const contents = []

  const push = (role, parts) => {
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

  const request = { contents }
  if (systemText) request.systemInstruction = { parts: [{ text: systemText }] }

  if (Array.isArray(options.tools) && options.tools.length > 0) {
    request.tools = [
      {
        functionDeclarations: options.tools.map(tool => ({
          name: tool.name,
          description: tool.description || '',
          parameters: tool.parameters || { type: 'object', properties: {} }
        }))
      }
    ]
  }

  const generationConfig = {}
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
function collectToolCallNames(messages) {
  const names = new Map()
  for (const message of messages) {
    if (message.role !== 'assistant' || !Array.isArray(message.content)) continue
    for (const block of message.content) {
      if (block.type === 'tool-call' && block.id) names.set(block.id, block.name)
    }
  }
  return names
}

async function assistantParts(content, resolveImage) {
  const parts = []
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
          ...block.id ? { id: block.id } : {}
        },
        // Antigravity requires a signature on replayed calls; this sentinel is
        // the documented escape hatch when the original one was not retained.
        thoughtSignature: block.thoughtSignature || 'skip_thought_signature_validator'
      })
    }
    // `reasoning` blocks are model-private; they are not replayed.
  }
  return parts
}

async function userParts(message, toolNames, resolveImage) {
  const parts = []
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
      const callId = block.toolCallId || message.source?.callId
      const name = (callId && toolNames.get(callId)) || block.name || 'tool'
      const output = resultText(block.content)
      parts.push({
        functionResponse: {
          name,
          response: block.isError ? { error: output } : { output },
          ...callId ? { id: callId } : {}
        }
      })
    }
  }
  return parts
}

async function imagePart(ref, resolveImage) {
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

function parseArguments(raw) {
  if (raw === undefined || raw === null || raw === '') return {}
  if (typeof raw === 'object') return raw
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function resultText(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.map(part => part?.text || '').join('\n')
  if (content === undefined || content === null) return ''
  return JSON.stringify(content)
}

function textOf(content) {
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
export async function* parseStream(response, spec) {
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let blockIndex = 0
  let active = null // { type: 'text'|'reasoning', text: string }
  let finishReason = 'stop'
  let usage = null
  let sawToolCall = false

  const endActive = () => {
    if (active === null) return null
    const chunk = { type: 'block-end', index: blockIndex++, block: { type: active.type, text: active.text } }
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

        let event
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
  // A completed tool call must run even when the same turn also hit the output
  // cap, so tool-calls outranks max-tokens.
  const kind = sawToolCall ? 'tool-calls' : finishReason
  yield { type: 'finish', reason: { kind } }
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
export function mapUsage(metadata) {
  const cached = metadata.cachedContentTokenCount || 0
  const thoughts = metadata.thoughtsTokenCount || 0
  const prompt = metadata.promptTokenCount || 0
  const candidates = metadata.candidatesTokenCount || 0
  const inputTokens = Math.max(0, prompt - cached)
  const outputTokens = candidates + thoughts
  return {
    inputTokens,
    outputTokens,
    ...cached > 0 ? { cacheReadTokens: cached } : {},
    ...thoughts > 0 ? { reasoningTokens: thoughts } : {},
    totalTokens: metadata.totalTokenCount || inputTokens + cached + outputTokens
  }
}
