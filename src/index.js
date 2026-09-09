import { GoogleAntigravityAdapter } from './adapter.js'
import { MODEL_CATALOG } from './models.js'
import { createProxyServer } from './proxy.js'

export const name = 'dsh-antigravity'
export const inject = ['llm']

const DEFAULT_PORT = 8045

export function apply(ctx) {
  const adapter = new GoogleAntigravityAdapter()

  // 1. 在 ctx.llm 上注册原生适配器路由（直接流式传输，零延迟开销）
  const adapterHandle = ctx.llm.registerAdapter(['google-antigravity'], adapter)

  // 2. 启动内部轻量代理服务，兼容 DSH 设置界面 (llm-pi-ai)
  let proxyServer = null
  try {
    proxyServer = createProxyServer()
    proxyServer.unref() // 允许进程在需要时正常退出
    proxyServer.listen(DEFAULT_PORT, '127.0.0.1', () => {
      ctx.logger?.info?.(`dsh-antigravity: 内置 OpenAI 兼容代理服务已监听 http://127.0.0.1:${DEFAULT_PORT}`)
    })
    proxyServer.on('error', (err) => {
      if (err.code !== 'EADDRINUSE') {
        ctx.logger?.warn?.(`dsh-antigravity 代理服务错误: ${err.message}`)
      }
    })
  } catch (err) {
    ctx.logger?.warn?.(`dsh-antigravity 代理服务初始化失败: ${err.message}`)
  }

  // 3. 注册为 llm-pi-ai 家族下的可配置提供商，使 DSH Web 界面可直接查看与编辑
  let configHandle = null
  try {
    configHandle = ctx.llm.registerConfigurableProviders([
      {
        provider: 'google-antigravity',
        displayName: 'Google Antigravity',
        settingsNs: 'llm-pi-ai',
        settingsPath: ['providers', 'google-antigravity']
      }
    ])
  } catch {}

  ctx.on('dispose', () => {
    try { adapterHandle?.dispose?.() } catch {}
    try { configHandle?.dispose?.() } catch {}
    try { proxyServer?.close?.() } catch {}
  })
}

export default { name, inject, apply }
export { GoogleAntigravityAdapter }
