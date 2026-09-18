import { spawn } from 'node:child_process'
import { readdir, stat } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { tokensOf } from './usage-collector.js'
import type { UsageRecord } from './usage-model.js'

/**
 * Historical import: fold the Antigravity calls already sitting in this
 * machine's session logs into the usage store.
 *
 * Live recording only ever sees calls made after the plugin was installed,
 * which makes a freshly installed panel look broken. The session logs already
 * hold every past call (DSH persists the provider's `usage` on each
 * `assistant/message` event), so one pass over them turns "no data yet" into
 * real history.
 *
 * What the logs cannot give back, and what this import therefore leaves empty:
 *
 * - first-token latency and duration — no event carries them;
 * - the stop reason — the log records a message, not how the step ended, so
 *   every imported row counts as successful. That is a stated distortion, not
 *   an accident.
 *
 * The logs are multi-frame zstd (`session.v3.jsonl.zstd`), a container Node's
 * own `zstdDecompress` stops reading after the first frame. The import shells
 * out to the `zstd` binary and reports its absence instead of guessing.
 *
 * @module dsh-antigravity/usage-backfill
 */

/** Options for {@link backfillFromSessions}. */
export interface BackfillOptions {
  /** `~/.dsh/sessions`. */
  sessionsRoot: string
  /** Provider route whose calls to import, e.g. `google-antigravity`. */
  provider: string
  /** Import one row; return whether it was newly written. */
  importRow: (key: string, record: UsageRecord) => boolean
  /** Decompressor binary; defaults to `zstd` from PATH. */
  zstdBinary?: string
  /** Per-file decompressed ceiling, to bound memory on a runaway file. */
  maxBytesPerFile?: number
  /** Progress sink, called once per session file. */
  onProgress?: (done: number, total: number) => void
  /**
   * Whether a file is already folded in at this revision. Supplying it turns a
   * repeat scan into a cheap stat sweep: decompression is the expensive part,
   * and an unchanged log cannot contain a call we have not already seen.
   */
  isCurrent?: (path: string, mtimeMs: number, size: number) => boolean
  /** Remember a file at this revision once its events have been folded in. */
  markProcessed?: (path: string, mtimeMs: number, size: number) => void
  /**
   * Whether this call was already recorded while it ran.
   *
   * Live observation and this scan are two views of the same call, and their
   * row keys cannot collide (a fresh uuid against `sessionId:seq`), so without
   * this check every call the plugin watched would be counted twice. Supplying
   * it makes the scan import only what live recording could not see: history
   * from before the plugin was installed.
   */
  observedCall?: (record: UsageRecord) => boolean
}

/** Outcome of one import pass. */
export interface BackfillResult {
  /** Session files visited. */
  files: number
  /** Events parsed across those files. */
  scanned: number
  /** Events that carried this provider's usage. */
  matched: number
  /** Rows newly written (already-present rows are skipped). */
  imported: number
  /** Events left alone because live recording already accounted for the call. */
  duplicates: number
  /** Files skipped because their revision was already folded in. */
  unchanged: number
  /** Files that could not be read, with the reason. */
  failed: string[]
}

/** The session artifact name DSH writes; both the plain and zstd forms are tried. */
const CANDIDATE_FILES = ['session.v3.jsonl.zstd', 'session.v3.jsonl']

/**
 * Import every recorded Antigravity call found in the session log tree.
 *
 * @param options - roots, provider filter, and the row sink.
 * @returns counts, including the files that could not be read.
 */
export async function backfillFromSessions(options: BackfillOptions): Promise<BackfillResult> {
  const result: BackfillResult = { files: 0, scanned: 0, matched: 0, imported: 0, duplicates: 0, unchanged: 0, failed: [] }
  const files = await listSessionFiles(options.sessionsRoot)
  const binary = options.zstdBinary ?? 'zstd'
  const maxBytes = options.maxBytesPerFile ?? 128 * 1024 * 1024

  let done = 0
  for (const file of files) {
    done += 1
    options.onProgress?.(done, files.length)
    result.files += 1

    if (options.isCurrent?.(file.path, file.mtimeMs, file.size) === true) {
      result.unchanged += 1
      continue
    }

    let text: string
    try {
      text = file.path.endsWith('.zstd')
        ? await decompress(file.path, binary, maxBytes)
        : await readPlain(file.path, maxBytes)
    } catch (error) {
      result.failed.push(`${basename(dirname(file.path))}: ${messageOf(error)}`)
      continue
    }

    // A file that decompressed cleanly is remembered even when it contributed
    // no rows: re-reading it next time would produce the same nothing.
    options.markProcessed?.(file.path, file.mtimeMs, file.size)

    const sessionId = basename(dirname(file.path))
    let cwd = ''
    let agentType: 'main' | 'subagent' = 'main'

    for (const line of text.split('\n')) {
      if (line === '') continue
      let event: SessionLogEvent
      try {
        event = JSON.parse(line)
      } catch {
        continue
      }
      result.scanned += 1

      if (event.type === 'session') {
        cwd = typeof event.cwd === 'string' ? event.cwd : ''
        agentType = Number(event.delegationDepth) > 0 || event.parentSession !== undefined ? 'subagent' : 'main'
        continue
      }
      if (event.type !== 'assistant/message') continue

      const data = event.data
      const source = data?.message?.source
      if (source === undefined || source.provider !== options.provider) continue
      if (data?.usage === undefined || data.usage === null) continue

      result.matched += 1
      const record: UsageRecord = {
        time: Number(event.time) || 0,
        sessionId,
        cwd,
        model: typeof source.model === 'string' ? source.model : '',
        agentType,
        ttftMs: null,
        durationMs: null,
        // See the module note: the log does not preserve how the step ended.
        stopReason: 'stop',
        errorMessage: '',
        tokens: tokensOf(data.usage)
      }
      // The log copy of a call the plugin already watched live is not new
      // information: counting both doubles every figure on the panel.
      if (options.observedCall?.(record) === true) {
        result.duplicates += 1
        continue
      }

      const key = `${sessionId}:${event.seq === undefined ? `${record.time}` : event.seq}`
      if (options.importRow(key, record)) result.imported += 1
    }
  }

  return result
}

/** Structural view of one line of a session log. */
interface SessionLogEvent {
  type?: string
  seq?: number
  time?: number
  cwd?: string
  delegationDepth?: number
  parentSession?: unknown
  data?: {
    usage?: Record<string, number> | null
    message?: { source?: { provider?: string; model?: string } }
  }
}

/** Just enough of `Dirent` to walk the tree without pinning the encoding overload. */
interface DirEntry {
  readonly name: string
  isDirectory(): boolean
}

/** One session artifact on disk, with the revision that identifies it. */
interface SessionFile {
  path: string
  mtimeMs: number
  size: number
}

/** List every session artifact under the sessions root (`--<path>--/<id>/<file>`). */
async function listSessionFiles(root: string): Promise<SessionFile[]> {
  const out: SessionFile[] = []
  let groups: DirEntry[]
  try {
    groups = await readdir(root, { withFileTypes: true })
  } catch {
    return out
  }
  for (const group of groups) {
    if (!group.isDirectory()) continue
    const groupDir = join(root, group.name)
    let sessions: DirEntry[]
    try {
      sessions = await readdir(groupDir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const session of sessions) {
      if (!session.isDirectory()) continue
      for (const name of CANDIDATE_FILES) {
        const candidate = join(groupDir, session.name, name)
        try {
          const info = await stat(candidate)
          if (info.isFile() && info.size > 0) {
            out.push({ path: candidate, mtimeMs: info.mtimeMs, size: info.size })
            break
          }
        } catch {
          /* try the next candidate name */
        }
      }
    }
  }
  return out
}

/** Run the zstd binary over one log and return the decoded text. */
function decompress(file: string, binary: string, maxBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let child
    try {
      child = spawn(binary, ['-d', '-c', '--', file], { stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (error) {
      reject(error)
      return
    }
    const chunks: Buffer[] = []
    let size = 0
    let settled = false
    let stderr = ''

    child.stdout.on('data', (chunk: Buffer) => {
      if (settled) return
      size += chunk.length
      if (size > maxBytes) {
        settled = true
        child.kill()
        reject(new Error(`解压后超过 ${Math.round(maxBytes / 1024 / 1024)} MB 上限`))
        return
      }
      chunks.push(chunk)
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < 400) stderr += chunk.toString('utf8')
    })
    child.on('error', (error: NodeJS.ErrnoException) => {
      if (settled) return
      settled = true
      reject(error.code === 'ENOENT' ? new Error(`找不到 ${binary} 命令`) : error)
    })
    child.on('close', (code: number | null) => {
      if (settled) return
      settled = true
      if (code === 0) resolve(Buffer.concat(chunks).toString('utf8'))
      else reject(new Error(stderr.trim() || `zstd 退出码 ${code}`))
    })
  })
}

async function readPlain(file: string, maxBytes: number): Promise<string> {
  const { readFile } = await import('node:fs/promises')
  const info = await stat(file)
  if (info.size > maxBytes) throw new Error(`文件超过 ${Math.round(maxBytes / 1024 / 1024)} MB 上限`)
  return readFile(file, 'utf8')
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
