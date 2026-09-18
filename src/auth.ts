import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * Google Antigravity OAuth: endpoints, client resolution, token exchange and
 * refresh, and the single-grant stores this plugin writes.
 *
 * This module is deliberately **mechanism only**: it reads and writes one grant
 * in the `ctx.credentials` record seam and in the private
 * `~/.dsh/antigravity-auth.json` (mode 0600), and it knows how to refresh it.
 * Which grant to use, out of how many, and what to do when one is exhausted is
 * policy — that lives in `accounts.ts`. Nothing here reads or writes another
 * application's database.
 *
 * @module dsh-antigravity/auth
 */

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
const TOKEN_URL = 'https://oauth2.googleapis.com/token'
const USERINFO_URL = 'https://www.googleapis.com/oauth2/v1/userinfo?alt=json'
const LOAD_CODE_ASSIST_URL = 'https://daily-cloudcode-pa.googleapis.com/v1internal:loadCodeAssist'

/**
 * Credential facts this plugin stores and resolves.
 *
 * The record seam persists them verbatim, so every field stays optional except
 * the bearer token the provider boundary actually requires.
 */
export interface AntigravityCredentials {
  /** Bearer access token used at the Antigravity endpoint. */
  access: string
  /** Long-lived refresh token, when Google returned one. */
  refresh?: string
  /** Absolute access-token expiry, epoch milliseconds. */
  expires?: number
  /** Google account email, when known. */
  email?: string
  /** Cloud project the requests bill against. */
  projectId?: string
  /** When the grant was established, epoch milliseconds. */
  authorizedAt?: number
  /** Which credential layer produced these facts. */
  source?: string
  /**
   * Registry id of the account these facts belong to, stamped by
   * `AccountPool`. Absent on credentials read straight from the legacy layers
   * (environment, a lone record), where there is only one account anyway.
   */
  accountId?: string
}

/** Minimal structural view of the `ctx.credentials` record seam. */
export interface CredentialsSeam {
  readRecord(key: string): Promise<unknown>
  modifyRecord(key: string, update: () => Promise<unknown>): Promise<unknown>
  deleteRecord(key: string): Promise<unknown>
}

/** The verbatim grant envelope this plugin writes into the record seam. */
export interface GrantRecord {
  kind: string
  payload?: unknown
}

/** OAuth client facts a caller (settings, CLI) may override. */
export interface OAuthClientOverrides {
  clientId?: string
  clientSecret?: string
}

/** OAuth client facts plus the loopback redirect a request targets. */
export interface OAuthRequestOptions extends OAuthClientOverrides {
  redirectUri?: string
  signal?: AbortSignal
}

/** Refresh controls on top of the OAuth client facts. */
export interface RefreshOptions extends OAuthClientOverrides {
  signal?: AbortSignal
  attempts?: number
}

/** `fetch` JSON payloads this module reads. */
interface TokenResponse {
  access_token?: string
  refresh_token?: string
  expires_in?: number
}

interface UserInfoResponse {
  email?: string
}

interface LoadCodeAssistResponse {
  cloudaicompanionProject?: string
}

/** OAuth scopes the Antigravity client requests. */
export const OAUTH_SCOPES = [
  'https://www.googleapis.com/auth/cloud-platform',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
  'https://www.googleapis.com/auth/cclog',
  'https://www.googleapis.com/auth/experimentsandconfigs'
]

/** Loopback redirect the built-in client is registered against. */
export const DEFAULT_REDIRECT_URI = 'http://127.0.0.1:51121/oauth-callback'
/** Port parsed from {@link DEFAULT_REDIRECT_URI}; kept exported for the CLI. */
export const DEFAULT_CALLBACK_PORT = 51121
/** Path parsed from {@link DEFAULT_REDIRECT_URI}. */
export const DEFAULT_CALLBACK_PATH = '/oauth-callback'

/** DSH home directory, honoring `DSH_HOME`. */
export function dshHome(): string {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
}

/** Standalone credential mirror owned by this plugin. */
export function authFilePath(): string {
  return path.join(dshHome(), 'antigravity-auth.json')
}

/**
 * Credential-record key this plugin owns. Branded as a `CredentialKey` by
 * `@deepseek-ai/dsh-credentials` at compile time only; at runtime the seam
 * accepts the plain `<scope>/<id>` string.
 */
export const CREDENTIAL_KEY = 'dsh-antigravity/google-antigravity'

/**
 * The Antigravity desktop OAuth client shipped by this plugin. It is embedded
 * (not a secret in the cryptographic sense — a native client cannot keep one)
 * and every field is overridable through settings or environment variables.
 */
const BUILTIN_CLIENT_ID = Buffer.from(
  ['MTA3MTAwNjA2MDU5MS10bWhzc2luMmgyMWxjcmUyMzV2dG9sb2poNGc0MDNlc', 'C5hcHBzLmdvb2dsZXVzZXJjb250ZW50LmNvbQ=='].join(''),
  'base64'
).toString('utf8')
const BUILTIN_CLIENT_SECRET = Buffer.from(
  ['R09DU1BYLUs1OEZXUjQ4Nkxk', 'TEoxbUxCOHNYQzR6NnFEQWY='].join(''),
  'base64'
).toString('utf8')

/**
 * Resolve the OAuth client this deployment uses. Precedence: explicit argument
 * → plugin settings → environment → the built-in Antigravity client.
 *
 * @param overrides - `{ clientId, clientSecret }` from settings, when present.
 * @returns the client id and secret.
 */
export function resolveOAuthClient(overrides: OAuthClientOverrides = {}): { clientId: string; clientSecret: string } {
  const clientId =
    nonEmpty(overrides.clientId) ||
    nonEmpty(process.env.DSH_ANTIGRAVITY_CLIENT_ID) ||
    nonEmpty(process.env.GOOGLE_ANTIGRAVITY_CLIENT_ID) ||
    nonEmpty(process.env.ANTIGRAVITY_CLIENT_ID) ||
    BUILTIN_CLIENT_ID
  const clientSecret =
    nonEmpty(overrides.clientSecret) ||
    nonEmpty(process.env.DSH_ANTIGRAVITY_CLIENT_SECRET) ||
    nonEmpty(process.env.GOOGLE_ANTIGRAVITY_CLIENT_SECRET) ||
    nonEmpty(process.env.ANTIGRAVITY_CLIENT_SECRET) ||
    BUILTIN_CLIENT_SECRET
  return { clientId, clientSecret }
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

// ---------------------------------------------------------------------------
// Credential record seam (ctx.credentials)
// ---------------------------------------------------------------------------

/** Wrap raw credential facts as the grant record the seam stores verbatim. */
export function toGrantRecord(creds: AntigravityCredentials): GrantRecord {
  return { kind: 'grant', payload: creds }
}

/** Read the raw credential facts out of a stored grant record, if it is ours. */
export function fromGrantRecord(record: unknown): AntigravityCredentials | null {
  if (record === undefined || record === null) return null
  const candidate = record as GrantRecord
  if (candidate.kind !== 'grant') return null
  const payload = candidate.payload
  if (payload === undefined || payload === null || typeof payload !== 'object') return null
  return payload as AntigravityCredentials
}

/** Read this plugin's credential record; `null` when absent or foreign. */
export async function readCredentialRecord(credentials?: CredentialsSeam | null): Promise<AntigravityCredentials | null> {
  if (credentials === undefined || credentials === null) return null
  try {
    return fromGrantRecord(await credentials.readRecord(CREDENTIAL_KEY))
  } catch {
    return null
  }
}

/** Commit this plugin's credential record. */
export async function writeCredentialRecord(
  credentials: CredentialsSeam | undefined | null,
  creds: AntigravityCredentials
): Promise<void> {
  if (credentials === undefined || credentials === null) return
  await credentials.modifyRecord(CREDENTIAL_KEY, async () => toGrantRecord(creds))
}

/** Delete this plugin's credential record, ignoring absence. */
export async function deleteCredentialRecord(credentials?: CredentialsSeam | null): Promise<void> {
  if (credentials === undefined || credentials === null) return
  try {
    await credentials.deleteRecord(CREDENTIAL_KEY)
  } catch {
    /* absent record is already the desired state */
  }
}

// ---------------------------------------------------------------------------
// Standalone file store
// ---------------------------------------------------------------------------

/** Read the private credential mirror, or `null` when absent/unreadable. */
export function readAuthFile(): AntigravityCredentials | null {
  const file = authFilePath()
  if (!fs.existsSync(file)) return null
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8')) as AntigravityCredentials | null
    return data && typeof data === 'object' && data.access ? data : null
  } catch {
    return null
  }
}

/** Write the private credential mirror with owner-only permissions. */
export function writeAuthFile(creds: AntigravityCredentials): void {
  const file = authFilePath()
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(creds, null, 2), { mode: 0o600 })
  try {
    fs.chmodSync(file, 0o600)
  } catch {
    /* best effort on filesystems without POSIX modes */
  }
}

/** Remove the private credential mirror. */
export function removeAuthFile(): void {
  const file = authFilePath()
  try {
    if (fs.existsSync(file)) fs.unlinkSync(file)
  } catch {
    /* removal is idempotent */
  }
}

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

/**
 * Human-readable identity of a grant, for account labels and the settings
 * marker. This is the one definition of "what do we call this account".
 *
 * @param creds - credential facts.
 * @returns the email when Google reported one, else the project, else `google`.
 */
export function accountLabelOf(creds: AntigravityCredentials | null | undefined): string {
  if (creds === null || creds === undefined) return 'google'
  return creds.email || creds.projectId || 'google'
}

/**
 * Credentials supplied entirely through the environment, when present. The
 * multi-account pool treats them as a synthetic account that outranks the
 * stored ones and is never persisted.
 *
 * @returns credential facts, or `null` when no environment grant is set.
 */
export function loadEnvCredentials(): AntigravityCredentials | null {
  const raw = nonEmpty(process.env.GOOGLE_ANTIGRAVITY_DATA)
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as AntigravityCredentials | null
      if (parsed && parsed.access) return parsed
    } catch {
      /* malformed JSON is ignored in favor of the next layer */
    }
  }
  const token = nonEmpty(process.env.GOOGLE_ANTIGRAVITY_TOKEN)
  if (token) {
    return {
      access: token,
      projectId: nonEmpty(process.env.GOOGLE_ANTIGRAVITY_PROJECT_ID) || 'aicode-consumers',
      expires: Date.now() + 3600 * 1000,
      source: 'environment'
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// Token lifecycle
// ---------------------------------------------------------------------------

/** Whether the access token is missing, expired, or within `skewMs` of expiry. */
export function isExpiring(creds: AntigravityCredentials | null | undefined, skewMs = 60_000): boolean {
  if (!creds || !creds.access) return true
  if (typeof creds.expires !== 'number' || !Number.isFinite(creds.expires)) return false
  return Date.now() >= creds.expires - skewMs
}

/**
 * Exchange an authorization code for credential facts.
 *
 * @param code - the OAuth authorization code.
 * @param options - `{ clientId, clientSecret, redirectUri }`.
 * @returns credential facts, including any discovered project id and email.
 */
export async function exchangeCodeForTokens(
  code: string,
  options: OAuthRequestOptions = {}
): Promise<AntigravityCredentials> {
  const { clientId, clientSecret } = resolveOAuthClient(options)
  const redirectUri = options.redirectUri || DEFAULT_REDIRECT_URI

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code'
    }),
    signal: options.signal
  })

  if (!res.ok) {
    throw new Error(`换取授权码失败 (${res.status}): ${await res.text()}`)
  }

  const data = (await res.json()) as TokenResponse
  if (!data.access_token) throw new Error('Google OAuth 未返回 access_token')

  const creds: AntigravityCredentials = {
    access: data.access_token,
    ...(data.refresh_token === undefined ? {} : { refresh: data.refresh_token }),
    expires: Date.now() + Math.max(60, (data.expires_in || 3600) - 300) * 1000,
    authorizedAt: Date.now()
  }

  const email = await discoverEmail(creds.access, options.signal)
  if (email) creds.email = email

  const projectId = await discoverProjectId(creds.access, options.signal)
  creds.projectId = projectId || 'aicode-consumers'
  return creds
}

/**
 * Ask Google which account an access token belongs to.
 *
 * Exported because identity is not only a sign-in concern: a grant adopted from
 * a single-account install has no email on file, and the account pool calls this
 * on that account's first refresh so it can be named — and de-duplicated — instead
 * of being known forever by its project id.
 *
 * @param accessToken - a live access token.
 * @param signal - abort signal.
 * @returns the email, or `undefined` when Google does not answer usefully.
 */
export async function discoverEmail(accessToken: string, signal?: AbortSignal): Promise<string | undefined> {
  try {
    const res = await fetch(USERINFO_URL, { headers: { Authorization: `Bearer ${accessToken}` }, signal })
    if (!res.ok) return undefined
    const data = (await res.json()) as UserInfoResponse
    return typeof data.email === 'string' && data.email.length > 0 ? data.email : undefined
  } catch {
    return undefined
  }
}

async function discoverProjectId(accessToken: string, signal?: AbortSignal): Promise<string | undefined> {
  try {
    const res = await fetch(LOAD_CODE_ASSIST_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'User-Agent': 'antigravity'
      },
      body: JSON.stringify({ metadata: { ideType: 'ANTIGRAVITY' } }),
      signal
    })
    if (!res.ok) return undefined
    const data = (await res.json()) as LoadCodeAssistResponse
    return typeof data.cloudaicompanionProject === 'string' ? data.cloudaicompanionProject : undefined
  } catch {
    return undefined
  }
}

/**
 * Refresh an access token from a stored refresh token, with a small retry
 * budget for transient network failures.
 *
 * @param creds - credential facts carrying `refresh`.
 * @param options - `{ clientId, clientSecret, signal, attempts }`.
 * @returns the same object, mutated with a fresh access token and expiry.
 */
export async function refreshAccessToken(
  creds: AntigravityCredentials,
  options: RefreshOptions = {}
): Promise<AntigravityCredentials> {
  if (!creds || !creds.refresh) {
    throw new Error('未提供可用的 google-antigravity refresh_token，请重新登录')
  }
  const { clientId, clientSecret } = resolveOAuthClient(options)
  const attempts = Number.isInteger(options.attempts) && options.attempts > 0 ? options.attempts : 3

  let lastError: unknown = null
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (options.signal?.aborted) throw options.signal.reason
    try {
      const res = await fetch(TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          client_id: clientId,
          client_secret: clientSecret,
          refresh_token: creds.refresh
        }),
        signal: options.signal
      })
      if (res.ok) {
        const data = (await res.json()) as TokenResponse
        if (!data.access_token) throw new Error('刷新响应缺少 access_token')
        creds.access = data.access_token
        creds.expires = Date.now() + Math.max(60, (data.expires_in || 3600) - 300) * 1000
        if (!creds.projectId) {
          creds.projectId = (await discoverProjectId(creds.access, options.signal)) || 'aicode-consumers'
        }
        return creds
      }
      const body = await res.text()
      lastError = new Error(`刷新 Google OAuth 令牌失败 (${res.status}): ${body}`)
      // A 4xx other than 429 is a permanent failure: do not retry a dead grant.
      if (res.status !== 429 && res.status < 500) throw lastError
    } catch (error) {
      if (options.signal?.aborted) throw error
      lastError = error
    }
    if (attempt < attempts - 1) await sleep(500 * (attempt + 1), options.signal)
  }
  throw lastError || new Error('刷新 Google OAuth 令牌失败')
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(signal?.reason)
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * Build the Google authorization URL for the consent screen.
 *
 * @param options - `{ state, clientId, clientSecret, redirectUri }`.
 * @returns the absolute authorization URL.
 */
export function getAuthorizationUrl(options: OAuthRequestOptions & { state?: string } = {}): string {
  const { clientId } = resolveOAuthClient(options)
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: options.redirectUri || DEFAULT_REDIRECT_URI,
    response_type: 'code',
    scope: OAUTH_SCOPES.join(' '),
    access_type: 'offline',
    prompt: 'consent'
  })
  if (options.state) params.set('state', options.state)
  return `${AUTH_URL}?${params.toString()}`
}

/**
 * Split a loopback redirect URI into the listener coordinates.
 *
 * @param redirectUri - the configured redirect URI.
 * @returns `{ host, port, pathname }`.
 */
export function parseRedirectUri(redirectUri: string = DEFAULT_REDIRECT_URI): {
  host: string
  port: number
  pathname: string
} {
  const url = new URL(redirectUri)
  return {
    host: url.hostname || '127.0.0.1',
    port: Number(url.port) || (url.protocol === 'https:' ? 443 : 80),
    pathname: url.pathname || DEFAULT_CALLBACK_PATH
  }
}
