export const MODEL_CATALOG = [
  {
    id: 'gemini-3.8-flash',
    wireId: 'gemini-3.8-flash-tiered',
    name: 'Gemini 3.8 Flash',
    description: '具备 1M 上下文的快速多模态推理模型',
    contextWindow: 1048576,
    maxTokens: 65536,
    reasoning: true,
    inputModalities: ['text', 'image']
  },
  {
    id: 'gemini-3.7-flash',
    wireId: 'gemini-3.7-flash-tiered',
    name: 'Gemini 3.7 Flash',
    description: '具备 1M 上下文的高速推理模型',
    contextWindow: 1048576,
    maxTokens: 65536,
    reasoning: true,
    inputModalities: ['text', 'image']
  },
  {
    id: 'gemini-3.6-flash',
    wireId: 'gemini-3.6-flash-tiered',
    name: 'Gemini 3.6 Flash',
    description: 'Gemini 3.6 Flash 推理模型',
    contextWindow: 1048576,
    maxTokens: 65536,
    reasoning: true,
    inputModalities: ['text', 'image']
  },
  {
    id: 'gemini-3.5-flash',
    wireId: 'gemini-3.5-flash-low',
    name: 'Gemini 3.5 Flash',
    description: '支持思考推理的 Gemini 3.5 Flash 模型',
    contextWindow: 1048576,
    maxTokens: 65536,
    reasoning: true,
    inputModalities: ['text', 'image']
  },
  {
    id: 'gemini-3.1-pro',
    wireId: 'gemini-pro-agent',
    name: 'Gemini 3.1 Pro',
    description: '高级推理与复杂问题求解模型',
    contextWindow: 1048576,
    maxTokens: 65535,
    reasoning: true,
    inputModalities: ['text', 'image']
  },
  {
    id: 'gemini-3-pro',
    wireId: 'gemini-3.1-pro-high',
    name: 'Gemini 3 Pro',
    description: '具备 1M 上下文的高性能 Pro 模型',
    contextWindow: 1048576,
    maxTokens: 65535,
    reasoning: true,
    inputModalities: ['text', 'image']
  },
  {
    id: 'gemini-2.5-flash',
    wireId: 'gemini-2.5-flash',
    name: 'Gemini 2.5 Flash',
    description: '快速基础 Gemini 模型',
    contextWindow: 1048576,
    maxTokens: 65536,
    reasoning: true,
    inputModalities: ['text', 'image']
  },
  {
    id: 'gemini-2.5-pro',
    wireId: 'gemini-2.5-pro',
    name: 'Gemini 2.5 Pro',
    description: '高智能 Gemini 2.5 Pro 模型',
    contextWindow: 1048576,
    maxTokens: 65536,
    reasoning: true,
    inputModalities: ['text', 'image']
  },
  {
    id: 'claude-sonnet-4-6',
    wireId: 'claude-sonnet-4-6',
    name: 'Claude Sonnet 4.6 (via Antigravity)',
    description: '通过 Cloud Code PA 提供的 Claude Sonnet 4.6 模型',
    contextWindow: 250000,
    maxTokens: 64000,
    reasoning: true,
    inputModalities: ['text', 'image']
  },
  {
    id: 'claude-opus-4-6-thinking',
    wireId: 'claude-opus-4-6-thinking',
    name: 'Claude Opus 4.6 (via Antigravity)',
    description: '通过 Cloud Code PA 提供的 Claude Opus 4.6 Thinking 模型',
    contextWindow: 250000,
    maxTokens: 64000,
    reasoning: true,
    inputModalities: ['text', 'image']
  },
  {
    id: 'gpt-oss-120b',
    wireId: 'gpt-oss-120b-medium',
    name: 'GPT-OSS 120B (via Antigravity)',
    description: '运行于 Antigravity 基础架构上的 120B 开源模型',
    contextWindow: 131072,
    maxTokens: 32768,
    reasoning: true,
    inputModalities: ['text']
  }
]

export function resolveModelSpec(modelId) {
  if (!modelId) return null
  const cleaned = modelId.replace(/^google-antigravity\//, '')

  // 1. 根据 id 精确匹配
  let found = MODEL_CATALOG.find(m => m.id === cleaned)
  if (found) return found

  // 2. 根据 wireId 匹配
  found = MODEL_CATALOG.find(m => m.wireId === cleaned)
  if (found) return found

  // 3. 前缀/模糊匹配回退
  for (const m of MODEL_CATALOG) {
    if (cleaned.startsWith(m.id)) return m
  }

  // 默认回退规格
  return {
    id: cleaned,
    wireId: cleaned,
    name: cleaned,
    description: 'Antigravity 模型',
    contextWindow: 1048576,
    maxTokens: 65536,
    reasoning: true,
    inputModalities: ['text', 'image']
  }
}
