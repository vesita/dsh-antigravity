import assert from 'node:assert'
import {
  DEFAULT_PRICING,
  addCost,
  addTokens,
  alignBucket,
  computeCost,
  emptyCost,
  emptyTokens,
  groupBy,
  isFailure,
  isUsageRange,
  percentile,
  priceOf,
  projectLabel,
  rangeSpec,
  seriesOf,
  summarize
} from '../lib/usage-model.js'
import { UsageStore } from '../lib/usage-store.js'
import { UsageCollector, tokensOf } from '../lib/usage-collector.js'
import { buildRequests, buildSnapshot, lastBackfillOf } from '../lib/usage-routes.js'

/**
 * Unit tests for the pure usage model. No DSH context, no filesystem: these
 * assert the arithmetic the panel is allowed to claim.
 */

let passed = 0
function check(label, fn) {
  fn()
  passed += 1
  console.log(`  ok  ${label}`)
}

console.log('# 1. 令牌桶与成本口径')

check('emptyTokens 全为 0', () => {
  const t = emptyTokens()
  assert.strictEqual(t.totalTokens, 0)
  assert.strictEqual(t.inputTokens + t.outputTokens + t.cacheReadTokens + t.cacheWriteTokens, 0)
})

check('addTokens 用四维之和补 totalTokens', () => {
  const t = addTokens(emptyTokens(), { inputTokens: 10, outputTokens: 20, cacheReadTokens: 30, cacheWriteTokens: 40 })
  assert.strictEqual(t.totalTokens, 100)
})

check('addTokens 忽略负数与非法值', () => {
  const t = addTokens(emptyTokens(), { inputTokens: -5, outputTokens: Number.NaN, cacheReadTokens: 3 })
  assert.strictEqual(t.inputTokens, 0)
  assert.strictEqual(t.outputTokens, 0)
  assert.strictEqual(t.cacheReadTokens, 3)
})

check('computeCost 按 USD/1M 计价', () => {
  const cost = computeCost({ inputTokens: 1_000_000, outputTokens: 1_000_000 }, DEFAULT_PRICING['gemini-3.8-flash'])
  assert.strictEqual(Math.round(cost.input * 1e6) / 1e6, 0.75)
  assert.strictEqual(cost.output, 3.75)
  assert.strictEqual(cost.total, 4.5)
  assert.strictEqual(cost.priced, true)
})

check('cacheSavings：缓存读取便宜 10 倍时省 90%', () => {
  const cost = computeCost({ cacheReadTokens: 1_000_000 }, DEFAULT_PRICING['gemini-3.8-flash'])
  assert.strictEqual(cost.noCacheInput, 0.75)
  assert.strictEqual(cost.cacheRead, 0.075)
  const savings = 1 - (cost.input + cost.cacheRead + cost.cacheWrite) / cost.noCacheInput
  assert.ok(Math.abs(savings - 0.9) < 1e-12, `期望 0.9，实得 ${savings}`)
})

check('未知模型 → priced=false（计入 unpriced）', () => {
  const cost = computeCost({ inputTokens: 1000 }, undefined)
  assert.strictEqual(cost.total, 0)
  assert.strictEqual(cost.priced, false)
})

check('零令牌请求不算 unpriced', () => {
  assert.strictEqual(computeCost(emptyTokens(), undefined).priced, true)
})

check('priceOf 让 tiered 别名回落到基础模型', () => {
  assert.strictEqual(priceOf('gemini-3.8-flash-tiered').input, 0.75)
  assert.strictEqual(priceOf('claude-opus-4-6').output, 25)
  assert.strictEqual(priceOf('unknown-model'), undefined)
})

console.log('# 2. 失败判定与时间窗')

check('只有 error 算失败，aborted 不算', () => {
  assert.strictEqual(isFailure('error'), true)
  assert.strictEqual(isFailure('ERROR'), true)
  assert.strictEqual(isFailure('aborted'), false)
  assert.strictEqual(isFailure('stop'), false)
  assert.strictEqual(isFailure('tool-calls'), false)
})

check('rangeSpec 的窗口与桶宽', () => {
  const now = 1_000_000_000_000
  assert.strictEqual(rangeSpec('1h', now).since, now - 3_600_000)
  assert.strictEqual(rangeSpec('24h', now).bucketMs, 3_600_000)
  assert.strictEqual(rangeSpec('7d', now).since, now - 7 * 86_400_000)
  assert.strictEqual(rangeSpec('all', now).since, undefined)
})

check('isUsageRange 拒绝未知值', () => {
  assert.strictEqual(isUsageRange('24h'), true)
  assert.strictEqual(isUsageRange('2d'), false)
  assert.strictEqual(isUsageRange(undefined), false)
})

check('alignBucket 向下对齐本地桶', () => {
  assert.strictEqual(alignBucket(3_600_000 * 5 + 123, 3_600_000), 3_600_000 * 5)
})

console.log('# 3. 聚合')

const record = (over = {}) => ({
  time: 1_000_000,
  sessionId: 's1',
  cwd: '/home/u/coding/my',
  model: 'gemini-3.8-flash',
  agentType: 'main',
  ttftMs: null,
  durationMs: null,
  stopReason: 'stop',
  errorMessage: '',
  tokens: emptyTokens(),
  ...over
})

check('summarize 计数、成功率与错误率', () => {
  const overview = summarize([
    record({ stopReason: 'stop' }),
    record({ stopReason: 'tool-calls' }),
    record({ stopReason: 'aborted' }),
    record({ stopReason: 'error' })
  ])
  assert.strictEqual(overview.requests, 4)
  assert.strictEqual(overview.failed, 1)
  assert.strictEqual(overview.successful, 3)
  assert.strictEqual(overview.errorRate, 0.25)
})

check('summarize 的 cacheRate = cacheRead/(input+cacheRead)', () => {
  const overview = summarize([
    record({ tokens: addTokens(emptyTokens(), { inputTokens: 1000, cacheReadTokens: 3000 }) })
  ])
  assert.strictEqual(overview.cacheRate, 0.75)
})

check('summarize 的均值只统计有值的行', () => {
  const overview = summarize([
    record({ ttftMs: 100, durationMs: 1000 }),
    record({ ttftMs: 300, durationMs: 3000 }),
    record({ ttftMs: null, durationMs: null })
  ])
  assert.strictEqual(overview.avgTtftMs, 200)
  assert.strictEqual(overview.avgDurationMs, 2000)
})

check('summarize 的 tokensPerSecond = 输出令牌/总时长', () => {
  const overview = summarize([
    record({ durationMs: 1000, tokens: addTokens(emptyTokens(), { outputTokens: 50 }) }),
    record({ durationMs: 1000, tokens: addTokens(emptyTokens(), { outputTokens: 50 }) })
  ])
  assert.strictEqual(overview.tokensPerSecond, 50)
})

check('summarize 空集安全', () => {
  const overview = summarize([])
  assert.strictEqual(overview.requests, 0)
  assert.strictEqual(overview.errorRate, 0)
  assert.strictEqual(overview.avgTtftMs, null)
  assert.strictEqual(overview.tokensPerSecond, null)
  assert.strictEqual(overview.firstTime, null)
})

check('summarize 统计首末时间与 unpriced', () => {
  const overview = summarize([
    record({ time: 500, model: 'claude-opus-4-6-thinking', tokens: addTokens(emptyTokens(), { inputTokens: 10 }) }),
    record({ time: 900 })
  ])
  assert.strictEqual(overview.firstTime, 500)
  assert.strictEqual(overview.lastTime, 900)
  assert.strictEqual(overview.unpricedRequests, 1)
})

console.log('# 4. 时间序列与分组')

check('seriesOf 填充空桶且升序', () => {
  const now = alignBucket(1_000_000_000, 3_600_000)
  const spec = rangeSpec('24h', now)
  const points = seriesOf([record({ time: now })], spec, now)
  assert.strictEqual(points.length, 25)
  assert.ok(points[0].time < points[points.length - 1].time)
  assert.strictEqual(points.reduce((sum, p) => sum + p.requests, 0), 1)
  assert.strictEqual(points[points.length - 1].requests, 1)
})

check('seriesOf 区分错误数', () => {
  const now = 3_600_000
  const spec = rangeSpec('24h', now)
  const points = seriesOf([record({ time: now, stopReason: 'error' })], spec, now)
  const last = points[points.length - 1]
  assert.strictEqual(last.requests, 1)
  assert.strictEqual(last.errors, 1)
})

check('groupBy 按请求数降序', () => {
  const groups = groupBy(
    [
      record({ model: 'a' }),
      record({ model: 'b' }),
      record({ model: 'b' }),
      record({ model: 'b' })
    ],
    r => r.model
  )
  assert.strictEqual(groups.length, 2)
  assert.strictEqual(groups[0].key, 'b')
  assert.strictEqual(groups[0].overview.requests, 3)
})

check('groupBy 把空 key 归到 (unknown)', () => {
  assert.strictEqual(groupBy([record({ cwd: '' })], r => r.cwd)[0].key, '(unknown)')
})

console.log('# 5. 展示辅助')

check('percentile 用最近秩法', () => {
  assert.strictEqual(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.5), 5)
  assert.strictEqual(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.95), 10)
  assert.strictEqual(percentile([], 0.95), null)
})

check('projectLabel 保留末两段', () => {
  assert.strictEqual(projectLabel('/home/vesita/coding/my'), 'coding/my')
  assert.strictEqual(projectLabel('/home/vesita/coding/my/'), 'coding/my')
  assert.strictEqual(projectLabel(''), '(unknown)')
})

check('addCost 累加并传播 priced', () => {
  const cost = addCost(computeCost({ inputTokens: 1_000_000 }, DEFAULT_PRICING['gemini-3.8-flash']), emptyCost())
  assert.strictEqual(cost.total, 0.75)
  assert.strictEqual(cost.priced, true)
})

console.log('# 6. 持久化、采集与快照')

const { mkdtempSync } = await import('node:fs')
const { tmpdir } = await import('node:os')
const { join } = await import('node:path')
// Hand-built databases below need the raw driver: one case opens a database
// written by the previous schema version.
const { DatabaseSync } = await import('node:sqlite')
const storeDir = mkdtempSync(join(tmpdir(), 'dsh-antigravity-usage-'))
const store = new UsageStore(join(storeDir, 'usage.db'))

check('store 写入并读回记录', () => {
  const wrote = store.insert('k1', record({ time: 1000, tokens: addTokens(emptyTokens(), { inputTokens: 10, outputTokens: 5 }) }))
  assert.strictEqual(wrote, true)
  const rows = store.query({})
  assert.strictEqual(rows.length, 1)
  assert.strictEqual(rows[0].tokens.totalTokens, 15)
})

check('store 对同一 key 幂等', () => {
  assert.strictEqual(store.insert('k1', record({ time: 1000 })), false)
  assert.strictEqual(store.stats().total, 1)
})

check('store 支持窗口、模型与错误过滤', () => {
  store.insert('k2', record({ time: 5000, model: 'claude-opus-4-6' }))
  assert.strictEqual(store.query({ since: 2000 }).length, 1)
  assert.strictEqual(store.query({ model: 'claude-opus-4-6' }).length, 1)
  assert.strictEqual(store.query({ errorsOnly: true }).length, 0)
  assert.strictEqual(store.query({ limit: 1 }).length, 1)
})

check('store 统计与按时间清理', () => {
  const stats = store.stats()
  assert.strictEqual(stats.total, 2)
  assert.strictEqual(stats.sessions, 1)
  assert.strictEqual(stats.firstTime, 1000)
  assert.strictEqual(store.prune(2000), 1)
  assert.strictEqual(store.stats().total, 1)
})

check('store 元数据往返', () => {
  store.setMeta('schema', '1')
  assert.strictEqual(store.meta('schema'), '1')
  assert.strictEqual(store.meta('missing'), undefined)
})

check('store 记录并读回服务调用的账号', () => {
  const probe = new UsageStore(':memory:')
  probe.insert('k-acct-1', record({ time: 10, account: 'a@b.c' }))
  probe.insert('k-acct-2', record({ time: 11 }))
  const rows = probe.query({})
  assert.strictEqual(rows.find(row => row.time === 10).account, 'a@b.c')
  assert.strictEqual(
    'account' in rows.find(row => row.time === 11),
    false,
    '没有账号的行不得被编造一个'
  )
  probe.close()
})

check('旧库（无 account 列）打开时自动补列，历史行全部保留', () => {
  // The one migration this plugin performs on someone's existing usage
  // database. A deployment that has been recording since before multi-account
  // keeps every row and gains an empty owner column.
  const legacyPath = join(storeDir, 'legacy.db')
  const legacy = new DatabaseSync(legacyPath)
  legacy.exec(`CREATE TABLE usage_records (
    key TEXT PRIMARY KEY,
    time INTEGER NOT NULL,
    session_id TEXT NOT NULL DEFAULT '',
    cwd TEXT NOT NULL DEFAULT '',
    model TEXT NOT NULL DEFAULT '',
    agent_type TEXT NOT NULL DEFAULT 'main',
    ttft_ms INTEGER,
    duration_ms INTEGER,
    stop_reason TEXT NOT NULL DEFAULT '',
    error_message TEXT NOT NULL DEFAULT '',
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    cache_read_tokens INTEGER NOT NULL DEFAULT 0,
    cache_write_tokens INTEGER NOT NULL DEFAULT 0,
    reasoning_tokens INTEGER NOT NULL DEFAULT 0,
    total_tokens INTEGER NOT NULL DEFAULT 0
  )`)
  legacy.exec('CREATE TABLE usage_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
  legacy.exec('CREATE TABLE usage_files (path TEXT PRIMARY KEY, mtime_ms REAL NOT NULL, size INTEGER NOT NULL)')
  legacy.exec("INSERT INTO usage_records (key, time, model, total_tokens) VALUES ('old-1', 100, 'gemini-3.8-flash', 42)")
  legacy.exec("INSERT INTO usage_meta (key, value) VALUES ('schema', '1')")
  legacy.close()

  const upgraded = new UsageStore(legacyPath)
  const rows = upgraded.query({})
  assert.strictEqual(rows.length, 1, '历史行必须留着')
  assert.strictEqual(rows[0].tokens.totalTokens, 42)
  assert.strictEqual('account' in rows[0], false, '升级前写入的行没有主，不许编一个')
  assert.strictEqual(upgraded.meta('schema'), '2', 'schema 版本必须升到 2')
  assert.strictEqual(upgraded.insert('new-1', record({ time: 200, account: 'd@e.f' })), true, '补列后必须能继续写')
  assert.strictEqual(upgraded.query({})[0].account, 'd@e.f')
  upgraded.close()
})

check('已记录更高 schema 版本的库不会被旧代码降级标记', () => {
  const futurePath = join(storeDir, 'future.db')
  const future = new DatabaseSync(futurePath)
  future.exec('CREATE TABLE usage_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
  future.exec("INSERT INTO usage_meta (key, value) VALUES ('schema', '3')")
  future.close()
  const opened = new UsageStore(futurePath)
  assert.strictEqual(opened.meta('schema'), '3', '版本只能前进，不能被旧代码写回旧值')
  opened.close()
})

check('明细可以按账号过滤，空串筛的是「没有主」的历史行', () => {
  const probe = new UsageStore(':memory:')
  probe.insert('k-f1', record({ time: 10, account: 'a@b.c' }))
  probe.insert('k-f2', record({ time: 11, account: 'd@e.f' }))
  probe.insert('k-f3', record({ time: 12 }))
  assert.strictEqual(probe.query({ account: 'a@b.c' }).length, 1)
  assert.strictEqual(probe.query({ account: '' }).length, 1, '空串是有意义的筛选值，不是「不过滤」')
  assert.strictEqual(probe.query({}).length, 3)
  assert.strictEqual(buildRequests(probe, DEFAULT_PRICING, { range: 'all', account: 'd@e.f' }).length, 1)
  probe.close()
})

check('快照按账号分组，未记录账号的历史归入 (unknown)', () => {
  const probe = new UsageStore(':memory:')
  probe.insert('k-a1', record({ time: 1_000_000, account: 'a@b.c' }))
  probe.insert('k-a2', record({ time: 1_000_001, account: 'a@b.c' }))
  probe.insert('k-a3', record({ time: 1_000_002, account: 'd@e.f' }))
  probe.insert('k-a4', record({ time: 1_000_003 }))
  const snapshot = buildSnapshot(probe, DEFAULT_PRICING, 'all', { now: 1_000_004 })
  const byKey = Object.fromEntries(snapshot.accounts.map(row => [row.key, row.overview.requests]))
  assert.deepStrictEqual(byKey, { 'a@b.c': 2, 'd@e.f': 1, '(unknown)': 1 })
  probe.close()
})

check('buildSnapshot 汇总窗口内的记录', () => {
  const snapshot = buildSnapshot(store, DEFAULT_PRICING, '24h', { enabled: true, now: 10_000 })
  assert.strictEqual(snapshot.overview.requests, 1)
  assert.strictEqual(snapshot.status.total, 1)
  assert.strictEqual(snapshot.status.enabled, true)
  assert.strictEqual(snapshot.status.bucketTimezone, 'local')
  assert.ok(snapshot.series.length > 0)
  assert.strictEqual(snapshot.models.length, 1)
  assert.strictEqual(snapshot.recent.length, 1)
})

check('快照按会话分组：key 是完整 session id，label 是短标签', () => {
  // The data layer already stores session_id (indexed), so this is pure aggregation —
  // no schema change, no migration. Checked against hand-built records so the labels
  // are pinned rather than inferred.
  const probe = new UsageStore(':memory:')
  probe.insert('k-long-1', record({ sessionId: 'session-2f2e2587-ad46-4a7e-ac59-058041f3156e', time: 1_000_000 }))
  probe.insert('k-long-2', record({ sessionId: 'session-2f2e2587-ad46-4a7e-ac59-058041f3156e', time: 1_000_001 }))
  probe.insert('k-bare', record({ sessionId: '9eed14a9-149a-4e31-a714-6b5654df2ab1', time: 1_000_002 }))
  probe.insert('k-none', record({ sessionId: '', time: 1_000_003 }))
  const snapshot = buildSnapshot(probe, DEFAULT_PRICING, 'all', { now: 1_000_004 })
  const keys = snapshot.sessions.map(row => row.key).sort()
  assert.deepStrictEqual(keys, [
    '(unknown)',
    '9eed14a9-149a-4e31-a714-6b5654df2ab1',
    'session-2f2e2587-ad46-4a7e-ac59-058041f3156e'
  ], '每个会话一组，空 id 归入 (unknown)：' + JSON.stringify(keys))
  const top = snapshot.sessions.find(row => row.key.startsWith('session-'))
  assert.strictEqual(top.label, '2f2e2587', '长 id 缩短成前 8 位：' + top.label)
  assert.strictEqual(top.overview.requests, 2, '同一会话的两条记录合并成一组')
  const bare = snapshot.sessions.find(row => row.key.startsWith('9eed'))
  assert.strictEqual(bare.label, '9eed14a9', '没有 session- 前缀的 id 也照缩短')
  // 分组必须加起来等于总数 —— 否则表会看着"少了调用"。
  const sum = snapshot.sessions.reduce((n, row) => n + row.overview.requests, 0)
  assert.strictEqual(sum, snapshot.overview.requests, '各会话请求数之和 === 窗口总数')
  probe.close()
})

check('buildRequests 附带成本与项目标签，且限制行数', () => {
  const rows = buildRequests(store, DEFAULT_PRICING, { range: 'all', limit: 10 })
  assert.strictEqual(rows.length, 1)
  assert.strictEqual(rows[0].project, 'coding/my')
  assert.strictEqual(typeof rows[0].cost.total, 'number')
  assert.ok(buildRequests(store, DEFAULT_PRICING, { range: 'all' }).length <= 50)
})

check('快照同时给出范围内与累计两组总量', () => {
  const scoped = buildSnapshot(store, DEFAULT_PRICING, '24h', { now: 10_000 })
  assert.strictEqual(scoped.overview.requests, 1)
  assert.strictEqual(scoped.lifetime.requests, 1)
  // The widest range IS the lifetime total, so the two must never disagree.
  const wide = buildSnapshot(store, DEFAULT_PRICING, 'all', { now: 10_000 })
  assert.strictEqual(wide.overview.requests, wide.lifetime.requests)
  assert.strictEqual(wide.lifetime.tokens.totalTokens, wide.overview.tokens.totalTokens)
})

check('窗口外有历史时不算「从未记录」', () => {
  // Shift the clock past the stored call so the one-hour window is genuinely
  // empty while the lifetime total still holds it.
  const later = 5_000 + 3_600_000 + 1
  const scoped = buildSnapshot(store, DEFAULT_PRICING, '1h', { now: later })
  assert.strictEqual(scoped.overview.requests, 0)
  assert.strictEqual(scoped.lifetime.requests, 1)
})

check('status 暴露账户门禁与上次统计时间', () => {
  const blank = buildSnapshot(store, DEFAULT_PRICING, '24h', { now: 10_000 })
  assert.strictEqual(blank.status.authenticated, true)
  assert.strictEqual(blank.status.lastBackfill, null)
  assert.strictEqual(
    buildSnapshot(store, DEFAULT_PRICING, '24h', { authenticated: false, now: 10_000 }).status.authenticated,
    false
  )
  store.setMeta('lastBackfill', '12345')
  assert.strictEqual(lastBackfillOf(store), 12345)
  assert.strictEqual(buildSnapshot(store, DEFAULT_PRICING, '24h', { now: 10_000 }).status.lastBackfill, 12345)
})

check('collector 在关闭时不写入', () => {
  const collector = new UsageCollector({ store, enabled: () => false })
  const wrote = collector.observe({
    time: 1,
    model: 'm',
    sessionId: '',
    ttftMs: null,
    durationMs: 1,
    stopReason: 'stop',
    errorMessage: '',
    tokens: null
  })
  assert.strictEqual(wrote, false)
})

check('collector 补齐 usage 总量并附上会话事实', () => {
  const collector = new UsageCollector({
    store,
    enabled: () => true,
    resolveSession: () => ({ cwd: '/x/y', agentType: 'subagent' })
  })
  const before = store.stats().total
  const wrote = collector.observe({
    time: 9999,
    model: 'gemini-3.8-flash',
    sessionId: 's1',
    ttftMs: 12,
    durationMs: 34,
    stopReason: 'stop',
    errorMessage: '',
    tokens: { inputTokens: 3, outputTokens: 4 }
  })
  assert.strictEqual(wrote, true)
  assert.strictEqual(store.stats().total, before + 1)
  const row = store.query({ limit: 1 })[0]
  assert.strictEqual(row.tokens.totalTokens, 7)
  assert.strictEqual(row.agentType, 'subagent')
  assert.strictEqual(row.cwd, '/x/y')
  assert.strictEqual(row.ttftMs, 12)
})

check('collector 的会话解析失败不影响写入', () => {
  const collector = new UsageCollector({
    store,
    enabled: () => true,
    resolveSession: () => {
      throw new Error('sessions 服务不可用')
    }
  })
  const wrote = collector.observe({
    time: 10_500,
    model: 'gemini-3.8-flash',
    sessionId: 's2',
    ttftMs: null,
    durationMs: 5,
    stopReason: 'error',
    errorMessage: 'boom',
    tokens: null
  })
  assert.strictEqual(wrote, true)
  const row = store.query({ limit: 1 })[0]
  assert.strictEqual(row.cwd, '')
  assert.strictEqual(row.agentType, 'main')
  assert.strictEqual(row.stopReason, 'error')
})

check('tokensOf 补齐总量并忽略非法值', () => {
  assert.strictEqual(tokensOf({ inputTokens: 1, outputTokens: 2 }).totalTokens, 3)
  assert.strictEqual(tokensOf(null).totalTokens, 0)
  assert.strictEqual(tokensOf({ inputTokens: -1, outputTokens: Number.NaN }).totalTokens, 0)
})

check('同一数据库可重开且数据仍在', () => {
  const file = join(storeDir, 'reopen.db')
  const first = new UsageStore(file)
  first.insert('r1', record({ time: 7000 }))
  first.close()
  const second = new UsageStore(file)
  assert.strictEqual(second.stats().total, 1)
  second.close()
})

store.close()

console.log('# 7. 适配器采集插桩（端到端，用假 fetch）')

const { GoogleAntigravityAdapter } = await import('../lib/adapter.js')

/** One SSE body carrying text, a finish reason, and provider usage. */
function sseBody(usage) {
  const payload = {
    response: {
      candidates: [{ content: { parts: [{ text: 'hello' }] }, finishReason: 'STOP' }],
      usageMetadata: usage
    }
  }
  return `data: ${JSON.stringify(payload)}\n\n`
}

/** Drive one adapter call with a stubbed transport. */
async function observeCall(options = {}) {
  const observations = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = options.fetch ?? (async () => new Response(sseBody(options.usage), { status: 200 }))
  try {
    const adapter = new GoogleAntigravityAdapter({
      resolveCredentials: async () => ({ access: 'token', projectId: 'proj' }),
      observe: observation => observations.push(observation)
    })
    const chunks = []
    let failure = null
    try {
      for await (const chunk of adapter.stream({
        provider: 'google-antigravity',
        model: 'gemini-3.8-flash',
        messages: [],
        sessionId: 'sess-1'
      })) {
        chunks.push(chunk)
      }
    } catch (error) {
      failure = error
    }
    return { observations, chunks, failure }
  } finally {
    globalThis.fetch = originalFetch
  }
}

const happy = await observeCall({
  usage: { promptTokenCount: 100, cachedContentTokenCount: 40, candidatesTokenCount: 10, thoughtsTokenCount: 5, totalTokenCount: 115 }
})
check('一次调用恰好产生一条观测', () => {
  assert.strictEqual(happy.observations.length, 1)
})
check('观测带上会话、模型与首字延迟', () => {
  const observation = happy.observations[0]
  assert.strictEqual(observation.sessionId, 'sess-1')
  assert.strictEqual(observation.model, 'gemini-3.8-flash')
  assert.ok(observation.ttftMs === null || observation.ttftMs >= 0)
  assert.ok(observation.durationMs >= 0)
})
check('观测按 DSH 口径拆分令牌', () => {
  const observation = happy.observations[0]
  assert.strictEqual(observation.tokens.inputTokens, 60)
  assert.strictEqual(observation.tokens.outputTokens, 15)
  assert.strictEqual(observation.tokens.cacheReadTokens, 40)
})
check('成功调用记为 stop 且无错误信息', () => {
  const observation = happy.observations[0]
  assert.strictEqual(observation.stopReason, 'stop')
  assert.strictEqual(observation.errorMessage, '')
})
check('插桩不改变 chunk 流', () => {
  const kinds = happy.chunks.map(chunk => chunk.type)
  assert.ok(kinds.includes('text-delta'))
  assert.ok(kinds.includes('usage'))
  assert.strictEqual(kinds[kinds.length - 1], 'finish')
})

const failed = await observeCall({
  fetch: async () => {
    throw new Error('网络断绝')
  }
})
check('传输失败记为 error 并保留原因', () => {
  const observation = failed.observations[0]
  assert.strictEqual(observation.stopReason, 'error')
  assert.match(observation.errorMessage, /Antigravity|端点|网络/)
  assert.strictEqual(observation.tokens, null)
})

/** Consume one chunk of a call, then stop early — the abort path. */
async function observeAborted() {
  const observations = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => new Response(sseBody({ promptTokenCount: 5, candidatesTokenCount: 1 }), { status: 200 })
  try {
    const adapter = new GoogleAntigravityAdapter({
      resolveCredentials: async () => ({ access: 'token' }),
      observe: observation => observations.push(observation)
    })
    let seen = 0
    for await (const _chunk of adapter.stream({ provider: 'google-antigravity', model: 'gemini-3.8-flash', messages: [] })) {
      seen += 1
      if (seen === 1) break
    }
  } finally {
    globalThis.fetch = originalFetch
  }
  return observations
}

const aborted = await observeAborted()
check('消费方提前中断记为 aborted', () => {
  assert.strictEqual(aborted.length, 1)
  assert.strictEqual(aborted[0].stopReason, 'aborted')
  assert.strictEqual(aborted[0].errorMessage, '')
})

console.log('# 8. 历史回填解析')

const { backfillFromSessions } = await import('../lib/usage-backfill.js')
const { mkdirSync, writeFileSync } = await import('node:fs')

const sessionsRoot = join(storeDir, 'sessions')
const sessionDir = join(sessionsRoot, '--home-u-coding-my--', 'sess-a')
mkdirSync(sessionDir, { recursive: true })

const sessionLines = [
  JSON.stringify({ type: 'session', version: 3, id: 'sess-a', cwd: '/home/u/coding/my', delegationDepth: 0 }),
  JSON.stringify({
    type: 'assistant/message',
    seq: 3,
    time: 1000,
    data: {
      message: { source: { kind: 'model', provider: 'google-antigravity', model: 'gemini-3.8-flash' } },
      usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 30 }
    }
  }),
  // Another provider's call must not be imported.
  JSON.stringify({
    type: 'assistant/message',
    seq: 4,
    time: 2000,
    data: {
      message: { source: { kind: 'model', provider: 'command-code', model: 'other' } },
      usage: { inputTokens: 5, outputTokens: 5 }
    }
  }),
  // An Antigravity call with no usage cannot be accounted for.
  JSON.stringify({
    type: 'assistant/message',
    seq: 5,
    time: 3000,
    data: { message: { source: { kind: 'model', provider: 'google-antigravity', model: 'gemini-3.8-flash' } } }
  })
]
writeFileSync(join(sessionDir, 'session.v3.jsonl'), sessionLines.join('\n') + '\n')

const imported = []
const backfilled = await backfillFromSessions({
  sessionsRoot,
  provider: 'google-antigravity',
  importRow: (key, record) => {
    imported.push([key, record])
    return true
  }
})

// A second pass over untouched logs must cost a stat, not a decompression:
// that is what makes "scan on every panel open" affordable.
const skipState = new Map()
const runSkipScan = () =>
  backfillFromSessions({
    sessionsRoot,
    provider: 'google-antigravity',
    importRow: () => true,
    isCurrent: (file, mtimeMs, size) => skipState.get(file) === `${mtimeMs}:${size}`,
    markProcessed: (file, mtimeMs, size) => skipState.set(file, `${mtimeMs}:${size}`)
  })
const firstScan = await runSkipScan()
const secondScan = await runSkipScan()

check('重复扫描按文件修订跳过未变化的日志', () => {
  assert.strictEqual(firstScan.unchanged, 0)
  assert.strictEqual(secondScan.unchanged, 1)
  assert.strictEqual(secondScan.scanned, 0, '未变化的日志不应被重新解压')
})

check('回填只收本 provider 且带 usage 的事件', () => {
  assert.strictEqual(backfilled.files, 1)
  assert.strictEqual(backfilled.scanned, 4)
  assert.strictEqual(backfilled.matched, 1)
  assert.strictEqual(backfilled.imported, 1)
  assert.strictEqual(imported.length, 1)
})

check('回填带上目录与模型，键由会话与序号组成', () => {
  assert.strictEqual(imported[0][0], 'sess-a:3')
  assert.strictEqual(imported[0][1].cwd, '/home/u/coding/my')
  assert.strictEqual(imported[0][1].model, 'gemini-3.8-flash')
  assert.strictEqual(imported[0][1].tokens.totalTokens, 150)
  assert.strictEqual(imported[0][1].agentType, 'main')
})

check('回填不编造延迟与停止原因', () => {
  assert.strictEqual(imported[0][1].ttftMs, null)
  assert.strictEqual(imported[0][1].durationMs, null)
  assert.strictEqual(imported[0][1].stopReason, 'stop')
})

const zstdDir = join(sessionsRoot, '--home-u-x--', 'sess-z')
mkdirSync(zstdDir, { recursive: true })
writeFileSync(join(zstdDir, 'session.v3.jsonl.zstd'), 'not really zstd')
const failureOutcome = await backfillFromSessions({
  sessionsRoot,
  provider: 'google-antigravity',
  importRow: () => true,
  zstdBinary: 'dsh-antigravity-no-such-binary'
})

check('回填遇缺失的解压器只报告失败，不中断整体', () => {
  assert.strictEqual(failureOutcome.failed.length, 1)
  assert.match(failureOutcome.failed[0], /sess-z/)
})

// ---------------------------------------------------------------------------
// 429 的呈现：现场实测（16195 条用量记录）里 429 **全是配额耗尽**，不是瞬时限流，
// 所以这里既要求把"多久后重置"讲清楚，也用负向对照守住"别给普通 429 乱扣配额帽子"。
// 同时钉住"只打一次端点"——429 会让端点轮询立刻 break（配额与鉴权都不是端点级的）。
// ---------------------------------------------------------------------------
const QUOTA_BODY = JSON.stringify({
  error: {
    code: 429,
    message: 'Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 1h31m29s.',
    status: 'RESOURCE_EXHAUSTED',
    details: [{ reason: 'QUOTA_EXHAUSTED' }]
  }
})

let quotaCalls = 0
const quota = await observeCall({
  fetch: async () => {
    quotaCalls += 1
    return new Response(QUOTA_BODY, { status: 429 })
  }
})

check('429 配额耗尽：错误消息说清"配额已用尽 + 何时重置"', () => {
  const message = String(quota.failure && quota.failure.message)
  assert.ok(message.includes('配额已用尽'), message)
  assert.ok(message.includes('1h31m29s'), '带上重置时间：' + message)
  assert.ok(message.includes('不会自动重试'), message)
  assert.strictEqual(quota.failure.code, 'QUOTA_EXCEEDED')
  assert.ok(/Antigravity 端点/.test(message), '仍指明是哪个端点：' + message)
})

check('429 时端点轮询立刻收手（鉴权/配额不是端点级故障）', () => {
  assert.strictEqual(quotaCalls, 1, '只打了一次：' + quotaCalls)
})

check('负向对照：非配额语义的 429 保持原始响应，不被扣上"配额"帽子', async () => {
  const odd = await observeCall({ fetch: async () => new Response('{"error":{"message":"weird throttling"}}', { status: 429 }) })
  const message = String(odd.failure && odd.failure.message)
  assert.ok(!message.includes('配额已用尽'), message)
  assert.ok(message.includes('weird throttling'), message)
  assert.strictEqual(odd.failure.code, 'QUOTA_EXCEEDED')
})

console.log(`\n用量模型测试全部通过：${passed} 项`)
