import { mkdirSync, statSync, chmodSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { StatementSync } from 'node:sqlite'
import { emptyTokens } from './usage-model.js'
import type { UsageRecord, UsageTokens } from './usage-model.js'

/**
 * Durable store for recorded Antigravity calls.
 *
 * One row per provider call, keyed by an idempotency key so a replay of the
 * same call (a re-scan of a session log, a retried ingest) can never
 * double-count. Aggregation deliberately happens in memory on top of
 * {@link UsageStore.query} rather than in SQL: the arithmetic lives in
 * `usage-model.ts` and having exactly one definition of every figure is worth
 * more than the microseconds SQL would save at this scale (a heavy user makes
 * thousands, not billions, of calls).
 *
 * Storage is `node:sqlite` — built into the Node runtime DSH itself runs on, so
 * this plugin adds no dependency.
 *
 * @module dsh-antigravity/usage-store
 */

/** Filter accepted by {@link UsageStore.query}. All fields are ANDed. */
export interface UsageQuery {
  /** Inclusive lower bound on call time, epoch ms. */
  since?: number
  /** Exclusive upper bound on call time, epoch ms. */
  until?: number
  model?: string
  cwd?: string
  agentType?: string
  sessionId?: string
  /**
   * Google account that served the call, as the collector recorded it (the
   * email). `''` selects the rows written before accounts existed.
   */
  account?: string
  /** Only calls whose stop reason counts as a failure. */
  errorsOnly?: boolean
  /** Newest-first cap; omitted means every matching row. */
  limit?: number
}

/** Whole-store figures for the panel header and for diagnostics. */
export interface UsageStoreStats {
  /** Rows currently stored. */
  total: number
  /** Oldest stored call time, or null when empty. */
  firstTime: number | null
  /** Newest stored call time, or null when empty. */
  lastTime: number | null
  /** Distinct sessions represented. */
  sessions: number
  /** Size of the database file in bytes, or null when it does not exist yet. */
  bytes: number | null
}

/** Schema version recorded in `usage_meta`; bump when the column set changes. */
export const USAGE_SCHEMA_VERSION = '2'

const SCHEMA = `
CREATE TABLE IF NOT EXISTS usage_records (
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
  total_tokens INTEGER NOT NULL DEFAULT 0,
  account TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS usage_records_time ON usage_records(time);
CREATE INDEX IF NOT EXISTS usage_records_time_model ON usage_records(time, model);
CREATE INDEX IF NOT EXISTS usage_records_time_cwd ON usage_records(time, cwd);
CREATE INDEX IF NOT EXISTS usage_records_session ON usage_records(session_id);
CREATE TABLE IF NOT EXISTS usage_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
-- Revision of each session file already folded in, so a repeat scan can skip
-- the decompression of everything that has not moved since last time.
CREATE TABLE IF NOT EXISTS usage_files (
  path TEXT PRIMARY KEY,
  mtime_ms REAL NOT NULL,
  size INTEGER NOT NULL
);
`

/** A row as SQLite hands it back. */
interface UsageRow {
  key: string
  time: number
  session_id: string
  cwd: string
  model: string
  agent_type: string
  ttft_ms: number | null
  duration_ms: number | null
  stop_reason: string
  error_message: string
  input_tokens: number
  output_tokens: number
  cache_read_tokens: number
  cache_write_tokens: number
  reasoning_tokens: number
  total_tokens: number
  account: string
}

export class UsageStore {
  readonly file: string
  #db: DatabaseSync
  #insert: StatementSync
  #closed = false

  /**
   * @param file - absolute path of the database; parent directories are created.
   */
  constructor(file: string) {
    this.file = file
    mkdirSync(dirname(file), { recursive: true })
    this.#db = new DatabaseSync(file)
    // WAL keeps a reader (the HTTP panel) from blocking the writer (a live
    // call landing while the panel refreshes).
    this.#db.exec('PRAGMA journal_mode = WAL')
    this.#db.exec('PRAGMA synchronous = NORMAL')
    this.#db.exec(SCHEMA)
    this.#migrate()
    this.#insert = this.#db.prepare(`
      INSERT OR IGNORE INTO usage_records (
        key, time, session_id, cwd, model, agent_type, ttft_ms, duration_ms,
        stop_reason, error_message, input_tokens, output_tokens,
        cache_read_tokens, cache_write_tokens, reasoning_tokens, total_tokens,
        account
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    try {
      chmodSync(file, 0o600)
    } catch {
      /* best effort: a foreign filesystem may refuse */
    }
  }

  /**
   * Bring an existing database up to the current column set.
   *
   * History is worth keeping — a working deployment has tens of thousands of
   * rows — so the one column added for multi-account attribution is applied with
   * `ALTER TABLE` rather than by recreating the table. Rows written before
   * accounts existed keep `''` and read back as "owner unknown".
   */
  #migrate(): void {
    const columns = this.#db.prepare('PRAGMA table_info(usage_records)').all() as unknown as Array<{ name: string }>
    if (!columns.some(column => column.name === 'account')) {
      this.#db.exec("ALTER TABLE usage_records ADD COLUMN account TEXT NOT NULL DEFAULT ''")
    }
    // Recorded version only ever moves forward: a database already written by a
    // newer build must not be relabelled by an older one, or the version stops
    // meaning "which columns this file has".
    const recorded = Number(this.meta('schema'))
    if (!(recorded >= Number(USAGE_SCHEMA_VERSION))) this.setMeta('schema', USAGE_SCHEMA_VERSION)
  }

  /**
   * Insert one call. Idempotent: a duplicate key is ignored.
   *
   * @param key - stable identity of the call (see the collector).
   * @param record - the call.
   * @returns whether a new row was written.
   */
  insert(key: string, record: UsageRecord): boolean {
    if (this.#closed) return false
    const tokens = record.tokens ?? emptyTokens()
    const result = this.#insert.run(
      key,
      Math.round(record.time),
      record.sessionId || '',
      record.cwd || '',
      record.model || '',
      record.agentType === 'subagent' ? 'subagent' : 'main',
      numberOrNull(record.ttftMs),
      numberOrNull(record.durationMs),
      record.stopReason || '',
      record.errorMessage || '',
      int(tokens.inputTokens),
      int(tokens.outputTokens),
      int(tokens.cacheReadTokens),
      int(tokens.cacheWriteTokens),
      int(tokens.reasoningTokens),
      int(tokens.totalTokens),
      record.account || ''
    )
    return Number(result.changes) > 0
  }

  /**
   * Insert many calls in one transaction.
   *
   * @param rows - `[key, record]` pairs.
   * @returns how many rows were newly written.
   */
  insertMany(rows: ReadonlyArray<readonly [string, UsageRecord]>): number {
    if (this.#closed || rows.length === 0) return 0
    let written = 0
    this.#db.exec('BEGIN')
    try {
      for (const [key, record] of rows) if (this.insert(key, record)) written += 1
      this.#db.exec('COMMIT')
    } catch (error) {
      this.#db.exec('ROLLBACK')
      throw error
    }
    return written
  }

  /**
   * Read calls matching a filter.
   *
   * @param query - the filter.
   * @returns records, newest first.
   */
  query(query: UsageQuery = {}): UsageRecord[] {
    if (this.#closed) return []
    const where: string[] = []
    const params: Array<string | number> = []
    if (query.since !== undefined) {
      where.push('time >= ?')
      params.push(query.since)
    }
    if (query.until !== undefined) {
      where.push('time < ?')
      params.push(query.until)
    }
    if (query.model) {
      where.push('model = ?')
      params.push(query.model)
    }
    if (query.cwd) {
      where.push('cwd = ?')
      params.push(query.cwd)
    }
    if (query.agentType) {
      where.push('agent_type = ?')
      params.push(query.agentType)
    }
    if (query.sessionId) {
      where.push('session_id = ?')
      params.push(query.sessionId)
    }
    // `account: ''` is a meaningful filter — it selects the rows written before
    // accounts existed — so this checks for `undefined` rather than for truth.
    if (query.account !== undefined) {
      where.push('account = ?')
      params.push(query.account)
    }
    if (query.errorsOnly) where.push("lower(stop_reason) = 'error'")

    const limit = typeof query.limit === 'number' && query.limit > 0 ? ` LIMIT ${Math.floor(query.limit)}` : ''
    const sql = `SELECT * FROM usage_records${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY time DESC${limit}`
    return (this.#db.prepare(sql).all(...params) as unknown as UsageRow[]).map(rowToRecord)
  }

  /** Whole-store figures. */
  stats(): UsageStoreStats {
    if (this.#closed) return { total: 0, firstTime: null, lastTime: null, sessions: 0, bytes: null }
    const row = this.#db
      .prepare('SELECT COUNT(*) AS total, MIN(time) AS first, MAX(time) AS last, COUNT(DISTINCT session_id) AS sessions FROM usage_records')
      .get() as { total: number; first: number | null; last: number | null; sessions: number }
    let bytes: number | null = null
    try {
      bytes = statSync(this.file).size
    } catch {
      bytes = null
    }
    return { total: Number(row.total) || 0, firstTime: row.first ?? null, lastTime: row.last ?? null, sessions: Number(row.sessions) || 0, bytes }
  }

  /**
   * Whether a session file has already been folded in at this exact revision.
   *
   * A scan is cheap only when it can skip unchanged files: decompressing every
   * log on disk costs seconds, while comparing (mtime, size) costs nothing.
   *
   * @param path - absolute session file path.
   * @param mtimeMs - current modification time.
   * @param size - current byte size.
   * @returns whether the file is unchanged since it was last processed.
   */
  isFileCurrent(path: string, mtimeMs: number, size: number): boolean {
    if (this.#closed) return false
    const row = this.#db.prepare('SELECT mtime_ms, size FROM usage_files WHERE path = ?').get(path) as
      | { mtime_ms: number; size: number }
      | undefined
    return row !== undefined && Number(row.mtime_ms) === mtimeMs && Number(row.size) === size
  }

  /**
   * Remember that a session file has been folded in at this revision.
   *
   * @param path - absolute session file path.
   * @param mtimeMs - modification time at the time of the scan.
   * @param size - byte size at the time of the scan.
   */
  markFile(path: string, mtimeMs: number, size: number): void {
    if (this.#closed) return
    this.#db
      .prepare('INSERT INTO usage_files (path, mtime_ms, size) VALUES (?, ?, ?) ON CONFLICT(path) DO UPDATE SET mtime_ms = excluded.mtime_ms, size = excluded.size')
      .run(path, mtimeMs, size)
  }

  /** Forget every remembered file revision, forcing the next scan to re-read all of them. */
  resetFiles(): void {
    if (this.#closed) return
    this.#db.prepare('DELETE FROM usage_files').run()
  }

  /** How many session files are currently remembered as processed. */
  fileCount(): number {
    if (this.#closed) return 0
    const row = this.#db.prepare('SELECT COUNT(*) AS total FROM usage_files').get() as { total: number }
    return Number(row.total) || 0
  }

  /** Read one metadata value. */
  meta(key: string): string | undefined {
    if (this.#closed) return undefined
    const row = this.#db.prepare('SELECT value FROM usage_meta WHERE key = ?').get(key) as { value: string } | undefined
    return row?.value
  }

  /** Write one metadata value. */
  setMeta(key: string, value: string): void {
    if (this.#closed) return
    this.#db.prepare('INSERT INTO usage_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, String(value))
  }

  /**
   * Drop calls older than a cutoff.
   *
   * @param before - epoch ms; rows strictly older are deleted.
   * @returns how many rows were removed.
   */
  prune(before: number): number {
    if (this.#closed) return 0
    const result = this.#db.prepare('DELETE FROM usage_records WHERE time < ?').run(before)
    return Number(result.changes) || 0
  }

  /** Remove every recorded call, keeping the database itself. */
  clear(): number {
    if (this.#closed) return 0
    const result = this.#db.prepare('DELETE FROM usage_records').run()
    return Number(result.changes) || 0
  }

  /** Close the database. Idempotent. */
  close(): void {
    if (this.#closed) return
    this.#closed = true
    try {
      this.#db.close()
    } catch {
      /* already closed by the runtime */
    }
  }
}

function rowToRecord(row: UsageRow): UsageRecord {
  const tokens: UsageTokens = {
    inputTokens: Number(row.input_tokens) || 0,
    outputTokens: Number(row.output_tokens) || 0,
    cacheReadTokens: Number(row.cache_read_tokens) || 0,
    cacheWriteTokens: Number(row.cache_write_tokens) || 0,
    reasoningTokens: Number(row.reasoning_tokens) || 0,
    totalTokens: Number(row.total_tokens) || 0
  }
  return {
    time: Number(row.time) || 0,
    sessionId: row.session_id || '',
    cwd: row.cwd || '',
    model: row.model || '',
    agentType: row.agent_type === 'subagent' ? 'subagent' : 'main',
    ttftMs: row.ttft_ms === null ? null : Number(row.ttft_ms),
    durationMs: row.duration_ms === null ? null : Number(row.duration_ms),
    stopReason: row.stop_reason || '',
    errorMessage: row.error_message || '',
    ...(row.account ? { account: row.account } : {}),
    tokens
  }
}

function int(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.round(value) : 0
}

function numberOrNull(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.round(value) : null
}
