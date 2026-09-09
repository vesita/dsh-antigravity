import { LlmAdapter } from '@deepseek-ai/dsh-llm'
import { getValidCredentials } from './auth.js'
import { MODEL_CATALOG, resolveModelSpec } from './models.js'

const ENDPOINTS = [
  'https://daily-cloudcode-pa.googleapis.com',
  'https://daily-cloudcode-pa.sandbox.googleapis.com'
]

export class GoogleAntigravityAdapter extends LlmAdapter {
  constructor(options = {}) {
    super()
    this.options = options
  }

  providerInfo(provider) {
    return {
      id: provider,
      name: 'Google Antigravity'
    }
  }

  providerRetryPolicy(_provider) {
    return {
      mode: 'normal',
      maxRetries: 3
    }
  }

  async listModels(provider) {
    return MODEL_CATALOG.map(m => ({
      provider,
      id: m.id,
      name: m.name,
      description: m.description,
      inputModalities: m.inputModalities
    }))
  }

  async resolveModel(provider, modelId) {
    const spec = resolveModelSpec(modelId)
    return {
      provider,
      id: spec.id,
      name: spec.name,
      description: spec.description,
      context: { contextWindow: spec.contextWindow },
      defaultMaxTokens: spec.maxTokens,
      maxTokens: spec.maxTokens,
      inputModalities: spec.inputModalities,
      reasoning: spec.reasoning ? {
        efforts: [
          { id: 'off', name: '关闭' },
          { id: 'low', name: '低' },
          { id: 'high', name: '高' }
        ],
        defaultEffort: 'high'
      } : undefined
    }
  }

  async *stream(options) {
    const creds = await getValidCredentials()
    const spec = resolveModelSpec(options.model)
    const wireModel = spec ? spec.wireId : options.model

    // 1. 构建消息载荷
    let systemText = options.system || ''
    const contents = []
    const toolCallNames = new Map()
    for (const msg of options.messages || []) {
      if (msg.role === 'system') {
        const text = extractText(msg.content)
        if (text) {
          systemText = systemText ? `${systemText}\n\n${text}` : text
        }
        continue
      }

      if (msg.role === 'user') {
        const parts = []
        if (typeof msg.content === 'string') {
          parts.push({ text: msg.content })
        } else if (Array.isArray(msg.content)) {
          for (const block of msg.content) {
            if (block.type === 'text') {
              parts.push({ text: block.text })
            } else if (block.type === 'image' && block.attachment) {
              if (block.attachment.base64) {
                parts.push({
                  inlineData: {
                    mimeType: block.attachment.mimeType || 'image/png',
                    data: block.attachment.base64
                  }
                })
              }
            } else if (block.type === 'tool-result') {
              let resultStr = ''
              if (Array.isArray(block.content)) {
                resultStr = block.content.map(c => c.text || '').join('\n')
              } else if (typeof block.content === 'string') {
                resultStr = block.content
              } else {
                resultStr = JSON.stringify(block.content || {})
              }
              const callId = block.toolCallId || msg.source?.callId
              const toolName = (callId && toolCallNames.get(callId)) || block.toolName || block.id || 'tool'
              parts.push({
                functionResponse: {
                  name: toolName,
                  response: block.isError ? { error: resultStr } : { output: resultStr },
                  ...(callId ? { id: callId } : {})
                }
              })
            }
          }
        }
        if (parts.length > 0) {
          contents.push({ role: 'user', parts })
        }
      } else if (msg.role === 'assistant' || msg.role === 'model') {
        const parts = []
        if (typeof msg.content === 'string') {
          parts.push({ text: msg.content })
        } else if (Array.isArray(msg.content)) {
          for (const block of msg.content) {
            if (block.type === 'text') {
              parts.push({ text: block.text })
            } else if (block.type === 'reasoning' && block.text) {
              // 保留前序推理内容（如需要）
            } else if (block.type === 'tool-call') {
              toolCallNames.set(block.id, block.name)
              let args = {}
              try {
                args = typeof block.arguments === 'string' ? JSON.parse(block.arguments) : (block.arguments || {})
              } catch {}
              parts.push({
                functionCall: {
                  name: block.name,
                  args,
                  id: block.id
                },
                thoughtSignature: block.thoughtSignature || 'skip_thought_signature_validator'
              })
            }
          }
        }
        if (parts.length > 0) {
          contents.push({ role: 'model', parts })
        }
      }
    }

    // 确保至少包含一条内容
    if (contents.length === 0) {
      contents.push({ role: 'user', parts: [{ text: 'Hello' }] })
    }

    const request = {
      contents
    }

    if (systemText) {
      request.systemInstruction = {
        parts: [{ text: systemText }]
      }
    }

    if (options.tools && options.tools.length > 0) {
      request.tools = [{
        functionDeclarations: options.tools.map(t => ({
          name: t.name,
          description: t.description || '',
          parameters: t.parameters || { type: 'object', properties: {} }
        }))
      }]
    }

    const generationConfig = {}
    if (spec.reasoning) {
      generationConfig.thinkingConfig = {
        includeThoughts: true
      }
    }
    if (options.temperature !== undefined) {
      generationConfig.temperature = options.temperature
    }
    if (options.maxTokens !== undefined) {
      generationConfig.maxOutputTokens = options.maxTokens
    }
    if (Object.keys(generationConfig).length > 0) {
      request.generationConfig = generationConfig
    }

    const payload = {
      project: creds.projectId || 'aicode-consumers',
      model: wireModel,
      requestId: `agent/${crypto.randomUUID()}/${Date.now()}/${crypto.randomUUID()}/1`,
      request,
      userAgent: 'antigravity',
      requestType: 'agent'
    }

    // 2. 向 Antigravity 端点发起流式请求
    let response = null
    let lastError = null

    for (const base of ENDPOINTS) {
      const url = `${base}/v1internal:streamGenerateContent?alt=sse`
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${creds.access}`,
            'Content-Type': 'application/json',
            Accept: 'text/event-stream',
            'User-Agent': 'antigravity'
          },
          body: JSON.stringify(payload),
          signal: options.signal
        })

        if (res.ok) {
          response = res
          break
        }
        const errBody = await res.text()
        lastError = new Error(`Antigravity ${base} 请求错误 (${res.status}): ${errBody}`)
      } catch (err) {
        if (options.signal?.aborted) throw err
        lastError = err
      }
    }

    if (!response || !response.body) {
      throw lastError || new Error('连接任何 Google Antigravity 端点均失败')
    }

    // 3. 将 SSE 流解析为 DSH 的 StreamChunk 事件
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let blockIndex = 0
    let activeBlockType = null
    let accumulatedText = ''
    let accumulatedReasoning = ''
    let finishReasonKind = 'stop'
    let usage = null

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
          try {
            data = JSON.parse(jsonStr)
          } catch {
            continue
          }

          const resp = data.response
          if (!resp) continue

          // 处理 Token 消耗统计
          if (resp.usageMetadata) {
            const um = resp.usageMetadata
            usage = {
              inputTokens: um.promptTokenCount || 0,
              outputTokens: um.candidatesTokenCount || 0,
              totalTokens: um.totalTokenCount || 0,
              reasoningTokens: um.thoughtsTokenCount || 0
            }
          }

          const candidate = resp.candidates?.[0]
          if (!candidate) continue

          if (candidate.finishReason === 'MAX_TOKENS') {
            finishReasonKind = 'max-tokens'
          }

          const parts = candidate.content?.parts || []
          for (const part of parts) {
            if (part.thoughtSignature && !part.text && !part.functionCall) {
              continue
            }

            // 工具调用块
            if (part.functionCall) {
              finishReasonKind = 'tool-calls'
              if (activeBlockType !== null) {
                yield {
                  type: 'block-end',
                  index: blockIndex++,
                  block: {
                    type: activeBlockType,
                    text: activeBlockType === 'reasoning' ? accumulatedReasoning : accumulatedText
                  }
                }
                activeBlockType = null
              }
              const callId = part.functionCall.id || `call_${crypto.randomUUID().slice(0, 8)}`
              const name = part.functionCall.name
              const argsStr = JSON.stringify(part.functionCall.args || {})

              yield {
                type: 'block-start',
                index: blockIndex,
                blockType: 'tool-call'
              }
              yield {
                type: 'tool-call-delta',
                index: blockIndex,
                id: callId,
                name,
                argumentsDelta: argsStr
              }
              yield {
                type: 'block-end',
                index: blockIndex++,
                block: {
                  type: 'tool-call',
                  id: callId,
                  name,
                  arguments: argsStr
                }
              }
              continue
            }

            // 思考过程 (Reasoning) 块
            if (part.thought === true || (spec.reasoning && isThoughtPart(part))) {
              if (activeBlockType !== 'reasoning') {
                if (activeBlockType !== null) {
                  yield {
                    type: 'block-end',
                    index: blockIndex++,
                    block: {
                      type: activeBlockType,
                      text: accumulatedText
                    }
                  }
                }
                activeBlockType = 'reasoning'
                accumulatedReasoning = ''
                yield { type: 'block-start', index: blockIndex, blockType: 'reasoning' }
              }
              if (part.text) {
                accumulatedReasoning += part.text
                yield { type: 'reasoning-delta', index: blockIndex, text: part.text }
              }
            } else if (part.text) {
              // 常规文本 (Text) 块
              if (activeBlockType !== 'text') {
                if (activeBlockType !== null) {
                  yield {
                    type: 'block-end',
                    index: blockIndex++,
                    block: {
                      type: activeBlockType,
                      text: accumulatedReasoning
                    }
                  }
                }
                activeBlockType = 'text'
                accumulatedText = ''
                yield { type: 'block-start', index: blockIndex, blockType: 'text' }
              }
              accumulatedText += part.text
              yield { type: 'text-delta', index: blockIndex, text: part.text }
            }
          }
        }
      }
    } finally {
      reader.releaseLock()
    }

    if (activeBlockType !== null) {
      yield {
        type: 'block-end',
        index: blockIndex,
        block: {
          type: activeBlockType,
          text: activeBlockType === 'reasoning' ? accumulatedReasoning : accumulatedText
        }
      }
    }

    if (usage) {
      yield { type: 'usage', usage }
    }

    yield {
      type: 'finish',
      reason: { kind: finishReasonKind }
    }
  }
}

function extractText(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content.map(c => c.text || '').join('\n')
  }
  return ''
}

function isThoughtPart(part) {
  return Boolean(part.thoughtSignature && part.text)
}
