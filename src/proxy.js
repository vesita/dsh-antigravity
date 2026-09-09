import http from 'node:http'
import { randomUUID } from 'node:crypto'
import { DEFAULT_ENDPOINTS } from './adapter.js'
import { MODEL_CATALOG, resolveModelSpec } from './models.js'

/**
 * Optional OpenAI-compatible loopback proxy over the same Antigravity
 * credentials as the native adapter.
 *
 * This exists for clients that speak `/v1/chat/completions` and cannot load a
 * DSH plugin (scripts, other editors). It is **opt-in**: the plugin only starts
 * it when `llm-antigravity.proxy.enabled` is true, so a normal DSH boot binds
 * no extra port.
 *
 * @module dsh-antigravity/proxy
 */

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization'
}

/**
 * Build the proxy HTTP server.
 *
 * @param options - `{ resolveModels, resolveCredentials, resolveEndpoint, resolveProjectId }`.
 * @returns a `node:http` server that is not yet listening.
 */
export function createProxyServer(options = {}) {
  const models = () => {
    const catalog = options.resolveModels?.()
    return Array.isArray(catalog) && catalog.length > 0 ? catalog : MODEL_CATALOG
  }
  const endpoints = () => {
    const configured = options.resolveEndpoint?.()
    return typeof configured === 'string' && configured.length > 0 ? [configured, ...DEFAULT_ENDPOINTS] : DEFAULT_ENDPOINTS
  }

  const server = http.createServer(async (req, res) => {
    for (const [key, value] of Object.entries(CORS_HEADERS)) res.setHeader(key, value)

    if (req.method === 'OPTIONS') {
      res.writeHead(204)
      res.end()
      return
    }

    let url
    try {
      url = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`)
    } catch {
      sendJson(res, 400, { error: { message: '无效的请求 URL' } })
      return
    }

    if (req.method === 'GET' && (url.pathname === '/v1/auth/status' || url.pathname === '/auth/status')) {
      try {
        const creds = await options.resolveCredentials?.()
        if (!creds || !creds.access) throw new Error('未登录')
        sendJson(res, 200, {
          authenticated: true,
          email: creds.email ?? null,
          projectId: creds.projectId ?? 'aicode-consumers',
          expires: creds.expires ?? null,
          timeLeftSeconds: typeof creds.expires === 'number' ? Math.max(0, Math.round((creds.expires - Date.now()) / 1000)) : null
        })
      } catch (error) {
        sendJson(res, 200, { authenticated: false, error: error.message })
      }
      return
    }

    if (req.method === 'GET' && (url.pathname === '/v1/models' || url.pathname === '/models')) {
      sendJson(res, 200, {
        object: 'list',
        data: models().map(entry => ({
          id: entry.id,
          object: 'model',
          created: 1700000000,
          owned_by: 'google-antigravity',
          permission: []
        }))
      })
      return
    }

    if (req.method === 'POST' && (url.pathname === '/v1/chat/completions' || url.pathname === '/chat/completions')) {
      let body = ''
      req.on('data', chunk => {
        body += chunk
        if (body.length > 64 * 1024 * 1024) req.destroy()
      })
      req.on('end', async () => {
        try {
          const payload = JSON.parse(body || '{}')
          await handleChatCompletions(payload, res, options, models(), endpoints())
        } catch (error) {
          sendJson(res, 500, { error: { message: error.message || String(error) } })
        }
      })
      return
    }

    sendJson(res, 404, { error: { message: '请求的接口未找到' } })
  })

  return server
}

function sendJson(res, status, payload) {
  if (res.headersSent) return
  const body = JSON.stringify(payload)
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(body)
}

async function handleChatCompletions(body, res, options, catalog, endpoints) {
  const creds = await options.resolveCredentials?.()
  if (!creds || !creds.access) throw new Error('未登录 google-antigravity，请先在 DSH 中登录')

  const spec = resolveModelSpec(body.model, catalog)
  const wireModel = spec?.wireId || body.model
  const isStream = Boolean(body.stream)

  const { contents, systemText, toolNames } = buildContents(body.messages || [])

  const request = { contents }
  if (systemText) request.systemInstruction = { parts: [{ text: systemText }] }

  if (Array.isArray(body.tools) && body.tools.length > 0) {
    request.tools = [
      {
        functionDeclarations: body.tools.map(tool => ({
          name: tool.function?.name || tool.name,
          description: tool.function?.description || tool.description || '',
          parameters: tool.function?.parameters || tool.parameters || { type: 'object', properties: {} }
        }))
      }
    ]
  }

  const generationConfig = {}
  if (spec?.reasoning !== false) generationConfig.thinkingConfig = { includeThoughts: true }
  if (body.temperature !== undefined) generationConfig.temperature = body.temperature
  if (body.max_tokens !== undefined) generationConfig.maxOutputTokens = body.max_tokens
  if (Object.keys(generationConfig).length > 0) request.generationConfig = generationConfig

  const payload = {
    project: creds.projectId || options.resolveProjectId?.() || 'aicode-consumers',
    model: wireModel,
    requestId: `agent/${randomUUID()}/${Date.now()}/${randomUUID()}/1`,
    request,
    userAgent: 'antigravity',
    requestType: 'agent'
  }

  let upstream = null
  let lastError = null
  for (const base of endpoints) {
    try {
      const response = await fetch(`${base.replace(/\/+$/, '')}/v1internal:streamGenerateContent?alt=sse`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${creds.access}`,
          'Content-Type': 'application/json',
          Accept: 'text/event-stream',
          'User-Agent': 'antigravity'
        },
        body: JSON.stringify(payload)
      })
      if (response.ok && response.body) {
        upstream = response
        break
      }
      lastError = new Error(`Antigravity 响应错误 (${response.status}): ${(await response.text()).slice(0, 500)}`)
    } catch (error) {
      lastError = error
    }
  }
  if (!upstream || !upstream.body) throw lastError || new Error('连接 Antigravity 代理失败')

  const id = `chatcmpl-${randomUUID().slice(0, 12)}`
  const created = Math.floor(Date.now() / 1000)

  if (isStream) await streamCompletion(upstream, res, { id, created, model: body.model })
  else await collectCompletion(upstream, res, { id, created, model: body.model, toolNames })
}

function buildContents(messages) {
  let systemText = ''
  const contents = []
  const toolNames = new Map()

  for (const message of messages) {
    if (message.role === 'system') {
      const text = typeof message.content === 'string' ? message.content : ''
      if (text) systemText = systemText ? `${systemText}\n\n${text}` : text
      continue
    }
    if (message.role === 'assistant' && Array.isArray(message.tool_calls)) {
      for (const call of message.tool_calls) {
        if (call.id) toolNames.set(call.id, call.function?.name)
      }
    }
  }

  const push = (role, parts) => {
    if (parts.length === 0) return
    const last = contents[contents.length - 1]
    if (last && last.role === role) last.parts.push(...parts)
    else contents.push({ role, parts })
  }

  for (const message of messages) {
    const parts = []
    if (typeof message.content === 'string') {
      if (message.content) parts.push({ text: message.content })
    } else if (Array.isArray(message.content)) {
      for (const item of message.content) {
        if (item.type === 'text' && item.text) parts.push({ text: item.text })
        else if (item.type === 'image_url' && item.image_url?.url) {
          const match = /^data:([^;]+);base64,(.+)$/.exec(item.image_url.url)
          if (match) parts.push({ inlineData: { mimeType: match[1], data: match[2] } })
        }
      }
    }

    if (message.role === 'tool' || message.role === 'function') {
      push('user', [
        {
          functionResponse: {
            name: (message.tool_call_id && toolNames.get(message.tool_call_id)) || message.name || 'tool',
            response: { output: message.content ?? '' },
            ...message.tool_call_id ? { id: message.tool_call_id } : {}
          }
        }
      ])
      continue
    }

    if (message.role === 'assistant') {
      for (const call of message.tool_calls || []) {
        parts.push({
          functionCall: { name: call.function?.name, args: safeJson(call.function?.arguments) },
          thoughtSignature: 'skip_thought_signature_validator'
        })
      }
      push('model', parts)
      continue
    }

    push('user', parts)
  }

  if (contents.length === 0) contents.push({ role: 'user', parts: [{ text: 'Hello' }] })
  return { contents, systemText, toolNames }
}

function safeJson(raw) {
  if (typeof raw !== 'string' || raw.length === 0) return {}
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

async function* sseEvents(upstream) {
  const reader = upstream.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
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
        try {
          yield JSON.parse(raw)
        } catch {
          /* malformed event is skipped */
        }
      }
    }
  } finally {
    reader.releaseLock()
  }
}

async function streamCompletion(upstream, res, meta) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive'
  })

  let finishReason = 'stop'
  let toolIndex = 0

  for await (const event of sseEvents(upstream)) {
    const payload = event.response ?? event
    const candidate = payload?.candidates?.[0]
    if (!candidate) continue
    if (candidate.finishReason === 'MAX_TOKENS') finishReason = 'length'

    for (const part of candidate.content?.parts || []) {
      if (part.functionCall) {
        finishReason = 'tool_calls'
        res.write(
          `data: ${JSON.stringify({
            id: meta.id,
            object: 'chat.completion.chunk',
            created: meta.created,
            model: meta.model,
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [
                    {
                      index: toolIndex++,
                      id: part.functionCall.id || `call_${randomUUID().slice(0, 8)}`,
                      type: 'function',
                      function: { name: part.functionCall.name, arguments: JSON.stringify(part.functionCall.args || {}) }
                    }
                  ]
                },
                finish_reason: null
              }
            ]
          })}\n\n`
        )
        continue
      }
      if (typeof part.text !== 'string' || part.text.length === 0) continue
      const delta = part.thought === true ? { reasoning_content: part.text } : { content: part.text }
      res.write(
        `data: ${JSON.stringify({
          id: meta.id,
          object: 'chat.completion.chunk',
          created: meta.created,
          model: meta.model,
          choices: [{ index: 0, delta, finish_reason: null }]
        })}\n\n`
      )
    }
  }

  res.write(
    `data: ${JSON.stringify({
      id: meta.id,
      object: 'chat.completion.chunk',
      created: meta.created,
      model: meta.model,
      choices: [{ index: 0, delta: {}, finish_reason: finishReason }]
    })}\n\n`
  )
  res.write('data: [DONE]\n\n')
  res.end()
}

async function collectCompletion(upstream, res, meta) {
  let text = ''
  let reasoning = ''
  const toolCalls = []
  let finishReason = 'stop'

  for await (const event of sseEvents(upstream)) {
    const payload = event.response ?? event
    const candidate = payload?.candidates?.[0]
    if (!candidate) continue
    if (candidate.finishReason === 'MAX_TOKENS') finishReason = 'length'
    for (const part of candidate.content?.parts || []) {
      if (part.functionCall) {
        finishReason = 'tool_calls'
        toolCalls.push({
          id: part.functionCall.id || `call_${randomUUID().slice(0, 8)}`,
          type: 'function',
          function: { name: part.functionCall.name, arguments: JSON.stringify(part.functionCall.args || {}) }
        })
      } else if (part.thought === true) {
        reasoning += part.text || ''
      } else if (typeof part.text === 'string') {
        text += part.text
      }
    }
  }

  const message = { role: 'assistant', content: text }
  if (reasoning) message.reasoning_content = reasoning
  if (toolCalls.length > 0) message.tool_calls = toolCalls

  sendJson(res, 200, {
    id: meta.id,
    object: 'chat.completion',
    created: meta.created,
    model: meta.model,
    choices: [{ index: 0, message, finish_reason: finishReason }]
  })
}
