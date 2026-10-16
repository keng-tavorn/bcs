import { randomBytes } from 'node:crypto'

// Fake Firebase Cloud Messaging for this machine (S17-10, ADR-165), served by the fake LINE server (scripts/lib/
// fake-line.ts) under /fcm: the token endpoint of Google's OAuth 2.0 (POST /fcm/token, a service account's signed JWT
// for an access token) and FCM HTTP v1 (POST /fcm/v1/projects/<project>/messages:send). It checks what Google checks
// of the shape — the JWT's claims, a Bearer token it issued, a message with a token, a title and string data — and
// keeps what it accepted for tests (pushes(), GET /__fake/pushes). Answers for a device are set per token
// (setPushAnswer, POST /__fake/push-answer): SENT by default, or one of FCM's errors.
// The JWT's signature is not checked: the app signs with a key made for its process (PUSH_PROVIDER=fake).

export type FakePushAnswer = 'SENT' | 'UNREGISTERED' | 'INVALID_ARGUMENT' | 'UNAUTHENTICATED' | 'PERMISSION_DENIED' | 'QUOTA_EXCEEDED' | 'UNAVAILABLE'

export interface FakePush {
  readonly project: string
  readonly token: string
  readonly title: string
  readonly body: string | null
  readonly data: Readonly<Record<string, string>>
  readonly collapseKey: string | null
  readonly at: string
}

export interface FakeFcm {
  /** Handles /fcm/* (and the /__fake/ push controls); false when the path is not FCM's */
  handle(method: string, path: string, raw: Buffer, authorization: string, answer: (status: number, body?: unknown) => void): boolean
  pushes(): readonly FakePush[]
  setPushAnswer(token: string, answer: FakePushAnswer | null): void
  /** Every access token issued so far stops working (as if Google revoked them) */
  revokeAccessTokens(): void
  reset(): void
}

const SCOPE = 'https://www.googleapis.com/auth/firebase.messaging'
const ERRORS: Readonly<Record<Exclude<FakePushAnswer, 'SENT'>, { readonly status: number; readonly code: string; readonly grpc: string }>> = {
  UNREGISTERED: { status: 404, code: 'UNREGISTERED', grpc: 'NOT_FOUND' },
  INVALID_ARGUMENT: { status: 400, code: 'INVALID_ARGUMENT', grpc: 'INVALID_ARGUMENT' },
  UNAUTHENTICATED: { status: 401, code: 'THIRD_PARTY_AUTH_ERROR', grpc: 'UNAUTHENTICATED' },
  PERMISSION_DENIED: { status: 403, code: 'SENDER_ID_MISMATCH', grpc: 'PERMISSION_DENIED' },
  QUOTA_EXCEEDED: { status: 429, code: 'QUOTA_EXCEEDED', grpc: 'RESOURCE_EXHAUSTED' },
  UNAVAILABLE: { status: 503, code: 'UNAVAILABLE', grpc: 'UNAVAILABLE' },
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const parse = (raw: Buffer): unknown => {
  try {
    return JSON.parse(raw.toString('utf8'))
  } catch {
    return null
  }
}
const fcmError = (status: number, message: string, code: string, grpc: string) => ({
  error: { code: status, message, status: grpc, details: [{ '@type': 'type.googleapis.com/google.firebase.fcm.v1.FcmError', errorCode: code }] },
})

export function createFakeFcm(): FakeFcm {
  const state = { pushes: [] as FakePush[], answers: new Map<string, FakePushAnswer>(), accessTokens: new Set<string>() }

  function token(raw: Buffer, answer: (status: number, body?: unknown) => void) {
    const form = new URLSearchParams(raw.toString('utf8'))
    if (form.get('grant_type') !== 'urn:ietf:params:oauth:grant-type:jwt-bearer') return answer(400, { error: 'unsupported_grant_type' })
    const [header = '', claims = '', signature = ''] = (form.get('assertion') ?? '').split('.')
    const head = parse(Buffer.from(header, 'base64url'))
    const body = parse(Buffer.from(claims, 'base64url'))
    const now = Math.floor(Date.now() / 1000)
    const valid =
      isRecord(head) &&
      head.alg === 'RS256' &&
      isRecord(body) &&
      typeof body.iss === 'string' &&
      body.scope === SCOPE &&
      typeof body.iat === 'number' &&
      typeof body.exp === 'number' &&
      body.exp > now &&
      signature !== ''
    if (!valid) return answer(400, { error: 'invalid_grant', error_description: 'Invalid JWT' })
    const accessToken = `ya29.fake-${randomBytes(16).toString('hex')}`
    state.accessTokens.add(accessToken)
    return answer(200, { access_token: accessToken, expires_in: 3599, token_type: 'Bearer' })
  }

  function send(project: string, raw: Buffer, authorization: string, answer: (status: number, body?: unknown) => void) {
    const bearer = authorization.startsWith('Bearer ') ? authorization.slice('Bearer '.length) : ''
    if (!state.accessTokens.has(bearer)) return answer(401, fcmError(401, 'Request had invalid authentication credentials.', 'THIRD_PARTY_AUTH_ERROR', 'UNAUTHENTICATED'))
    const body = parse(raw)
    const message = isRecord(body) && isRecord(body.message) ? body.message : null
    const notification = message && isRecord(message.notification) ? message.notification : null
    const data = message?.data === undefined ? {} : message.data
    const android = message && isRecord(message.android) ? message.android : null
    const shapeOk =
      message !== null &&
      typeof message.token === 'string' &&
      message.token !== '' &&
      notification !== null &&
      typeof notification.title === 'string' &&
      (notification.body === undefined || typeof notification.body === 'string') &&
      isRecord(data) &&
      Object.values(data).every((v) => typeof v === 'string')
    if (!shapeOk) return answer(400, fcmError(400, 'Invalid message', 'INVALID_ARGUMENT', 'INVALID_ARGUMENT'))
    const deviceToken = message.token as string
    const set = state.answers.get(deviceToken) ?? 'SENT'
    if (set !== 'SENT') {
      const e = ERRORS[set]
      return answer(e.status, fcmError(e.status, `fake answer ${set}`, e.code, e.grpc))
    }
    state.pushes.push({
      project,
      token: deviceToken,
      title: notification.title as string,
      body: typeof notification.body === 'string' ? notification.body : null,
      data: data as Record<string, string>,
      collapseKey: android && typeof android.collapse_key === 'string' ? android.collapse_key : null,
      at: new Date().toISOString(),
    })
    return answer(200, { name: `projects/${project}/messages/${randomBytes(8).toString('hex')}` })
  }

  const fake: FakeFcm = {
    handle(method, path, raw, authorization, answer) {
      if (method === 'POST' && path === '/fcm/token') {
        token(raw, answer)
        return true
      }
      const sendPath = /^\/fcm\/v1\/projects\/([^/]+)\/messages:send$/.exec(path)
      if (method === 'POST' && sendPath) {
        send(decodeURIComponent(sendPath[1] ?? ''), raw, authorization, answer)
        return true
      }
      if (method === 'GET' && path === '/__fake/pushes') {
        answer(200, { pushes: state.pushes })
        return true
      }
      if (method === 'POST' && path === '/__fake/push-answer') {
        const body = parse(raw)
        if (!isRecord(body) || typeof body.token !== 'string') {
          answer(400, { message: 'token is required' })
          return true
        }
        fake.setPushAnswer(body.token, typeof body.answer === 'string' && (body.answer === 'SENT' || body.answer in ERRORS) ? (body.answer as FakePushAnswer) : null)
        answer(200, {})
        return true
      }
      return path.startsWith('/fcm/') ? (answer(404, { error: { code: 404, message: 'Not found', status: 'NOT_FOUND' } }), true) : false
    },
    pushes: () => [...state.pushes],
    setPushAnswer(deviceToken, value) {
      if (value === null || value === 'SENT') state.answers.delete(deviceToken)
      else state.answers.set(deviceToken, value)
    },
    revokeAccessTokens: () => state.accessTokens.clear(),
    reset() {
      state.pushes.length = 0
      state.answers.clear()
      state.accessTokens.clear()
    },
  }
  return fake
}
