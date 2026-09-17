import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  DEFAULT_PRICING,
  DEFAULT_RANGE,
  USAGE_RANGES,
  computeCost,
  groupBy,
  isUsageRange,
  priceOf,
  projectLabel,
  rangeSpec,
  seriesOf,
  sessionLabel,
  summarize
} from './usage-model.js'
import type {
  ModelPrice,
  UsageCost,
  UsageGroup,
  UsageOverview,
  UsageRange,
  UsageRecord,
  UsageSeriesPoint
} from './usage-model.js'
import type { UsageStore, UsageStoreStats } from './usage-store.js'

/**
 * Read side of the usage panel: one snapshot endpoint that answers the whole
 * first screen, plus a request-detail endpoint, a status probe, and the two
 * maintenance actions.
 *
 * Aggregation goes through `usage-model.ts` rather than SQL so the panel and
 * the tests share one definition of every figure.
 *
 * @module dsh-antigravity/usage-routes
 */

/** One grouped row as the panel renders it. */
export interface UsageGroupView {
  key: string
  label: string
  overview: UsageOverview
}

/** One request row: the stored record plus what the client would otherwise recompute. */
export interface UsageRequestView extends UsageRecord {
  /** Cost under the price table in force. */
  cost: UsageCost
  /** Short project label for the working directory. */
  project: string
}

/** Everything the first screen needs, in one response. */
export interface UsageSnapshot {
  range: UsageRange
  ranges: readonly UsageRange[]
  generatedAt: number
  overview: UsageOverview
  /**
   * The all-time total, independent of `range`.
   *
   * "How much have I used in total" is a different question from "in this
   * window", so it gets its own figure rather than making the reader switch the
   * whole panel to the widest range and read it back out of the cards.
   */
  lifetime: UsageOverview
  series: UsageSeriesPoint[]
  models: UsageGroupView[]
  projects: UsageGroupView[]
  /**
   * Per-session totals.
   *
   * The data layer already stores `session_id` (with an index on it), so "which session burned
   * this" needs no schema change and no migration — only this aggregation. `key` is the full
   * session id (use it to line a row up with a transcript); `label` is the short form.
   */
  sessions: UsageGroupView[]
  agents: UsageGroupView[]
  /** Newest calls in the window, so the first screen costs one request. */
  recent: UsageRequestView[]
  status: UsageStatus
}

/** Store-level facts and the recording switches, for the panel's footer. */
export interface UsageStatus extends UsageStoreStats {
  enabled: boolean
  retentionDays: number | null
  /** Whether the host can import historical session logs on demand. */
  backfill: boolean
  /**
   * Whether an Antigravity account is installed. The panel is only offered to
   * a user who has one — an account-less install has nothing to account for.
   */
  authenticated: boolean
  /** When the history was last imported, epoch ms; null when never. */
  lastBackfill: number | null
  /** Local calendar day the series buckets are aligned to; always 'local'. */
  bucketTimezone: 'local'
}

/** What the routes need from the mounting plugin. */
export interface UsageRoutesOptions {
  store: UsageStore
  /** Price table in force; re-read per request so settings edits apply live. */
  pricing: () => Record<string, ModelPrice>
  /** Whether recording is enabled. */
  enabled: () => boolean
  /** Retention in days, or null when unbounded. */
  retentionDays?: () => number | null
  /** Route prefix, e.g. `/dsh-antigravity/usage`. */
  prefix: string
  /**
   * Whether an Antigravity account is installed. Resolved per request so a
   * sign-out takes the panel away without needing a reload.
   */
  authenticated?: () => Promise<boolean> | boolean
  /** Host/Origin guard supplied by the mounting plugin. */
  guard: (req: IncomingMessage, res: ServerResponse) => boolean
  /** Register one route as an effect on the mounting fiber. */
  register: (path: string, method: string, handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>) => void
  /** Optional historical import; omitted when the capability is unavailable. */
  backfill?: () => Promise<{ imported: number; scanned: number; files?: number; matched?: number; failed?: number }>
}

/**
 * Build the aggregate snapshot.
 *
 * @param store - where recorded calls live.
 * @param pricing - price table in force.
 * @param range - requested window.
 * @param options - `{ enabled, retentionDays, now }` for the status block.
 * @returns the snapshot the panel renders.
 */
export function buildSnapshot(
  store: UsageStore,
  pricing: Record<string, ModelPrice>,
  range: UsageRange,
  options: {
    enabled?: boolean
    retentionDays?: number | null
    backfill?: boolean
    authenticated?: boolean
    now?: number
  } = {}
): UsageSnapshot {
  const now = options.now ?? Date.now()
  const spec = rangeSpec(range, now)
  const records = store.query({ since: spec.since })
  const stats = store.stats()

  const models: UsageGroupView[] = groupBy(records, record => record.model, pricing).map(group => ({
    key: group.key,
    label: group.key,
    overview: group.overview
  }))

  // Projects group by directory but present a short label; two checkouts that
  // share a leaf name keep distinct keys, which the table needs to stay useful.
  const projects: UsageGroupView[] = groupBy(records, record => record.cwd || '(unknown)', pricing).map(group => ({
    key: group.key,
    label: projectLabel(group.key),
    overview: group.overview
  }))

  const agents: UsageGroupView[] = groupBy(records, record => record.agentType, pricing).map(group => ({
    key: group.key,
    label: group.key,
    overview: group.overview
  }))

  // Sessions group by the stored session id. `(unknown)` collects rows written before the id was
  // available (backfill gaps) so the group totals still add up to the window total.
  const sessions: UsageGroupView[] = groupBy(records, record => record.sessionId || '(unknown)', pricing).map(group => ({
    key: group.key,
    label: sessionLabel(group.key),
    overview: group.overview
  }))

  const overview = summarize(records, pricing)
  // Widest range already IS the lifetime total, so the extra pass is skipped
  // exactly when it would be redundant.
  const lifetime = spec.since === undefined ? overview : summarize(store.query({}), pricing)

  return {
    range,
    ranges: USAGE_RANGES,
    generatedAt: now,
    overview,
    lifetime,
    series: seriesOf(records, spec, now, pricing),
    models,
    projects,
    sessions,
    agents,
    recent: records.slice(0, 20).map(record => ({
      ...record,
      cost: computeCost(record.tokens, priceOf(record.model, pricing)),
      project: projectLabel(record.cwd)
    })),
    status: {
      ...stats,
      enabled: options.enabled !== false,
      retentionDays: options.retentionDays ?? null,
      backfill: options.backfill === true,
      authenticated: options.authenticated !== false,
      lastBackfill: lastBackfillOf(store),
      bucketTimezone: 'local'
    }
  }
}

/**
 * Read one window of request rows, newest first.
 *
 * @param store - where recorded calls live.
 * @param pricing - price table in force.
 * @param query - `{ range, limit, errorsOnly, model, project }`.
 * @returns rows ready for the detail table.
 */
export function buildRequests(
  store: UsageStore,
  pricing: Record<string, ModelPrice>,
  query: { range?: UsageRange; limit?: number; errorsOnly?: boolean; model?: string; cwd?: string }
): UsageRequestView[] {
  const spec = rangeSpec(query.range ?? DEFAULT_RANGE)
  const records = store.query({
    since: spec.since,
    errorsOnly: query.errorsOnly === true,
    limit: clampLimit(query.limit),
    model: query.model,
    cwd: query.cwd
  })
  return records.map(record => ({
    ...record,
    cost: computeCost(record.tokens, priceOf(record.model, pricing)),
    project: projectLabel(record.cwd)
  }))
}

/** Cap a caller-supplied row limit so one request cannot pull the whole store. */
function clampLimit(limit: number | undefined): number {
  if (typeof limit !== 'number' || !Number.isFinite(limit) || limit <= 0) return 50
  return Math.min(500, Math.floor(limit))
}

/**
 * Attach the usage routes to a mounted web server.
 *
 * @param options - store, guards, and per-request resolvers.
 */
export function registerUsageRoutes(options: UsageRoutesOptions): void {
  const prefix = options.prefix.replace(/\/+$/, '')

  options.register(`${prefix}/overview`, 'GET', async (req, res) => {
    if (options.guard(req, res)) return
    const range = rangeOf(req)
    sendJson(res, 200, buildSnapshot(options.store, options.pricing(), range, {
      enabled: options.enabled(),
      retentionDays: options.retentionDays?.() ?? null,
      backfill: options.backfill !== undefined,
      authenticated: await authenticatedOf(options)
    }))
  })

  options.register(`${prefix}/requests`, 'GET', (req, res) => {
    if (options.guard(req, res)) return
    const url = parseUrl(req)
    sendJson(res, 200, {
      rows: buildRequests(options.store, options.pricing(), {
        range: rangeOf(req),
        limit: Number(url.searchParams.get('limit') ?? '') || undefined,
        errorsOnly: url.searchParams.get('errors') === '1',
        model: url.searchParams.get('model') ?? undefined,
        cwd: url.searchParams.get('cwd') ?? undefined
      })
    })
  })

  options.register(`${prefix}/status`, 'GET', async (req, res) => {
    if (options.guard(req, res)) return
    sendJson(res, 200, {
      ...options.store.stats(),
      enabled: options.enabled(),
      retentionDays: options.retentionDays?.() ?? null,
      backfill: options.backfill !== undefined,
      authenticated: await authenticatedOf(options),
      lastBackfill: lastBackfillOf(options.store)
    })
  })

  options.register(`${prefix}/clear`, 'POST', (req, res) => {
    if (options.guard(req, res)) return
    try {
      const removed = options.store.clear()
      sendJson(res, 200, { removed })
    } catch (error) {
      sendJson(res, 500, { error: messageOf(error) })
    }
  })

  if (options.backfill !== undefined) {
    const backfill = options.backfill
    options.register(`${prefix}/backfill`, 'POST', async (req, res) => {
      if (options.guard(req, res)) return
      try {
        const result = await backfill()
        // Stamp the pass: the panel reopens often, and rescanning every
        // session file on each open would be pure waste.
        options.store.setMeta(BACKFILL_STAMP, String(Date.now()))
        sendJson(res, 200, result)
      } catch (error) {
        sendJson(res, 500, { error: messageOf(error) })
      }
    })
  }
}

/** `usage_meta` key holding the last successful history import. */
const BACKFILL_STAMP = 'lastBackfill'

/**
 * When the history was last imported.
 *
 * @param store - the usage store.
 * @returns epoch ms, or null when the history was never imported.
 */
export function lastBackfillOf(store: UsageStore): number | null {
  const value = Number(store.meta(BACKFILL_STAMP) ?? '')
  return Number.isFinite(value) && value > 0 ? value : null
}

/** Resolve the account gate, treating a failing probe as "no account". */
async function authenticatedOf(options: UsageRoutesOptions): Promise<boolean> {
  if (options.authenticated === undefined) return true
  try {
    return (await options.authenticated()) === true
  } catch {
    return false
  }
}

/** Read the `range` query parameter, falling back to the default window. */
function rangeOf(req: IncomingMessage): UsageRange {
  const value = parseUrl(req).searchParams.get('range')
  return isUsageRange(value) ? value : DEFAULT_RANGE
}

function parseUrl(req: IncomingMessage): URL {
  const host = typeof req.headers.host === 'string' && req.headers.host !== '' ? req.headers.host : '127.0.0.1'
  try {
    return new URL(req.url ?? '/', `http://${host}`)
  } catch {
    return new URL('http://127.0.0.1/')
  }
}

function sendJson(res: ServerResponse, statusCode: number, payload: unknown): void {
  if (res.headersSent) return
  const body = JSON.stringify(payload)
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body)
  })
  res.end(body)
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export { DEFAULT_PRICING }
