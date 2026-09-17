/**
 * Pure usage-accounting model for the Google Antigravity route.
 *
 * Everything here is dependency-free: no Cordis context, no filesystem, no
 * network. That keeps the arithmetic (cost, cache rate, savings, bucketing,
 * grouping) unit-testable on its own and lets the store, the routes, and the
 * browser half share one definition of every figure the panel renders.
 *
 * Accounting conventions were derived from the reference implementation where
 * they are observable, and are written down explicitly where they are not:
 *
 * - token counts are DISJOINT, as DSH's `TokenUsage` defines them: `inputTokens`
 *   excludes cached input, `cacheReadTokens` is the cached part;
 * - `totalTokens` is the sum of the four buckets;
 * - a request counts as `successful` unless its stop reason is `error`
 *   (`aborted` still counts as successful);
 * - cost is computed at read time from the current price table rather than
 *   stored per record, so editing prices never requires a rebuild;
 * - bucket boundaries are LOCAL calendar days, not UTC, because the panel is
 *   read by a human in one timezone.
 *
 * @module dsh-antigravity/usage-model
 */

/** The four disjoint token buckets plus the two derived totals. */
export interface UsageTokens {
  /** Uncached prompt tokens. */
  inputTokens: number
  /** Completion tokens, including reasoning tokens when the provider reports them separately. */
  outputTokens: number
  /** Prompt tokens served from the provider's cache. */
  cacheReadTokens: number
  /** Prompt tokens written into the provider's cache. */
  cacheWriteTokens: number
  /** Reasoning tokens, a subset of `outputTokens` when reported. */
  reasoningTokens: number
  /** `input + output + cacheRead + cacheWrite`. */
  totalTokens: number
}

/**
 * Price of one model, in USD per 1M tokens.
 *
 * The numbers in {@link DEFAULT_PRICING} were read from Oh My Pi's embedded
 * price table (`strings /usr/bin/omp` → the `provider: "google-antigravity"`
 * entries) and cross-checked against per-model implied prices reverse-computed
 * from this machine's recorded spend: `SUM(cost_*)/SUM(tokens_*) * 1e6` matched
 * every model that had spend. They are an *estimate of API-equivalent value*,
 * not a bill: Antigravity is subscription-billed.
 */
export interface ModelPrice {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

/** Cost split of one request or one aggregate, in USD. */
export interface UsageCost {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  total: number
  /**
   * Counterfactual: what the uncached input would have cost at the full input
   * price. It exists only to make `cacheSavings` computable, mirroring the
   * `cost_no_cache_input` column the reference implementation carries.
   */
  noCacheInput: number
  /** True when every non-zero token bucket had a known price. */
  priced: boolean
}

/**
 * Default Antigravity price table, USD per 1M tokens.
 *
 * `claude-opus-4-6-thinking` and `gpt-oss-120b` carry no price upstream, so
 * their four rates are 0 and requests against them are reported as unpriced.
 * A deployment may override any entry through the plugin's settings.
 */
export const DEFAULT_PRICING: Record<string, ModelPrice> = {
  'gemini-3.8-flash': { input: 0.75, output: 3.75, cacheRead: 0.075, cacheWrite: 0 },
  'gemini-3.7-flash': { input: 0.75, output: 3.75, cacheRead: 0.075, cacheWrite: 0 },
  'gemini-3.6-flash': { input: 0.75, output: 3.75, cacheRead: 0.075, cacheWrite: 0 },
  'gemini-3.5-flash': { input: 1.5, output: 9, cacheRead: 0.15, cacheWrite: 0 },
  'gemini-3.1-pro': { input: 2, output: 12, cacheRead: 0.2, cacheWrite: 0 },
  'gemini-3-pro': { input: 2, output: 12, cacheRead: 0.2, cacheWrite: 0 },
  'gemini-2.5-flash': { input: 0.3, output: 2.5, cacheRead: 0.03, cacheWrite: 0 },
  'gemini-2.5-pro': { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 0 },
  'claude-sonnet-4-6': { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  'claude-opus-4-6': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  'claude-opus-4-6-thinking': { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  'gpt-oss-120b': { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
}

/** Time windows the panel offers, matching the reference implementation's set. */
export type UsageRange = '1h' | '24h' | '7d' | '30d' | '90d' | 'all'

/** Every offered range, narrowest first. */
export const USAGE_RANGES: readonly UsageRange[] = ['1h', '24h', '7d', '30d', '90d', 'all']

/** Default range: what a user almost always wants to see first. */
export const DEFAULT_RANGE: UsageRange = '24h'

const HOUR_MS = 3_600_000
const DAY_MS = 86_400_000

/**
 * How a range maps onto a query.
 *
 * `bucketMs` is the width of one point in the time series, chosen so a range
 * yields a readable number of points (24 hourly points for a day, 30 daily
 * points for a month).
 */
export interface RangeSpec {
  range: UsageRange
  /** Inclusive lower bound in epoch ms, or `undefined` for "everything". */
  since: number | undefined
  /** Time-series bucket width in ms. */
  bucketMs: number
  /** Human label for the axis. */
  bucket: '5m' | 'hour' | 'day'
}

/**
 * Resolve a range against a clock.
 *
 * @param range - the requested window.
 * @param now - current epoch ms; injected so the mapping stays pure.
 * @returns the query window and bucket width.
 */
export function rangeSpec(range: UsageRange, now: number = Date.now()): RangeSpec {
  switch (range) {
    case '1h':
      return { range, since: now - HOUR_MS, bucketMs: 5 * 60_000, bucket: '5m' }
    case '24h':
      return { range, since: now - DAY_MS, bucketMs: HOUR_MS, bucket: 'hour' }
    case '7d':
      return { range, since: now - 7 * DAY_MS, bucketMs: DAY_MS, bucket: 'day' }
    case '30d':
      return { range, since: now - 30 * DAY_MS, bucketMs: DAY_MS, bucket: 'day' }
    case '90d':
      return { range, since: now - 90 * DAY_MS, bucketMs: DAY_MS, bucket: 'day' }
    case 'all':
    default:
      return { range: 'all', since: undefined, bucketMs: DAY_MS, bucket: 'day' }
  }
}

/**
 * Whether a string names an offered range.
 *
 * @param value - candidate, typically straight off a query string.
 * @returns whether it is a {@link UsageRange}.
 */
export function isUsageRange(value: unknown): value is UsageRange {
  return typeof value === 'string' && (USAGE_RANGES as readonly string[]).includes(value)
}

/** An all-zero token record. */
export function emptyTokens(): UsageTokens {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0
  }
}

/**
 * Fold one token record into another, in place.
 *
 * @param target - accumulator, mutated.
 * @param add - the record to add.
 * @returns the accumulator.
 */
export function addTokens(target: UsageTokens, add: Partial<UsageTokens> | undefined): UsageTokens {
  if (add === undefined || add === null) return target
  target.inputTokens += num(add.inputTokens)
  target.outputTokens += num(add.outputTokens)
  target.cacheReadTokens += num(add.cacheReadTokens)
  target.cacheWriteTokens += num(add.cacheWriteTokens)
  target.reasoningTokens += num(add.reasoningTokens)
  target.totalTokens +=
    add.totalTokens !== undefined && add.totalTokens !== null
      ? num(add.totalTokens)
      : num(add.inputTokens) + num(add.outputTokens) + num(add.cacheReadTokens) + num(add.cacheWriteTokens)
  return target
}

function num(value: number | undefined | null): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
}

/**
 * Compute the cost split of one token record.
 *
 * @param tokens - the token buckets.
 * @param price - the model's price, or `undefined` when the model is unknown.
 * @returns the cost split; `priced` is false when tokens were spent but no
 *   positive rate applies, which is what the panel surfaces as "unpriced".
 */
export function computeCost(tokens: Partial<UsageTokens> | undefined, price: ModelPrice | undefined): UsageCost {
  const t = tokens ?? {}
  const p = price ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
  const per = (count: number | undefined, rate: number): number => (num(count) * rate) / 1_000_000

  const input = per(t.inputTokens, p.input)
  const output = per(t.outputTokens, p.output)
  const cacheRead = per(t.cacheReadTokens, p.cacheRead)
  const cacheWrite = per(t.cacheWriteTokens, p.cacheWrite)
  // Uncached input priced at the full input rate is the counterfactual the
  // savings figure divides against. Cached read tokens are the ones that were
  // saved from that full rate, so they are what makes the denominator differ.
  const noCacheInput = per(num(t.inputTokens) + num(t.cacheReadTokens) + num(t.cacheWriteTokens), p.input)

  const total = input + output + cacheRead + cacheWrite
  const spentTokens = num(t.inputTokens) + num(t.outputTokens) + num(t.cacheReadTokens) + num(t.cacheWriteTokens)
  return { input, output, cacheRead, cacheWrite, total, noCacheInput, priced: spentTokens === 0 || total > 0 }
}

/** Fold one cost split into another, in place. */
export function addCost(target: UsageCost, add: UsageCost): UsageCost {
  target.input += add.input
  target.output += add.output
  target.cacheRead += add.cacheRead
  target.cacheWrite += add.cacheWrite
  target.total += add.total
  target.noCacheInput += add.noCacheInput
  target.priced = target.priced && add.priced
  return target
}

/** An all-zero cost record. */
export function emptyCost(): UsageCost {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, noCacheInput: 0, priced: true }
}

/**
 * One recorded model call, as the store persists it.
 *
 * Costs are deliberately absent: they are derived from {@link UsageRecord.tokens}
 * and the price table in force at read time.
 */
export interface UsageRecord {
  /** Call completion time, epoch ms. */
  time: number
  /** Session the call belongs to. */
  sessionId: string
  /** Session working directory, the panel's "project" axis. */
  cwd: string
  /** DSH-facing model id. */
  model: string
  /** Whether the call came from the main agent or a delegated child. */
  agentType: 'main' | 'subagent'
  /** Window between request start and the first content chunk, ms; null when unobserved. */
  ttftMs: number | null
  /** Window between request start and stream end, ms; null when unobserved. */
  durationMs: number | null
  /** Terminal reason: `stop`, `tool-calls`, `max-tokens`, `error`, `aborted`, or a provider string. */
  stopReason: string
  /** Provider error text, empty on success. */
  errorMessage: string
  /** Token buckets as the provider reported them. */
  tokens: UsageTokens
}

/** Aggregate figures for one set of records. */
export interface UsageOverview {
  requests: number
  successful: number
  failed: number
  errorRate: number
  tokens: UsageTokens
  /** `cacheRead / (input + cacheRead)`, 0 when no prompt tokens were seen. */
  cacheRate: number
  /**
   * Fraction of the uncached-input counterfactual that caching avoided,
   * clamped to [0, 1]; 0 when there is nothing to compare against.
   */
  cacheSavings: number
  cost: UsageCost
  /** Requests that spent tokens without any positive price applying. */
  unpricedRequests: number
  /** Mean wall time over records that recorded one; null when none did. */
  avgDurationMs: number | null
  /** Mean first-token latency over records that recorded one; null when none did. */
  avgTtftMs: number | null
  /** `outputTokens / duration`, summed then divided — see the module note. */
  tokensPerSecond: number | null
  firstTime: number | null
  lastTime: number | null
}

/**
 * Aggregate a set of records.
 *
 * @param records - the records to fold; order is irrelevant.
 * @param pricing - price table in force.
 * @returns the overview figures.
 */
export function summarize(
  records: readonly UsageRecord[],
  pricing: Record<string, ModelPrice> = DEFAULT_PRICING
): UsageOverview {
  const tokens = emptyTokens()
  const cost = emptyCost()
  let requests = 0
  let failed = 0
  let unpriced = 0
  let durationSum = 0
  let durationCount = 0
  let ttftSum = 0
  let ttftCount = 0
  let first: number | null = null
  let last: number | null = null

  for (const record of records) {
    requests += 1
    if (isFailure(record.stopReason)) failed += 1
    addTokens(tokens, record.tokens)
    const recordCost = computeCost(record.tokens, priceOf(record.model, pricing))
    addCost(cost, recordCost)
    if (!recordCost.priced) unpriced += 1
    if (typeof record.durationMs === 'number' && Number.isFinite(record.durationMs)) {
      durationSum += record.durationMs
      durationCount += 1
    }
    if (typeof record.ttftMs === 'number' && Number.isFinite(record.ttftMs)) {
      ttftSum += record.ttftMs
      ttftCount += 1
    }
    if (first === null || record.time < first) first = record.time
    if (last === null || record.time > last) last = record.time
  }

  const promptTokens = tokens.inputTokens + tokens.cacheReadTokens
  const savingsBase = cost.noCacheInput
  return {
    requests,
    successful: requests - failed,
    failed,
    errorRate: requests === 0 ? 0 : failed / requests,
    tokens,
    cacheRate: promptTokens === 0 ? 0 : tokens.cacheReadTokens / promptTokens,
    cacheSavings: savingsBase <= 0 ? 0 : clamp01(1 - (cost.input + cost.cacheRead + cost.cacheWrite) / savingsBase),
    cost,
    unpricedRequests: unpriced,
    avgDurationMs: durationCount === 0 ? null : durationSum / durationCount,
    avgTtftMs: ttftCount === 0 ? null : ttftSum / ttftCount,
    tokensPerSecond: durationSum <= 0 ? null : (tokens.outputTokens / durationSum) * 1000,
    firstTime: first,
    lastTime: last
  }
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0
  return value < 0 ? 0 : value > 1 ? 1 : value
}

/**
 * Whether a stop reason represents a provider-side failure.
 *
 * `aborted` is deliberately NOT a failure: the user stopping a request is not
 * the provider misbehaving, and treating it as one would make the error rate
 * reflect user behaviour.
 *
 * @param stopReason - the recorded terminal reason.
 * @returns whether it counts as failed.
 */
export function isFailure(stopReason: string): boolean {
  return String(stopReason).toLowerCase() === 'error'
}

/** Resolve a model's price, falling back to the built-in table. */
export function priceOf(model: string, pricing: Record<string, ModelPrice> = DEFAULT_PRICING): ModelPrice | undefined {
  const table = pricing ?? DEFAULT_PRICING
  return table[model] ?? table[stripWireSuffix(model)] ?? DEFAULT_PRICING[model] ?? DEFAULT_PRICING[stripWireSuffix(model)]
}

/** `gemini-3.8-flash-tiered` → `gemini-3.8-flash`, so tiered aliases price like their base model. */
function stripWireSuffix(model: string): string {
  return String(model).replace(/(?:-tiered|-preview|-exp)$/i, '')
}

/** One point of the requests/tokens/cost time series. */
export interface UsageSeriesPoint {
  /** Bucket start, epoch ms, aligned to {@link RangeSpec.bucket}. */
  time: number
  requests: number
  errors: number
  tokens: UsageTokens
  cost: UsageCost
}

/**
 * Build a time series, filling empty buckets so the chart has no gaps.
 *
 * @param records - records already filtered to the window.
 * @param spec - the resolved range (bucket width).
 * @param now - clock, injected for testability.
 * @param pricing - price table in force.
 * @returns points in ascending time order.
 */
export function seriesOf(
  records: readonly UsageRecord[],
  spec: RangeSpec,
  now: number = Date.now(),
  pricing: Record<string, ModelPrice> = DEFAULT_PRICING
): UsageSeriesPoint[] {
  const bucketMs = spec.bucketMs
  const start = spec.since === undefined ? earliestBucket(records, bucketMs, now) : alignBucket(spec.since, bucketMs)
  const end = alignBucket(now, bucketMs)
  const buckets = new Map<number, UsageSeriesPoint>()

  for (let time = start; time <= end; time += bucketMs) {
    buckets.set(time, { time, requests: 0, errors: 0, tokens: emptyTokens(), cost: emptyCost() })
  }

  for (const record of records) {
    const key = alignBucket(record.time, bucketMs)
    let point = buckets.get(key)
    if (point === undefined) {
      point = { time: key, requests: 0, errors: 0, tokens: emptyTokens(), cost: emptyCost() }
      buckets.set(key, point)
    }
    point.requests += 1
    if (isFailure(record.stopReason)) point.errors += 1
    addTokens(point.tokens, record.tokens)
    addCost(point.cost, computeCost(record.tokens, priceOf(record.model, pricing)))
  }

  return [...buckets.values()].sort((a, b) => a.time - b.time)
}

function earliestBucket(records: readonly UsageRecord[], bucketMs: number, fallback: number): number {
  let earliest = Number.POSITIVE_INFINITY
  for (const record of records) if (record.time < earliest) earliest = record.time
  return Number.isFinite(earliest) ? alignBucket(earliest, bucketMs) : alignBucket(fallback, bucketMs)
}

/** Align a timestamp down to its bucket start. */
export function alignBucket(time: number, bucketMs: number): number {
  return Math.floor(time / bucketMs) * bucketMs
}

/** One row of a grouped breakdown. */
export interface UsageGroup {
  key: string
  label: string
  overview: UsageOverview
}

/**
 * Group records by a key function and summarize each group.
 *
 * @param records - the records to group.
 * @param keyOf - maps a record to its group key.
 * @param pricing - price table in force.
 * @returns groups sorted by request count, descending.
 */
export function groupBy(
  records: readonly UsageRecord[],
  keyOf: (record: UsageRecord) => string,
  pricing: Record<string, ModelPrice> = DEFAULT_PRICING
): UsageGroup[] {
  const buckets = new Map<string, UsageRecord[]>()
  for (const record of records) {
    const key = keyOf(record) || '(unknown)'
    const list = buckets.get(key)
    if (list === undefined) buckets.set(key, [record])
    else list.push(record)
  }
  return [...buckets.entries()]
    .map(([key, list]) => ({ key, label: key, overview: summarize(list, pricing) }))
    .sort((a, b) => b.overview.requests - a.overview.requests)
}

/**
 * Nearest-rank percentile over a numeric sample.
 *
 * @param values - the sample; order is irrelevant.
 * @param fraction - 0..1, e.g. 0.95 for p95.
 * @returns the percentile, or null for an empty sample.
 */
export function percentile(values: readonly number[], fraction: number): number | null {
  const sorted = values.filter(value => Number.isFinite(value)).sort((a, b) => a - b)
  if (sorted.length === 0) return null
  const rank = Math.ceil(clamp01(fraction) * sorted.length) - 1
  return sorted[Math.max(0, Math.min(sorted.length - 1, rank))]
}

/**
 * Collapse an absolute path into a short project label.
 *
 * Keeps the last two segments so `/home/vesita/coding/my` reads as `coding/my`,
 * which is what distinguishes sibling checkouts at a glance.
 *
 * @param cwd - absolute path, possibly empty.
 * @returns the short label.
 */
export function projectLabel(cwd: string): string {
  const trimmed = String(cwd || '').replace(/\/+$/, '')
  if (trimmed === '') return '(unknown)'
  const parts = trimmed.split('/').filter(Boolean)
  if (parts.length === 0) return trimmed
  return parts.slice(-2).join('/')
}

/**
 * Collapse a session id into a short label for the usage table.
 *
 * Session ids are long (`session-2f2e2587-ad46-4a7e-…`) and the column is narrow, so the label
 * shows just the leading id chunk. The **full** id stays in the group's `key` — that is what
 * correlates a row with a transcript; the label is for reading, not for matching.
 *
 * @param sessionId - the stored `session_id`, possibly empty.
 * @returns the short label (`(unknown)` when there is no session to name).
 */
export function sessionLabel(sessionId: string): string {
  const raw = String(sessionId || '').trim()
  if (raw === '') return '(unknown)'
  const stripped = raw.startsWith('session-') ? raw.slice('session-'.length) : raw
  const head = stripped.split('-')[0] || stripped
  return head.slice(0, 8)
}
