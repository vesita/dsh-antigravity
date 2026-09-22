import assert from 'node:assert'
import { Context } from '@deepseek-ai/cordis'
import { createVolatile, updateVolatile } from '@deepseek-ai/cosmokit'
import { LlmRuntime } from '@deepseek-ai/dsh-llm'
import Schema from '@deepseek-ai/schemastery'
import { GoogleAntigravityAdapter, buildRequest, mapUsage, parseQuotaResetMs, parseStream } from '../lib/adapter.js'
import {
  CREDENTIAL_KEY,
  fromGrantRecord,
  getAuthorizationUrl,
  isExpiring,
  parseRedirectUri,
  readAuthFile,
  removeAuthFile,
  resolveOAuthClient,
  toGrantRecord,
  writeAuthFile
} from '../lib/auth.js'
import { MODEL_CATALOG, resolveModelSpec } from '../lib/models.js'
import { toAntigravityToolSchema } from '../lib/tool-schema.js'
import antigravityPlugin, { Config as AntigravityConfig, version as antigravityVersion } from '../lib/index.js'

/**
 * Every test that touches credentials must stay inside a throwaway `DSH_HOME`:
 * the closed-loop section signs out, and signing out is *supposed* to delete
 * `~/.dsh/antigravity-auth.json`. Without this the suite would log the
 * developer's own Antigravity account out.
 */
const { mkdtempSync } = await import('node:fs')
const { tmpdir } = await import('node:os')
const pathJoin = (await import('node:path')).join
process.env.DSH_HOME = mkdtempSync(pathJoin(tmpdir(), 'dsh-antigravity-test-'))

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
      {
        // 0.1.7 起工具结果不再是 user 消息里的 tool-result 内容块，
        // 而是自己一条 tool 角色消息。
        role: 'tool',
        id: 'msg_tool_1',
        source: { kind: 'tool', callId: 'call_1' },
        toolCallId: 'call_1',
        content: [{ type: 'text', text: 'file body' }]
      }
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

console.log('# 3.1 Gemini 工具 schema 投影（const / $ref / examples）')
await check('const becomes a one-value enum', () => {
  assert.deepStrictEqual(toAntigravityToolSchema({ type: 'string', const: 'new' }), { type: 'string', enum: ['new'] })
})
await check('nested consts are projected wherever a schema can sit', () => {
  const projected = toAntigravityToolSchema({
    type: 'object',
    properties: {
      plugin: {
        oneOf: [
          { type: 'object', properties: { kind: { const: 'new' } } },
          { type: 'object', properties: { kind: { const: 'existing' } } }
        ]
      },
      list: { type: 'array', items: { const: 7 } }
    }
  })
  const branches = projected.properties.plugin.oneOf
  assert.deepStrictEqual(branches[0].properties.kind, { enum: ['new'] })
  assert.deepStrictEqual(branches[1].properties.kind, { enum: ['existing'] })
  assert.deepStrictEqual(projected.properties.list.items, { enum: [7] })
  assert.strictEqual(JSON.stringify(projected).includes('"const"'), false)
})
await check('a const merges into an existing enum without duplicating', () => {
  assert.deepStrictEqual(toAntigravityToolSchema({ const: 'a', enum: ['a', 'b'] }).enum, ['a', 'b'])
  assert.deepStrictEqual(toAntigravityToolSchema({ const: 'c', enum: ['a', 'b'] }).enum, ['a', 'b', 'c'])
})
await check('reference and document keywords are dropped', () => {
  const projected = toAntigravityToolSchema({
    $ref: '#/$defs/x',
    $defs: { x: { type: 'string' } },
    definitions: { y: { type: 'string' } },
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    examples: ['x'],
    type: 'object'
  })
  assert.deepStrictEqual(projected, { type: 'object' })
})
await check('accepted keywords survive unchanged', () => {
  const schema = {
    type: 'object',
    required: ['p'],
    additionalProperties: false,
    properties: {
      p: { type: 'string', pattern: '^a', format: 'date', default: 'a' },
      n: { type: 'number', minimum: 1, maximum: 9 },
      l: { type: 'array', items: { type: 'string' }, minItems: 1 },
      any: { anyOf: [{ type: 'string' }, { type: 'number' }] },
      none: { not: { type: 'string' } }
    }
  }
  assert.deepStrictEqual(toAntigravityToolSchema(schema), schema)
})
await check('a missing or unusable schema falls back to an open object', () => {
  assert.deepStrictEqual(toAntigravityToolSchema(undefined), { type: 'object', properties: {} })
  assert.deepStrictEqual(toAntigravityToolSchema('not a schema'), { type: 'object', properties: {} })
  assert.deepStrictEqual(toAntigravityToolSchema(null), { type: 'object', properties: {} })
})
await check('buildRequest ships a const-free declaration (regression: 400 Unknown name "const")', async () => {
  const request = await buildRequest(
    {
      provider: 'google-antigravity',
      model: 'gemini-3.8-flash',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      tools: [
        {
          name: 'cordis_define',
          description: 'define a package',
          parameters: {
            type: 'object',
            properties: {
              plugin: {
                oneOf: [
                  { type: 'object', additionalProperties: false, properties: { kind: { type: 'string', const: 'new' } } },
                  { type: 'object', additionalProperties: false, properties: { kind: { type: 'string', const: 'existing' } } }
                ]
              }
            }
          }
        }
      ]
    },
    resolveModelSpec('gemini-3.8-flash')
  )
  const parameters = request.tools[0].functionDeclarations[0].parameters
  assert.strictEqual(JSON.stringify(parameters).includes('"const"'), false)
  assert.deepStrictEqual(parameters.properties.plugin.oneOf[0].properties.kind.enum, ['new'])
  assert.deepStrictEqual(parameters.properties.plugin.oneOf[1].properties.kind.enum, ['existing'])
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
await check('configurable entry addresses this plugin\'s own entry id', () => {
  const entry = ctx.llm.listConfigurableProviders().find(candidate => candidate.provider === 'google-antigravity')
  assert(entry, 'directory entry must exist')
  assert.strictEqual(entry.settingsNs, 'antigravity')
  assert.deepStrictEqual([...entry.settingsPath], ['account'])
  assert.strictEqual(entry.declared, false)
})
await check('the bundled patch declares the id the settings namespace resolves to', async () => {
  // The settings service resolves an entry by `entry.options.id === ns`, so the
  // id this package's own patch inserts **is** the namespace of its Config. If
  // they drift, every settings write is refused (`No configurable plugin entry`)
  // and the provider row can never be installed — silently.
  const { readFileSync } = await import('node:fs')
  const patch = readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
  const id = /^\s*-\s*id:\s*(\S+)\s*$/m.exec(patch)?.[1]
  assert.strictEqual(id, 'antigravity', 'the patch must declare the entry id')
  const entry = ctx.llm.listConfigurableProviders().find(candidate => candidate.provider === 'google-antigravity')
  assert.strictEqual(entry.settingsNs, id, 'the directory entry must address the declared entry id')
})
await check('the account marker is volatile and starts unset, so the entry is dormant', () => {
  // Two facts the directory entry depends on:
  //  - the marker is **volatile**, because the settings service only permits
  //    writes to volatile paths (`isVolatilePath` per path), and the plugin
  //    writes it on sign-in;
  //  - it starts unset, because `configured` is
  //    `settingsPath.length === 0 || getPath(value, settingsPath) !== undefined`,
  //    which is what keeps the row out of the page until somebody signs in.
  assert.strictEqual(antigravityPlugin.Config.dict.account.meta.volatile, true)
  const unset = antigravityPlugin.Config({}).account
  assert.strictEqual(unset.get(), undefined, 'an absent marker reads as unset')
  const set = antigravityPlugin.Config({ account: 'a@b.c' }).account
  assert.strictEqual(set.get(), 'a@b.c', 'the schema must keep the marker')
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

const clientSource = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'client.js'), 'utf8')
let registration = null
/**
 * The bundle's factory closes over the sandbox realm, so its `fetch` resolves
 * to THIS object rather than the test process's global — a page-level global
 * that only exists in a browser. Stubbing it here is what lets the account
 * probe be exercised at all; `accountAnswer` is what each test varies.
 */
let accountAnswer = { authenticated: true }
const sandbox = {
  window: {
    __ModuleLoader__: {
      load: entry => {
        registration = entry
      }
    }
  },
  navigator: { language: 'zh-CN' },
  fetch: async () => ({
    ok: true,
    status: 200,
    json: async () => accountAnswer
  }),
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
 * `refs` is the identity axis a re-render shares with its mount, so a card can
 * be exercised across the render where its props change.
 */
function fakeReact(initialStates = [], refs = []) {
  const queue = [...initialStates]
  let refIndex = 0
  return {
    createElement(type, props, ...children) {
      const base = props == null ? {} : { ...props }
      if (children.length === 1) base.children = children[0]
      else if (children.length > 1) base.children = children
      return { type, props: base }
    },
    useState: value => [queue.length > 0 ? queue.shift() : value, () => {}],
    useRef: value => {
      const index = refIndex++
      refs[index] ??= { current: value }
      return refs[index]
    },
    useEffect: () => {},
    useCallback: fn => fn
  }
}

/**
 * The primitives the client half consumes. The settings-form entries are
 * stand-ins that expose the same surface the real ones do, so the config card
 * can mount and its wiring can be asserted: `SettingsFormModel` stages edits
 * and writes on save in the real one, so the fake mirrors
 * `bind`/`shell`/`field`/`actions`/`dispose` and records what was called.
 */
const fakePrimitives = {
  Button: 'button',
  SettingsForm: 'SettingsForm',
  SettingsValueField: 'SettingsValueField',
  Switch: 'Switch',
  settingsNumberField: field => ({
    field,
    format: value => (typeof value === 'number' ? String(value) : ''),
    parse: text => (String(text).trim() === '' ? { kind: 'clear' } : { kind: 'set', value: Number(text) })
  }),
  settingsTextField: field => ({
    field,
    format: value => (typeof value === 'string' ? value : ''),
    parse: text => (String(text).trim() === '' ? { kind: 'clear' } : { kind: 'set', value: String(text).trim() })
  }),
  SettingsFormModel: class {
    constructor(scope, specs) {
      this.scope = scope
      this.specs = specs
      this.disposed = false
      this.calls = []
    }
    bind(project) {
      this.projection = project
      return { getSnapshot: () => project() }
    }
    shell() {
      return { available: true, writable: true, dirty: false, invalid: false, saving: false, failed: false }
    }
    field(name) {
      return { text: '', overridden: false, invalid: false }
    }
    actions() {
      return {
        edit: (field, text) => { this.calls.push(['edit', field, text]) },
        resetField: field => { this.calls.push(['resetField', field]) },
        save: () => { this.calls.push(['save']) },
        discard: () => { this.calls.push(['discard']) }
      }
    }
    dispose() {
      this.disposed = true
    }
  }
}

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
  // `configForms` joined `slots` in 0.1.7: the Plugins page's configuration card
  // reads and writes the active profile's plugin Config through it.
  assert.deepStrictEqual([...clientExports.inject], ['slots', 'configForms'])
})
await check('apply registers the provider-card cell', () => {
  const injections = []
  const registrations = []
  const fakeCtx = {
    // No `configForms`: this case is about the provider card, and the config
    // card must simply not register when the service is absent.
    get: () => undefined,
    slots: {
      inject(key, callback) {
        injections.push(key)
        callback()
      },
      register(options, component) {
        registrations.push({ options, component })
        return () => {}
      }
    }
  }
  clientExports.apply(fakeCtx)
  assert.deepStrictEqual(injections, ['settings.models.provider-card', 'conversation.view'])
  const card = registrations.find(entry => entry.options.name === 'settings.models.provider-card')
  // The settings page dispatches this slot with `{ entryKey: row.entry.settingsNs }`,
  // and the Host half resolves that to the profile entry id (`antigravity`). A key
  // that does not match renders nothing — no account list, no sign-in button.
  assert.strictEqual(card.options.key, 'antigravity')
  assert.strictEqual(typeof card.component, 'function')
})

/**
 * The `settingsSchema` service's introspection surface, over the real
 * schemastery library: the envelope a test serves is parsed by the same library
 * the Host serializes with, so the client's schema read is exercised end to end.
 * `nodeAtPath` mirrors the service's object walk.
 */
const settingsSchemaFace = {
  rehydrate: envelope => Schema(envelope),
  nodeAtPath(root, path) {
    let node = root
    for (const key of path) {
      if (node === undefined || node.type !== 'object') return undefined
      node = node.dict?.[key]
    }
    return node
  }
}

/**
 * One describe-mirror row for this plugin's profile entry, carrying the Host
 * `Config`'s own serialized schema — exactly what the settings service serves the
 * browser, which is where the strategy dropdown reads its choices from.
 *
 * @param schema - the schema to serve; defaults to the real Host `Config`.
 * @returns the namespace row the mirror lists.
 */
function configNamespaceView(schema = AntigravityConfig) {
  return { ns: 'antigravity', schema: schema.toJSON(), value: {}, autoGenerate: false, applies: 'live' }
}

/**
 * Run `apply` with a `configForms` service standing in for the real one, so the
 * config card's registration and baked-in contract can be inspected.
 *
 * The fake records the namespace it was asked for and exposes a scope shaped
 * like the real controller's snapshot (`value` / `base` / `user`), which is what
 * `SettingsFormModel` reads. Passing `namespaceView` also stands up the shared
 * describe mirror and the `settingsSchema` service the real deployment serves
 * beside `configForms`, so a card that reads its choices out of the namespace
 * schema can be exercised.
 *
 * @param namespaceView - one describe-mirror row, or undefined for a deployment
 *   that serves no schema at all.
 */
function applyWithConfigForms(namespaceView) {
  const requested = []
  const registrations = []
  const effects = []
  const fakeCtx = {
    configForms: {
      get(ns) {
        requested.push(ns)
        return {
          getSnapshot: () => ({ status: 'ready', writable: true, value: {}, base: {}, user: {} }),
          subscribe: () => () => {},
          mutate: async () => true
        }
      },
      // The shared describe mirror every settings surface derives from.
      describe: () => ({
        getSnapshot: () => ({
          status: namespaceView === undefined ? 'idle' : 'ready',
          view:
            namespaceView === undefined
              ? undefined
              : { namespaces: [namespaceView], writable: true, hasDocument: true }
        })
      })
    },
    effect(fn) {
      effects.push(fn)
      return () => {}
    },
    // The schema service ships beside `configForms`; a deployment that omits it
    // gets no choices, which is the text-field path.
    get: name =>
      namespaceView === undefined || name !== 'settingsSchema' ? undefined : settingsSchemaFace,
    slots: {
      inject(key, callback) {
        callback()
      },
      register(options, component) {
        registrations.push({ options, component })
        return () => {}
      }
    }
  }
  clientExports.apply(fakeCtx)
  return { requested, registrations, effects }
}

await check('config card addresses the profile entry id, not the provider namespace', () => {
  const { requested } = applyWithConfigForms()
  // The Plugins page keys a package's form by the entry's own id; the
  // `llm-antigravity` namespace is the provider row in Settings → Models.
  assert.deepStrictEqual(requested, ['antigravity'])
})

await check('config card registers under the bundle package name', () => {
  const { registrations } = applyWithConfigForms()
  const entry = registrations.find(r => r.options.name === 'plugins.bundle.config')
  assert.ok(entry, 'plugins.bundle.config was not registered')
  // The page looks the card up by the bundle's package name.
  assert.strictEqual(entry.options.key, 'dsh-antigravity')
  assert.strictEqual(typeof entry.component, 'function')
})

await check('config card injects the form actions the official form needs', () => {
  const { registrations } = applyWithConfigForms()
  const entry = registrations.find(r => r.options.name === 'plugins.bundle.config')
  const injected = entry.options.inject()
  // `SettingsForm` is driven entirely by these four; a card that omits them
  // renders a save bar that does nothing.
  for (const action of ['edit', 'resetField', 'save', 'discard']) {
    assert.strictEqual(typeof injected[action], 'function', `missing action ${action}`)
  }
  assert.ok(injected.hooks && injected.hooks.antigravityConfig, 'missing bound form hook')
})

await check('config card exposes only flat scalar fields', () => {
  const { registrations } = applyWithConfigForms()
  const entry = registrations.find(r => r.options.name === 'plugins.bundle.config')
  const injected = entry.options.inject()
  const snapshot = injected.hooks.antigravityConfig.getSnapshot()
  // A nested name (`proxy.enabled`) addresses a literal top-level key, so every
  // field must be a flat scalar the Host schema declares.
  assert.deepStrictEqual(
    Object.keys(snapshot).filter(k => k !== 'shell').sort(),
    ['accountStrategy', 'proxyEnabled', 'proxyHost', 'proxyPort', 'reasoningEffort', 'usageEnabled', 'usageRetentionDays']
  )
  for (const key of Object.keys(snapshot)) {
    assert.ok(!key.includes('.'), `field ${key} is dotted and cannot be resolved by the form`)
  }
})

await check('config card fields all exist in the Host schema', async () => {
  const { registrations } = applyWithConfigForms()
  const entry = registrations.find(r => r.options.name === 'plugins.bundle.config')
  const snapshot = entry.options.inject().hooks.antigravityConfig.getSnapshot()
  const host = await import('../lib/index.js')
  const dict = host.Config.dict
  for (const key of Object.keys(snapshot)) {
    if (key === 'shell') continue
    assert.ok(dict[key] !== undefined, `field ${key} is not declared by the Host Config`)
    assert.strictEqual(dict[key].meta?.volatile, true, `field ${key} is not volatile, so no form is rendered`)
  }
})

/** Depth-first search for the first element created from `type`. */
function findByType(node, type) {
  if (node == null || typeof node !== 'object') return null
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = findByType(child, type)
      if (hit) return hit
    }
    return null
  }
  if (node.type === type) return node
  return findByType(node.props && node.props.children, type)
}

await check('插件页配置卡自带账号与登录界面', () => {
  const { registrations } = applyWithConfigForms()
  const entry = registrations.find(r => r.options.name === 'plugins.bundle.config')
  // The card stacks the account manager over the settings form; rendering the
  // element is enough to assert the wiring, because the manager is the same
  // component the provider card mounts.
  const tree = entry.component({
    useAntigravityConfig: () => ({
      shell: { available: true, writable: true, dirty: false, invalid: false, saving: false, failed: false }
    }),
    edit: () => {},
    resetField: () => {},
    save: () => {},
    discard: () => {}
  })
  assert.ok(
    findByType(tree, clientExports.AntigravityCard),
    '插件页的配置卡必须自己带上账号/登录界面，而不是只在「设置 → 模型」里'
  )
})

/** One field state as the store projects it. */
const fieldState = (text, overridden = false, invalid = false) => ({ text, overridden, invalid })

/** The state a fresh install projects: Host defaults, nothing overridden. */
function freshConfigState() {
  return {
    shell: { available: true, writable: true, dirty: false, invalid: false, saving: false, failed: false },
    accountStrategy: fieldState('round-robin'),
    reasoningEffort: fieldState(''),
    proxyEnabled: fieldState('off'),
    proxyHost: fieldState(''),
    proxyPort: fieldState(''),
    usageEnabled: fieldState('on'),
    usageRetentionDays: fieldState('')
  }
}

/** The card's props: the store hook over `state`, plus the injected actions. */
function configCardProps(state, actions = {}) {
  return Object.assign(
    {
      useAntigravityConfig: selector => selector(state),
      edit: () => {},
      resetField: () => {},
      save: () => {},
      discard: () => {}
    },
    actions
  )
}

/** Every node created from `type` in a fake element tree, depth-first. */
function collectByType(node, type, out = []) {
  if (node == null || typeof node !== 'object') return out
  if (Array.isArray(node)) {
    for (const child of node) collectByType(child, type, out)
    return out
  }
  if (node.type === type) out.push(node)
  collectByType(node.props && node.props.children, type, out)
  return out
}

/** The config card's rendered tree for one describe-mirror row. */
function renderConfigCard(namespaceView, state = freshConfigState(), actions = {}) {
  const { registrations } = applyWithConfigForms(namespaceView)
  const entry = registrations.find(r => r.options.name === 'plugins.bundle.config')
  return entry.component(configCardProps(state, actions))
}

console.log('# 6.1 插件页配置卡：控件按字段类型选（策略=下拉框，布尔=开关）')

await check('账号池策略渲染成下拉框，选项就是 Host Config 自己声明的 union', () => {
  const select = findByType(renderConfigCard(configNamespaceView()), 'select')
  assert.ok(select, '账号池策略必须是下拉框：手输 round-robin 是这次要改掉的形状')
  assert.strictEqual(select.props.id, 'accountStrategy')
  // The options are read out of the namespace schema the settings service serves
  // for this entry, so the Host `Config`'s union stays the one declaration.
  const union = Schema(AntigravityConfig.toJSON()).dict.accountStrategy
  assert.deepStrictEqual(
    select.props.children.map(option => option.props.value),
    union.list.map(member => member.value)
  )
  // And the Host declares exactly these two today, so the control shows both.
  assert.deepStrictEqual(
    select.props.children.map(option => option.props.value),
    ['round-robin', 'active-first']
  )
})

await check('下拉框的选项跟着 schema 走，不是客户端写死的两个', () => {
  const synthetic = Schema.object({
    accountStrategy: Schema.union(['round-robin', 'active-first', 'least-used']).default('round-robin')
  })
  const select = findByType(renderConfigCard(configNamespaceView(synthetic)), 'select')
  assert.deepStrictEqual(
    select.props.children.map(option => option.props.value),
    ['round-robin', 'active-first', 'least-used'],
    'schema 里多一个值，下拉框就多一个选项'
  )
})

await check('控件按 schema 分工：策略是下拉框、两个布尔是开关、其余是文本框', () => {
  const tree = renderConfigCard(configNamespaceView())
  assert.strictEqual(collectByType(tree, 'select').length, 1, '只有账号池策略该变成下拉框')
  assert.strictEqual(collectByType(tree, 'Switch').length, 2, 'proxyEnabled 与 usageEnabled 该是两个开关')
  assert.strictEqual(
    collectByType(tree, 'SettingsValueField').length,
    4,
    '其余四个字段仍走官方 SettingsValueField'
  )
})

/** `collectByType` 之外：按渲染顺序抽出「标题」——官方字段的 label、组标题、可见文本。 */
function titleOrder(node, out = []) {
  if (node == null || typeof node !== 'object') return out
  if (Array.isArray(node)) {
    for (const child of node) titleOrder(child, out)
    return out
  }
  if (typeof node.props.label === 'string') out.push(node.props.label)
  else if (typeof node.props.children === 'string') out.push(node.props.children)
  titleOrder(node.props.children, out)
  return out
}

await check('设置项按功能分三组，顺序与父子相邻', () => {
  const tree = renderConfigCard(configNamespaceView())
  // The walk is depth-first, so the sequence is the render order — which is what
  // the grouping promises: each switch sits with the fields it governs, and the
  // groups run in the order a user meets them.
  const titles = titleOrder(tree)
  const order = [
    '账号与请求', '账号池策略', '思考强度',
    '兼容代理', '启用兼容代理', '代理监听地址', '代理端口',
    '用量统计', '启用用量统计', '用量保留天数'
  ]
  let at = -1
  for (const item of order) {
    const next = titles.indexOf(item, at + 1)
    assert.ok(next > at, `「${item}」不在预期位置：${JSON.stringify(titles)}`)
    at = next
  }
})

await check('布尔开关的初值来自生效中的值，切换即暂存 on/off', () => {
  const calls = []
  const state = freshConfigState()
  state.proxyEnabled = fieldState('off')
  state.usageEnabled = fieldState('on')
  const tree = renderConfigCard(configNamespaceView(), state, {
    edit: (field, text) => calls.push(['edit', field, text])
  })
  const switches = collectByType(tree, 'Switch')
  assert.deepStrictEqual(
    Object.fromEntries(switches.map(node => [node.props.label, node.props.checked])),
    { '启用兼容代理': false, '启用用量统计': true }
  )
  switches.find(node => node.props.label === '启用兼容代理').props.onChange(true)
  assert.deepStrictEqual(calls, [['edit', 'proxyEnabled', 'on']], '开关只暂存，不直接写 Host')
})

await check('只读或保存中的文档里，三种控件都被禁用', () => {
  const readonly = freshConfigState()
  readonly.shell = Object.assign({}, readonly.shell, { writable: false })
  const tree = renderConfigCard(configNamespaceView(), readonly)
  assert.strictEqual(findByType(tree, 'select').props.disabled, true, '只读时下拉框不可选')
  for (const node of collectByType(tree, 'Switch')) {
    assert.strictEqual(node.props.disabled, true, '只读时开关不可拨')
  }
  for (const node of collectByType(tree, 'SettingsValueField')) {
    assert.strictEqual(node.props.disabled, true, '只读时文本框与它的重置不可用')
  }

  const saving = freshConfigState()
  saving.shell = Object.assign({}, saving.shell, { saving: true })
  for (const node of collectByType(renderConfigCard(configNamespaceView(), saving), 'Switch')) {
    assert.strictEqual(node.props.disabled, true, '保存中不许再拨开关')
  }
})

await check('下拉框选中即暂存编辑，覆盖态给重置', () => {
  const calls = []
  const state = freshConfigState()
  state.accountStrategy = fieldState('active-first', true)
  state.shell = Object.assign({}, state.shell, { dirty: true })
  const tree = renderConfigCard(configNamespaceView(), state, {
    edit: (field, text) => calls.push(['edit', field, text]),
    resetField: field => calls.push(['resetField', field])
  })
  const select = findByType(tree, 'select')
  assert.strictEqual(select.props.value, 'active-first', '暂存的草稿就是被选中的那一项')
  select.props.onChange({ target: { value: 'round-robin' } })
  assert.deepStrictEqual(calls, [['edit', 'accountStrategy', 'round-robin']], '选中只暂存，不直接写 Host')
  const reset = collectByType(tree, 'button').find(button => button.props.children === '重置')
  assert.ok(reset, '有覆盖时必须给一个重置')
  reset.props.onClick()
  assert.deepStrictEqual(calls[1], ['resetField', 'accountStrategy'])
})

await check('没有 schema 服务时回落到官方文本框，而不是渲染空下拉框', () => {
  const tree = renderConfigCard(undefined)
  assert.strictEqual(findByType(tree, 'select'), null, '没有 schema 就没有选项可列')
  assert.strictEqual(collectByType(tree, 'SettingsValueField').length, 7, '回落路径仍是官方控件')
  assert.strictEqual(collectByType(tree, 'Switch').length, 0, '没有 schema 就不冒充布尔开关')
})

await check('插件页里那份账号卡渲染登录按钮', () => {
  const face = registration.factory(requireFace(fakeReact()))
  // No `provider` prop: the Plugins page dispatches this cell with none, and
  // the manager must not drop itself for lack of one.
  const text = textOf(face.AntigravityCard({})).join(' | ')
  assert.match(text, /未登录/, 'must state the signed-out status')
  assert.match(text, /登录 Google 账号/, 'must render the sign-in button label')
})

/** Run `apply` against a stubbed host answer for the account probe. */
async function applyWithAccount(authenticated) {
  const registrations = []
  const fakeCtx = {
    slots: {
      inject(key, callback) {
        callback()
      },
      register(options, component) {
        registrations.push({ options, component })
        return () => {}
      }
    }
  }
  accountAnswer = { authenticated }
  clientExports.apply(fakeCtx)
  // The registration is a promise away: the probe is what decides.
  await new Promise(resolve => setTimeout(resolve, 20))
  return registrations
}

await check('没有账户时不注册用量 tab', async () => {
  const registrations = await applyWithAccount(false)
  assert.strictEqual(
    registrations.find(entry => entry.options.name === 'conversation.view'),
    undefined,
    'an account-less install must not show the usage tab'
  )
})

await check('有账户时注册用量 tab', async () => {
  const registrations = await applyWithAccount(true)
  const usage = registrations.find(entry => entry.options.name === 'conversation.view')
  assert.ok(usage, 'an installed account must show the usage tab')
  assert.strictEqual(usage.options.id, 'antigravity-usage')
  assert.strictEqual(usage.options.order, 20)
  assert.strictEqual(typeof usage.options.label, 'function')
  assert.strictEqual(typeof usage.component, 'function')
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
      fakeReact([
        {
          authenticated: true,
          activeAccountId: 'a1',
          accounts: [{ id: 'a1', email: 'a@b.c', projectId: 'proj', timeLeftSeconds: 600, active: true }]
        }
      ])
    )
  )
  const tree = face.AntigravityCard({
    provider: { provider: 'google-antigravity', settingsNs: 'llm-antigravity' }
  })
  const text = textOf(tree).join(' | ')
  assert.match(text, /已登录/)
  assert.match(text, /退出登录/)
})
await check('card lists every account with its own health and default badge', () => {
  const face = registration.factory(
    requireFace(
      fakeReact([
        {
          authenticated: true,
          strategy: 'round-robin',
          activeAccountId: 'a1',
          accounts: [
            { id: 'a1', email: 'a@b.c', projectId: 'proj-1', timeLeftSeconds: 600, active: true },
            { id: 'a2', email: 'd@e.f', projectId: 'proj-2', cooling: true, cooldownSeconds: 1800, active: false }
          ]
        }
      ])
    )
  )
  const text = textOf(face.AntigravityCard({ provider: { provider: 'google-antigravity' } })).join(' | ')
  assert.match(text, /2 个账号/, 'the heading must count the pool')
  assert.match(text, /a@b\.c/, 'every account must be named')
  assert.match(text, /d@e\.f/)
  assert.match(text, /默认/, 'the active account must be marked')
  assert.match(text, /设为默认/, 'the other account must be selectable')
  assert.match(text, /配额冷却中/, 'a parked account must say so')
  assert.match(text, /轮询使用/, 'the strategy must be visible')
})
await check('card offers adding another account once one is installed', () => {
  const face = registration.factory(
    requireFace(
      fakeReact([{ authenticated: true, activeAccountId: 'a1', accounts: [{ id: 'a1', email: 'a@b.c', active: true }] }])
    )
  )
  const text = textOf(face.AntigravityCard({ provider: { provider: 'google-antigravity' } })).join(' | ')
  assert.match(text, /添加账号/, 'an installed provider grows by adding, not by signing in again')
  assert.match(text, /退出登录/)
})
await check('card ignores rows owned by another provider', () => {
  const face = registration.factory(requireFace(fakeReact()))
  assert.strictEqual(face.AntigravityCard({ provider: { provider: 'si-beat' } }), null)
})
await check('card says why an attempt ended without a grant', () => {
  const face = registration.factory(
    requireFace(fakeReact([{ authenticated: false, pending: false, error: '登录已取消' }]))
  )
  const text = textOf(face.AntigravityCard({ provider: { provider: 'google-antigravity' } })).join(' | ')
  assert.match(text, /登录已取消/)
})
await check('the draft copy renders while the provider still has no row', () => {
  const face = registration.factory(
    requireFace(fakeReact([{ authenticated: true, accounts: [{ id: 'a1', email: 'a@b.c', active: true }] }], []))
  )
  const text = textOf(
    face.AntigravityCard({
      provider: { provider: 'google-antigravity', settingsNs: 'llm-antigravity' },
      configured: false
    })
  ).join(' | ')
  assert.match(text, /已登录/, 'the dormant entry still needs its card')
})
await check('the draft copy drops out once the marker installs the saved row', () => {
  // Same instance across both renders: it mounted from the dormant row, then
  // the sign-in wrote `llm-antigravity.account` and the row appeared.
  const refs = []
  const signedIn = [{ authenticated: true, accounts: [{ id: 'a1', email: 'a@b.c', active: true }] }]
  const mounted = registration.factory(requireFace(fakeReact(signedIn, refs)))
  const dormant = { provider: { provider: 'google-antigravity', settingsNs: 'llm-antigravity' }, configured: false }
  assert.notStrictEqual(mounted.AntigravityCard(dormant), null)
  const rerendered = registration.factory(requireFace(fakeReact(signedIn, refs)))
  assert.strictEqual(
    rerendered.AntigravityCard({ ...dormant, configured: true }),
    null,
    'the draft must not keep a card the saved row already renders'
  )
})
await check('the saved row copy keeps its card once configured', () => {
  const face = registration.factory(
    requireFace(
      fakeReact([
        {
          authenticated: true,
          accounts: [{ id: 'a1', email: 'a@b.c', projectId: 'proj', timeLeftSeconds: 600, active: true }]
        }
      ])
    )
  )
  const text = textOf(
    face.AntigravityCard({
      provider: { provider: 'google-antigravity', settingsNs: 'llm-antigravity' },
      configured: true
    })
  ).join(' | ')
  assert.match(text, /已登录/)
  assert.match(text, /退出登录/)
})
await check('card states an expired session once instead of echoing the host error', () => {
  const face = registration.factory(
    requireFace(fakeReact([{ authenticated: false, pending: false, expired: true, error: '令牌已过期' }]))
  )
  const text = textOf(face.AntigravityCard({ provider: { provider: 'google-antigravity' } })).join(' | ')
  assert.match(text, /登录已过期/)
  assert.doesNotMatch(text, /令牌已过期/)
})
await check('card does not claim a live session while every account is expired', () => {
  // 红灯配「已登录」是这张卡最容易骗人的组合：列表非空不代表还能用。
  const face = registration.factory(
    requireFace(
      fakeReact([
        {
          authenticated: false,
          pending: false,
          expired: true,
          error: '刷新失败',
          accounts: [{ id: 'a1', email: 'a@b.c', active: true, expired: true }]
        }
      ])
    )
  )
  const text = textOf(face.AntigravityCard({ provider: { provider: 'google-antigravity' } })).join(' | ')
  assert.match(text, /登录已过期/, '全部过期时必须说的是过期')
  assert.doesNotMatch(text, /已登录/, '不得同时宣称已登录')
})
await check('card names the environment account when the registry is empty', () => {
  // GOOGLE_ANTIGRAVITY_TOKEN 供的凭据不进注册表：此时 status 是 authenticated 但
  // accounts 为空，卡片不能因此显示「未登录」。
  const face = registration.factory(
    requireFace(
      fakeReact([
        {
          authenticated: true,
          pending: false,
          email: 'env@x.y',
          projectId: 'proj',
          timeLeftSeconds: 600,
          accounts: []
        }
      ])
    )
  )
  const text = textOf(face.AntigravityCard({ provider: { provider: 'google-antigravity' } })).join(' | ')
  assert.match(text, /已登录/, '绿灯不能说未登录')
  assert.match(text, /env@x\.y/, '必须指出这个凭据对应哪个账号')
  assert.match(text, /proj/)
})

// ---------------------------------------------------------------------------
// The closed loop: no account -> add -> sign in -> remove.
// ---------------------------------------------------------------------------

/** An ephemeral loopback port the OAuth redirect can be pointed at. */
async function freePort() {
  const net = await import('node:net')
  return new Promise((resolve, reject) => {
    const probe = net.createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address()
      probe.close(() => resolve(port))
    })
  })
}

/** Let the mount's deferred `inject` callbacks run. */
async function settle() {
  for (let round = 0; round < 4; round += 1) await new Promise(resolve => setTimeout(resolve, 5))
}

console.log('# 7. 登录闭环的状态迁移与中止路径')
const { LoginManager } = await import('../lib/auth-flow.js')

const loopbackPort = await freePort()
const redirectUri = `http://127.0.0.1:${loopbackPort}/oauth-callback`
const manager = new LoginManager({ redirectUri, timeoutMs: 60_000 })

await check('loop starts from "no account, no attempt"', () => {
  const state = manager.status()
  assert.strictEqual(state.pending, false)
  assert.strictEqual(state.url, null)
  assert.strictEqual(state.error, null)
})
const consentUrl = await manager.begin()
await check('adding an account hands back a Google consent URL for this redirect', () => {
  const url = new URL(consentUrl)
  assert.strictEqual(url.host, 'accounts.google.com')
  assert.strictEqual(url.searchParams.get('redirect_uri'), redirectUri)
  assert(url.searchParams.get('scope').includes('/auth/cloud-platform'))
  assert(url.searchParams.get('state').length >= 16)
})
await check('the attempt is pending and a second begin() joins it', async () => {
  assert.strictEqual(manager.status().pending, true)
  assert.strictEqual(await manager.begin(), consentUrl)
})
await check('a stray path on the loopback listener does not settle the attempt', async () => {
  const response = await fetch(`http://127.0.0.1:${loopbackPort}/somewhere-else`)
  assert.strictEqual(response.status, 404)
  assert.strictEqual(manager.status().pending, true)
})
await check('a forged state is refused without cancelling the real attempt', async () => {
  const response = await fetch(`http://127.0.0.1:${loopbackPort}/oauth-callback?code=forged&state=deadbeef`)
  assert.strictEqual(response.status, 400)
  assert.strictEqual(manager.status().pending, true, 'a stray callback must not cancel the sign-in')
})
await check('a denial carrying the right state ends the attempt and reports why', async () => {
  const state = new URL(manager.status().url).searchParams.get('state')
  const awaited = manager.completion()
  const response = await fetch(`http://127.0.0.1:${loopbackPort}/oauth-callback?error=access_denied&state=${state}`)
  assert.strictEqual(response.status, 400)
  await assert.rejects(awaited, /access_denied/)
  assert.strictEqual(manager.status().pending, false)
  assert.match(manager.status().error, /access_denied/)
})
await check('cancel() ends the attempt and records the reason', async () => {
  await manager.begin()
  const awaited = manager.completion()
  manager.cancel()
  await assert.rejects(awaited, /取消/)
  assert.strictEqual(manager.status().pending, false)
  assert.match(manager.status().error, /取消/)
})
await check('a cancelled attempt can be started again', async () => {
  const restarted = await manager.begin()
  assert.notStrictEqual(restarted, consentUrl)
  assert.strictEqual(manager.status().pending, true)
  assert.strictEqual(manager.status().error, null)
  manager.dispose()
  assert.strictEqual(manager.status().pending, false)
})
await check('an abandoned attempt times out and records the reason', async () => {
  const port = await freePort()
  const shortLived = new LoginManager({ redirectUri: `http://127.0.0.1:${port}/oauth-callback`, timeoutMs: 40 })
  await shortLived.begin()
  const awaited = shortLived.completion()
  await assert.rejects(awaited, /超时/)
  assert.strictEqual(shortLived.status().pending, false)
  assert.match(shortLived.status().error, /超时/)
  shortLived.dispose()
})

console.log('# 8. 宿主路由闭环（/status → /login → /cancel → /logout）')
const routes = new Map()
const registeredPaths = []
const fakeWebServer = {
  register(options) {
    routes.set(options.path, options)
    registeredPaths.push(options.path)
    return () => {
      routes.delete(options.path)
    }
  }
}
const loopCtx = new Context()
new LlmRuntime(loopCtx)
loopCtx.provide('webServer', fakeWebServer)
const hostPort = await freePort()
const hostRedirect = `http://127.0.0.1:${hostPort}/oauth-callback`
await loopCtx.plugin(antigravityPlugin, { redirectUri: hostRedirect })
await settle()

function fakeRes() {
  return {
    statusCode: 200,
    headers: {},
    body: '',
    headersSent: false,
    setHeader(name, value) {
      this.headers[name] = value
    },
    writeHead(statusCode, headers) {
      this.statusCode = statusCode
      this.headersSent = true
      Object.assign(this.headers, headers)
    },
    end(body) {
      this.body = body ?? ''
    }
  }
}

/**
 * Invoke a registered route handler the way the web server would. A `body`
 * option is serialized and offered as an async-iterable request stream, which
 * is what the host's JSON reader consumes.
 */
async function request(method, path, options = {}) {
  const route = routes.get(path)
  assert(route, `${path} must be registered`)
  const res = fakeRes()
  const encoded = options.body === undefined ? '' : JSON.stringify(options.body)
  const chunks = encoded === '' ? [] : [Buffer.from(encoded, 'utf8')]
  const req = {
    method,
    url: path,
    headers: {},
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk
    }
  }
  await route.handler(req, res)
  return { status: res.statusCode, headers: res.headers, body: res.body ? JSON.parse(res.body) : null }
}

const STATUS = '/dsh-antigravity/auth/status'
const LOGIN = '/dsh-antigravity/auth/login'
const CANCEL = '/dsh-antigravity/auth/cancel'
const LOGOUT = '/dsh-antigravity/auth/logout'
const ACCOUNTS = '/dsh-antigravity/auth/accounts'
const ACCOUNTS_ACTIVE = '/dsh-antigravity/auth/accounts/active'
const ACCOUNTS_CLEAR = '/dsh-antigravity/auth/accounts/clear-cooldown'
const ACCOUNTS_REMOVE = '/dsh-antigravity/auth/accounts/remove'

await check('the host registers exactly the routes the card calls', () => {
  const authPaths = [...registeredPaths].filter(entry => entry.startsWith('/dsh-antigravity/auth')).sort()
  assert.deepStrictEqual(authPaths, [ACCOUNTS, ACCOUNTS_ACTIVE, ACCOUNTS_CLEAR, ACCOUNTS_REMOVE, CANCEL, LOGIN, LOGOUT, STATUS])
  const usagePaths = [...registeredPaths].filter(entry => entry.startsWith('/dsh-antigravity/usage')).sort()
  assert.deepStrictEqual(usagePaths, [
    '/dsh-antigravity/usage/backfill',
    '/dsh-antigravity/usage/clear',
    '/dsh-antigravity/usage/overview',
    '/dsh-antigravity/usage/requests',
    '/dsh-antigravity/usage/status'
  ])
})
await check('no account: /status reports the signed-out posture', async () => {
  const { status, body } = await request('GET', STATUS)
  assert.strictEqual(status, 200)
  assert.strictEqual(body.authenticated, false)
  assert.strictEqual(body.expired, false)
  assert.strictEqual(body.pending, false)
})
await check('add: /login opens an attempt and returns the consent URL', async () => {
  const { status, body } = await request('POST', LOGIN)
  assert.strictEqual(status, 200)
  assert.strictEqual(body.pending, true)
  assert.strictEqual(new URL(body.url).searchParams.get('redirect_uri'), hostRedirect)
})
await check('waiting: /status reports the attempt the browser must finish', async () => {
  const { body } = await request('GET', STATUS)
  assert.strictEqual(body.pending, true)
  assert.strictEqual(body.authenticated, false)
})
await check('a wrong method is refused with Allow', async () => {
  const { status, headers, body } = await request('POST', STATUS)
  assert.strictEqual(status, 405)
  assert.strictEqual(headers.Allow, 'GET')
  assert.match(body.error, /GET/)
})
await check('cancel: /cancel ends the attempt and the card learns why', async () => {
  const { status, body } = await request('POST', CANCEL)
  assert.strictEqual(status, 200)
  assert.strictEqual(body.pending, false)
  const after = await request('GET', STATUS)
  assert.strictEqual(after.body.pending, false)
  assert.match(after.body.error, /取消/)
})
await check('an existing account is reported as signed in', async () => {
  writeAuthFile({ access: 'seeded-access', projectId: 'aicode-consumers', expires: Date.now() + 3_600_000 })
  const { body } = await request('GET', STATUS)
  assert.strictEqual(body.authenticated, true)
  assert.strictEqual(body.projectId, 'aicode-consumers')
})
await check('remove: /logout clears the account and closes the loop', async () => {
  const { status, body } = await request('POST', LOGOUT)
  assert.strictEqual(status, 200)
  assert.strictEqual(body.authenticated, false)
  assert.strictEqual(readAuthFile(), null, 'the credential mirror must be gone')
  const after = await request('GET', STATUS)
  assert.strictEqual(after.body.authenticated, false)
  assert.strictEqual(after.body.expired, false)
})

// ---------------------------------------------------------------------------
// 多账号路由：列表 / 切换默认 / 逐个移除。两条账号直接写进注册表，因为这一段要考的
// 是路由本身，签发流程已由第 7 节覆盖。
// ---------------------------------------------------------------------------
const { writeAccountRegistry, accountsFilePath } = await import('../lib/accounts.js')

const seededAccount = (id, email, projectId) => ({
  id,
  label: email,
  email,
  projectId,
  addedAt: 1,
  creds: { access: `access-${id}`, refresh: `refresh-${id}`, email, projectId, expires: Date.now() + 3_600_000 }
})

await check('multi: /accounts lists every account and never a token', async () => {
  writeAccountRegistry(
    {
      version: 1,
      activeId: 'id-a',
      accounts: [seededAccount('id-a', 'a@b.c', 'proj-a'), seededAccount('id-b', 'd@e.f', 'proj-b')],
      updatedAt: 0
    },
    accountsFilePath()
  )
  const { status, body } = await request('GET', ACCOUNTS)
  assert.strictEqual(status, 200)
  assert.strictEqual(body.accounts.length, 2)
  assert.strictEqual(body.activeAccountId, 'id-a')
  assert.strictEqual(body.strategy, 'round-robin', 'the default strategy must be reported')
  assert.ok(!('access' in body.accounts[0]), 'the browser half must never receive a token')
  assert.ok(!('creds' in body.accounts[0]))
})

await check('multi: /status reports the active account and the whole pool', async () => {
  const { body } = await request('GET', STATUS)
  assert.strictEqual(body.authenticated, true)
  assert.strictEqual(body.email, 'a@b.c')
  assert.strictEqual(body.accounts.length, 2)
})

await check('multi: /accounts/active switches the default and /status follows', async () => {
  const { status, body } = await request('POST', ACCOUNTS_ACTIVE, { body: { id: 'id-b' } })
  assert.strictEqual(status, 200)
  assert.strictEqual(body.activeAccountId, 'id-b')
  assert.strictEqual(body.email, 'd@e.f')
  assert.strictEqual(readAuthFile().email, 'd@e.f', 'the legacy mirror must follow the default')
})

await check('multi: /accounts/active refuses an unknown id', async () => {
  const { status, body } = await request('POST', ACCOUNTS_ACTIVE, { body: { id: 'nope' } })
  assert.strictEqual(status, 404)
  assert.match(body.error, /未找到/)
})

await check('multi: /logout signs out only the active account', async () => {
  const { status, body } = await request('POST', LOGOUT)
  assert.strictEqual(status, 200)
  assert.strictEqual(body.accounts.length, 1, 'the other account must survive a sign-out')
  assert.strictEqual(body.authenticated, true)
  assert.strictEqual(body.email, 'a@b.c', 'the remaining account takes over')
})

await check('multi: /accounts/remove deletes one and closes the loop on the last', async () => {
  const removed = await request('POST', ACCOUNTS_REMOVE, { body: { id: 'id-a' } })
  assert.strictEqual(removed.status, 200)
  assert.strictEqual(removed.body.accounts.length, 0)
  assert.strictEqual(removed.body.authenticated, false)
  assert.strictEqual(readAuthFile(), null)
  const missing = await request('POST', ACCOUNTS_REMOVE, { body: { id: 'id-a' } })
  assert.strictEqual(missing.status, 404)
})
await check('multi: /accounts/clear-cooldown drops the park and /status follows', async () => {
  writeAccountRegistry(
    {
      version: 1,
      activeId: 'id-a',
      accounts: [
        { ...seededAccount('id-a', 'a@b.c', 'proj-a'), cooldownUntil: Date.now() + 3_600_000 },
        seededAccount('id-b', 'd@e.f', 'proj-b')
      ],
      updatedAt: 0
    },
    accountsFilePath()
  )
  const listed = await request('GET', ACCOUNTS)
  assert.strictEqual(
    listed.body.accounts.find(a => a.id === 'id-a').cooling,
    true,
    '先让它真的处在冷却里'
  )
  const cleared = await request('POST', ACCOUNTS_CLEAR, { body: { id: 'id-a' } })
  assert.strictEqual(cleared.status, 200)
  assert.strictEqual(
    cleared.body.accounts.find(a => a.id === 'id-a').cooling,
    false,
    '冷却必须被清掉'
  )
  assert.strictEqual(
    cleared.body.accounts.find(a => a.id === 'id-b').cooling,
    false,
    '清一个账号不能碰到别人的冷却状态'
  )
  const missing = await request('POST', ACCOUNTS_CLEAR, { body: { id: 'nope' } })
  assert.strictEqual(missing.status, 404)
  assert.match(missing.body.error, /未找到/)
  // 下一节从「这台机器上还没有账号」开始，所以把这一段借来的两条还回去。
  await request('POST', ACCOUNTS_REMOVE, { body: { id: 'id-a' } })
  const emptied = await request('POST', ACCOUNTS_REMOVE, { body: { id: 'id-b' } })
  assert.strictEqual(emptied.body.accounts.length, 0)
})
await check('teardown during a pending attempt releases every route', async () => {
  const { body } = await request('POST', LOGIN)
  assert.strictEqual(body.pending, true)
  await loopCtx.fiber.dispose()
  assert.strictEqual(routes.size, 0)
})

console.log('# 9. 账户标记：默认不出现，登录后出现，移除后消失')
/** A stand-in for `ctx.settings`: records writes and can replay a removal. */
function fakeSettings(initial = {}) {
  let value = { ...initial }
  /**
   * The 0.1.7 settings contract, in the two ways it differs from the section API
   * this fake used to model:
   *
   * 1. An entry is resolved by `entry.options.id === ns`, so a write addressed
   *    to a name the profile did not declare is refused — that is how the real
   *    service behaves (`write()` throws `No configurable plugin entry`), and
   *    modelling it is what catches an id that drifted from the profile patch.
   * 2. Only **volatile** fields may be written (`isVolatilePath` is checked per
   *    path), which is why the `account` marker is declared volatile.
   *
   * A committed write then reaches the plugin the same way the Loader delivers
   * it: the volatile reference is updated in place, and `loader/volatile-update`
   * fires (see `_commitVolatile`).
   */
  const listeners = []
  const calls = []
  /** Deliver a committed change the way the Loader does: ref updated, then event. */
  const notify = () => {
    for (const fn of listeners) fn()
  }
  /** Entry ids the profile declares, as the live fiber's `options.id` reports. */
  const declared = new Set(['antigravity'])
  /** Paths the schema marks volatile, as `isVolatilePath` decides. */
  const volatilePaths = new Set(['account', 'accountStrategy', 'reasoningEffort',
    'proxyEnabled', 'proxyHost', 'proxyPort', 'usageEnabled', 'usageRetentionDays'])
  return {
    service: {
      async mutate(ns, ops) {
        if (!declared.has(ns)) throw new Error(`No configurable plugin entry "${ns}"`)
        for (const op of ops) {
          const key = op.path.join('.')
          if (op.path.length !== 0 && !volatilePaths.has(key)) {
            throw new Error(`Config field "${key}" is not volatile`)
          }
        }
        calls.push({ ns, ops })
        for (const op of ops) {
          if (op.path.length !== 1) continue
          if (op.op === 'set') value = { ...value, [op.path[0]]: op.value }
          else {
            const { [op.path[0]]: _dropped, ...rest } = value
            value = rest
          }
        }
        notify()
      }
    },
    calls,
    read: () => value,
    /** Register the plugin's volatile-update listener (what `ctx.on` does). */
    listen(fn) {
      listeners.push(fn)
      return () => {
        const at = listeners.indexOf(fn)
        if (at >= 0) listeners.splice(at, 1)
      }
    },
    /** What the row's native 「移除」 does: unset the path, then notify. */
    removeAccountMarker() {
      const { account, ...rest } = value
      value = rest
      notify()
    },
    /** A settings reload that brings the marker back (see the flicker case). */
    setAccountMarker(label) {
      value = { ...value, account: label }
      notify()
    },
    /** Any unrelated settings edit. */
    notify
  }
}

const markerRoutes = new Map()
const markerSettings = fakeSettings()
const markerCtx = new Context()
new LlmRuntime(markerCtx)
markerCtx.provide('webServer', {
  register(options) {
    markerRoutes.set(options.path, options)
    return () => markerRoutes.delete(options.path)
  }
})
markerCtx.provide('settings', markerSettings.service)
/**
 * The `account` marker as the plugin observes it.
 *
 * Under 0.1.7 a volatile Config field arrives as a **stable reference** and a
 * committed settings write updates that ref **in place** (`updateVolatile`),
 * which is what `_commitVolatile` does on a real edit — the plugin is never
 * reloaded. The ref is taken from the plugin's own schema, so this exercises the
 * real wrapping rather than a hand-built stand-in.
 *
 * The plugin is applied through `apply` directly (not `ctx.plugin`): `ctx.plugin`
 * re-validates its config against the schema, and a ref is not a string. Resolving
 * once and handing the refs across is precisely what the Loader does, so this is
 * the production shape, not a shortcut.
 */
const markerAccountRef = antigravityPlugin.Config['~standard'].validate({}).value.account
assert(markerAccountRef && typeof markerAccountRef.get === 'function', 'account must resolve to a volatile ref')
const markerPort = await freePort()
/**
 * Apply the plugin with the resolved config, the way the Loader does.
 *
 * `ctx.plugin` would validate the config again and reject the ref (a ref is not
 * a string), so the plugin is applied directly on this context with the resolved
 * config in hand. That resolved config is what the plugin reads, and the
 * `account` ref inside it is the object a committed settings write updates.
 */
const markerApplyConfig = {
  redirectUri: `http://127.0.0.1:${markerPort}/oauth-callback`,
  account: markerAccountRef
}
antigravityPlugin.apply(markerCtx, markerApplyConfig)
assert(markerApplyConfig.account === markerAccountRef, 'apply must receive the ref')
// A committed marker write reaches the plugin as a volatile update, not as a new
// config object; mirror that ordering.
markerSettings.listen(() => {
  // Deliver the commit the way the Loader does: update the ref the plugin holds,
  // *then* signal it. Each schema resolution mints a distinct ref, so the service
  // and the plugin must share one — resolving once and passing that ref across is
  // precisely what the Loader does.
  updateVolatile(markerAccountRef, { get: () => markerSettings.read().account })
  markerCtx.emit('loader/volatile-update', markerCtx.fiber)
})
await settle()

async function markerCall(method, path) {
  const route = markerRoutes.get(path)
  assert(route, `${path} must be registered`)
  const res = fakeRes()
  await route.handler({ method, url: path, headers: {} }, res)
  return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null }
}

await check('signed out: looking at the card installs nothing', async () => {
  const { body } = await markerCall('GET', STATUS)
  assert.strictEqual(body.authenticated, false)
  assert.deepStrictEqual(markerSettings.calls, [], 'no marker may be written without an account')
  assert.strictEqual(markerSettings.read().account, undefined)
})
await check('a pre-existing account gets its marker back at load, without any UI', async () => {
  // The deadlock this guards: the provider row only renders when `settingsPath`
  // (`['account']`) resolves, and the card used to be the only writer of that
  // marker — no marker, no row; no row, no card; no card, no writer. A grant
  // that predates the marker therefore never became visible.
  //
  // So the repair must happen at load, from the pool alone. This mounts a fresh
  // context with an account on disk but no marker, and asserts the marker lands
  // *before* anything reads a card.
  const { Context } = await import('@deepseek-ai/cordis')
  const { LlmRuntime } = await import('@deepseek-ai/dsh-llm')
  const fresh = new Context()
  new LlmRuntime(fresh)
  const calls = []
  let value = {}
  fresh.provide('settings', {
    async mutate(ns, ops) {
      if (ns !== 'antigravity') throw new Error(`No configurable plugin entry "${ns}"`)
      calls.push({ ns, ops })
      for (const op of ops) {
        if (op.op === 'set') value = { ...value, [op.path[0]]: op.value }
      }
    }
  })
  // A grant already on disk. The pool reads the **accounts registry**, not the
  // auth file, so seed that.
  writeAccountRegistry({
    version: 1,
    activeId: 'load-repair',
    accounts: [{
      id: 'load-repair',
      label: 'load-repair',
      projectId: 'load-repair',
      addedAt: Date.now(),
      creds: { access: 'seeded-access', projectId: 'load-repair', expires: Date.now() + 3_600_000 }
    }]
  })
  const ref = antigravityPlugin.Config['~standard'].validate({}).value.account
  antigravityPlugin.apply(fresh, { account: ref, redirectUri: 'http://127.0.0.1:1/cb' })
  await new Promise(r => setTimeout(r, 20))
  assert.deepStrictEqual(
    calls.filter(c => c.ops[0].op === 'set'),
    [{ ns: 'antigravity', ops: [{ op: 'set', path: ['account'], value: 'load-repair' }] }],
    'load must publish the marker for an account that already exists'
  )
  // Put the registry back to empty: the suite's later cases seed their own, and a
  // leftover account here would make them see a marker they did not expect.
  writeAccountRegistry({ version: 1, activeId: null, accounts: [] })
})
await check('an account with no marker installs the row when the card reads it', async () => {
  writeAuthFile({ access: 'seeded-access', projectId: 'aicode-consumers', expires: Date.now() + 3_600_000 })
  const { body } = await markerCall('GET', STATUS)
  assert.strictEqual(body.authenticated, true)
  const set = markerSettings.calls.filter(call => call.ops[0].op === 'set')
  // The namespace is the **entry id**, resolved off the live fiber; this context
  // applies the plugin bare, so it falls back to the package's own constant —
  // which must equal the id the bundled patch declares.
  assert.deepStrictEqual(set, [
    { ns: 'antigravity', ops: [{ op: 'set', path: ['account'], value: 'aicode-consumers' }] }
  ])
  await markerCall('GET', STATUS)
  // The guard compares the live marker against the label it would write. If the
  // plugin cannot see the committed value, every read rewrites the same marker.
  assert.strictEqual(
    markerAccountRef.get(), 'aicode-consumers',
    'the committed marker must be visible through the ref the plugin reads'
  )
  assert.strictEqual(markerSettings.calls.length, 1, 'a present marker must not be rewritten')
})
await check('an unrelated settings edit keeps the grant', async () => {
  markerSettings.notify()
  await settle()
  assert(markerSettings.calls.length === 1)
  assert(readAuthFile(), 'the grant must survive a settings change that leaves the marker alone')
})
// 标记这一节要直接看注册表：清空账号是否真的发生，只有文件能证明。
const { accountsFilePath: markerRegistryPath, readAccountRegistry: readMarkerRegistry } = await import(
  '../lib/accounts.js'
)

await check('the row\'s native 移除 takes the account with it', async () => {
  markerSettings.removeAccountMarker()
  await settle()
  assert.strictEqual(markerSettings.read().account, undefined)
  // 清空账号是唯一不可逆的路径，所以它被推迟了一个宽限期才执行。
  await new Promise(resolve => setTimeout(resolve, 1200))
  assert.strictEqual(readAuthFile(), null, 'removing the marker must remove the grant')
  assert.strictEqual(readMarkerRegistry(markerRegistryPath()).accounts.length, 0, '清单也必须清空')
})
await check('标记短暂消失（设置重载）不得清空账号', async () => {
  writeAuthFile({ access: 'seeded-access', projectId: 'aicode-consumers', expires: Date.now() + 3_600_000 })
  await markerCall('GET', STATUS)
  assert.strictEqual(readMarkerRegistry(markerRegistryPath()).accounts.length, 1, '先要有账号')
  // 一次「看起来像移除」的闪烁：宽限期内标记又回来了。
  markerSettings.removeAccountMarker()
  await new Promise(resolve => setTimeout(resolve, 150))
  markerSettings.setAccountMarker('aicode-consumers')
  await new Promise(resolve => setTimeout(resolve, 1200))
  assert.strictEqual(
    readMarkerRegistry(markerRegistryPath()).accounts.length,
    1,
    '设置重载的闪烁不得删掉用户的账号'
  )
  assert(readAuthFile(), '镜像也必须还在')
})
await check('signing out clears the grant and the marker, so the row goes away', async () => {
  writeAuthFile({ access: 'seeded-access', projectId: 'aicode-consumers', expires: Date.now() + 3_600_000 })
  await markerCall('GET', STATUS)
  assert.strictEqual(markerSettings.read().account, 'aicode-consumers')
  const { status, body } = await markerCall('POST', LOGOUT)
  assert.strictEqual(status, 200)
  assert.strictEqual(body.authenticated, false)
  assert.strictEqual(readAuthFile(), null)
  assert.strictEqual(markerSettings.read().account, undefined)
  assert(markerSettings.calls.some(call => call.ops[0].op === 'unset'), 'the marker must be withdrawn')
})
await check('marker-side teardown releases the routes', async () => {
  await markerCtx.fiber.dispose()
  assert.strictEqual(markerRoutes.size, 0)
})

console.log('# 10. 中止路径不得触发 DSH 的 fatal load failure')
const { spawnSync } = await import('node:child_process')
const authFlowHref = new URL('../lib/auth-flow.js', import.meta.url).href
/**
 * A child process wearing DSH's own fail-loud handler (`dsh-app-boot`
 * `installFailLoud`), which answers any unhandled rejection by exiting 1. Each
 * scenario drives the web path exactly as the settings card does: `begin()`
 * with nobody awaiting `completion()`.
 */
const fatalSource = `
process.on('unhandledRejection', error => {
  process.stderr.write('fatal load failure: ' + (error instanceof Error ? error.message : String(error)) + '\\n')
  process.exit(1)
})
const { LoginManager } = await import(${JSON.stringify(authFlowHref)})
const scenario = process.env.SCENARIO
const port = Number(process.env.PORT)
const manager = new LoginManager({ redirectUri: 'http://127.0.0.1:' + port + '/oauth-callback', timeoutMs: 40 })
await manager.begin()
if (scenario === 'cancel') manager.cancel()
else if (scenario === 'timeout') await new Promise(resolve => setTimeout(resolve, 250))
else if (scenario === 'forged') await fetch('http://127.0.0.1:' + port + '/oauth-callback?code=x&state=wrong')
else if (scenario === 'teardown') manager.dispose()
else if (scenario === 'headless') {
  const creds = await manager.completion().catch(() => null)
  if (creds !== null) {
    process.stderr.write('a failed attempt must not yield credentials\\n')
    process.exit(1)
  }
}
await new Promise(resolve => setTimeout(resolve, 250))
manager.dispose()
console.log('SURVIVED ' + scenario)
`
for (const scenario of ['cancel', 'timeout', 'forged', 'teardown', 'headless']) {
  await check(`"${scenario}" leaves the host alive`, async () => {
    const port = await freePort()
    const run = spawnSync(process.execPath, ['--input-type=module', '-e', fatalSource], {
      encoding: 'utf8',
      timeout: 20_000,
      env: { ...process.env, SCENARIO: scenario, PORT: String(port) }
    })
    const output = `${run.stdout}${run.stderr}`
    assert(!/fatal load failure/.test(output), `DSH would have exited:\n${output.trim()}`)
    assert.match(run.stdout, /SURVIVED/, `the child did not survive:\n${output.trim()}`)
    assert.strictEqual(run.status, 0)
  })
}

console.log('# 11. providerRetryPolicy 必须交出「可被 dsh-llm-retry 消费」的策略')
// 消费者的那一行逐字来自 dsh-llm-retry/lib/index.js:160：
//     } else if (!policy.retryableCodes.includes(failure.code)) return next();
// 旧实现的冷启动兜底是 `{ mode: 'normal', maxRetries: 3 }`（**没有** retryableCodes），
// 而 dsh-llm 只在适配器返回 undefined 时才补默认 —— 于是这条路径**只在 provider 失败时**才炸：
// TypeError「Cannot read properties of undefined (reading 'includes')」盖掉真正的 TRANSPORT 错误
// （实测：'连接任何 Google Antigravity 端点均失败' 被盖成 UNKNOWN）。
{
  const cold = new GoogleAntigravityAdapter({})
  await check('冷启动（无 resolver）返回 undefined，绝不是一个残缺策略', () => {
    assert.strictEqual(cold.providerRetryPolicy(), undefined)
  })

  const partial = new GoogleAntigravityAdapter({ resolveRetryPolicy: () => ({ mode: 'normal', maxRetries: 3 }) })
  await check('resolver 交回缺 retryableCodes 的 normal 策略 -> undefined', () => {
    assert.strictEqual(partial.providerRetryPolicy(), undefined)
  })

  const complete = Object.freeze({
    mode: 'normal', maxRetries: 3, retryableCodes: Object.freeze(['TRANSPORT']), maxDelayMs: 4000
  })
  const full = new GoogleAntigravityAdapter({ resolveRetryPolicy: () => complete })
  await check('完整的 normal 策略按同一性透传（不重建、不改写）', () => {
    assert.strictEqual(full.providerRetryPolicy(), complete)
  })

  // 'always' 策略**本来就没有** retryableCodes（消费者在 mode === 'always' 分支根本不读它），
  // 护栏必须放行它 —— 否则等于把用户设的 always 静默降级成默认。
  const always = Object.freeze({ mode: 'always', maxDelayMs: 4000 })
  const alwaysAdapter = new GoogleAntigravityAdapter({ resolveRetryPolicy: () => always })
  await check('always 策略（无 retryableCodes 字段）原样透传', () => {
    assert.strictEqual(alwaysAdapter.providerRetryPolicy(), always)
  })

  await check('适配器交出的每个策略都能活着走过消费者那一行', () => {
    for (const adapter of [cold, partial, full, alwaysAdapter]) {
      const policy = adapter.providerRetryPolicy()
      if (policy === undefined) continue // undefined 由 dsh-llm 换成它自己的完整默认
      assert.doesNotThrow(() => {
        if (policy.mode === 'always') return
        policy.retryableCodes.includes('TRANSPORT')
      })
    }
  })

  // 负向对照：证明上面那条断言**真的会失败** —— 旧实现的冷启动字面量确实在消费点抛 TypeError。
  await check('负向对照：旧的冷启动字面量在消费点抛 TypeError', () => {
    const legacy = { mode: 'normal', maxRetries: 3 }
    assert.throws(() => { legacy.retryableCodes.includes('TRANSPORT') }, TypeError)
  })
}

console.log('# 12. 空回答必须变成可重试的失败（EMPTY_RESPONSE）')

/** Feed one SSE script through parseStream and collect every emitted chunk. */
async function parseSse(events) {
  const body = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder()
      for (const event of events) controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`))
      controller.close()
    }
  })
  const collected = []
  for await (const chunk of parseStream(new Response(body), resolveModelSpec('gemini-3.8-flash'))) collected.push(chunk)
  return collected
}

const finishOf = chunks => chunks.find(chunk => chunk.type === 'finish')

const emptyStream = await parseSse([
  { response: { candidates: [{ finishReason: 'STOP', content: { parts: [] } }], usageMetadata: { promptTokenCount: 7 } } }
])

await check('零内容 + stop -> error finish，code 是 EMPTY_RESPONSE', () => {
  const finish = finishOf(emptyStream)
  assert.strictEqual(finish.reason.kind, 'error')
  assert.strictEqual(finish.reason.failure.code, 'EMPTY_RESPONSE')
})
await check('空回答的 message 与生态先例逐字一致', () => {
  assert.strictEqual(
    finishOf(emptyStream).reason.failure.message,
    'model returned a completed response with no content'
  )
})
await check('空回答只产出一个 finish（普通 finish 不得同时出现）', () => {
  assert.strictEqual(emptyStream.filter(chunk => chunk.type === 'finish').length, 1)
})
await check('空回答仍产出 usage', () => {
  assert(emptyStream.some(chunk => chunk.type === 'usage'))
})

const textStream = await parseSse([
  { response: { candidates: [{ content: { parts: [{ text: 'hi' }] } }] } },
  { response: { candidates: [{ finishReason: 'STOP', content: { parts: [] } }] } }
])
await check('负控：有文本 + stop -> 正常 stop，不得改写成 error', () => {
  assert.strictEqual(finishOf(textStream).reason.kind, 'stop')
})

const toolStream = await parseSse([
  { response: { candidates: [{ content: { parts: [{ functionCall: { name: 'read', args: {}, id: 'c1' } }] } }] } }
])
await check('负控：只有 tool call -> tool-calls，不得改写成 error', () => {
  assert.strictEqual(finishOf(toolStream).reason.kind, 'tool-calls')
})

const reasoningStream = await parseSse([
  { response: { candidates: [{ content: { parts: [{ thought: true, text: 'thinking' }] } }] } }
])
await check('负控：只有 reasoning 块 -> stop（reasoning 也算内容）', () => {
  assert.strictEqual(finishOf(reasoningStream).reason.kind, 'stop')
})

const cappedStream = await parseSse([
  { response: { candidates: [{ finishReason: 'MAX_TOKENS', content: { parts: [] } }] } }
])
await check('负控：零内容 + MAX_TOKENS -> max-tokens（独立结局，不算空回答）', () => {
  assert.strictEqual(finishOf(cappedStream).reason.kind, 'max-tokens')
})

// ---------------------------------------------------------------------------
// 版本可见性：装的是哪一版，必须能问出来。
//
// 为什么值得一条测试：这个插件从 tarball 安装，而 pnpm 把 `file:` 依赖按路径判为已满足 ——
// 同版本号覆盖 tarball **不会**刷新 node_modules（实测：install 报 "Lockfile is up to date"、
// install --force 从 store 复用旧内容、只删 node_modules/<pkg> 也没用）。
// 于是"源码 0.3.3、装的是 0.2.5"是默认结果而不是意外，唯一的解法是让运行时的版本可读。
// ---------------------------------------------------------------------------
const packageVersion = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version

await check('导出的 version 与 package.json 一致（且非 unknown）', () => {
  assert.notStrictEqual(antigravityVersion, 'unknown', '版本读不出来说明路径假设错了')
  assert.strictEqual(antigravityVersion, packageVersion, `导出 ${antigravityVersion} vs package.json ${packageVersion}`)
})

await check('默认导出带上 name / inject / apply / Config', () => {
  assert.strictEqual(antigravityPlugin.name, 'dsh-antigravity')
  assert.deepStrictEqual([...antigravityPlugin.inject], ['llm'])
  assert.strictEqual(typeof antigravityPlugin.apply, 'function')
  assert.ok(antigravityPlugin.Config)
})

// ---------------------------------------------------------------------------
// 多账号：注册表、选择策略、配额冷却、跨账号故障转移。
//
// 这一段整体搬进一个独立的 DSH_HOME：它会写注册表与旧镜像，而旧镜像正是
// `~/.dsh/antigravity-auth.json` —— 跑在共享 home 里会把上面几节的状态搅乱。
// ---------------------------------------------------------------------------
console.log('# 13. 多账号注册表、选择策略与跨账号故障转移')
const {
  AccountPool,
  upsertAccount,
  removeAccountById,
  adoptLegacy,
  mergeDuplicates,
  readAccountRegistry,
  accountsFilePath: poolPath
} = await import('../lib/accounts.js')

const accountsHome = mkdtempSync(pathJoin(tmpdir(), 'dsh-antigravity-accounts-'))
const sharedHome = process.env.DSH_HOME
process.env.DSH_HOME = accountsHome

/** A monotonic fake clock: cooldowns must be judgeable without sleeping. */
let clock = 1_000_000
let poolSeq = 0
/**
 * A pool with its own registry file.
 *
 * The legacy mirror (`antigravity-auth.json`) is deliberately removed first:
 * it is one shared file, the previous case always leaves its active account in
 * it, and an empty registry adopts whatever it finds there — so a leftover
 * would silently become an extra account in the next case.
 */
const makePool = (options = {}) => {
  removeAuthFile()
  return new AccountPool({
    file: pathJoin(accountsHome, `registry-${poolSeq++}.json`),
    now: () => clock,
    warn: () => {},
    refresh: async creds => creds,
    // Never let a unit test reach Google: identity lookup is stubbed off unless a
    // case asks for one.
    discoverEmail: async () => undefined,
    ...options
  })
}

const credsOf = (email, overrides = {}) => ({
  access: `access-${email}`,
  refresh: `refresh-${email}`,
  email,
  accountId: email,
  projectId: `proj-${email}`,
  expires: Date.now() + 3_600_000,
  ...overrides
})

await check('注册表把同一邮箱的再次登录并入同一条目', () => {
  const registry = { version: 1, accounts: [], updatedAt: 0 }
  const first = upsertAccount(registry, credsOf('a@b.c'), 1000)
  const again = upsertAccount(registry, credsOf('a@b.c', { access: 'access-renewed' }), 2000)
  assert.strictEqual(registry.accounts.length, 1, 'the same email must not become two accounts')
  assert.strictEqual(again.id, first.id)
  assert.strictEqual(again.creds.access, 'access-renewed')
})

await check('不同邮箱各占一条，互不覆盖', () => {
  const registry = { version: 1, accounts: [], updatedAt: 0 }
  upsertAccount(registry, credsOf('a@b.c'), 1000)
  upsertAccount(registry, credsOf('d@e.f'), 1000)
  assert.strictEqual(registry.accounts.length, 2)
})

await check('移除默认账号会把默认指到剩下的账号', () => {
  const registry = { version: 1, accounts: [], updatedAt: 0 }
  const a = upsertAccount(registry, credsOf('a@b.c'), 1000)
  const d = upsertAccount(registry, credsOf('d@e.f'), 1000)
  registry.activeId = a.id
  assert.strictEqual(removeAccountById(registry, a.id), true)
  assert.strictEqual(registry.activeId, d.id)
  assert.strictEqual(removeAccountById(registry, 'nope'), false)
})

await check('空注册表会采纳既有凭据（单账号升级为多账号）', () => {
  const registry = { version: 1, accounts: [], updatedAt: 0 }
  const entry = adoptLegacy(registry, { access: 'legacy', projectId: 'aicode-consumers' }, 1000)
  assert(entry, 'an existing grant must be adopted')
  assert.strictEqual(registry.accounts.length, 1)
  assert.strictEqual(registry.activeId, entry.id)
  assert.strictEqual(adoptLegacy({ version: 1, accounts: [], updatedAt: 0 }, null), null)
})

await check('没有账号时 resolve 返回 undefined', async () => {
  const pool = makePool()
  assert.strictEqual(await pool.resolve(), undefined)
  assert.strictEqual(pool.configured(), false)
})

await check('round-robin 把连续调用分给不同账号', async () => {
  const pool = makePool()
  await pool.add(credsOf('a@b.c'))
  await pool.add(credsOf('d@e.f'))
  const seen = []
  for (let index = 0; index < 4; index += 1) seen.push((await pool.resolve()).email)
  assert.deepStrictEqual(seen, ['a@b.c', 'd@e.f', 'a@b.c', 'd@e.f'])
})

await check('active-first 只用默认账号，直到它不可用', async () => {
  const pool = makePool({ strategy: () => 'active-first' })
  await pool.add(credsOf('a@b.c'))
  await pool.add(credsOf('d@e.f'))
  const seen = []
  for (let index = 0; index < 3; index += 1) seen.push((await pool.resolve()).email)
  assert.deepStrictEqual(seen, ['d@e.f', 'd@e.f', 'd@e.f'], 'the active account must be drained first')
})

await check('配额失败停一个窗口，下一次调用自动换人', async () => {
  const pool = makePool({ strategy: () => 'active-first' })
  await pool.add(credsOf('a@b.c'))
  await pool.add(credsOf('d@e.f'))
  const first = await pool.resolve()
  assert.strictEqual(first.email, 'd@e.f')
  pool.reportFailure({
    accountId: first.accountId,
    kind: 'quota',
    message: '配额已用尽',
    cooldownUntil: clock + 3_600_000
  })
  const second = await pool.resolve()
  assert.strictEqual(second.email, 'a@b.c', 'a parked account must not be handed out again')
  const parked = pool.list().find(view => view.email === 'd@e.f')
  assert.strictEqual(parked.cooling, true)
  assert.strictEqual(parked.cooldownSeconds, 3600, 'provider 说重置在一小时后，就停一小时')
  assert.strictEqual(parked.cooldownKind, 'hard', '带重置时间的 429 是硬冷却（事实，不是猜测）')
  assert.match(parked.lastError, /配额/)
})

await check('重置时间报 92 小时就停 92 小时，期间绝不重试', async () => {
  const pool = makePool()
  const entry = await pool.add(credsOf('a@b.c'))
  pool.reportFailure({
    accountId: entry.id,
    kind: 'quota',
    message: 'q',
    cooldownUntil: clock + 92 * 3600 * 1000
  })
  assert.strictEqual(pool.list()[0].cooldownSeconds, 92 * 3600, '带重置时间的 429 就是事实，一个字都不改')
  assert.strictEqual(pool.list()[0].cooldownKind, 'hard')
  // 负向对照：五分钟后（旧规则下这个点已经放行）仍然不许交出。
  clock += 300_001
  assert.strictEqual(pool.list()[0].cooling, true, '硬冷却不许被五分钟这个旧窗口放行')
  assert.strictEqual(await pool.resolve(), undefined, '唯一账号硬冷却时，调用直接失败而不是拿它重试')
  // 到点才回来。
  clock += 92 * 3600 * 1000
  const creds = await pool.resolve()
  assert.strictEqual(creds.email, 'a@b.c', '到 provider 说的那个时刻才回到队列')
})

await check('旧版写下的冷却被当作硬冷却保留（不猜、不压缩）', async () => {
  removeAuthFile()
  const file = pathJoin(accountsHome, `registry-${poolSeq++}-stale.json`)
  writeAccountRegistry(
    {
      version: 1,
      activeId: 'a@b.c',
      accounts: [
        {
          id: 'a@b.c',
          label: 'a@b.c',
          email: 'a@b.c',
          addedAt: 1,
          cooldownUntil: clock + 24 * 3600 * 1000,
          creds: credsOf('a@b.c')
        }
      ],
      updatedAt: 0
    },
    file
  )
  const pool = new AccountPool({
    file,
    now: () => clock,
    warn: () => {},
    refresh: async creds => creds,
    discoverEmail: async () => undefined
  })
  await pool.ready()
  const view = pool.list()[0]
  assert.strictEqual(view.cooling, true)
  // 旧注册表没有 cooldownKind 这一栏。当年能写进文件的长冷却只可能来自
  // provider 明说的重置时间（猜的那条路一直封在五分钟），所以按 hard 读 ——
  // 当成 soft 会把真正耗尽的账号放出去重试。
  assert.strictEqual(view.cooldownKind, 'hard', '缺字段的旧条目按硬冷却读')
  assert.strictEqual(view.cooldownSeconds, 24 * 3600, '旧条目里的长冷却不再被压成一个窗口')
})

await check('手动清除冷却：清掉后下一次调用立刻轮得到它', async () => {
  const pool = makePool()
  const entry = await pool.add(credsOf('a@b.c'))
  pool.reportFailure({ accountId: entry.id, kind: 'quota', message: 'q', cooldownUntil: clock + 3_600_000 })
  assert.strictEqual(pool.list()[0].cooling, true)
  assert.strictEqual(await pool.clearCooldown(entry.id), 'cleared')
  assert.strictEqual(pool.list()[0].cooling, false)
  const creds = await pool.resolve()
  assert.strictEqual(creds.email, 'a@b.c', '冷却清掉之后必须重新轮得到它')
  assert.strictEqual(await pool.clearCooldown(entry.id), 'idle', '本来没冷却时如实回答')
  assert.strictEqual(await pool.clearCooldown('nope'), 'missing', '不存在的账号要能区分出来')
})

await check('账号恢复可用后冷却自动解除', async () => {
  const pool = makePool()
  const entry = await pool.add(credsOf('a@b.c'))
  pool.reportFailure({ accountId: entry.id, kind: 'quota', message: 'q', cooldownUntil: clock + 60_000 })
  assert.strictEqual(pool.list()[0].cooling, true)
  clock += 60_001
  assert.strictEqual(pool.list()[0].cooling, false)
  const creds = await pool.resolve()
  assert.strictEqual(creds.email, 'a@b.c', 'a cooled-down account must come back')
})

await check('全部账号硬冷却时不交出任何账号（不拿它重试）', async () => {
  const pool = makePool()
  const a = await pool.add(credsOf('a@b.c'))
  const d = await pool.add(credsOf('d@e.f'))
  pool.reportFailure({ accountId: a.id, kind: 'quota', message: 'q', cooldownUntil: clock + 60_000 })
  pool.reportFailure({ accountId: d.id, kind: 'quota', message: 'q', cooldownUntil: clock + 600_000 })
  // 两个都是「带重置时间的 429」，也就是事实。没有账号可用时就不试 ——
  // 交出去只会白白再吃一个 429，而 registry 早就知道答案。
  assert.strictEqual(await pool.resolve(), undefined, '全是硬冷却时必须返回 undefined')
  assert.strictEqual(
    pool.list().find(view => view.email === 'a@b.c').cooling,
    true,
    '一次都没有被交出去，冷却自然还在'
  )
})

await check('全硬冷却里夹着软冷却时，只给软的那个一次机会', async () => {
  const pool = makePool()
  const hard = await pool.add(credsOf('hard@b.c'))
  const soft = await pool.add(credsOf('soft@e.f'))
  pool.reportFailure({ accountId: hard.id, kind: 'quota', message: 'q', cooldownUntil: clock + 3_600_000 })
  // 不带重置时间 = 猜测的窗口（软冷却），值得花一次请求去验。
  pool.reportFailure({ accountId: soft.id, kind: 'quota', message: 'q' })
  assert.strictEqual(pool.list().find(v => v.email === 'soft@e.f').cooldownKind, 'soft')
  const creds = await pool.resolve()
  assert.strictEqual(creds.email, 'soft@e.f', '硬冷却绝不给，软冷却可以试')
  assert.strictEqual(pool.list().find(v => v.email === 'hard@b.c').cooling, true, '硬冷却全程不动')
})

await check('mergeDuplicates 折叠同一邮箱的条目并保住默认账号', () => {
  const registry = {
    version: 1,
    activeId: 'dup',
    accounts: [
      // 先出现的那条是「晚学到邮箱」的旧条目：两个字段里任一有邮箱就算同号。
      { id: 'old', label: 'proj', addedAt: 10, cooldownUntil: clock + 5000, creds: { access: 'a1', projectId: 'proj', expires: 100, email: 'x@y.z' } },
      { id: 'dup', label: 'x@y.z', email: 'x@y.z', addedAt: 20, creds: { access: 'a2', email: 'x@y.z', projectId: 'proj', expires: 200 } }
    ],
    updatedAt: 0
  }
  assert.strictEqual(mergeDuplicates(registry, clock), 1)
  assert.strictEqual(registry.accounts.length, 1)
  assert.strictEqual(registry.accounts[0].id, 'old', '最先出现的那条留下')
  assert.strictEqual(registry.accounts[0].creds.access, 'a2', '取过期更晚的那份凭据')
  assert.strictEqual(registry.activeId, 'old', '默认账号必须指向幸存条目')
  assert.strictEqual(registry.accounts[0].addedAt, 10, '最早加入时间保留')
  assert.strictEqual(registry.accounts[0].cooldownUntil, clock + 5000, '冷却不能被合并抹掉')
  assert.strictEqual(mergeDuplicates(registry, clock), 0, '没有重复时是空操作')
})

await check('重置时间已到时不得把账号停掉', async () => {
  const pool = makePool()
  const entry = await pool.add(credsOf('a@b.c'))
  pool.reportFailure({ accountId: entry.id, kind: 'quota', message: 'q', cooldownUntil: clock - 1 })
  assert.strictEqual(pool.list()[0].cooldownUntil, null, '已经到点的重置时间不是「停用一个窗口」')
  assert.strictEqual(pool.list()[0].cooling, false)
  // 负控：provider 没说重置时间时才用保守默认。
  pool.reportFailure({ accountId: entry.id, kind: 'quota', message: 'q' })
  assert.strictEqual(pool.list()[0].cooling, true)
  assert.strictEqual(pool.list()[0].cooldownSeconds, 300, '没说重置时间就排一个窗口')
})

await check('全部账号都刷新失败时，报出的是真实原因而不是「未登录」', async () => {
  const pool = makePool({
    discoverEmail: async () => undefined,
    refresh: async () => {
      throw new Error('刷新 Google OAuth 令牌失败 (400): invalid_grant')
    }
  })
  await pool.add({ access: 'x1', refresh: 'r1', email: 'a@x.y', expires: Date.now() - 1000 })
  await pool.add({ access: 'x2', refresh: 'r2', email: 'b@x.y', expires: Date.now() - 1000 })
  const result = await runAdapter(() => healthySse(), pool)
  assert(result.error, '必须失败')
  assert.match(result.error.message, /invalid_grant/, '真实原因必须传上来：' + result.error.message)
  assert.doesNotMatch(
    result.error.message,
    /未找到 google-antigravity 认证凭据/,
    '把刷新失败说成「没登录」会把人骗去重新登录'
  )
})

await check('429 文案能读出声明的纯分钟重置时间', async () => {
  const pool = makePool()
  await pool.add(credsOf('a@b.c'))
  const body = '{"error":{"message":"Individual quota reached. Resets in 45m."}}'
  const result = await runAdapter(() => new Response(body, { status: 429 }), pool)
  assert(result.error)
  assert.match(result.error.message, /约 45m 后重置/, '文案：' + result.error.message.slice(0, 120))
})

await check('无 email 的旧条目在刷新后学到邮箱，并合并同一账号的重复条目', async () => {
  const pool = makePool({
    refresh: async creds => ({ ...creds, access: 'access-renewed', expires: Date.now() + 3_600_000 }),
    discoverEmail: async () => 'real@x.y'
  })
  // 旧条目：无 email 且 access 已过期（所以 resolve 会走刷新）。
  const legacy = await pool.add({ access: 'expired', refresh: 'r-legacy', projectId: 'proj', expires: Date.now() - 1000 })
  // 用户用同一个 Google 账号又登录了一次 —— 旧版本下这就是第二条条目。
  await pool.add({ access: 'a2', refresh: 'r2', email: 'real@x.y', projectId: 'proj', expires: Date.now() + 3_600_000 })
  assert.strictEqual(pool.count(), 2, '先并存')

  const creds = await pool.resolve()
  assert.strictEqual(creds.email, 'real@x.y', '刷新后必须知道这是哪个账号')
  assert.strictEqual(pool.count(), 1, '同一 Google 账号不得留下两条条目')
  assert.strictEqual(pool.list()[0].id, legacy.id, '幸存的是最早那条，调用方也要跟着它')
  assert.strictEqual(creds.accountId, legacy.id)
  assert.strictEqual(pool.list()[0].label, 'real@x.y', '卡片上必须显示邮箱而不是项目名')
})

await check('刷新期间外部新增的账号不得被覆盖，且新 token 仍必须落盘', async () => {
  const file = pathJoin(accountsHome, 'race-registry.json')
  const pool = makePool({
    file,
    discoverEmail: async () => undefined,
    refresh: async creds => {
      // 刷新是一次网络往返，期间 CLI 完全可能往同一份注册表里加账号。
      const concurrent = readAccountRegistry(file)
      concurrent.accounts.push({
        id: 'cli-added',
        label: 'cli@x.y',
        email: 'cli@x.y',
        addedAt: 1,
        creds: { access: 'cli-access', email: 'cli@x.y', projectId: 'proj', expires: Date.now() + 3_600_000 }
      })
      writeAccountRegistry(concurrent, file)
      return { ...creds, access: 'access-renewed', expires: Date.now() + 3_600_000 }
    }
  })
  await pool.add({ access: 'old', refresh: 'r', projectId: 'proj', expires: Date.now() - 1000 })
  await pool.resolve()
  const after = readAccountRegistry(file)
  assert.strictEqual(after.accounts.length, 2, '并发加入的账号必须活着')
  assert(
    after.accounts.some(account => account.creds.access === 'access-renewed'),
    '刷新结果必须落盘：' + JSON.stringify(after.accounts.map(account => account.creds.access))
  )
})

await check('采纳期间外部新增的账号不得被覆盖', async () => {
  const file = pathJoin(accountsHome, 'adopt-race.json')
  let release = null
  const seam = {
    readRecord: () =>
      new Promise(resolve => {
        release = resolve
      }),
    modifyRecord: async () => {},
    deleteRecord: async () => {}
  }
  const pool = makePool({ file, credentials: () => seam })
  const adopting = pool.ready()
  await new Promise(resolve => setTimeout(resolve, 10))
  // 采纳正卡在 seam 读取上时，CLI 往同一份注册表里加了一个账号。
  const cli = makePool({ file })
  await cli.add(credsOf('cli@x.y'))
  assert.strictEqual(readAccountRegistry(file).accounts.length, 1, 'CLI 账号已落盘')
  release({ kind: 'grant', payload: { access: 'legacy', email: 'legacy@x.y', projectId: 'proj' } })
  await adopting
  const labels = readAccountRegistry(file).accounts.map(account => account.email).sort()
  assert.deepStrictEqual(labels, ['cli@x.y', 'legacy@x.y'], '两条都必须活着：' + JSON.stringify(labels))
})

await check('刷新失败的账号会进入冷却，不会每次调用都重试', async () => {
  let refreshes = 0
  const pool = makePool({
    discoverEmail: async () => undefined,
    refresh: async () => {
      refreshes += 1
      throw new Error('invalid_grant')
    }
  })
  const dead = await pool.add({ access: 'expired', refresh: 'dead', email: 'dead@x.y', expires: Date.now() - 1000 })
  await pool.add(credsOf('live@x.y'))
  const first = await pool.resolve()
  assert.strictEqual(first.email, 'live@x.y', '故障转移必须落到另一个账号')
  assert.strictEqual(refreshes, 1)
  assert.strictEqual(pool.list().find(view => view.id === dead.id).cooling, true, '刷新失败的账号必须被停用')
  await pool.resolve()
  assert.strictEqual(refreshes, 1, '冷却期内不得再次重试那个死 refresh_token')
})

await check('一个账号冷却时，其余账号必须均分调用', async () => {
  const pool = makePool()
  const a = await pool.add(credsOf('a@x.y'))
  await pool.add(credsOf('b@x.y'))
  await pool.add(credsOf('c@x.y'))
  pool.reportFailure({ accountId: a.id, kind: 'quota', message: 'q', cooldownUntil: clock + 60_000 })
  const counts = {}
  for (let index = 0; index < 20; index += 1) {
    const creds = await pool.resolve()
    counts[creds.email] = (counts[creds.email] || 0) + 1
  }
  assert.deepStrictEqual(counts, { 'b@x.y': 10, 'c@x.y': 10 }, '轮询要跑在可用集合上：' + JSON.stringify(counts))
})

await check('环境变量凭据永远优先，且不参与轮询', async () => {
  const pool = makePool()
  await pool.add(credsOf('a@x.y'))
  await pool.add(credsOf('b@x.y'))
  const previous = process.env.GOOGLE_ANTIGRAVITY_TOKEN
  process.env.GOOGLE_ANTIGRAVITY_TOKEN = 'env-token'
  try {
    const seen = []
    for (let index = 0; index < 4; index += 1) seen.push((await pool.resolve()).accountId)
    assert.deepStrictEqual(seen, ['env', 'env', 'env', 'env'])
  } finally {
    if (previous === undefined) delete process.env.GOOGLE_ANTIGRAVITY_TOKEN
    else process.env.GOOGLE_ANTIGRAVITY_TOKEN = previous
  }
})

await check('故障转移用的 exclude 会跳过已试过的账号', async () => {
  const pool = makePool()
  const a = await pool.add(credsOf('a@b.c'))
  const d = await pool.add(credsOf('d@e.f'))
  // The pool keys candidates by registry id, which is what the adapter puts in
  // `exclude` — passing an email here would exclude nothing.
  const creds = await pool.resolve(undefined, new Set([a.id]))
  assert.strictEqual(creds.email, 'd@e.f')
  assert.strictEqual(await pool.resolve(undefined, new Set([a.id, d.id])), undefined)
})

await check('clear() 清空全部账号并撤掉旧镜像', async () => {
  const pool = makePool()
  await pool.add(credsOf('a@b.c'))
  assert(readAuthFile(), 'the legacy mirror must exist so the CLI keeps working')
  await pool.clear()
  assert.strictEqual(pool.count(), 0)
  assert.strictEqual(readAuthFile(), null)
})

await check('注册表为空时会采纳旧镜像里的单个凭据', async () => {
  // The pool is built first so the grant lands after its empty-world reset,
  // which is exactly the order an upgrading deployment sees.
  const pool = makePool()
  writeAuthFile(credsOf('legacy@x.y'))
  const creds = await pool.resolve()
  assert.strictEqual(creds.email, 'legacy@x.y')
  assert.strictEqual(pool.count(), 1)
  assert.strictEqual(pool.activeLabel(), 'legacy@x.y')
})

// ---------------------------------------------------------------------------
// 适配器侧的故障转移：一次调用穿过多个账号，430/401 换人，传输失败不换。
// ---------------------------------------------------------------------------

/** Serve one SSE stream of plain text, the shape a healthy answer takes. */
function healthySse() {
  const body = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder()
      const events = [
        { response: { candidates: [{ content: { parts: [{ text: 'ok' }] } }] } },
        { response: { candidates: [{ finishReason: 'STOP', content: { parts: [] } }] } }
      ]
      for (const event of events) controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`))
      controller.close()
    }
  })
  return new Response(body, { status: 200 })
}

/** Run one adapter call against a stubbed network and report what happened. */
async function runAdapter(fetchImpl, pool) {
  const originalFetch = globalThis.fetch
  const seen = []
  globalThis.fetch = async (url, init) => {
    const token = String((init && init.headers && init.headers.Authorization) || '')
    seen.push(token)
    return fetchImpl(token)
  }
  const failures = []
  try {
    const adapter = new GoogleAntigravityAdapter({
      resolveCredentials: (signal, exclude) => pool.resolve(signal, exclude),
      // Exactly how the mounting plugin wires it: the pool learns about the
      // failure so the *next* call does not walk into the same account.
      reportFailure: info => {
        failures.push(info)
        pool.reportFailure(info)
      }
    })
    const chunks = []
    for await (const chunk of adapter.stream({
      model: 'gemini-3.8-flash',
      messages: [{ role: 'user', content: 'hi' }]
    })) {
      chunks.push(chunk)
    }
    return { chunks, seen, failures, error: null }
  } catch (error) {
    return { chunks: [], seen, failures, error }
  } finally {
    globalThis.fetch = originalFetch
  }
}

const quotaBody = '{"error":{"message":"Individual quota reached. Resets in 1h0m0s."}}'

await check('配额重置时间的解析覆盖常见写法', () => {
  const now = 1_000_000
  assert.strictEqual(parseQuotaResetMs('Resets in 1h31m29s.', now), now + (3600 + 31 * 60 + 29) * 1000)
  assert.strictEqual(parseQuotaResetMs('Individual quota reached. Resets in 2m12s.', now), now + (2 * 60 + 12) * 1000)
  assert.strictEqual(parseQuotaResetMs('Resets in 45m', now), now + 45 * 60 * 1000)
  assert.strictEqual(parseQuotaResetMs('Resets in 30s', now), now + 30_000)
  assert.strictEqual(parseQuotaResetMs('RESETS IN 2M12S', now), now + (2 * 60 + 12) * 1000, '大小写不敏感')
  assert.strictEqual(parseQuotaResetMs('quota exceeded', now), undefined, '没有这句话就不能编一个')
  assert.strictEqual(
    parseQuotaResetMs('Resets in 0s', now),
    now,
    '「0 秒后重置」是有效答案：丢掉它会让账号池退回保守的 10 分钟停用'
  )
})

await check('带重置时间的 429 是终局：不换账号重试，直接报出 provider 的原因', async () => {
  const pool = makePool()
  const first = await pool.add(credsOf('a@b.c'))
  await pool.add(credsOf('d@e.f'))
  const result = await runAdapter(
    // 第一个账号吃到「带重置时间」的 429；第二个账号本来健康。
    token => (token.endsWith('access-a@b.c') ? new Response(quotaBody, { status: 429 }) : healthySse()),
    pool
  )
  // provider 量化了自己的恢复时间，这就是这次调用的最终答案 —— 再往下走
  // 只会把同样的 429 重学一遍。用户拿到的是真实配额信息，不是「未登录」。
  assert(result.error !== null, '带重置时间的 429 不许被下一个账号悄悄盖过去')
  assert.strictEqual(result.error.code, 'QUOTA_EXCEEDED')
  assert.match(result.error.message, /配额已用尽/)
  assert(result.seen.every(token => token.endsWith('access-a@b.c')), '不该去碰第二个账号：' + result.seen.join(','))
  assert.strictEqual(result.failures.length, 1, '失败只记一次')
  assert.strictEqual(result.failures[0].kind, 'quota')
  assert.strictEqual(result.failures[0].accountId, first.id)
  assert(
    result.failures[0].cooldownUntil > Date.now(),
    '429 里的 "Resets in 1h0m0s" 必须被解析成冷却时间'
  )
  const parked = pool.list().find(view => view.email === 'a@b.c')
  assert.strictEqual(parked.cooling, true)
  assert.strictEqual(parked.cooldownKind, 'hard', '带重置时间 = 硬冷却')
})

await check('不带重置时间的 429 仍是软冷却：换下一个账号继续试', async () => {
  const pool = makePool()
  await pool.add(credsOf('a@b.c'))
  await pool.add(credsOf('d@e.f'))
  const result = await runAdapter(
    // 429 但正文没说什么时候重置 —— 猜测的窗口，值得换人试。
    token => (token.endsWith('access-a@b.c') ? new Response('{"error":{"message":"rate limited"}}', { status: 429 }) : healthySse()),
    pool
  )
  assert.strictEqual(result.error, null, `软冷却必须还能换账号成功：${result.error}`)
  assert(result.seen.some(token => token.endsWith('access-d@e.f')), '第二个账号必须接手')
  assert.strictEqual(finishOf(result.chunks).reason.kind, 'stop')
  assert.strictEqual(result.failures[0].kind, 'quota')
  assert.strictEqual(result.failures[0].cooldownUntil, undefined, '没说重置时间就不能编一个')
  assert.strictEqual(pool.list().find(view => view.email === 'a@b.c').cooldownKind, 'soft')
})

await check('负控：传输类失败不换账号（换也没用）', async () => {
  const pool = makePool()
  await pool.add(credsOf('a@b.c'))
  await pool.add(credsOf('d@e.f'))
  const result = await runAdapter(() => new Response('boom', { status: 500 }), pool)
  assert(result.error, 'a transport failure must surface')
  assert(
    result.seen.every(token => token.endsWith('access-a@b.c')),
    `only the first account may be tried: ${JSON.stringify(result.seen)}`
  )
  assert.strictEqual(result.failures.length, 1)
  assert.strictEqual(result.failures[0].kind, 'other')
})

await check('带重置时间的配额耗尽：第一次就报真实配额错误，且只停那一个账号', async () => {
  const pool = makePool()
  const first = await pool.add(credsOf('a@b.c'))
  await pool.add(credsOf('d@e.f'))
  const result = await runAdapter(() => new Response(quotaBody, { status: 429 }), pool)
  assert(result.error, 'the call must fail')
  assert.match(result.error.message, /配额已用尽/)
  // provider 量化了恢复时间 ⇒ 这次调用的最终答案。第二个账号根本没被请求，
  // 所以它不该被记一笔失败，也不该被停 —— 下次调用还得靠它。
  assert.strictEqual(result.failures.length, 1, '只有真正被请求过的账号才记失败')
  assert.strictEqual(result.failures[0].accountId, first.id)
  const views = pool.list()
  assert.strictEqual(views.find(v => v.email === 'a@b.c').cooling, true, '吃到 429 的账号停用')
  assert.strictEqual(views.find(v => v.email === 'd@e.f').cooling, false, '没碰过的账号不该被牵连')
})

await check('全部账号都软冷却时，两个都被试过并各自记一笔', async () => {
  const pool = makePool()
  await pool.add(credsOf('a@b.c'))
  await pool.add(credsOf('d@e.f'))
  // 不带重置时间的 429 = 软冷却，值得逐个试；试完两个都不行才报错。
  const result = await runAdapter(
    () => new Response('{"error":{"message":"rate limited"}}', { status: 429 }),
    pool
  )
  assert(result.error, 'the call must fail')
  assert.strictEqual(result.failures.length, 2, '软冷却会走遍整个池子')
  assert.strictEqual(pool.list().filter(view => view.cooling).length, 2)
  assert(pool.list().every(view => view.cooldownKind === 'soft'), '这两笔都是猜测的窗口')
})

await check('鉴权失败（401）同样换账号', async () => {
  const pool = makePool()
  await pool.add(credsOf('a@b.c'))
  await pool.add(credsOf('d@e.f'))
  const result = await runAdapter(
    token => (token.endsWith('access-a@b.c') ? new Response('bad token', { status: 401 }) : healthySse()),
    pool
  )
  assert.strictEqual(result.error, null, `the call must succeed on the second account: ${result.error}`)
  assert.strictEqual(result.failures[0].kind, 'auth')
})

await check('单账号时 429 的报错文案与文案断言保持原样', async () => {
  const pool = makePool()
  await pool.add(credsOf('a@b.c'))
  const result = await runAdapter(() => new Response(quotaBody, { status: 429 }), pool)
  assert.match(result.error.message, /配额已用尽/)
  assert.match(result.error.message, /1h0m0s/, '重置时间必须留在文案里')
})

await check('真实配额报文（Resets in + RESOURCE_EXHAUSTED + reason）仍判为配额', async () => {
  const real = JSON.stringify({
    error: {
      code: 429,
      message: 'Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 26m31s.',
      status: 'RESOURCE_EXHAUSTED',
      details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'QUOTA_EXCEEDED' }]
    }
  })
  const pool = makePool()
  await pool.add(credsOf('a@b.c'))
  const before = Date.now()
  const result = await runAdapter(() => new Response(real, { status: 429 }), pool)
  assert.strictEqual(result.error.code, 'QUOTA_EXCEEDED', '配额必须留在不可重试集合之外')
  assert.match(result.error.message, /配额已用尽/)
  assert(
    result.error.retryAtMs >= before + 26 * 60 * 1000 && result.error.retryAtMs <= before + 27 * 60 * 1000,
    `26m31s 必须被解析成冷却时间，实际 ${result.error.retryAtMs}`
  )
  assert.strictEqual(pool.list()[0].cooling, true, '真配额用尽就该停用这个账号')
})

await check('429 但报文不是配额：code 保持 RATE_LIMIT（保住 DSH 重试），同时记成软冷却', async () => {
  const pool = makePool()
  await pool.add(credsOf('a@b.c'))
  // 报文里没有任何配额字样：这是被限流/网关抖动，等一个「重置时间」没有意义。
  const transient = '{"error":{"code":429,"message":"Rate Limit Exceeded"}}'
  const result = await runAdapter(() => new Response(transient, { status: 429 }), pool)
  assert(result.error, '全部端点都失败后仍然要把错误抛出来')
  // code 与 kind 回答的是两个不同的问题，所以这里两条必须同时成立：
  //   code —— DSH 的重试策略认得 RATE_LIMIT（不认得 QUOTA_EXCEEDED），
  //           编成 QUOTA_EXCEEDED 就等于永久退出自动重试；
  //   kind —— 对账号池来说这仍然是「这个号被限流了」，该软冷却、该换人。
  assert.strictEqual(
    result.error.code,
    'RATE_LIMIT',
    'dsh-llm-retry 的 retryableCodes 默认含 RATE_LIMIT；编成 QUOTA_EXCEEDED 就永远不会自动重试'
  )
  assert.strictEqual(result.error.quotaScoped, true, '但它仍然是账号级的限流，池子该看到这件事')
  assert.strictEqual(result.error.retryAtMs, undefined, '没说重置时间就不能凭空编一个')
  assert.doesNotMatch(result.error.message, /配额已用尽/, '文案不能把限流说成配额用尽')
  const view = pool.list()[0]
  assert.strictEqual(view.cooling, true, '限流也是账号级的，要软冷却（可以再试，但不是首选）')
  assert.strictEqual(view.cooldownKind, 'soft', '猜测的窗口 —— 不是 provider 量化的事实')
  assert(
    result.failures.every(failure => failure.kind === 'quota'),
    `账号级 429 记成 quota：${JSON.stringify(result.failures)}`
  )
})

await check('负控：配额 429 依旧被停用，不被上面的分流放过', async () => {
  const pool = makePool()
  await pool.add(credsOf('a@b.c'))
  const result = await runAdapter(() => new Response(quotaBody, { status: 429 }), pool)
  assert.strictEqual(result.error.code, 'QUOTA_EXCEEDED')
  assert.strictEqual(result.failures[0].kind, 'quota')
  assert.strictEqual(pool.list()[0].cooling, true)
})

await check('故障转移途中取不到下一个账号时，报出的是第一次的真实故障', async () => {
  let calls = 0
  const adapter = new GoogleAntigravityAdapter({
    resolveCredentials: async () => {
      calls += 1
      if (calls === 1) return { access: 'acc1', accountId: 'acc1', email: 'a@x.y' }
      throw new Error('Connect to oauth2.googleapis.com failed: ETIMEDOUT')
    }
  })
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => new Response(quotaBody, { status: 429 })
  try {
    for await (const _chunk of adapter.stream({ model: 'gemini-3.8-flash', messages: [{ role: 'user', content: 'hi' }] })) {
      /* drain */
    }
    assert.fail('the call must fail')
  } catch (error) {
    assert.match(error.message, /配额已用尽/, '真实故障是配额，不能被取下一个账号时的异常盖掉：' + error.message)
  } finally {
    globalThis.fetch = originalFetch
  }
})

await check('没有任何账号时抛出 MISSING_CREDENTIAL', async () => {
  const pool = makePool()
  const result = await runAdapter(() => healthySse(), pool)
  assert(result.error, 'a call without any account must fail')
  assert.strictEqual(result.error.code, 'MISSING_CREDENTIAL')
})

await check('某个端点 429 不会终止端点遍历（配额池按端点独立）', async () => {
  const pool = makePool()
  await pool.add(credsOf('a@b.c'))
  const urls = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = async url => {
    urls.push(String(url))
    if (String(url).includes('sandbox')) return healthySse()
    return new Response(quotaBody, { status: 429 })
  }
  try {
    const adapter = new GoogleAntigravityAdapter({
      resolveCredentials: (signal, exclude) => pool.resolve(signal, exclude)
    })
    const chunks = []
    for await (const chunk of adapter.stream({ model: 'gemini-3.8-flash', messages: [{ role: 'user', content: 'hi' }] })) {
      chunks.push(chunk)
    }
    assert.strictEqual(finishOf(chunks).reason.kind, 'stop', '第二个端点可用时这次调用必须成功')
    assert(urls.some(url => url.includes('daily-cloudcode-pa.googleapis.com')), '第一个端点必须先被尝试')
    assert(
      urls.some(url => url.includes('sandbox')),
      `429 之后必须继续试下一个端点（实测 daily 返回 200 的同一秒 cloudcode-pa 返回 429）: ${JSON.stringify(urls)}`
    )
  } finally {
    globalThis.fetch = originalFetch
  }
})

await check('端点迟迟不返回响应头时被放弃并切到下一个端点', async () => {
  const pool = makePool()
  await pool.add(credsOf('a@b.c'))
  const urls = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = (url, init) => {
    urls.push(String(url))
    if (String(url).includes('sandbox')) return Promise.resolve(healthySse())
    // A hang: never answers on its own, only lets go when the attempt aborts.
    return new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(new Error('the operation was aborted')))
    })
  }
  try {
    const adapter = new GoogleAntigravityAdapter({
      resolveCredentials: (signal, exclude) => pool.resolve(signal, exclude),
      firstByteTimeoutMs: 40
    })
    const started = Date.now()
    const chunks = []
    for await (const chunk of adapter.stream({ model: 'gemini-3.8-flash', messages: [{ role: 'user', content: 'hi' }] })) {
      chunks.push(chunk)
    }
    const elapsed = Date.now() - started
    assert.strictEqual(finishOf(chunks).reason.kind, 'stop', '超时后必须由下一个端点接管')
    assert(urls.length >= 2, `挂住的端点必须被放弃: ${JSON.stringify(urls)}`)
    assert(elapsed < 5000, `熔断必须立刻发生，而不是等到底层 TCP 超时: ${elapsed}ms`)
  } finally {
    globalThis.fetch = originalFetch
  }
})

await check('首包超时只覆盖响应头：头部到达后的长流不会被掐断', async () => {
  const pool = makePool()
  await pool.add(credsOf('a@b.c'))
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => {
    const body = new ReadableStream({
      async start(controller) {
        const encoder = new TextEncoder()
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify({ response: { candidates: [{ content: { parts: [{ text: 'a' }] } }] } })}\n\n`)
        )
        await new Promise(resolve => setTimeout(resolve, 150))
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify({ response: { candidates: [{ finishReason: 'STOP', content: { parts: [] } }] } })}\n\n`)
        )
        controller.close()
      }
    })
    return new Response(body, { status: 200 })
  }
  try {
    const adapter = new GoogleAntigravityAdapter({
      resolveCredentials: (signal, exclude) => pool.resolve(signal, exclude),
      firstByteTimeoutMs: 30
    })
    const chunks = []
    for await (const chunk of adapter.stream({ model: 'gemini-3.8-flash', messages: [{ role: 'user', content: 'hi' }] })) {
      chunks.push(chunk)
    }
    assert.strictEqual(finishOf(chunks).reason.kind, 'stop', '流必须完整读完，不能被 30ms 的首包超时当成挂起掐断')
    assert(chunks.some(chunk => chunk.type === 'text-delta'), '第一段内容必须送达')
  } finally {
    globalThis.fetch = originalFetch
  }
})

process.env.DSH_HOME = sharedHome

console.log(`\n所有 dsh-antigravity 单元测试通过（${passed} 项）`)
