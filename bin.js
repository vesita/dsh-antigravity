#!/usr/bin/env node
import http from 'node:http'
import {
  getValidCredentials,
  refreshAccessToken,
  loadCredentials,
  getAuthorizationUrl,
  exchangeCodeForTokens,
  clearCredentials
} from './src/auth.js'
import { MODEL_CATALOG } from './src/models.js'
import { createProxyServer } from './src/proxy.js'

const args = process.argv.slice(2)
const command = args[0] || 'status'

if (command === 'status') {
  console.log('--- Google Antigravity (DSH 适配器) 状态 ---')
  try {
    const creds = await getValidCredentials()
    console.log('认证状态: 已登录 (有效)')
    if (creds.email) console.log('账号:', creds.email)
    console.log('项目 ID:', creds.projectId)
    console.log('过期时间:', new Date(creds.expires).toLocaleString())
    console.log('剩余有效期:', Math.round((creds.expires - Date.now()) / 1000), '秒')
    console.log('\n支持的模型 (' + MODEL_CATALOG.length + '):')
    for (const m of MODEL_CATALOG) {
      console.log(` - ${m.id.padEnd(26)} -> 目标模型: ${m.wireId} (上下文: ${m.contextWindow})`)
    }
  } catch (err) {
    console.error('认证状态: 未登录或凭据无效:', err.message)
    console.log('\n请运行 "dsh-antigravity login" 以使用 Google 账号进行授权登录。')
    process.exit(1)
  }
} else if (command === 'login') {
  console.log('--- Google Antigravity OAuth 登录 ---')
  const authUrl = getAuthorizationUrl()

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1:51121')
    if (url.pathname === '/oauth-callback') {
      const code = url.searchParams.get('code')
      const error = url.searchParams.get('error')

      if (error) {
        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end(`<h2>授权失败: ${error}</h2><p>您可以关闭此标签页。</p>`)
        console.error('\n用户拒绝授权或 Google 授权出错:', error)
        server.close()
        process.exit(1)
        return
      }

      if (code) {
        try {
          console.log('\n收到 OAuth 授权码，正在换取令牌...')
          const creds = await exchangeCodeForTokens(code)
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
          res.end(`<h2>Google Antigravity 登录成功！</h2><p>关联项目: <b>${creds.projectId}</b></p><p>您可以关闭此标签页并返回终端。</p>`)
          console.log('登录成功！')
          if (creds.email) console.log('账号:', creds.email)
          console.log('项目 ID:', creds.projectId)
          console.log('凭据已保存至 ~/.dsh/antigravity-auth.json 与 ~/.omp/agent/agent.db')
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' })
          res.end(`<h2>换取令牌失败</h2><p>${err.message}</p>`)
          console.error('\n换取令牌失败:', err.message)
        } finally {
          server.close()
          process.exit(0)
        }
        return
      }
    }

    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
    res.end('未找到请求资源')
  })

  server.listen(51121, '127.0.0.1', () => {
    console.log('正在监听 OAuth 回调端点: http://127.0.0.1:51121/oauth-callback\n')
    console.log('请在浏览器中打开以下链接完成 Google 账号登录授权:')
    console.log('\n  ' + authUrl + '\n')
    console.log('正在等待浏览器端完成授权...（按 Ctrl+C 可取消）')
  })
} else if (command === 'logout') {
  console.log('正在退出 Google Antigravity 登录...')
  clearCredentials()
  console.log('已清除 ~/.dsh/antigravity-auth.json 和 ~/.omp/agent/agent.db 中的凭据')
} else if (command === 'refresh') {
  console.log('正在刷新 Google OAuth 令牌...')
  try {
    const creds = loadCredentials()
    const updated = await refreshAccessToken(creds)
    console.log('刷新成功！新过期时间:', new Date(updated.expires).toLocaleString())
  } catch (err) {
    console.error('刷新失败:', err.message)
    process.exit(1)
  }
} else if (command === 'proxy') {
  const portIdx = args.indexOf('--port')
  const port = portIdx !== -1 ? parseInt(args[portIdx + 1], 10) : 8045
  const hostIdx = args.indexOf('--host')
  const host = hostIdx !== -1 ? args[hostIdx + 1] : '127.0.0.1'

  const server = createProxyServer()
  server.listen(port, host, () => {
    console.log(`Google Antigravity OpenAI 兼容代理服务已启动: http://${host}:${port}/v1`)
    console.log(`可用端点:`)
    console.log(` - GET  http://${host}:${port}/v1/models`)
    console.log(` - POST http://${host}:${port}/v1/chat/completions`)
  })
} else {
  console.log('用法:')
  console.log('  dsh-antigravity login      通过 Google OAuth 登录 Antigravity')
  console.log('  dsh-antigravity logout     退出登录并清除本地凭据')
  console.log('  dsh-antigravity status     查看认证状态与可用模型列表')
  console.log('  dsh-antigravity refresh    强制刷新 OAuth 令牌')
  console.log('  dsh-antigravity proxy      启动 OpenAI 兼容代理服务 (--port 8045)')
}
