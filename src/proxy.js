import http from 'node:http'
import { getValidCredentials } from './auth.js'
import { MODEL_CATALOG, resolveModelSpec } from './models.js'

const ENDPOINTS = [
  'https://daily-cloudcode-pa.googleapis.com',
  'https://daily-cloudcode-pa.sandbox.googleapis.com',
  'https://cloudcode-pa.googleapis.com'
]

export function createProxyServer() {
  const server = http.createServer(async (req, res) => {
    // CORS 跨域响应头配置
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')

    if (req.method === 'OPTIONS') {
      res.writeHead(204)
      res.end()
      return
    }

    const url = new URL(req.url, `http://${req.headers.host}`)

    // 0. GET /v1/auth/status 认证状态查询
    if (req.method === 'GET' && (url.pathname === '/v1/auth/status' || url.pathname === '/auth/status')) {
      try {
        const creds = await getValidCredentials()
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({
          authenticated: true,
          email: creds.email || null,
          projectId: creds.projectId || 'aicode-consumers',
          expires: creds.expires,
          timeLeftSeconds: Math.max(0, Math.round((creds.expires - Date.now()) / 1000))
        }))
      } catch (err) {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({
          authenticated: false,
          error: err.message
        }))
      }
      return
    }

    // 1. GET /v1/models 模型列表
    if (req.method === 'GET' && (url.pathname === '/v1/models' || url.pathname === '/models')) {
      const data = MODEL_CATALOG.map(m => ({
        id: m.id,
        object: 'model',
        created: 1700000000,
        owned_by: 'google-antigravity',
        permission: []
      }))
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ object: 'list', data }))
      return
    }

    // 2. POST /v1/chat/completions 聊天补全
    if (req.method === 'POST' && (url.pathname === '/v1/chat/completions' || url.pathname === '/chat/completions')) {
      let body = ''
      req.on('data', chunk => { body += chunk })
      req.on('end', async () => {
        try {
          const payload = JSON.parse(body)
          await handleChatCompletions(payload, res)
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: { message: err.message || String(err) } }))
        }
      })
      return
    }

    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: { message: '请求的接口未找到' } }))
  })

  return server
}

async function handleChatCompletions(body, res) {
  const creds = await getValidCredentials()
  const spec = resolveModelSpec(body.model)
  const wireModel = spec ? spec.wireId : body.model
  const isStream = Boolean(body.stream)

  // 格式化请求消息内容
  let systemText = ''
  const contents = []

  for (const msg of body.messages || []) {
    if (msg.role === 'system') {
      const text = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content)
      systemText = systemText ? `${systemText}\n\n${text}` : text
      continue
    }

    const parts = []
    if (typeof msg.content === 'string') {
      parts.push({ text: msg.content })
    } else if (Array.isArray(msg.content)) {
      for (const item of msg.content) {
        if (item.type === 'text') parts.push({ text: item.text })
        else if (item.type === 'image_url' && item.image_url?.url) {
          const match = item.image_url.url.match(/^data:([^;]+);base64,(.+)$/)
          if (match) {
            parts.push({
              inlineData: { mimeType: match[1], data: match[2] }
            })
          }
        }
      }
    }

    if (msg.role === 'tool' || msg.role === 'function') {
      parts.push({
        functionResponse: {
          name: msg.name || 'tool',
          response: { output: msg.content }
        }
      })
      contents.push({ role: 'user', parts })
    } else if (msg.role === 'assistant') {
      if (msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          parts.push({
            functionCall: {
              name: tc.function.name,
              args: JSON.parse(tc.function.arguments || '{}')
            }
          })
        }
      }
      contents.push({ role: 'model', parts })
    } else {
      contents.push({ role: 'user', parts })
    }
  }

  const request = { contents }
  if (systemText) {
    request.systemInstruction = { parts: [{ text: systemText }] }
  }

  if (body.tools && body.tools.length > 0) {
    request.tools = [{
      functionDeclarations: body.tools.map(t => ({
        name: t.function?.name || t.name,
        description: t.function?.description || t.description || '',
        parameters: t.function?.parameters || t.parameters || { type: 'object', properties: {} }
      }))
    }]
  }

  const generationConfig = {}
  if (spec.reasoning) {
    generationConfig.thinkingConfig = { includeThoughts: true }
  }
  if (body.temperature !== undefined) generationConfig.temperature = body.temperature
  if (body.max_tokens !== undefined) generationConfig.maxOutputTokens = body.max_tokens

  if (Object.keys(generationConfig).length > 0) {
    request.generationConfig = generationConfig
  }

  const antigravityPayload = {
    project: creds.projectId || 'aicode-consumers',
    model: wireModel,
    requestId: `agent/${crypto.randomUUID()}/${Date.now()}/${crypto.randomUUID()}/1`,
    request,
    userAgent: 'antigravity',
    requestType: 'agent'
  }

  let upstreamRes = null
  let lastErr = null
  for (const base of ENDPOINTS) {
    try {
      const resp = await fetch(`${base}/v1internal:streamGenerateContent?alt=sse`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${creds.access}`,
          'Content-Type': 'application/json',
          Accept: 'text/event-stream',
          'User-Agent': 'antigravity'
        },
        body: JSON.stringify(antigravityPayload)
      })
      if (resp.ok) {
        upstreamRes = resp
        break
      }
      lastErr = new Error(`Antigravity 响应错误 (${resp.status}): ${await resp.text()}`)
    } catch (e) {
      lastErr = e
    }
  }

  if (!upstreamRes || !upstreamRes.body) {
    throw lastErr || new Error('连接 Antigravity 代理失败')
  }

  const id = `chatcmpl-${crypto.randomUUID().slice(0, 12)}`
  const created = Math.floor(Date.now() / 1000)

  if (isStream) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive'
    })

    const reader = upstreamRes.body.getReader()
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
          const jsonStr = trimmed.slice(5).trim()
          if (!jsonStr || jsonStr === '[DONE]') continue

          let data
          try { data = JSON.parse(jsonStr) } catch { continue }
          const parts = data.response?.candidates?.[0]?.content?.parts || []

          for (const part of parts) {
            if (part.thoughtSignature && !part.text) continue

            const isThinking = part.thought === true || Boolean(part.thoughtSignature && part.text)
            const chunk = {
              id,
              object: 'chat.completion.chunk',
              created,
              model: body.model,
              choices: [
                {
                  index: 0,
                  delta: isThinking ? { reasoning_content: part.text } : { content: part.text },
                  finish_reason: null
                }
              ]
            }

            if (part.functionCall) {
              chunk.choices[0].delta = {
                tool_calls: [{
                  index: 0,
                  id: `call_${crypto.randomUUID().slice(0, 8)}`,
                  type: 'function',
                  function: {
                    name: part.functionCall.name,
                    arguments: JSON.stringify(part.functionCall.args || {})
                  }
                }]
              }
            }

            res.write(`data: ${JSON.stringify(chunk)}\n\n`)
          }
        }
      }
    } finally {
      reader.releaseLock()
    }

    const finalChunk = {
      id,
      object: 'chat.completion.chunk',
      created,
      model: body.model,
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }]
    }
    res.write(`data: ${JSON.stringify(finalChunk)}\n\n`)
    res.write('data: [DONE]\n\n')
    res.end()
  } else {
    // 非流式响应收集
    const reader = upstreamRes.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let fullText = ''
    let fullReasoning = ''
    const toolCalls = []

    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() || ''

      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed.startsWith('data:')) continue
        const jsonStr = trimmed.slice(5).trim()
        if (!jsonStr || jsonStr === '[DONE]') continue
        try {
          const data = JSON.parse(jsonStr)
          const parts = data.response?.candidates?.[0]?.content?.parts || []
          for (const p of parts) {
            if (p.thought || (p.thoughtSignature && p.text)) {
              fullReasoning += p.text || ''
            } else if (p.text) {
              fullText += p.text
            } else if (p.functionCall) {
              toolCalls.push({
                id: `call_${crypto.randomUUID().slice(0, 8)}`,
                type: 'function',
                function: {
                  name: p.functionCall.name,
                  arguments: JSON.stringify(p.functionCall.args || {})
                }
              })
            }
          }
        } catch {}
      }
    }

    const message = {
      role: 'assistant',
      content: fullText
    }
    if (fullReasoning) message.reasoning_content = fullReasoning
    if (toolCalls.length > 0) message.tool_calls = toolCalls

    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({
      id,
      object: 'chat.completion',
      created,
      model: body.model,
      choices: [{ index: 0, message, finish_reason: toolCalls.length > 0 ? 'tool_calls' : 'stop' }]
    }))
  }
}
