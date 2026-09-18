import { randomUUID } from 'node:crypto'
import type { CallObservation } from './adapter.js'
import { emptyTokens } from './usage-model.js'
import type { UsageRecord, UsageTokens } from './usage-model.js'
import type { UsageStore } from './usage-store.js'

/**
 * Turns settled provider calls into durable usage rows.
 *
 * The collector is the only writer: the adapter reports what it saw, the
 * collector attaches the session facts the adapter cannot see (working
 * directory, main-vs-subagent) and hands one row to the store under an
 * idempotency key.
 *
 * @module dsh-antigravity/usage-collector
 */

/** Session facts the collector attaches to a call. */
export interface SessionFacts {
  /** Absolute working directory, empty when unknown. */
  cwd: string
  /** Whether the call came from a delegated child session. */
  agentType: 'main' | 'subagent'
}

/** Options for {@link UsageCollector}. */
export interface UsageCollectorOptions {
  /** Where rows land. */
  store: UsageStore
  /** Resolve session facts; may throw, in which case facts degrade to empty. */
  resolveSession?: (sessionId: string) => SessionFacts
  /** Whether recording is on; read on every call so a settings edit applies live. */
  enabled?: () => boolean
  /** Sink for non-fatal problems. */
  warn?: (message: string) => void
}

export class UsageCollector {
  readonly #store: UsageStore
  readonly #resolveSession: ((sessionId: string) => SessionFacts) | undefined
  readonly #enabled: (() => boolean) | undefined
  readonly #warn: ((message: string) => void) | undefined

  constructor(options: UsageCollectorOptions) {
    this.#store = options.store
    this.#resolveSession = options.resolveSession
    this.#enabled = options.enabled
    this.#warn = options.warn
  }

  /**
   * Record one settled call.
   *
   * @param observation - what the adapter saw.
   * @param key - idempotency key; defaults to a fresh UUID.
   * @returns whether a new row was written.
   */
  observe(observation: CallObservation, key: string = randomUUID()): boolean {
    if (this.#enabled !== undefined && this.#enabled() !== true) return false
    try {
      const facts = observation.sessionId === '' ? undefined : this.#safeFacts(observation.sessionId)
      // The human label, not the registry id: the panel answers "which Google
      // account spent this", and an email is that answer.
      const account = observation.accountLabel || observation.accountId || ''
      const record: UsageRecord = {
        time: observation.time,
        sessionId: observation.sessionId,
        cwd: facts?.cwd ?? '',
        model: observation.model,
        agentType: facts?.agentType ?? 'main',
        ttftMs: observation.ttftMs,
        durationMs: observation.durationMs,
        stopReason: observation.stopReason || 'stop',
        errorMessage: observation.errorMessage || '',
        ...(account === '' ? {} : { account }),
        tokens: tokensOf(observation.tokens)
      }
      return this.#store.insert(key, record)
    } catch (error) {
      // Recording is a side effect of a working call: a failure here is
      // reported and swallowed, never propagated into the model route.
      this.#warn?.(`用量记录失败：${messageOf(error)}`)
      return false
    }
  }

  /** Import pre-built rows (the historical backfill path). */
  import(key: string, record: UsageRecord): boolean {
    try {
      return this.#store.insert(key, record)
    } catch (error) {
      this.#warn?.(`用量导入失败：${messageOf(error)}`)
      return false
    }
  }

  #safeFacts(sessionId: string): SessionFacts | undefined {
    if (this.#resolveSession === undefined) return undefined
    try {
      return this.#resolveSession(sessionId)
    } catch {
      return undefined
    }
  }
}

/**
 * Normalize DSH's `TokenUsage` into the store's bucket shape.
 *
 * DSH leaves `totalTokens` and `reasoningTokens` optional; the store's
 * invariant is that `totalTokens` always equals the sum of the four buckets,
 * so a provider that omits it is completed here rather than at read time.
 *
 * @param usage - provider-reported usage, or null.
 * @returns the normalized buckets.
 */
export function tokensOf(usage: Partial<TokenUsageLike> | null | undefined): UsageTokens {
  if (usage === null || usage === undefined) return emptyTokens()
  const inputTokens = count(usage.inputTokens)
  const outputTokens = count(usage.outputTokens)
  const cacheReadTokens = count(usage.cacheReadTokens)
  const cacheWriteTokens = count(usage.cacheWriteTokens)
  const reasoningTokens = count(usage.reasoningTokens)
  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    reasoningTokens,
    totalTokens: inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens
  }
}

/** Structural view of the fields {@link tokensOf} reads. */
interface TokenUsageLike {
  inputTokens: number
  outputTokens: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  reasoningTokens?: number
  totalTokens?: number
}

function count(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.round(value) : 0
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
