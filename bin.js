#!/usr/bin/env node
import {
  DEFAULT_REDIRECT_URI,
  clearCredentials,
  getValidCredentials,
  readAuthFile,
  refreshAccessToken,
  saveCredentials
} from './src/auth.js'
import { LoginManager } from './src/auth-flow.js'
import { MODEL_CATALOG } from './src/models.js'
import { createProxyServer } from './src/proxy.js'

/**
 * Standalone CLI. It runs without a Cordis context, so credentials come from
 * the private `~/.dsh/antigravity-auth.json` mirror and the environment; the
 * DSH credential-record seam is used only when DSH itself mounts the plugin.
 */

const args = process.argv.slice(2)
const command = args[0] || 'status'

function flag(name, fallback) {
  const index = args.indexOf(`--${name}`)
  return index !== -1 && args[index + 1] !== undefined ? args[index + 1] : fallback
}

if (command === 'status') {
  console.log('--- Google Antigravity (DSH 适配器) 状态 ---')
  try {
    const creds = await getValidCredentials(undefined)
    console.log('认证状态: 已登录 (有效)')
    if (creds.email) console.log('账号:', creds.email)
    console.log('项目 ID:', creds.projectId)
    if (typeof creds.expires === 'number') {
      console.log('过期时间:', new Date(creds.expires).toLocaleString())
      console.log('剩余有效期:', Math.round((creds.expires - Date.now()) / 1000), '秒')
    }
    console.log('\n支持的模型 (' + MODEL_CATALOG.length + '):')
    for (const model of MODEL_CATALOG) {
      console.log(` - ${model.id.padEnd(26)} -> 目标模型: ${model.wireId} (上下文: ${model.contextWindow})`)
    }
  } catch (error) {
    console.error('认证状态: 未登录或凭据无效:', error.message)
    console.log('\n请运行 "dsh-antigravity login"，或在 DSH 的「设置 → 模型」中登录。')
    process.exit(1)
  }
} else if (command === 'login') {
  console.log('--- Google Antigravity OAuth 登录 ---')
  const manager = new LoginManager({
    redirectUri: flag('redirect-uri', DEFAULT_REDIRECT_URI),
    onSuccess: async creds => {
      await saveCredentials(undefined, creds)
    }
  })
  try {
    const url = await manager.begin()
    console.log('请在浏览器中打开以下链接完成 Google 账号授权:')
    console.log('\n  ' + url + '\n')
    console.log('正在等待浏览器端完成授权…（按 Ctrl+C 可取消）')
    const creds = await manager.completion()
    console.log('登录成功！')
    if (creds.email) console.log('账号:', creds.email)
    console.log('项目 ID:', creds.projectId)
    console.log('凭据已保存至', '~/.dsh/antigravity-auth.json')
  } catch (error) {
    console.error('登录失败:', error.message)
    process.exit(1)
  } finally {
    manager.dispose()
  }
} else if (command === 'logout') {
  console.log('正在退出 Google Antigravity 登录...')
  await clearCredentials(undefined)
  console.log('已清除本地凭据 (~/.dsh/antigravity-auth.json)')
} else if (command === 'refresh') {
  console.log('正在刷新 Google OAuth 令牌...')
  try {
    const creds = readAuthFile()
    if (!creds || !creds.access) throw new Error('未找到本地凭据，请先登录')
    const updated = await refreshAccessToken(creds, {})
    await saveCredentials(undefined, updated)
    console.log('刷新成功！新过期时间:', new Date(updated.expires).toLocaleString())
  } catch (error) {
    console.error('刷新失败:', error.message)
    process.exit(1)
  }
} else if (command === 'proxy') {
  const port = Number(flag('port', '8045'))
  const host = flag('host', '127.0.0.1')
  const server = createProxyServer({
    resolveModels: () => MODEL_CATALOG,
    resolveCredentials: () => getValidCredentials(undefined)
  })
  server.listen(port, host, () => {
    console.log(`Google Antigravity OpenAI 兼容代理服务已启动: http://${host}:${port}/v1`)
    console.log('可用端点:')
    console.log(` - GET  http://${host}:${port}/v1/models`)
    console.log(` - GET  http://${host}:${port}/v1/auth/status`)
    console.log(` - POST http://${host}:${port}/v1/chat/completions`)
  })
} else {
  console.log('用法:')
  console.log('  dsh-antigravity login              通过 Google OAuth 登录')
  console.log('  dsh-antigravity logout             退出登录并清除本地凭据')
  console.log('  dsh-antigravity status             查看认证状态与可用模型列表')
  console.log('  dsh-antigravity refresh            强制刷新 OAuth 令牌')
  console.log('  dsh-antigravity proxy [--port N]   启动 OpenAI 兼容代理服务')
}
