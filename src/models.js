/**
 * Google Antigravity model catalog and request-side model resolution.
 *
 * The catalog is plain data: it is the schema default of the plugin's own
 * `llm-antigravity` settings section, so a deployment may override, extend, or
 * replace it from `~/.dsh/settings.yaml` without touching this file.
 *
 * @module dsh-antigravity/models
 */

/**
 * One catalog entry. `id` is the DSH-facing model id (what a Session selects
 * and what `settings.yaml` names); `wireId` is the Antigravity endpoint model
 * the request must carry. They differ because Antigravity exposes tiered
 * aliases (`gemini-3.8-flash-tiered`) behind friendlier selection ids.
 */
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

/** The reasoning efforts every catalog model advertises, in display order. */
export const REASONING_EFFORTS = [
  { id: 'off', name: '关闭' },
  { id: 'low', name: '低' },
  { id: 'high', name: '高' }
]

/** Accepted request modalities, mirroring `ModelModalityMap` from `@deepseek-ai/dsh-llm`. */
export const MODEL_MODALITIES = ['text', 'image']

/** Fallback capacity for a model id the catalog does not describe. */
export const DEFAULT_CONTEXT_WINDOW = 1048576
export const DEFAULT_MAX_TOKENS = 65536

/**
 * Resolve one exact model id against a catalog, with a permissive fallback so
 * an unlisted-but-accepted Antigravity alias still routes.
 *
 * @param modelId - the DSH model id (an optional `google-antigravity/` prefix is stripped).
 * @param catalog - the active catalog; defaults to {@link MODEL_CATALOG}.
 * @returns the matching entry, or a synthesized fallback carrying `modelId` as its wire id.
 */
export function resolveModelSpec(modelId, catalog = MODEL_CATALOG) {
  if (!modelId) return null
  const cleaned = String(modelId).replace(/^google-antigravity\//, '')

  const entries = Array.isArray(catalog) && catalog.length > 0 ? catalog : MODEL_CATALOG

  // 1. exact id
  let found = entries.find(m => m.id === cleaned)
  if (found) return found

  // 2. wire id (accept the endpoint spelling as a selection id too)
  found = entries.find(m => m.wireId === cleaned)
  if (found) return found

  // 3. longest-prefix fallback (e.g. a dated suffix on a known family)
  let best = null
  for (const m of entries) {
    if (!m.id || !cleaned.startsWith(m.id)) continue
    if (best === null || m.id.length > best.id.length) best = m
  }
  if (best) return best

  return {
    id: cleaned,
    wireId: cleaned,
    name: cleaned,
    description: 'Antigravity 模型',
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    maxTokens: DEFAULT_MAX_TOKENS,
    reasoning: true,
    inputModalities: ['text', 'image']
  }
}

/**
 * Normalize one catalog entry into the shape DSH model metadata expects.
 *
 * @param spec - a resolved catalog entry.
 * @param provider - the provider route key.
 * @returns detached `LlmModelInfo`-shaped metadata.
 */
export function modelInfoOf(spec, provider) {
  return {
    provider,
    id: spec.id,
    name: spec.name || spec.id,
    ...spec.description === undefined ? {} : { description: spec.description },
    inputModalities: [...(spec.inputModalities || MODEL_MODALITIES)]
  }
}
