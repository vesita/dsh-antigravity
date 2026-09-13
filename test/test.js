import assert from 'node:assert'
import { Context } from '@deepseek-ai/cordis'
import { LlmRuntime } from '@deepseek-ai/dsh-llm'
import { buildRequest, mapUsage, parseStream } from '../lib/adapter.js'
import {
  CREDENTIAL_KEY,
  fromGrantRecord,
  getAuthorizationUrl,
  isExpiring,
  parseRedirectUri,
  readAuthFile,
  resolveOAuthClient,
  toGrantRecord,
  writeAuthFile
} from '../lib/auth.js'
import { MODEL_CATALOG, resolveModelSpec } from '../lib/models.js'
import antigravityPlugin from '../lib/index.js'

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
  assert.deepStrictEqual([...entry.settingsPath], ['account'])
  assert.strictEqual(entry.declared, false)
})
await check('the account marker has no default, so the entry starts dormant', () => {
  // `configured` is `settingsPath.length === 0 || getPath(value, settingsPath)
  // !== undefined`, so an unset marker is what keeps the row out of the page
  // until somebody signs in.
  assert.strictEqual(antigravityPlugin.Config({}).account, undefined)
  assert.strictEqual(antigravityPlugin.Config({ account: 'a@b.c' }).account, 'a@b.c', 'the schema must keep the marker')
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
await check('apply registers the provider-card cell', () => {
  const injections = []
  const registrations = []
  const fakeCtx = {
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
  assert.deepStrictEqual(injections, ['settings.models.provider-card', 'settings.section'])
  const card = registrations.find(entry => entry.options.name === 'settings.models.provider-card')
  assert.strictEqual(card.options.key, 'llm-antigravity')
  assert.strictEqual(typeof card.component, 'function')
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

await check('没有账户时不注册用量页', async () => {
  const registrations = await applyWithAccount(false)
  assert.strictEqual(
    registrations.find(entry => entry.options.name === 'settings.section'),
    undefined,
    'an account-less install must not show the usage page'
  )
})

await check('有账户时注册用量页', async () => {
  const registrations = await applyWithAccount(true)
  const usage = registrations.find(entry => entry.options.name === 'settings.section')
  assert.ok(usage, 'an installed account must show the usage page')
  assert.strictEqual(usage.options.id, 'antigravity-usage')
  assert.strictEqual(usage.options.order, 30)
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
await check('card says why an attempt ended without a grant', () => {
  const face = registration.factory(
    requireFace(fakeReact([{ authenticated: false, pending: false, error: '登录已取消' }]))
  )
  const text = textOf(face.AntigravityCard({ provider: { provider: 'google-antigravity' } })).join(' | ')
  assert.match(text, /登录已取消/)
})
await check('the draft copy renders while the provider still has no row', () => {
  const face = registration.factory(
    requireFace(fakeReact([{ authenticated: true, email: 'a@b.c' }], []))
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
  const mounted = registration.factory(
    requireFace(fakeReact([{ authenticated: true, email: 'a@b.c' }], refs))
  )
  const dormant = { provider: { provider: 'google-antigravity', settingsNs: 'llm-antigravity' }, configured: false }
  assert.notStrictEqual(mounted.AntigravityCard(dormant), null)
  const rerendered = registration.factory(
    requireFace(fakeReact([{ authenticated: true, email: 'a@b.c' }], refs))
  )
  assert.strictEqual(
    rerendered.AntigravityCard({ ...dormant, configured: true }),
    null,
    'the draft must not keep a card the saved row already renders'
  )
})
await check('the saved row copy keeps its card once configured', () => {
  const face = registration.factory(
    requireFace(fakeReact([{ authenticated: true, email: 'a@b.c', projectId: 'proj', timeLeftSeconds: 600 }]))
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

/** Invoke a registered route handler the way the web server would. */
async function request(method, path) {
  const route = routes.get(path)
  assert(route, `${path} must be registered`)
  const res = fakeRes()
  await route.handler({ method, url: path, headers: {} }, res)
  return { status: res.statusCode, headers: res.headers, body: res.body ? JSON.parse(res.body) : null }
}

const STATUS = '/dsh-antigravity/auth/status'
const LOGIN = '/dsh-antigravity/auth/login'
const CANCEL = '/dsh-antigravity/auth/cancel'
const LOGOUT = '/dsh-antigravity/auth/logout'

await check('the host registers exactly the four routes the card calls', () => {
  const authPaths = [...registeredPaths].filter(entry => entry.startsWith('/dsh-antigravity/auth')).sort()
  assert.deepStrictEqual(authPaths, [CANCEL, LOGIN, LOGOUT, STATUS])
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
  let hooks = null
  const calls = []
  return {
    service: {
      installSection(owner, ns, schema, entry, captured) {
        hooks = captured
        captured.setSource(() => value)
        captured.onChange()
      },
      async mutate(ns, ops) {
        calls.push({ ns, ops })
        for (const op of ops) {
          if (op.path.length !== 1) continue
          if (op.op === 'set') value = { ...value, [op.path[0]]: op.value }
          else {
            const { [op.path[0]]: _dropped, ...rest } = value
            value = rest
          }
        }
        if (hooks) hooks.onChange()
      }
    },
    calls,
    read: () => value,
    /** What the row's native 「移除」 does: unset the path, then notify. */
    removeAccountMarker() {
      const { account, ...rest } = value
      value = rest
      if (hooks) hooks.onChange()
    },
    /** Any unrelated settings edit. */
    notify() {
      if (hooks) hooks.onChange()
    }
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
const markerPort = await freePort()
await markerCtx.plugin(antigravityPlugin, { redirectUri: `http://127.0.0.1:${markerPort}/oauth-callback` })
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
await check('an account with no marker installs the row when the card reads it', async () => {
  writeAuthFile({ access: 'seeded-access', projectId: 'aicode-consumers', expires: Date.now() + 3_600_000 })
  const { body } = await markerCall('GET', STATUS)
  assert.strictEqual(body.authenticated, true)
  const set = markerSettings.calls.filter(call => call.ops[0].op === 'set')
  assert.deepStrictEqual(set, [
    { ns: 'llm-antigravity', ops: [{ op: 'set', path: ['account'], value: 'aicode-consumers' }] }
  ])
  await markerCall('GET', STATUS)
  assert.strictEqual(markerSettings.calls.length, 1, 'a present marker must not be rewritten')
})
await check('an unrelated settings edit keeps the grant', async () => {
  markerSettings.notify()
  await settle()
  assert(markerSettings.calls.length === 1)
  assert(readAuthFile(), 'the grant must survive a settings change that leaves the marker alone')
})
await check('the row\'s native 移除 takes the account with it', async () => {
  markerSettings.removeAccountMarker()
  await settle()
  assert.strictEqual(markerSettings.read().account, undefined)
  assert.strictEqual(readAuthFile(), null, 'removing the marker must remove the grant')
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

console.log(`\n所有 dsh-antigravity 单元测试通过（${passed} 项）`)
