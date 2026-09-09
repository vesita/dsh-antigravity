import assert from 'node:assert'
import { Context } from '@deepseek-ai/cordis'
import { LlmRuntime } from '@deepseek-ai/dsh-llm'
import { getValidCredentials } from '../src/auth.js'
import { MODEL_CATALOG, resolveModelSpec } from '../src/models.js'
import { GoogleAntigravityAdapter } from '../src/adapter.js'
import antigravityPlugin from '../src/index.js'

console.log('# 1. 测试认证凭据')
const creds = await getValidCredentials()
assert(creds.access, '访问令牌 (Access Token) 必须存在')
assert(creds.projectId, '项目 ID (Project ID) 必须存在')
console.log('  ok  凭据有效，关联项目 ID:', creds.projectId)

console.log('# 2. 测试模型目录与规格解析')
assert(MODEL_CATALOG.length >= 10, '模型目录应包含至少 10 个模型')
const flashSpec = resolveModelSpec('gemini-3.8-flash')
assert.strictEqual(flashSpec.wireId, 'gemini-3.8-flash-tiered')
const claudeSpec = resolveModelSpec('claude-sonnet-4-6')
assert.strictEqual(claudeSpec.wireId, 'claude-sonnet-4-6')
console.log('  ok  模型映射与别名验证通过')

console.log('# 3. 测试 Cordis 插件注册')
const ctx = new Context()
new LlmRuntime(ctx)
await ctx.plugin(antigravityPlugin)

const providers = ctx.llm.listProviders().map(p => p.id)
assert(providers.includes('google-antigravity'), '提供商列表中必须包含 google-antigravity')
console.log('  ok  提供商已成功注册至 DSH LlmRuntime')

console.log('# 4. 测试通过 DSH LlmRuntime 解析模型信息')
const resolved = await ctx.llm.resolveModelInfo('google-antigravity', 'gemini-3.8-flash')
assert.strictEqual(resolved.id, 'gemini-3.8-flash')
assert.strictEqual(resolved.context.contextWindow, 1048576)
console.log('  ok  LlmRuntime 模型解析验证通过')

console.log('# 5. 测试通过 DSH LlmRuntime 发起 Antigravity 实时流式请求')
const chunks = []
for await (const chunk of ctx.llm.stream({
  provider: 'google-antigravity',
  model: 'gemini-3.8-flash',
  messages: [
    {
      role: 'user',
      content: [{ type: 'text', text: 'Respond with exactly: PONG' }]
    }
  ]
})) {
  chunks.push(chunk)
}

const textDeltas = chunks.filter(c => c.type === 'text-delta').map(c => c.text).join('')
console.log('  实时流式响应:', JSON.stringify(textDeltas.trim()))
assert(chunks.some(c => c.type === 'finish'), '流式块必须包含 finish 块')
console.log('  ok  Antigravity 实时流式传输执行成功')

console.log('\n所有 ANTIGRAVITY DSH 适配器测试通过！')
