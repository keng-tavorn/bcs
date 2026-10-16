import { createSign, generateKeyPairSync } from 'node:crypto'
import { FCM_JWT_LIFETIME_S, MS_PER_SECOND, PUSH_ACCESS_TOKEN_MARGIN_S, PUSH_SEND_TIMEOUT_MS, THROWAWAY_RSA_BITS } from '@/lib/constants'
import { getEnv } from '@/lib/env'

// Push adapter of the BCS Go app (S17-10, ADR-165, BR-NOTI-05 to BR-NOTI-07): Firebase Cloud Messaging HTTP v1. A send
// answers what came of it for one device (core/notification-route PushAnswer) and never throws for FCM's own answers,
// so delivery decides the next step from the answer alone. Credentials: a Google service account (the JSON key, given
// base64 in FCM_SERVICE_ACCOUNT_JSON_B64) signs a short JWT that the token endpoint trades for an access token, kept
// in memory until shortly before it ends.
//
// PUSH_PROVIDER: fcm = Google (FCM_PROJECT_ID and the key) · fake = the same client against the fake LINE server's FCM
// routes (FCM_API_BASE_URL and FCM_TOKEN_URL, this machine only; a throwaway key, which the fake does not check) · off
// or unset = no push: delivery goes by LINE and e-mail as before.
// Nothing here logs: a push token, an access token and the key never leave this module except to Google (NFR-SEC-09).

/** What came of a push for one device: the same words as PushAnswer of src/core/notification-route (BR-NOTI-07) */
export type PushAnswer = 'SENT' | 'UNREGISTERED' | 'INVALID_TOKEN' | 'AUTH_401' | 'AUTH_403' | 'QUOTA_429' | 'SERVER_503' | 'NETWORK'

export interface PushNotification {
  readonly title: string
  readonly body: string | null
  /** String values only (FCM's rule): the notification's id and the page inside the app */
  readonly data: Readonly<Record<string, string>>
  /** One push per notification on a device: a second one with the same key replaces the first */
  readonly collapseKey: string
}

export interface PushProvider {
  send(token: string, message: PushNotification): Promise<PushAnswer>
}

export interface FcmServiceAccount {
  readonly client_email: string
  readonly private_key: string
  readonly token_uri?: string
}

export interface FcmOptions {
  readonly projectId: string
  readonly serviceAccount: FcmServiceAccount
  readonly apiBaseUrl: string
  readonly tokenUrl: string
  /** For tests: seconds since the epoch */
  readonly nowSeconds?: () => number
}

const FCM_SCOPE = 'https://www.googleapis.com/auth/firebase.messaging'
export const FCM_API_ORIGIN = 'https://fcm.googleapis.com'
export const FCM_TOKEN_ORIGIN = 'https://oauth2.googleapis.com/token'
const HTTP_TOO_MANY = 429
const HTTP_SERVER_ERROR = 500

const base64url = (value: string | Buffer) => Buffer.from(value).toString('base64url')

/** The JWT a service account signs to ask for an access token (Google's OAuth 2.0 for server-to-server) */
export function serviceAccountAssertion(account: FcmServiceAccount, audience: string, nowSeconds: number): string {
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))
  const claims = base64url(JSON.stringify({ iss: account.client_email, scope: FCM_SCOPE, aud: audience, iat: nowSeconds, exp: nowSeconds + FCM_JWT_LIFETIME_S }))
  const signature = createSign('RSA-SHA256').update(`${header}.${claims}`).sign(account.private_key)
  return `${header}.${claims}.${base64url(signature)}`
}

/** FCM's error answer: error.status and the FcmError detail's errorCode (UNREGISTERED, INVALID_ARGUMENT, …) */
function fcmErrorCode(body: unknown): string | null {
  const error = (body as { error?: { status?: unknown; details?: Array<{ errorCode?: unknown }> } } | null)?.error
  const detail = error?.details?.find((d) => typeof d?.errorCode === 'string')?.errorCode
  return typeof detail === 'string' ? detail : typeof error?.status === 'string' ? error.status : null
}

/** BR-NOTI-07: FCM's answer for one device */
export function answerOf(status: number, body: unknown): PushAnswer {
  if (status >= 200 && status < 300) return 'SENT'
  const code = fcmErrorCode(body)
  if (code === 'UNREGISTERED' || status === 404) return 'UNREGISTERED'
  if (status === 401) return 'AUTH_401'
  if (status === 403) return 'AUTH_403'
  if (status === HTTP_TOO_MANY || code === 'QUOTA_EXCEEDED') return 'QUOTA_429'
  if (status >= HTTP_SERVER_ERROR) return 'SERVER_503'
  // 400 INVALID_ARGUMENT: the token is not one FCM can read (our message is checked by tests against the fake)
  return 'INVALID_TOKEN'
}

export function createFcmProvider(options: FcmOptions): PushProvider {
  const now = options.nowSeconds ?? (() => Math.floor(Date.now() / MS_PER_SECOND))
  const sendUrl = `${options.apiBaseUrl.replace(/\/+$/, '')}/v1/projects/${encodeURIComponent(options.projectId)}/messages:send`
  let cached: { readonly token: string; readonly until: number } | null = null

  type TokenResult = { readonly ok: true; readonly token: string } | { readonly ok: false; readonly answer: PushAnswer }

  async function accessToken(fresh: boolean): Promise<TokenResult> {
    if (!fresh && cached && cached.until > now()) return { ok: true, token: cached.token }
    try {
      const response = await fetch(options.tokenUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: serviceAccountAssertion(options.serviceAccount, options.tokenUrl, now()) }),
        signal: AbortSignal.timeout(PUSH_SEND_TIMEOUT_MS),
      })
      const body = (await response.json().catch(() => null)) as { access_token?: unknown; expires_in?: unknown } | null
      if (!response.ok || typeof body?.access_token !== 'string') {
        // A key Google does not take is BCS's trouble (an alert and the next channel); its own outage is tried again
        return { ok: false, answer: response.status >= HTTP_SERVER_ERROR || response.status === HTTP_TOO_MANY ? 'SERVER_503' : 'AUTH_401' }
      }
      const lifetime = typeof body.expires_in === 'number' ? body.expires_in : FCM_JWT_LIFETIME_S
      cached = { token: body.access_token, until: now() + Math.max(0, lifetime - PUSH_ACCESS_TOKEN_MARGIN_S) }
      return { ok: true, token: body.access_token }
    } catch {
      return { ok: false, answer: 'NETWORK' }
    }
  }

  async function post(token: string, accessTokenValue: string, message: PushNotification): Promise<PushAnswer> {
    try {
      const response = await fetch(sendUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${accessTokenValue}` },
        body: JSON.stringify({
          message: {
            token,
            notification: { title: message.title, ...(message.body ? { body: message.body } : {}) },
            data: message.data,
            android: { priority: 'HIGH', collapse_key: message.collapseKey, notification: { tag: message.collapseKey } },
          },
        }),
        signal: AbortSignal.timeout(PUSH_SEND_TIMEOUT_MS),
      })
      return answerOf(response.status, await response.json().catch(() => null))
    } catch {
      return 'NETWORK'
    }
  }

  return {
    async send(token, message) {
      const first = await accessToken(false)
      if (!first.ok) return first.answer
      const answer = await post(token, first.token, message)
      if (answer !== 'AUTH_401') return answer
      // The access token may have ended early (revoked, clock skew): one more try with a new one before calling it BCS's
      cached = null
      const again = await accessToken(true)
      return again.ok ? post(token, again.token, message) : again.answer
    },
  }
}

/** The service account of FCM_SERVICE_ACCOUNT_JSON_B64; src/lib/env.ts checks its form before this runs */
export function parseServiceAccount(base64: string): FcmServiceAccount {
  const parsed = JSON.parse(Buffer.from(base64, 'base64').toString('utf8')) as Partial<FcmServiceAccount>
  if (typeof parsed.client_email !== 'string' || typeof parsed.private_key !== 'string') throw new TypeError('FCM_SERVICE_ACCOUNT_JSON_B64 is not a service account key')
  return { client_email: parsed.client_email, private_key: parsed.private_key, ...(typeof parsed.token_uri === 'string' ? { token_uri: parsed.token_uri } : {}) }
}

let throwaway: FcmServiceAccount | null = null
/** PUSH_PROVIDER=fake: a key made for this process, which the fake FCM accepts without checking */
function throwawayAccount(): FcmServiceAccount {
  if (throwaway) return throwaway
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: THROWAWAY_RSA_BITS })
  throwaway = { client_email: 'bcs-local@fake-fcm.local', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() }
  return throwaway
}

let provider: PushProvider | null | undefined

/** The push provider of this environment, or null when push is off (delivery goes by LINE and e-mail) */
export function getPushProvider(): PushProvider | null {
  if (provider !== undefined) return provider
  const env = getEnv()
  if (env.PUSH_PROVIDER === 'fcm' && env.FCM_PROJECT_ID && env.FCM_SERVICE_ACCOUNT_JSON_B64) {
    const account = parseServiceAccount(env.FCM_SERVICE_ACCOUNT_JSON_B64)
    provider = createFcmProvider({ projectId: env.FCM_PROJECT_ID, serviceAccount: account, apiBaseUrl: env.FCM_API_BASE_URL ?? FCM_API_ORIGIN, tokenUrl: env.FCM_TOKEN_URL ?? account.token_uri ?? FCM_TOKEN_ORIGIN })
  } else if (env.PUSH_PROVIDER === 'fake' && env.FCM_API_BASE_URL && env.FCM_TOKEN_URL) {
    provider = createFcmProvider({ projectId: env.FCM_PROJECT_ID ?? 'bcs-local', serviceAccount: throwawayAccount(), apiBaseUrl: env.FCM_API_BASE_URL, tokenUrl: env.FCM_TOKEN_URL })
  } else {
    provider = null
  }
  return provider
}

/** Tests point push at the fake FCM (or turn it off with null); undefined goes back to the environment's */
export function setPushProvider(next: PushProvider | null | undefined): void {
  provider = next
}
