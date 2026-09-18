import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import {
  accountLabelOf,
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

/** Write the registry with owner-only permissions. */
export function writeAccountRegistry(registry: AccountRegistry, file: string = accountsFilePath()): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(registry, null, 2), { mode: 0o600 })
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
    const registry = this.#load()
    if (registry.accounts.length > 0) return
    let legacy: AntigravityCredentials | null = null
    try {
      legacy = await readCredentialRecord(this.#options.credentials?.())
    } catch {
      legacy = null
    }
    if (legacy === null || !legacy.access) legacy = readAuthFile()
    const entry = adoptLegacy(registry, legacy, this.#now())
    if (entry === null) return
    this.#persist(registry)
    this.#options.warn?.(`dsh-antigravity: 已把现有凭据登记为首个账号（${entry.label}）`)
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
    for (const entry of this.#order(registry)) {
      candidates.push({ id: entry.id, creds: entry.creds, transient: false })
    }

    const available = candidates.filter(candidate => exclude === undefined || !exclude.has(candidate.id))
    if (available.length === 0) return undefined

    const ready = available.filter(candidate => !this.#cooling(candidate, now))
    // Every candidate parked: ask the one that recovers first, so the provider's
    // own quota message reaches the caller instead of "no credentials".
    const order =
      ready.length > 0
        ? ready
        : available.slice().sort((a, b) => this.#cooldownEnd(a, now) - this.#cooldownEnd(b, now))

    for (const candidate of order) {
      try {
        const creds = await this.#usable(candidate)
        if (creds !== undefined) {
          this.markUsed(creds)
          return creds
        }
      } catch (error: any) {
        this.#noteFailure(candidate.id, 'auth', messageOf(error))
      }
    }
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

  /** Order accounts for this call; round-robin advances a cursor per call. */
  #order(registry: AccountRegistry): AccountEntry[] {
    const accounts = registry.accounts.slice()
    if (accounts.length <= 1) return accounts
    const activeIndex = accounts.findIndex(a => a.id === registry.activeId)
    if (this.strategy() === 'active-first') {
      if (activeIndex > 0) accounts.unshift(accounts.splice(activeIndex, 1)[0])
      return accounts
    }
    const start = this.#cursor % accounts.length
    this.#cursor = (this.#cursor + 1) % 1_000_000
    return accounts.slice(start).concat(accounts.slice(0, start))
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
    // `refreshAccessToken` mutates in place, so the registry entry already holds
    // the new token; persisting it is what survives a restart.
    const registry = this.#load()
    if (registry.accounts.some(entry => entry.id === candidate.id)) this.#persist(registry)
    return refreshed
  }

  /**
   * Record that an account just served a call. Clears any park and failure:
   * a call that worked is the proof that the quota came back.
   */
  markUsed(creds: AntigravityCredentials | undefined): void {
    if (creds === undefined || creds === null) return
    const id = typeof creds.accountId === 'string' && creds.accountId !== '' ? creds.accountId : accountIdFor(creds)
    if (id === ENV_ACCOUNT_ID) return
    const registry = this.#load()
    const entry = registry.accounts.find(a => a.id === id)
    if (entry === undefined) return
    const now = this.#now()
    const dirty =
      entry.cooldownUntil !== undefined ||
      entry.lastError !== undefined ||
      entry.lastUsedAt === undefined ||
      now - entry.lastUsedAt > 60_000
    entry.lastUsedAt = now
    entry.cooldownUntil = undefined
    entry.lastError = undefined
    entry.lastErrorKind = undefined
    // Once a minute is enough resolution for "last used" and keeps a hot model
    // route from writing the registry on every single call.
    if (dirty) this.#persist(registry)
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
      const until =
        typeof info.cooldownUntil === 'number' && info.cooldownUntil > now
          ? info.cooldownUntil
          : now + (this.#options.quotaCooldownMs ?? DEFAULT_QUOTA_COOLDOWN_MS)
      entry.cooldownUntil = Math.min(until, now + MAX_QUOTA_COOLDOWN_MS)
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
    this.#persist(registry)
    await this.#persistSeam(registry)
    return entry
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

  /** Forget every account (the provider row's 「移除」). */
  async clear(): Promise<void> {
    await this.ready()
    const registry = this.#load()
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
