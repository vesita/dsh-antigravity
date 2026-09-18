import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import {
  accountLabelOf,
  discoverEmail,
  dshHome,
  isExpiring,
  loadEnvCredentials,
  readAuthFile,
  readCredentialRecord,
  refreshAccessToken,
  removeAuthFile,
  writeAuthFile,
  writeCredentialRecord,
  deleteCredentialRecord
} from './auth.js'
import type { AntigravityCredentials, CredentialsSeam, OAuthClientOverrides } from './auth.js'

/**
 * Multi-account ownership: the durable account registry and the pool that hands
 * one usable account to each provider call.
 *
 * Two stores, one meaning:
 * - `~/.dsh/antigravity-accounts.json` (0600) is the **list**: every signed-in
 *   Google account, which one is active, when each was last used, and until when
 *   a quota-exhausted one is parked. It is the only place the set of accounts
 *   exists — the `ctx.credentials` seam stores one record per key and cannot be
 *   enumerated, so it keeps mirroring the *active* account only;
 * - `~/.dsh/antigravity-auth.json` keeps its old meaning as a mirror of the
 *   active account, so the standalone CLI, a proxy started outside DSH, and any
 *   earlier build keep resolving credentials exactly as before.
 *
 * A deployment that has always had exactly one account needs no migration step
 * the user can see: on first read an empty registry adopts the grant the seam or
 * the legacy mirror already holds.
 *
 * @module dsh-antigravity/accounts
 */

/** On-disk registry format version. */
export const ACCOUNT_REGISTRY_VERSION = 1

/** Cooldown applied to a quota failure whose reset time the body did not carry. */
export const DEFAULT_QUOTA_COOLDOWN_MS = 10 * 60 * 1000

/** Ceiling on any cooldown, so one bad parse cannot park an account forever. */
export const MAX_QUOTA_COOLDOWN_MS = 24 * 60 * 60 * 1000

/**
 * How long an account is skipped after a credential failure (a refresh that came
 * back rejected or unreachable). Long enough that a dead grant is not re-tried on
 * every call, short enough that a transient failure costs one window.
 */
export const AUTH_COOLDOWN_MS = 5 * 60 * 1000

/** Synthetic account id for the `GOOGLE_ANTIGRAVITY_TOKEN` environment grant. */
export const ENV_ACCOUNT_ID = 'env'

/** How the pool orders accounts that are all ready to serve. */
export type AccountStrategy = 'round-robin' | 'active-first'

/** One signed-in Google account, credentials included. */
export interface AccountEntry {
  /** Stable id derived from the account's email. */
  id: string
  /** Human-readable identity shown in settings: the email when known. */
  label: string
  /** Google account email, when Google reported one. */
  email?: string
  /** Cloud project this account bills against. */
  projectId?: string
  /** When the account was first added, epoch ms. */
  addedAt: number
  /** Last time a call actually used it, epoch ms. */
  lastUsedAt?: number
  /**
   * Epoch ms until which the pool skips this account. Set by a quota failure:
   * retrying a subscription whose quota resets in an hour is not a backoff, it
   * is a wasted request, and with a second account there is somewhere better to
   * go.
   */
  cooldownUntil?: number
  /** Last failure this account produced, for the settings card. */
  lastError?: string
  /** Failure class behind {@link AccountEntry.lastError}. */
  lastErrorKind?: 'quota' | 'auth' | 'other'
  /** The live grant. */
  creds: AntigravityCredentials
}

/** The whole registry file. */
export interface AccountRegistry {
  version: number
  /** Account a fresh sign-in landed on; also the one the seam/file mirror holds. */
  activeId?: string
  accounts: AccountEntry[]
  updatedAt: number
}

/** Secret-free projection of one account, as the browser half reads it. */
export interface AccountView {
  id: string
  label: string
  email: string | null
  projectId: string | null
  addedAt: number
  lastUsedAt: number | null
  expires: number | null
  timeLeftSeconds: number | null
  expired: boolean
  cooldownUntil: number | null
  cooldownSeconds: number | null
  cooling: boolean
  active: boolean
  source: string | null
  lastError: string | null
}

/** One account-scoped failure reported back to the pool. */
export interface AccountFailureInfo {
  /** Id of the account that failed; absent when the caller cannot tell. */
  accountId?: string
  /** What kind of failure it was. Only `quota` and `auth` justify another account. */
  kind: 'quota' | 'auth' | 'other'
  /** Provider text, stored on the account for the settings card. */
  message: string
  /** When a quota is known to reset, epoch ms. */
  cooldownUntil?: number
}

/** Pool wiring supplied by the mounting plugin. */
export interface AccountPoolOptions {
  /** `ctx.credentials` seam, when the deployment mounts one. */
  credentials?: () => CredentialsSeam | undefined
  /** OAuth client facts for refreshes. */
  oauth?: () => OAuthClientOverrides
  /** Live selection strategy, read on every call so a settings edit applies. */
  strategy?: () => AccountStrategy
  /** Clock, injectable for tests. */
  now?: () => number
  /** Registry path override; the CLI and tests use it. */
  file?: string
  /** Cooldown for a quota failure without a parseable reset time. */
  quotaCooldownMs?: number
  /** Sink for non-fatal problems. */
  warn?: (message: string) => void
  /** Token refresh, injectable for tests. */
  refresh?: (creds: AntigravityCredentials, options: OAuthClientOverrides & { signal?: AbortSignal }) => Promise<AntigravityCredentials>
  /** Identity lookup for a grant that has no email; injectable for tests. */
  discoverEmail?: (access: string, signal?: AbortSignal) => Promise<string | undefined>
}

// ---------------------------------------------------------------------------
// Registry file
// ---------------------------------------------------------------------------

/** Path of the multi-account registry this plugin owns. */
export function accountsFilePath(): string {
  return path.join(dshHome(), 'antigravity-accounts.json')
}

/** A registry with no accounts. */
export function emptyRegistry(): AccountRegistry {
  return { version: ACCOUNT_REGISTRY_VERSION, accounts: [], updatedAt: 0 }
}

/** Read the registry; a missing or corrupt file reads as empty, never throws. */
export function readAccountRegistry(file: string = accountsFilePath()): AccountRegistry {
  let parsed: any
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return emptyRegistry()
  }
  if (parsed === null || typeof parsed !== 'object' || !Array.isArray(parsed.accounts)) return emptyRegistry()
  const accounts: AccountEntry[] = []
  for (const raw of parsed.accounts) {
    if (raw === null || typeof raw !== 'object') continue
    if (typeof raw.id !== 'string' || raw.id === '') continue
    const creds = raw.creds
    if (creds === null || typeof creds !== 'object' || typeof creds.access !== 'string' || creds.access === '') continue
    accounts.push({
      id: raw.id,
      label: typeof raw.label === 'string' && raw.label !== '' ? raw.label : creds.email || raw.id,
      ...(typeof raw.email === 'string' && raw.email !== '' ? { email: raw.email } : {}),
      ...(typeof raw.projectId === 'string' && raw.projectId !== '' ? { projectId: raw.projectId } : {}),
      addedAt: typeof raw.addedAt === 'number' ? raw.addedAt : 0,
      ...(typeof raw.lastUsedAt === 'number' ? { lastUsedAt: raw.lastUsedAt } : {}),
      ...(typeof raw.cooldownUntil === 'number' ? { cooldownUntil: raw.cooldownUntil } : {}),
      ...(typeof raw.lastError === 'string' && raw.lastError !== '' ? { lastError: raw.lastError } : {}),
      ...(raw.lastErrorKind === 'quota' || raw.lastErrorKind === 'auth' || raw.lastErrorKind === 'other'
        ? { lastErrorKind: raw.lastErrorKind }
        : {}),
      creds: { ...creds, accountId: raw.id }
    })
  }
  return {
    version: typeof parsed.version === 'number' ? parsed.version : ACCOUNT_REGISTRY_VERSION,
    ...(typeof parsed.activeId === 'string' && parsed.activeId !== '' ? { activeId: parsed.activeId } : {}),
    accounts,
    updatedAt: typeof parsed.updatedAt === 'number' ? parsed.updatedAt : 0
  }
}

/**
 * Write the registry with owner-only permissions.
 *
 * Written to a sibling temp file and renamed into place. `writeFileSync` alone
 * truncates the target first, and a reader that lands in that window — the CLI,
 * a second DSH process, a status request — would parse an empty file and
 * conclude the user has no accounts at all. `rename` within one filesystem is
 * atomic, so a reader sees either the old registry or the new one.
 */
export function writeAccountRegistry(registry: AccountRegistry, file: string = accountsFilePath()): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const temporary = `${file}.${process.pid}.tmp`
  fs.writeFileSync(temporary, JSON.stringify(registry, null, 2), { mode: 0o600 })
  fs.renameSync(temporary, file)
  try {
    fs.chmodSync(file, 0o600)
  } catch {
    /* best effort on filesystems without POSIX modes */
  }
}

// ---------------------------------------------------------------------------
// Registry operations (pure; the pool owns persistence)
// ---------------------------------------------------------------------------

/**
 * Stable id for a grant. The email is what makes the same human re-signing in
 * land on the same entry instead of a duplicate; a grant without one falls back
 * to its project, then to a random id.
 *
 * @param creds - credential facts.
 * @returns a short stable id.
 */
export function accountIdFor(creds: AntigravityCredentials): string {
  const email = typeof creds.email === 'string' ? creds.email.trim().toLowerCase() : ''
  if (email) return createHash('sha1').update(email).digest('hex').slice(0, 12)
  const seed = `${creds.projectId || ''}|${creds.authorizedAt ?? ''}`
  if (seed !== '|') return createHash('sha1').update(seed).digest('hex').slice(0, 12)
  return createHash('sha1').update(`${Date.now()}|${Math.random()}`).digest('hex').slice(0, 12)
}

/**
 * Insert or update one account. Re-signing in to a known email refreshes that
 * entry (and clears any quota park) rather than adding a second copy.
 *
 * @param registry - registry to mutate.
 * @param creds - credential facts.
 * @param now - clock, epoch ms.
 * @returns the entry that now holds these credentials.
 */
export function upsertAccount(
  registry: AccountRegistry,
  creds: AntigravityCredentials,
  now: number = Date.now()
): AccountEntry {
  const email = typeof creds.email === 'string' ? creds.email.trim() : ''
  const id = accountIdFor(creds)
  const existing =
    (email === '' ? undefined : registry.accounts.find(a => (a.email || '').toLowerCase() === email.toLowerCase())) ??
    registry.accounts.find(a => a.id === id)

  const target: AccountEntry =
    existing ??
    ({
      id,
      label: accountLabelOf(creds),
      addedAt: now,
      creds
    } as AccountEntry)

  if (existing === undefined) registry.accounts.push(target)
  target.creds = { ...creds, accountId: target.id }
  if (email !== '') {
    target.email = email
    target.label = email
  } else if (target.label === undefined || target.label === '') {
    target.label = creds.projectId || target.id
  }
  if (creds.projectId) target.projectId = creds.projectId
  target.cooldownUntil = undefined
  target.lastError = undefined
  target.lastErrorKind = undefined
  registry.updatedAt = now
  return target
}

/** The account the seam/file mirror follows: the active one, else the first. */
export function activeAccount(registry: AccountRegistry): AccountEntry | null {
  if (registry.accounts.length === 0) return null
  return registry.accounts.find(a => a.id === registry.activeId) ?? registry.accounts[0]
}

/**
 * Fold entries that turn out to be the same Google account into one.
 *
 * Duplicates come from an email-less grant: an account adopted from a
 * single-account install is identified by its project id, so a sign-in with that
 * same Google account lands beside it instead of refreshing it. Two entries for
 * one account are worse than untidy — the pool would rotate a single quota
 * between them and report a failover that cannot help.
 *
 * The survivor is the entry that appears first (the oldest, which is the one the
 * card has been showing); it takes the newer grant, the later cooldown, the
 * active flag and the earliest `addedAt`.
 *
 * @param registry - registry to mutate.
 * @param now - clock, epoch ms.
 * @returns how many entries were folded away.
 */
export function mergeDuplicates(registry: AccountRegistry, now: number = Date.now()): number {
  const kept: AccountEntry[] = []
  const byEmail = new Map<string, AccountEntry>()
  let merged = 0
  for (const entry of registry.accounts) {
    const email = (entry.email ?? entry.creds.email ?? '').trim().toLowerCase()
    if (email === '') {
      kept.push(entry)
      continue
    }
    const survivor = byEmail.get(email)
    if (survivor === undefined) {
      byEmail.set(email, entry)
      kept.push(entry)
      continue
    }
    merged += 1
    if (registry.activeId === entry.id) registry.activeId = survivor.id
    if ((entry.creds.expires ?? 0) > (survivor.creds.expires ?? 0)) {
      survivor.creds = { ...entry.creds, accountId: survivor.id }
    }
    survivor.projectId = survivor.projectId ?? entry.projectId
    survivor.addedAt = Math.min(survivor.addedAt, entry.addedAt)
    survivor.lastUsedAt = Math.max(survivor.lastUsedAt ?? 0, entry.lastUsedAt ?? 0) || undefined
    survivor.cooldownUntil = Math.max(survivor.cooldownUntil ?? 0, entry.cooldownUntil ?? 0) || undefined
    if (survivor.lastError === undefined) {
      survivor.lastError = entry.lastError
      survivor.lastErrorKind = entry.lastErrorKind
    }
  }
  if (merged > 0) {
    registry.accounts = kept
    registry.updatedAt = now
  }
  return merged
}

/** Remove one account, re-pointing `activeId` when the active one left. */
export function removeAccountById(registry: AccountRegistry, id: string, now: number = Date.now()): boolean {
  const index = registry.accounts.findIndex(a => a.id === id)
  if (index === -1) return false
  registry.accounts.splice(index, 1)
  if (registry.activeId === id) {
    const next = registry.accounts[0]
    if (next === undefined) delete registry.activeId
    else registry.activeId = next.id
  }
  registry.updatedAt = now
  return true
}

/**
 * Adopt a pre-multi-account grant into an empty registry.
 *
 * @param registry - registry to mutate.
 * @param legacy - the grant the seam or the legacy mirror held.
 * @param now - clock, epoch ms.
 * @returns the adopted entry, or null when there was nothing to adopt.
 */
export function adoptLegacy(
  registry: AccountRegistry,
  legacy: AntigravityCredentials | null,
  now: number = Date.now()
): AccountEntry | null {
  if (legacy === null || legacy === undefined || typeof legacy.access !== 'string' || legacy.access === '') return null
  const entry = upsertAccount(registry, legacy, now)
  registry.activeId = entry.id
  return entry
}

/**
 * Keep the legacy single-account mirror in step with the active account.
 *
 * @param registry - registry whose active account should be mirrored.
 */
export function mirrorLegacy(registry: AccountRegistry): void {
  const active = activeAccount(registry)
  if (active === null) {
    removeAuthFile()
    return
  }
  try {
    writeAuthFile(active.creds)
  } catch {
    /* the registry already holds the truth; the mirror is a convenience */
  }
}

/** Secret-free view of one entry for the settings card. */
export function viewOf(entry: AccountEntry, registry: AccountRegistry, now: number = Date.now()): AccountView {
  const expires = typeof entry.creds.expires === 'number' ? entry.creds.expires : null
  const cooling = typeof entry.cooldownUntil === 'number' && entry.cooldownUntil > now
  return {
    id: entry.id,
    label: entry.label,
    email: entry.email ?? entry.creds.email ?? null,
    projectId: entry.projectId ?? entry.creds.projectId ?? null,
    addedAt: entry.addedAt,
    lastUsedAt: typeof entry.lastUsedAt === 'number' ? entry.lastUsedAt : null,
    expires,
    timeLeftSeconds: expires === null ? null : Math.max(0, Math.round((expires - now) / 1000)),
    expired: expires !== null && expires <= now,
    cooldownUntil: typeof entry.cooldownUntil === 'number' ? entry.cooldownUntil : null,
    cooldownSeconds: cooling ? Math.max(0, Math.round((entry.cooldownUntil! - now) / 1000)) : null,
    cooling,
    active: registry.activeId === entry.id,
    source: entry.creds.source ?? null,
    lastError: entry.lastError ?? null
  }
}

// ---------------------------------------------------------------------------
// Account pool
// ---------------------------------------------------------------------------

/** One resolved candidate inside {@link AccountPool.resolve}. */
interface Candidate {
  id: string
  creds: AntigravityCredentials
  /** Environment grants are never persisted and never cooled down. */
  transient: boolean
}

/**
 * Hands the provider route one usable account per call.
 *
 * Selection is quota-aware on purpose. Antigravity quotas are per Google
 * account and reset on the order of an hour, so the useful act when one account
 * is exhausted is to spend a different account — and to stop asking the
 * exhausted one until its own reset time. The pool therefore skips parked
 * accounts, refreshes what is about to expire, and falls back to the
 * soonest-recovering parked account when *every* account is parked, so the
 * caller still sees the provider's real quota message instead of a generic
 * "no credentials".
 */
export class AccountPool {
  readonly #options: AccountPoolOptions
  #adopting: Promise<void> | null = null
  #cursor = 0
  #refreshing = new Map<string, Promise<AntigravityCredentials>>()
  #cache: { mtimeMs: number; size: number; registry: AccountRegistry } | null = null

  /**
   * @param options - `{ credentials, oauth, strategy, now, file, quotaCooldownMs, warn, refresh }`.
   */
  constructor(options: AccountPoolOptions = {}) {
    this.#options = options
  }

  #file(): string {
    return this.#options.file ?? accountsFilePath()
  }

  #now(): number {
    return this.#options.now ? this.#options.now() : Date.now()
  }

  /** Live selection strategy. */
  strategy(): AccountStrategy {
    return this.#options.strategy?.() ?? 'round-robin'
  }

  /** Read the registry, re-reading it when the file moved under us. */
  #load(): AccountRegistry {
    const file = this.#file()
    let stat: fs.Stats | null = null
    try {
      stat = fs.statSync(file)
    } catch {
      stat = null
    }
    if (stat === null) return this.#cache?.registry ?? emptyRegistry()
    if (this.#cache !== null && this.#cache.mtimeMs === stat.mtimeMs && this.#cache.size === stat.size) {
      return this.#cache.registry
    }
    const registry = readAccountRegistry(file)
    this.#cache = { mtimeMs: stat.mtimeMs, size: stat.size, registry }
    return registry
  }

  /** Write the registry, the legacy mirror, and the cache together. */
  #persist(registry: AccountRegistry): void {
    registry.updatedAt = this.#now()
    const file = this.#file()
    writeAccountRegistry(registry, file)
    let mtimeMs = 0
    let size = 0
    try {
      const stat = fs.statSync(file)
      mtimeMs = stat.mtimeMs
      size = stat.size
    } catch {
      /* the cache is only an optimization */
    }
    this.#cache = { mtimeMs, size, registry }
    mirrorLegacy(registry)
  }

  /** Mirror the active grant into the record seam, when one is mounted. */
  async #persistSeam(registry: AccountRegistry): Promise<void> {
    const seam = this.#options.credentials?.()
    if (seam === undefined) return
    const active = activeAccount(registry)
    try {
      if (active === null) await deleteCredentialRecord(seam)
      else await writeCredentialRecord(seam, active.creds)
    } catch {
      /* the registry file remains the source of truth for the list */
    }
  }

  /**
   * Adopt a pre-existing single grant, so an upgrading deployment finds its
   * account already listed.
   *
   * Deliberately re-checked rather than done once: the standalone CLI writes the
   * same registry, but a grant written by an *older* build (or by hand) only
   * exists in the legacy layers, and it must become visible without restarting
   * DSH. The check is a registry read that returns immediately once any account
   * is listed.
   *
   * @returns when the registry is ready to be used.
   */
  async ready(): Promise<void> {
    if (this.#adopting !== null) return this.#adopting
    const adoption = this.#adopt()
    this.#adopting = adoption
    try {
      await adoption
    } finally {
      if (this.#adopting === adoption) this.#adopting = null
    }
  }

  async #adopt(): Promise<void> {
    if (this.#load().accounts.length > 0) return
    let legacy: AntigravityCredentials | null = null
    try {
      legacy = await readCredentialRecord(this.#options.credentials?.())
    } catch {
      legacy = null
    }
    if (legacy === null || !legacy.access) legacy = readAuthFile()
    if (legacy === null || !legacy.access) return

    // The lookups above are I/O, and the CLI writes this same registry: an
    // account may have been registered while we waited. Re-reading is what keeps
    // this adoption from erasing it — the registry parsed a moment ago would be
    // written back whole, minus the new account.
    const registry = this.#load()
    const grew = registry.accounts.length > 0
    const entry = grew ? upsertAccount(registry, legacy, this.#now()) : adoptLegacy(registry, legacy, this.#now())
    if (entry === null) return
    mergeDuplicates(registry, this.#now())
    this.#persist(registry)
    this.#options.warn?.(
      grew
        ? `dsh-antigravity: 已把旧版凭据登记为附加账号（${entry.label}）`
        : `dsh-antigravity: 已把现有凭据登记为首个账号（${entry.label}）`
    )
  }

  /** Accounts as the settings card reads them. */
  list(): AccountView[] {
    const registry = this.#load()
    const now = this.#now()
    return registry.accounts.map(entry => viewOf(entry, registry, now))
  }

  /** Number of installed accounts. */
  count(): number {
    return this.#load().accounts.length
  }

  /** Id of the active account, when one exists. */
  activeId(): string | undefined {
    return this.#load().activeId
  }

  /** The active account's label. */
  activeLabel(): string | undefined {
    return activeAccount(this.#load())?.label
  }

  /** Whether any credential layer can currently serve a call. */
  configured(): boolean {
    return this.#load().accounts.length > 0 || loadEnvCredentials() !== null
  }

  /**
   * Resolve one account for a call.
   *
   * @param signal - abort signal for a pending refresh.
   * @param exclude - account ids already tried for this call, so a failover
   *   walks the pool instead of returning to the account that just failed.
   * @returns credential facts, or `undefined` when nothing is left to try.
   */
  async resolve(signal?: AbortSignal, exclude?: ReadonlySet<string>): Promise<AntigravityCredentials | undefined> {
    await this.ready()
    if (signal?.aborted) throw signal.reason

    const now = this.#now()
    const registry = this.#load()
    const candidates: Candidate[] = []
    const env = loadEnvCredentials()
    if (env !== null && env.access) {
      candidates.push({
        id: ENV_ACCOUNT_ID,
        creds: { ...env, accountId: ENV_ACCOUNT_ID },
        transient: true
      })
    }
    for (const entry of registry.accounts) {
      candidates.push({ id: entry.id, creds: entry.creds, transient: false })
    }

    const available = candidates.filter(candidate => exclude === undefined || !exclude.has(candidate.id))
    if (available.length === 0) return undefined

    const ready = available.filter(candidate => !this.#cooling(candidate, now))
    // Every candidate parked: ask the one that recovers first, so the provider's
    // own quota message reaches the caller instead of "no credentials".
    const order =
      ready.length > 0
        ? this.#order(ready)
        : available.slice().sort((a, b) => this.#cooldownEnd(a, now) - this.#cooldownEnd(b, now))

    let lastFailure: unknown = null
    for (const candidate of order) {
      try {
        const creds = await this.#usable(candidate)
        if (creds !== undefined) {
          // Handing an account out is not evidence its quota recovered, so a
          // candidate that was parked a moment ago keeps its park — see
          // {@link AccountPool.markUsed}.
          this.markUsed(creds, { recovered: !this.#cooling(candidate, now) })
          return creds
        }
      } catch (error: any) {
        lastFailure = error
        this.#noteFailure(candidate.id, 'auth', messageOf(error))
      }
    }
    // Accounts exist but not one of them produced credentials. Returning
    // `undefined` here would flatten that into "not signed in" and send the user
    // to re-login over a token that only needed refreshing, so the last real
    // reason travels up instead.
    if (lastFailure !== null) throw lastFailure
    return undefined
  }

  /**
   * Resolve the *active* account (refreshing it when needed) without rotating
   * the pool.
   *
   * Status reads use this: the settings card asks "which account is this
   * provider on", and answering must not consume a round-robin turn or park the
   * account just because the card was opened.
   *
   * @param signal - abort signal for a pending refresh.
   * @returns credential facts, or `undefined` when there is nothing to resolve.
   */
  async resolveActive(signal?: AbortSignal): Promise<AntigravityCredentials | undefined> {
    await this.ready()
    if (signal?.aborted) throw signal.reason
    const registry = this.#load()
    const active = activeAccount(registry)
    if (active !== null) return this.#usable({ id: active.id, creds: active.creds, transient: false })
    const env = loadEnvCredentials()
    if (env !== null && env.access) return { ...env, accountId: ENV_ACCOUNT_ID }
    return undefined
  }

  /**
   * Force a token refresh for one account — the active one by default.
   *
   * Distinct from {@link AccountPool.resolveActive}, which refreshes only when
   * the token is at or near expiry: this is the `refresh` verb, where the caller
   * explicitly wants a new access token now.
   *
   * @param id - account to refresh; defaults to the active one.
   * @returns the refreshed facts, or `undefined` when there is no such account.
   */
  async refreshNow(id?: string): Promise<AntigravityCredentials | undefined> {
    await this.ready()
    const registry = this.#load()
    const entry = id === undefined ? activeAccount(registry) : registry.accounts.find(a => a.id === id)
    if (entry === undefined || entry === null) return undefined
    return this.#refresh({ id: entry.id, creds: entry.creds, transient: false })
  }

  /**
   * Order the accounts that can actually serve this call.
   *
   * The rotation deliberately runs on the *ready* set rather than the whole
   * registry. Advancing the cursor over accounts that are parked or already
   * tried hands the remaining ones a skewed share — measured with three accounts
   * and one parked: the first healthy account took two thirds of the calls
   * instead of half, which is exactly the load that spends its quota next.
   *
   * Environment grants stay in front of every rotation: an operator who set
   * `GOOGLE_ANTIGRAVITY_TOKEN` asked for that credential specifically.
   *
   * @param ready - candidates that are neither excluded nor parked.
   * @returns the same candidates in the order they should be tried.
   */
  #order(ready: Candidate[]): Candidate[] {
    const fromEnv = ready.filter(candidate => candidate.transient)
    const rest = ready.filter(candidate => !candidate.transient)
    if (rest.length <= 1) return [...fromEnv, ...rest]

    if (this.strategy() === 'active-first') {
      const activeId = this.#load().activeId
      const index = rest.findIndex(candidate => candidate.id === activeId)
      const ordered = index > 0 ? [rest[index], ...rest.slice(0, index), ...rest.slice(index + 1)] : rest
      return [...fromEnv, ...ordered]
    }

    const start = this.#cursor % rest.length
    this.#cursor = (this.#cursor + 1) % 1_000_000
    return [...fromEnv, ...rest.slice(start), ...rest.slice(0, start)]
  }

  #cooling(candidate: Candidate, now: number): boolean {
    if (candidate.transient) return false
    const registry = this.#load()
    const entry = registry.accounts.find(a => a.id === candidate.id)
    return entry !== undefined && typeof entry.cooldownUntil === 'number' && entry.cooldownUntil > now
  }

  #cooldownEnd(candidate: Candidate, now: number): number {
    if (candidate.transient) return now
    const entry = this.#load().accounts.find(a => a.id === candidate.id)
    return typeof entry?.cooldownUntil === 'number' ? entry.cooldownUntil : now
  }

  /** Refresh when needed, one attempt per account at a time. */
  async #usable(candidate: Candidate): Promise<AntigravityCredentials | undefined> {
    const creds = candidate.creds
    if (typeof creds.access !== 'string' || creds.access === '') return undefined
    if (candidate.transient || !isExpiring(creds) || !creds.refresh) return creds

    let inflight = this.#refreshing.get(candidate.id)
    if (inflight === undefined) {
      inflight = this.#refresh(candidate)
      this.#refreshing.set(candidate.id, inflight)
      // One in-flight refresh per account: a burst of concurrent calls must not
      // stampede Google's token endpoint with the same refresh token.
      void inflight.finally(() => this.#refreshing.delete(candidate.id)).catch(() => {})
    }
    return inflight
  }

  async #refresh(candidate: Candidate): Promise<AntigravityCredentials> {
    const refresh = this.#options.refresh ?? refreshAccessToken
    const refreshed = await refresh(candidate.creds, { ...this.#options.oauth?.() })

    // The registry is re-read *after* the round trip rather than trusted from
    // before it: another writer (a concurrent call, the CLI) may have rewritten
    // the file meanwhile, and writing the fresh token into whatever is on disk
    // *now* is what keeps the refresh from being silently dropped.
    const registry = this.#load()
    const entry = registry.accounts.find(a => a.id === candidate.id)
    if (entry === undefined) return refreshed
    entry.creds = { ...refreshed, accountId: entry.id }
    this.#persist(registry)

    // A grant adopted from a single-account install carries no email, so it can
    // only ever be named by its project — and a sign-in with that same Google
    // account becomes a second entry instead of refreshing the first. The
    // refresh has just produced a live access token: the cheapest moment to ask
    // who it belongs to, and to fold away any duplicate that wait produced.
    if ((entry.email ?? entry.creds.email ?? '') === '') {
      const learned = await this.#discoverEmail(refreshed.access)
      if (learned !== undefined) {
        entry.email = learned
        entry.label = learned
        refreshed.email = learned
        mergeDuplicates(registry, this.#now())
        this.#persist(registry)
        const survivor = registry.accounts.find(
          a => (a.email ?? a.creds.email ?? '').trim().toLowerCase() === learned.toLowerCase()
        )
        if (survivor !== undefined && survivor.id !== entry.id) refreshed.accountId = survivor.id
      }
    }
    return refreshed
  }

  /** Best-effort identity lookup; an unreachable Google never breaks a call. */
  async #discoverEmail(access: string): Promise<string | undefined> {
    try {
      const learned = await (this.#options.discoverEmail ?? discoverEmail)(access)
      return typeof learned === 'string' && learned.trim() !== '' ? learned.trim() : undefined
    } catch {
      return undefined
    }
  }

  /**
   * Record that an account was handed out for a call.
   *
   * @param creds - the credentials `resolve` returned.
   * @param options - `{ recovered }` is false when the account came out of the
   *   soonest-recovering fallback, i.e. it was parked a moment ago. A park is
   *   only lifted by evidence, and being handed out is not evidence: clearing it
   *   here would make an all-exhausted pool retry every account on every call
   *   instead of waiting for the reset it was told about.
   */
  markUsed(creds: AntigravityCredentials | undefined, options: { recovered?: boolean } = {}): void {
    if (creds === undefined || creds === null) return
    const id = typeof creds.accountId === 'string' && creds.accountId !== '' ? creds.accountId : accountIdFor(creds)
    if (id === ENV_ACCOUNT_ID) return
    const registry = this.#load()
    const entry = registry.accounts.find(a => a.id === id)
    if (entry === undefined) return
    const now = this.#now()
    const recovered = options.recovered !== false
    const stale = entry.lastUsedAt === undefined || now - entry.lastUsedAt > 60_000
    const cleared = recovered && (entry.cooldownUntil !== undefined || entry.lastError !== undefined)
    entry.lastUsedAt = now
    if (recovered) {
      entry.cooldownUntil = undefined
      entry.lastError = undefined
      entry.lastErrorKind = undefined
    }
    // Once a minute is enough resolution for "last used" and keeps a hot model
    // route from writing the registry on every single call.
    if (stale || cleared) this.#persist(registry)
  }

  /**
   * Record an account-scoped failure. A quota failure parks the account until
   * its reset time (or a conservative default), which is what makes the next
   * call go to a different account.
   */
  reportFailure(info: AccountFailureInfo): void {
    if (info.accountId === undefined || info.accountId === ENV_ACCOUNT_ID) return
    const registry = this.#load()
    const entry = registry.accounts.find(a => a.id === info.accountId)
    if (entry === undefined) return
    const now = this.#now()
    entry.lastError = info.message
    entry.lastErrorKind = info.kind
    if (info.kind === 'quota') {
      // A provider that names a reset time already in the past ("Resets in 0s")
      // is saying the quota is back; parking it anyway would take a healthy
      // account out of the rotation for the conservative default. Silence about
      // the reset time is the case that default exists for.
      const until =
        typeof info.cooldownUntil === 'number'
          ? info.cooldownUntil
          : now + (this.#options.quotaCooldownMs ?? DEFAULT_QUOTA_COOLDOWN_MS)
      entry.cooldownUntil = until > now ? Math.min(until, now + MAX_QUOTA_COOLDOWN_MS) : undefined
    }
    this.#persist(registry)
  }

  #noteFailure(id: string, kind: 'quota' | 'auth' | 'other', message: string): void {
    if (id === ENV_ACCOUNT_ID) return
    const registry = this.#load()
    const entry = registry.accounts.find(a => a.id === id)
    if (entry === undefined) return
    entry.lastError = message
    entry.lastErrorKind = kind
    // A grant whose refresh fails fails the same way on every attempt, and each
    // attempt is three retries against Google's token endpoint before it gives
    // up (`refreshAccessToken`), so leaving the account eligible means paying
    // that on every single call. Parking it briefly bounds the storm without
    // writing off an account over one transient network blip.
    if (kind === 'auth') {
      const now = this.#now()
      entry.cooldownUntil = Math.max(entry.cooldownUntil ?? 0, now + AUTH_COOLDOWN_MS)
    }
    this.#persist(registry)
  }

  /**
   * Add (or refresh) an account and make it active.
   *
   * @param creds - credential facts from a completed sign-in.
   * @returns the stored entry.
   */
  async add(creds: AntigravityCredentials, options: { makeActive?: boolean } = {}): Promise<AccountEntry> {
    await this.ready()
    const registry = this.#load()
    const entry = upsertAccount(registry, creds, this.#now())
    if (options.makeActive !== false) registry.activeId = entry.id
    // Two entries can share an email only if one of them learned it late (or a
    // previous build wrote them); a sign-in is a good moment to fold them, and
    // the merge re-points `activeId` at the survivor when it swallows this one.
    const merged = mergeDuplicates(registry, this.#now())
    this.#persist(registry)
    await this.#persistSeam(registry)
    if (merged === 0) return entry
    const email = (creds.email ?? '').trim().toLowerCase()
    return (
      registry.accounts.find(a => (a.email ?? a.creds.email ?? '').trim().toLowerCase() === email) ?? entry
    )
  }

  /** Remove one account by id. */
  async remove(id: string): Promise<boolean> {
    await this.ready()
    const registry = this.#load()
    if (!removeAccountById(registry, id, this.#now())) return false
    this.#persist(registry)
    await this.#persistSeam(registry)
    return true
  }

  /** Point the active marker at one account. */
  async setActive(id: string): Promise<boolean> {
    await this.ready()
    const registry = this.#load()
    if (!registry.accounts.some(a => a.id === id)) return false
    registry.activeId = id
    this.#persist(registry)
    await this.#persistSeam(registry)
    return true
  }

  /**
   * Forget every account — the provider row's 「移除」.
   *
   * The only irreversible path in this module: what it deletes are refresh
   * tokens, which cannot be recovered from anything else on the machine. It is
   * reached from a settings transition (the marker going away), and a hand edit
   * or a settings reload can produce that transition by accident, so one
   * generation is kept beside the registry before the list is emptied.
   */
  async clear(): Promise<void> {
    await this.ready()
    const registry = this.#load()
    if (registry.accounts.length > 0) {
      const file = this.#file()
      try {
        fs.copyFileSync(file, `${file}.bak`)
        fs.chmodSync(`${file}.bak`, 0o600)
      } catch (error: any) {
        this.#options.warn?.(`dsh-antigravity: 清空前备份账号失败：${error.message}`)
      }
    }
    registry.accounts = []
    delete registry.activeId
    this.#persist(registry)
    await this.#persistSeam(registry)
  }

  /** Sign the active account out, keeping the others. */
  async signOut(): Promise<boolean> {
    await this.ready()
    const registry = this.#load()
    const active = activeAccount(registry)
    if (active === null) return false
    return this.remove(active.id)
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
