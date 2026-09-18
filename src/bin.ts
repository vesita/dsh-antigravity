#!/usr/bin/env node
import { DEFAULT_REDIRECT_URI } from './auth.js'
import { AccountPool, accountsFilePath } from './accounts.js'
import { LoginManager } from './auth-flow.js'
import { MODEL_CATALOG } from './models.js'
import { createProxyServer } from './proxy.js'

/**
 * Standalone CLI. It runs without a Cordis context, so credentials come from
 * this plugin's own account registry and its legacy single-account mirror; the
 * DSH credential-record seam is used only when DSH itself mounts the plugin.
 *
 * It drives the same {@link AccountPool} the host half does, which is what makes
 * the two agree: an account added from a terminal is in the pool the next time
 * a running DSH asks for one, and a quota park set by a live call is visible
 * here.
 */

const args = process.argv.slice(2)
const command = args[0] || 'status'

function flag(name: string, fallback: string): string {
  const index = args.indexOf(`--${name}`)
  return index !== -1 && args[index + 1] !== undefined ? args[index + 1] : fallback
}

const pool = new AccountPool({
  warn: (message: string) => console.warn(message)
})

/** One line per account, the shape every list-printing command shares. */
function printAccounts(): void {
  const views = pool.list()
  if (views.length === 0) {
    console.log('尚未安装任何账号。运行 "dsh-antigravity login" 添加一个。')
    return
  }
  console.log(`已安装 ${views.length} 个账号（注册表：${accountsFilePath()}）:`)
  for (const view of views) {
    const marks = [
      view.active ? '默认' : null,
      view.cooling ? `配额冷却 ${Math.max(1, Math.round((view.cooldownSeconds || 0) / 60))} 分钟` : null,
      view.expired ? '令牌已过期' : null
    ].filter(Boolean)
    const suffix = marks.length > 0 ? ` [${marks.join(' / ')}]` : ''
    console.log(` - ${view.id}  ${view.email || view.label}${view.projectId ? ` (${view.projectId})` : ''}${suffix}`)
  }
}

if (command === 'status') {
  console.log('--- Google Antigravity (DSH 适配器) 状态 ---')
  try {
    await pool.ready()
    const creds = await pool.resolveActive()
    if (!creds) throw new Error('未找到本地凭据，请先登录')
    console.log(`认证状态: 已登录（${pool.count()} 个账号，默认 ${pool.activeLabel() ?? '—'}）`)
    console.log('账号:', creds.email || '(未知)')
    console.log('项目 ID:', creds.projectId)
    if (typeof creds.expires === 'number') {
      console.log('过期时间:', new Date(creds.expires).toLocaleString())
      console.log('剩余有效期:', Math.round((creds.expires - Date.now()) / 1000), '秒')
    }
    printAccounts()
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
      await pool.add(creds)
    }
  })
  try {
    const url = await manager.begin()
    console.log('请在浏览器中打开以下链接完成 Google 账号授权:')
    console.log('\n  ' + url + '\n')
    console.log('正在等待浏览器端完成授权…（按 Ctrl+C 可取消）')
    const creds = await manager.completion()
    console.log('登录成功！本次账号已登记为默认账号。')
    console.log('账号:', creds.email || '(未知)')
    console.log('项目 ID:', creds.projectId)
    printAccounts()
  } catch (error) {
    console.error('登录失败:', error.message)
    process.exit(1)
  } finally {
    manager.dispose()
  }
} else if (command === 'accounts') {
  const removeId = flag('remove', '')
  const activeId = flag('active', '')
  await pool.ready()
  if (removeId !== '') {
    const removed = await pool.remove(removeId)
    console.log(removed ? `已移除账号 ${removeId}` : `未找到账号 ${removeId}`)
  }
  if (activeId !== '') {
    const switched = await pool.setActive(activeId)
    console.log(switched ? `默认账号已切换为 ${activeId}` : `未找到账号 ${activeId}`)
  }
  printAccounts()
} else if (command === 'logout') {
  // Two different intents, two commands' worth of meaning: the bare command has
  // always meant "forget everything", and `--account <id>` forgets one.
  const id = flag('account', '')
  if (id !== '') {
    const removed = await pool.remove(id)
    console.log(removed ? `已移除账号 ${id}` : `未找到账号 ${id}`)
    printAccounts()
  } else {
    await pool.clear()
    console.log('已清除全部账号凭据（', accountsFilePath(), '与旧镜像 ~/.dsh/antigravity-auth.json）')
  }
} else if (command === 'refresh') {
  console.log('正在刷新 Google OAuth 令牌...')
  try {
    const updated = await pool.refreshNow()
    if (!updated) throw new Error('未找到本地凭据，请先登录')
    console.log('刷新成功！账号:', updated.email || '(未知)')
    console.log('新过期时间:', new Date(updated.expires).toLocaleString())
  } catch (error) {
    console.error('刷新失败:', error.message)
    process.exit(1)
  }
} else if (command === 'proxy') {
  const port = Number(flag('port', '8045'))
  const host = flag('host', '127.0.0.1')
  const server = createProxyServer({
    resolveModels: () => MODEL_CATALOG,
    resolveCredentials: signal => pool.resolve(signal)
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
  console.log('  dsh-antigravity login                    通过 Google OAuth 登录并登记一个账号')
  console.log('  dsh-antigravity accounts                 列出全部账号')
  console.log('  dsh-antigravity accounts --active <id>   把某个账号设为默认')
  console.log('  dsh-antigravity accounts --remove <id>   移除某个账号')
  console.log('  dsh-antigravity logout                   清除全部账号')
  console.log('  dsh-antigravity logout --account <id>    只清除某个账号')
  console.log('  dsh-antigravity status                   查看认证状态与可用模型列表')
  console.log('  dsh-antigravity refresh                  强制刷新默认账号的 OAuth 令牌')
  console.log('  dsh-antigravity proxy [--port N]         启动 OpenAI 兼容代理服务')
}
