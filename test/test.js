import assert from 'node:assert'
import { Context } from '@deepseek-ai/cordis'
import { LlmRuntime } from '@deepseek-ai/dsh-llm'
import { buildRequest, mapUsage, parseStream } from '../src/adapter.js'
import {
  CREDENTIAL_KEY,
  fromGrantRecord,
  getAuthorizationUrl,
  isExpiring,
  parseRedirectUri,
  resolveOAuthClient,
  toGrantRecord
} from '../src/auth.js'
import { MODEL_CATALOG, resolveModelSpec } from '../src/models.js'
import antigravityPlugin from '../src/index.js'

let passed = 0
async function check(label, fn) {
  await fn()
  passed += 1
  console.log(`  ok  ${label}`)
}

console.log('# 1. 模型目录与规格解析')
await check('catalog has at least 10 entries', () => assert(MODEL_CATALOG.length >= 10))
await check('exact id resolves to its wire id', () => {
  assert.strictEqual(resolveModelSpec('gemini-3.8-flash').wireId, 'gemini-3.8-flash-tiered')
})
await check('wire id resolves back to the selection id', () => {
  assert.strictEqual(resolveModelSpec('gemini-3.8-flash-tiered').id, 'gemini-3.8-flash')
})
await check('provider-qualified id resolves', () => {
  assert.strictEqual(resolveModelSpec('google-antigravity/claude-sonnet-4-6').id, 'claude-sonnet-4-6')
})
await check('unknown id falls back to itself', () => {
  const spec = resolveModelSpec('gemini-future-x')
  assert.strictEqual(spec.wireId, 'gemini-future-x')
})
await check('longest prefix wins', () => {
  assert.strictEqual(resolveModelSpec('gemini-2.5-pro-preview').id, 'gemini-2.5-pro')
})

console.log('# 2. 凭据与 OAuth 辅助函数')
await check('grant record round-trips', () => {
  const creds = { access: 'a', refresh: 'r', expires: 1 }
  assert.deepStrictEqual(fromGrantRecord(toGrantRecord(creds)), creds)
})
await check('foreign record is rejected', () => {
  assert.strictEqual(fromGrantRecord({ kind: 'api-key', key: 'x' }), null)
  assert.strictEqual(fromGrantRecord(undefined), null)
})
await check('credential key is scoped to this plugin', () => {
  assert.strictEqual(CREDENTIAL_KEY, 'dsh-antigravity/google-antigravity')
})
await check('expiry detection', () => {
  assert.strictEqual(isExpiring({ access: 'a' }), false)
  assert.strictEqual(isExpiring({ access: 'a', expires: Date.now() + 10_000 }), true)
  assert.strictEqual(isExpiring({ access: 'a', expires: Date.now() + 3_600_000 }), false)
})
await check('redirect uri parsing', () => {
  assert.deepStrictEqual(parseRedirectUri('http://127.0.0.1:51121/oauth-callback'), {
    host: '127.0.0.1',
    port: 51121,
    pathname: '/oauth-callback'
  })
})
await check('authorization url carries the configured client and state', () => {
  const url = new URL(getAuthorizationUrl({ clientId: 'cid', redirectUri: 'http://127.0.0.1:9/cb', state: 's1' }))
  assert.strictEqual(url.searchParams.get('client_id'), 'cid')
  assert.strictEqual(url.searchParams.get('state'), 's1')
  assert.strictEqual(url.searchParams.get('access_type'), 'offline')
  assert(url.searchParams.get('scope').includes('cloud-platform'))
})
await check('oauth client prefers explicit settings', () => {
  const client = resolveOAuthClient({ clientId: 'explicit-id', clientSecret: 'explicit-secret' })
  assert.strictEqual(client.clientId, 'explicit-id')
  assert.strictEqual(client.clientSecret, 'explicit-secret')
})

console.log('# 3. 请求构造')
const built = await buildRequest(
  {
    provider: 'google-antigravity',
    model: 'gemini-3.8-flash',
    system: 'be brief',
    reasoningEffort: 'low',
    maxTokens: 1234,
    messages: [
      { role: 'system', content: [{ type: 'text', text: 'extra system' }] },
      { role: 'user', content: [{ type: 'text', text: 'hello' }] },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'thinking out loud' },
          { type: 'tool-call', id: 'call_1', name: 'read', arguments: '{"path":"a"}' }
        ]
      },
      { role: 'user', content: [{ type: 'tool-result', toolCallId: 'call_1', content: [{ type: 'text', text: 'file body' }] }] }
    ],
    tools: [{ name: 'read', description: 'read a file', parameters: { type: 'object' } }]
  },
  resolveModelSpec('gemini-3.8-flash')
)
await check('system prompt merges both system messages', () => {
  assert.strictEqual(built.systemInstruction.parts[0].text, 'be brief\n\nextra system')
})
await check('roles are mapped and adjacent user turns merged', () => {
  assert.deepStrictEqual(
    built.contents.map(entry => entry.role),
    ['user', 'model', 'user']
  )
})
await check('tool call replays with a signature sentinel', () => {
  const part = built.contents[1].parts.find(entry => entry.functionCall)
  assert.strictEqual(part.functionCall.name, 'read')
  assert.deepStrictEqual(part.functionCall.args, { path: 'a' })
  assert.strictEqual(part.thoughtSignature, 'skip_thought_signature_validator')
})
await check('tool result resolves its function name from history', () => {
  const part = built.contents[2].parts.find(entry => entry.functionResponse)
  assert.strictEqual(part.functionResponse.name, 'read')
  assert.deepStrictEqual(part.functionResponse.response, { output: 'file body' })
})
await check('thinking config carries the requested level', () => {
  assert.deepStrictEqual(built.generationConfig.thinkingConfig, { includeThoughts: true, thinkingLevel: 'low' })
  assert.strictEqual(built.generationConfig.maxOutputTokens, 1234)
})
await check('tools are declared', () => {
  assert.strictEqual(built.tools[0].functionDeclarations[0].name, 'read')
})

console.log('# 4. SSE 解析与用量映射')
await check('usage is split into disjoint input/output', () => {
  const usage = mapUsage({
    promptTokenCount: 100,
    cachedContentTokenCount: 40,
    candidatesTokenCount: 30,
    thoughtsTokenCount: 10,
    totalTokenCount: 140
  })
  assert.deepStrictEqual(usage, {
    inputTokens: 60,
    outputTokens: 40,
    cacheReadTokens: 40,
    reasoningTokens: 10,
    totalTokens: 140
  })
})

const sse = [
  { response: { candidates: [{ content: { parts: [{ text: 'Hel' }] } }] } },
  { response: { candidates: [{ content: { parts: [{ thought: true, text: 'why' }] } }] } },
  { response: { candidates: [{ content: { parts: [{ text: 'lo' }, { functionCall: { name: 'read', args: { path: 'b' }, id: 'c9' } }] } }] } },
  { response: { candidates: [{ finishReason: 'MAX_TOKENS', content: { parts: [] } }], usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2 } } }
]
const body = new ReadableStream({
  start(controller) {
    const encoder = new TextEncoder()
    for (const event of sse) controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`))
    controller.close()
  }
})
const chunks = []
for await (const chunk of parseStream(new Response(body), resolveModelSpec('gemini-3.8-flash'))) chunks.push(chunk)

await check('emits alternating reasoning and text blocks', () => {
  const starts = chunks.filter(chunk => chunk.type === 'block-start').map(chunk => chunk.blockType)
  assert.deepStrictEqual(starts, ['text', 'reasoning', 'text', 'tool-call'])
})
await check('text deltas assemble in order', () => {
  const text = chunks.filter(chunk => chunk.type === 'text-delta').map(chunk => chunk.text).join('')
  assert.strictEqual(text, 'Hello')
})
await check('reasoning delta is separated from text', () => {
  const reasoning = chunks.filter(chunk => chunk.type === 'reasoning-delta').map(chunk => chunk.text).join('')
  assert.strictEqual(reasoning, 'why')
})
await check('tool call delta and block-end agree', () => {
  const delta = chunks.find(chunk => chunk.type === 'tool-call-delta')
  const end = chunks.find(chunk => chunk.type === 'block-end' && chunk.block.type === 'tool-call')
  assert.strictEqual(delta.name, 'read')
  assert.strictEqual(end.block.arguments, JSON.stringify({ path: 'b' }))
  assert.strictEqual(end.block.id, 'c9')
})
await check('finish reason reflects MAX_TOKENS and tool use', () => {
  const finish = chunks.find(chunk => chunk.type === 'finish')
  assert.strictEqual(finish.reason.kind, 'tool-calls')
})
await check('usage chunk precedes finish', () => {
  const usageIndex = chunks.findIndex(chunk => chunk.type === 'usage')
  const finishIndex = chunks.findIndex(chunk => chunk.type === 'finish')
  assert(usageIndex !== -1 && usageIndex < finishIndex)
})

console.log('# 5. Cordis 插件注册（不再污染 llm-pi-ai 命名空间）')
const ctx = new Context()
new LlmRuntime(ctx)
await ctx.plugin(antigravityPlugin)

await check('provider route is registered', () => {
  assert(ctx.llm.listProviders().map(provider => provider.id).includes('google-antigravity'))
})
await check('configurable entry belongs to llm-antigravity, not llm-pi-ai', () => {
  const entry = ctx.llm.listConfigurableProviders().find(candidate => candidate.provider === 'google-antigravity')
  assert(entry, 'directory entry must exist')
  assert.strictEqual(entry.settingsNs, 'llm-antigravity')
  assert.deepStrictEqual([...entry.settingsPath], [])
  assert.strictEqual(entry.declared, false)
})
await check('model metadata resolves through the runtime', async () => {
  const resolved = await ctx.llm.resolveModelInfo('google-antigravity', 'gemini-3.8-flash')
  assert.strictEqual(resolved.id, 'gemini-3.8-flash')
  assert.strictEqual(resolved.context.contextWindow, 1048576)
})
await check('reasoning efforts are advertised', async () => {
  const resolved = await ctx.llm.resolveModelInfo('google-antigravity', 'gemini-3.8-flash')
  assert.deepStrictEqual(
    resolved.reasoning.efforts.map(effort => effort.id),
    ['off', 'low', 'high']
  )
})
await check('text-only model omits image modality', async () => {
  const resolved = await ctx.llm.resolveModelInfo('google-antigravity', 'gpt-oss-120b')
  assert.deepStrictEqual([...resolved.inputModalities], ['text'])
})

await ctx.fiber.dispose()

console.log('# 6. 浏览器半（client bundle）结构与插槽注册')
const { readFileSync } = await import('node:fs')
const { fileURLToPath } = await import('node:url')
const { dirname, join } = await import('node:path')
const vm = await import('node:vm')

const clientSource = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'client.js'), 'utf8')
let registration = null
const sandbox = {
  window: {
    __ModuleLoader__: {
      load: entry => {
        registration = entry
      }
    }
  },
  navigator: { language: 'zh-CN' },
  require: specifier => {
    throw new Error(`unexpected top-level require: ${specifier}`)
  }
}
vm.runInNewContext(clientSource, sandbox)

await check('bundle registers under the package id', () => {
  assert(registration, 'window.__ModuleLoader__.load must be called')
  assert.strictEqual(registration.id, 'dsh-antigravity')
})

/**
 * Faithful stand-ins for the two static seeds the bundle requires. The
 * `createElement` shape matters: children are the trailing arguments, which is
 * exactly what a `jsx`/`jsxs` third argument is NOT (there it is the key).
 */
function fakeReact(initialStates = []) {
  const queue = [...initialStates]
  return {
    createElement(type, props, ...children) {
      const base = props == null ? {} : { ...props }
      if (children.length === 1) base.children = children[0]
      else if (children.length > 1) base.children = children
      return { type, props: base }
    },
    useState: value => [queue.length > 0 ? queue.shift() : value, () => {}],
    useEffect: () => {},
    useCallback: fn => fn
  }
}

const fakePrimitives = { Button: 'button' }

function requireFace(react) {
  return specifier => {
    if (specifier === 'react') return react
    if (specifier === '@deepseek-ai/dsh-client-ui-primitives') return fakePrimitives
    throw new Error(`unexpected require: ${specifier}`)
  }
}

/** Every string in a fake element tree, depth-first. */
function textOf(node, out = []) {
  if (node == null || node === false || node === true) return out
  if (typeof node === 'string' || typeof node === 'number') {
    out.push(String(node))
    return out
  }
  if (Array.isArray(node)) {
    for (const child of node) textOf(child, out)
    return out
  }
  if (typeof node === 'object' && node.props !== undefined) textOf(node.props.children, out)
  return out
}

const clientExports = registration.factory(requireFace(fakeReact()))
await check('bundle exports apply/inject', () => {
  assert.strictEqual(typeof clientExports.apply, 'function')
  assert.deepStrictEqual([...clientExports.inject], ['slots'])
})
await check('apply registers the provider-card cell for llm-antigravity', () => {
  let injectedKey = null
  let registered = null
  const fakeCtx = {
    slots: {
      inject(key, callback) {
        injectedKey = key
        callback()
      },
      register(options, component) {
        registered = { options, component }
        return () => {}
      }
    }
  }
  clientExports.apply(fakeCtx)
  assert.strictEqual(injectedKey, 'settings.models.provider-card')
  assert.strictEqual(registered.options.key, 'llm-antigravity')
  assert.strictEqual(typeof registered.component, 'function')
})
await check('card renders a visible sign-in button while signed out', () => {
  const face = registration.factory(requireFace(fakeReact()))
  const tree = face.AntigravityCard({
    provider: { provider: 'google-antigravity', settingsNs: 'llm-antigravity' }
  })
  const text = textOf(tree).join(' | ')
  assert.match(text, /未登录/, 'must state the signed-out status')
  assert.match(text, /登录 Google 账号/, 'must render the sign-in button label')
})
await check('card renders the sign-out action while signed in', () => {
  const face = registration.factory(
    requireFace(
      fakeReact([{ authenticated: true, email: 'a@b.c', projectId: 'proj', timeLeftSeconds: 600 }])
    )
  )
  const tree = face.AntigravityCard({
    provider: { provider: 'google-antigravity', settingsNs: 'llm-antigravity' }
  })
  const text = textOf(tree).join(' | ')
  assert.match(text, /已登录/)
  assert.match(text, /退出登录/)
})
await check('card ignores rows owned by another provider', () => {
  const face = registration.factory(requireFace(fakeReact()))
  assert.strictEqual(face.AntigravityCard({ provider: { provider: 'si-beat' } }), null)
})

console.log(`\n所有 dsh-antigravity 单元测试通过（${passed} 项）`)
