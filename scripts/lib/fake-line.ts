// A fake LINE Platform for this machine and for tests (S5 sub-spec "fake LINE server"): the parts of the Messaging API
// and LINE Login that BCS calls, answering with LINE's shapes, so nothing local or in CI needs a real channel.
//  - Messaging API: push, reply, bot info, webhook endpoint (get, set, test), rich menus (create, upload the image,
//    default, link and unlink per user, list, get, delete). Every call needs `Authorization: Bearer <token>`; with
//    `accessToken` set, only that token passes (401 like LINE otherwise).
//  - LINE Login: POST /oauth2/v2.1/verify checks only the ID tokens this server issued (issueIdToken or
//    POST /__fake/id-token), with LINE's error answers for an unknown, expired or wrong-audience token (BR-LINE-02).
//  - Webhook test: LINE's own test sends `{"destination":…,"events":[]}` signed with the channel secret
//    (x-line-signature, BR-LINE-03) to the endpoint and reports what it answered.
//  - On purpose: a push to a user id that starts with "Ublocked" fails 403 (a permanent refusal) and one that starts
//    with "Udown" fails 500 (LINE trouble, transient), so the e-mail fallback can be tested (§4.7 rule 2). The 403 is a
//    stand-in: what real LINE answers a push to a user who blocked the OA is NOT CONFIRMED (check it with the real
//    channel in D-03; LINE reports a block through the `unfollow` webhook event, BR-LINE-08).
// Messages are checked against LINE's limits written out here on their own (not imported from src/integrations/line),
// so a wrong limit in the app is caught by the fake. What was sent is kept for tests (messages(), GET /__fake/messages)
// and never printed. The server listens on 127.0.0.1 only; outside local the app cannot use it at all, because
// src/lib/env.ts accepts LINE's own hosts only for LINE_API_BASE_URL and LINE_DATA_API_BASE_URL.
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createFakeFcm, type FakeFcm } from './fake-fcm'

export interface FakeLineOptions {
  /** 0 = any free port (tests); `pnpm line:fake` uses FAKE_LINE_PORT or 4100 */
  readonly port: number
  /** The channel secret the test webhooks are signed with (32 hexadecimal characters for a real channel) */
  readonly channelSecret: string
  /** When set, the only access token the Messaging API accepts; otherwise any non-empty token passes */
  readonly accessToken?: string
  /** 127.0.0.1 by default: nothing outside this machine reaches the fake */
  readonly host?: string
  /** How long a test webhook waits for the endpoint before LINE's REQUEST_TIMEOUT */
  readonly webhookTimeoutMs?: number
  /**
   * Where a test webhook for `endpoint` is really delivered; the endpoint itself by default. LINE resolves the public
   * webhook URL (APP_URL/api/webhooks/line/<channelKey>) on the internet; a test maps that URL to the stand-in of the
   * route it started on this machine. The answer and webhookDeliveries() name the endpoint as given, as LINE does.
   */
  readonly webhookTarget?: (endpoint: string) => string
  readonly botUserId?: string
  readonly botDisplayName?: string
  /** Called after every answer with the route (user ids left out) and the status: for the console of `pnpm line:fake` */
  readonly onRequest?: (line: { readonly method: string; readonly route: string; readonly status: number }) => void
}

export interface FakeLineMessage {
  readonly kind: 'push' | 'reply'
  readonly to: string | null
  readonly replyToken: string | null
  readonly messages: readonly Record<string, unknown>[]
  readonly retryKey: string | null
  readonly notificationDisabled: boolean
  readonly requestId: string
  readonly at: string
}

export interface FakeLineRequest {
  readonly method: string
  readonly route: string
  readonly status: number
}

export interface FakeLineRichMenu {
  readonly richMenuId: string
  readonly menu: Readonly<Record<string, unknown>>
  readonly image: { readonly contentType: string; readonly bytes: number } | null
}

export interface FakeLineWebhookDelivery {
  readonly endpoint: string
  readonly success: boolean
  readonly statusCode: number
  readonly reason: string
}

export interface IdTokenRequest {
  /** The LINE user id the token is for */
  readonly sub: string
  /** The channel id of the LIFF app (LINE_LIFF_CHANNEL_ID) */
  readonly aud: string
  /** Seconds until it expires; negative for an expired token. 3600 by default */
  readonly expiresInSeconds?: number
  readonly name?: string
  readonly nonce?: string
}

export interface FakeLine {
  /** Base URL for LINE_API_BASE_URL and LINE_DATA_API_BASE_URL, e.g. http://127.0.0.1:4100 */
  readonly url: string
  readonly botUserId: string
  close(): Promise<void>
  issueIdToken(request: IdTokenRequest): string
  /** Pushes and replies LINE accepted, oldest first */
  messages(): readonly FakeLineMessage[]
  /** Every answer given, oldest first */
  requests(): readonly FakeLineRequest[]
  /** The rich menu linked to this user (not the default); null when none */
  userRichMenu(userId: string): string | null
  defaultRichMenu(): string | null
  richMenus(): readonly FakeLineRichMenu[]
  webhook(): { readonly endpoint: string; readonly active: boolean }
  /** What LINE Developers Console would hold: the webhook URL and "Use webhook" */
  setWebhook(endpoint: string, active?: boolean): void
  webhookDeliveries(): readonly FakeLineWebhookDelivery[]
  /** S17-10: the fake FCM served under /fcm (scripts/lib/fake-fcm.ts): pushes accepted, answers per device token */
  readonly fcm: FakeFcm
  /** Forget everything sent, linked and created */
  reset(): void
  /** S17-06: the content LINE keeps for a message a user sent (an image), which the app reads from the data API */
  putContent(messageId: string, contentType: string, bytes: Uint8Array): void
}

// LINE's limits as LINE documents them (checked 2026-10-03, see src/integrations/line/limits.ts for the pages)
const MESSAGES_MAX = 5
const ALT_TEXT_MAX = 400
const POSTBACK_MAX = 300
const TEXT_MAX = 5000
const BUBBLE_MAX_BYTES = 30 * 1024
const CAROUSEL_MAX_BYTES = 50 * 1024
const CAROUSEL_MAX_BUBBLES = 12
const RICH_MENU_IMAGE_MAX_BYTES = 1024 * 1024
const RICH_MENU_AREAS_MAX = 20
const RICH_MENU_NAME_MAX = 300
const CHAT_BAR_TEXT_MAX = 14
const RICH_MENU_WIDTH = { min: 800, max: 2500 }
const RICH_MENU_MIN_HEIGHT = 250
const RICH_MENU_MIN_RATIO = 1.45
const WEBHOOK_URL_MAX = 500
/** Bigger bodies are refused before they are read (an image is at most 1 MB) */
const BODY_MAX_BYTES = 2 * 1024 * 1024
const DEFAULT_ID_TOKEN_SECONDS = 3600
const DEFAULT_WEBHOOK_TIMEOUT_MS = 5000
const ISSUER = 'https://access.line.me'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

type Json = Record<string, unknown>
type Detail = { message: string; property: string }

const isRecord = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v)
const hex = (bytes: number) => randomBytes(bytes).toString('hex')
const bodyError = (details: Detail[]) => ({ message: `The request body has ${details.length} error(s)`, details })

/** Width and height of a PNG (IHDR) or JPEG (first SOF marker); null when the bytes are neither */
export function imageSize(bytes: Buffer): { width: number; height: number } | null {
  if (bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
  }
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let at = 2
    while (at + 9 < bytes.length) {
      if (bytes[at] !== 0xff) return null
      const marker = bytes[at + 1] ?? 0
      const length = bytes.readUInt16BE(at + 2)
      const isFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
      if (isFrame) return { height: bytes.readUInt16BE(at + 5), width: bytes.readUInt16BE(at + 7) }
      at += 2 + length
    }
  }
  return null
}

function postbackErrors(value: unknown, path: string, out: Detail[]): void {
  if (Array.isArray(value)) {
    value.forEach((v, i) => postbackErrors(v, `${path}[${i}]`, out))
    return
  }
  if (!isRecord(value)) return
  if (value.type === 'postback') {
    for (const field of ['data', 'displayText'] as const) {
      const text = value[field]
      if (typeof text === 'string' && text.length > POSTBACK_MAX) out.push({ message: `Length must be between 0 and ${POSTBACK_MAX}`, property: `${path}.${field}` })
    }
  }
  for (const [key, child] of Object.entries(value)) postbackErrors(child, `${path}.${key}`, out)
}

/** What LINE would refuse in a push or reply body's `messages`, as LINE's `details` */
function messageErrors(messages: unknown): Detail[] {
  if (!Array.isArray(messages) || messages.length < 1 || messages.length > MESSAGES_MAX) return [{ message: `Size must be between 1 and ${MESSAGES_MAX}`, property: 'messages' }]
  const out: Detail[] = []
  messages.forEach((m, i) => {
    const path = `messages[${i}]`
    if (!isRecord(m) || typeof m.type !== 'string') {
      out.push({ message: 'Must be one of the following values: [text, image, video, audio, location, sticker, template, imagemap, flex]', property: `${path}.type` })
      return
    }
    if (m.type === 'text' && (typeof m.text !== 'string' || m.text.length < 1 || m.text.length > TEXT_MAX)) out.push({ message: `Length must be between 1 and ${TEXT_MAX}`, property: `${path}.text` })
    if (m.type === 'flex' || m.type === 'template') {
      if (typeof m.altText !== 'string' || m.altText.length < 1 || m.altText.length > ALT_TEXT_MAX) out.push({ message: `Length must be between 1 and ${ALT_TEXT_MAX}`, property: `${path}.altText` })
    }
    if (m.type === 'flex') {
      const contents = m.contents
      if (!isRecord(contents) || (contents.type !== 'bubble' && contents.type !== 'carousel')) {
        out.push({ message: 'Must be one of the following values: [bubble, carousel]', property: `${path}.contents.type` })
      } else {
        const bytes = Buffer.byteLength(JSON.stringify(contents), 'utf8')
        const max = contents.type === 'bubble' ? BUBBLE_MAX_BYTES : CAROUSEL_MAX_BYTES
        if (bytes > max) out.push({ message: `Size must be at most ${max} bytes`, property: `${path}.contents` })
        if (contents.type === 'carousel' && (!Array.isArray(contents.contents) || contents.contents.length > CAROUSEL_MAX_BUBBLES)) {
          out.push({ message: `Size must be between 1 and ${CAROUSEL_MAX_BUBBLES}`, property: `${path}.contents.contents` })
        }
      }
    }
    postbackErrors(m, path, out)
  })
  return out
}

function richMenuErrors(menu: unknown): Detail[] {
  if (!isRecord(menu)) return [{ message: 'Must not be null', property: 'richmenu' }]
  const out: Detail[] = []
  const size = menu.size
  const width = isRecord(size) && Number.isInteger(size.width) ? (size.width as number) : null
  const height = isRecord(size) && Number.isInteger(size.height) ? (size.height as number) : null
  if (width === null || width < RICH_MENU_WIDTH.min || width > RICH_MENU_WIDTH.max) out.push({ message: `Must be between ${RICH_MENU_WIDTH.min} and ${RICH_MENU_WIDTH.max}`, property: 'size.width' })
  if (height === null || height < RICH_MENU_MIN_HEIGHT) out.push({ message: `Must be at least ${RICH_MENU_MIN_HEIGHT}`, property: 'size.height' })
  if (width !== null && height !== null && height > 0 && width / height < RICH_MENU_MIN_RATIO) out.push({ message: `Aspect ratio (width / height) must be at least ${RICH_MENU_MIN_RATIO}`, property: 'size' })
  if (typeof menu.selected !== 'boolean') out.push({ message: 'Must be a boolean', property: 'selected' })
  if (typeof menu.name !== 'string' || menu.name.length < 1 || menu.name.length > RICH_MENU_NAME_MAX) out.push({ message: `Length must be between 1 and ${RICH_MENU_NAME_MAX}`, property: 'name' })
  if (typeof menu.chatBarText !== 'string' || menu.chatBarText.length < 1 || [...menu.chatBarText].length > CHAT_BAR_TEXT_MAX) {
    out.push({ message: `Length must be between 1 and ${CHAT_BAR_TEXT_MAX}`, property: 'chatBarText' })
  }
  const areas = menu.areas
  if (!Array.isArray(areas) || areas.length < 1 || areas.length > RICH_MENU_AREAS_MAX) {
    out.push({ message: `Size must be between 1 and ${RICH_MENU_AREAS_MAX}`, property: 'areas' })
  } else {
    areas.forEach((area, i) => {
      const b = isRecord(area) ? area.bounds : null
      const inside =
        isRecord(b) &&
        [b.x, b.y, b.width, b.height].every((n) => Number.isInteger(n) && (n as number) >= 0) &&
        (width === null || (b.x as number) + (b.width as number) <= width) &&
        (height === null || (b.y as number) + (b.height as number) <= height)
      if (!inside) out.push({ message: 'Must be inside the rich menu', property: `areas[${i}].bounds` })
      if (!isRecord(area) || !isRecord(area.action) || typeof area.action.type !== 'string') out.push({ message: 'Must not be null', property: `areas[${i}].action` })
      else postbackErrors(area.action, `areas[${i}].action`, out)
    })
  }
  return out
}

/** The route of a path with LINE user ids and rich menu ids left out, for the console */
function routeOf(path: string): string {
  return path
    .replace(/\/v2\/bot\/user\/(?!all\/)[^/]+/, '/v2/bot/user/:userId')
    .replace(/richmenu-[0-9a-f]+/g, ':richMenuId')
    .replace(/\/__fake\/users\/[^/]+/, '/__fake/users/:userId')
}

async function readBody(req: IncomingMessage): Promise<Buffer | null> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = chunk as Buffer
    size += buffer.length
    if (size > BODY_MAX_BYTES) return null
    chunks.push(buffer)
  }
  return Buffer.concat(chunks)
}

const parseJson = (body: Buffer): unknown => {
  try {
    return JSON.parse(body.toString('utf8'))
  } catch {
    return undefined
  }
}

export async function startFakeLine(options: FakeLineOptions): Promise<FakeLine> {
  if (options.channelSecret === '') throw new TypeError('the fake LINE server needs a channel secret to sign test webhooks')
  const botUserId = options.botUserId ?? `U${hex(16)}`
  const fcm = createFakeFcm()
  const tokenKey = randomBytes(32)
  const webhookTimeoutMs = options.webhookTimeoutMs ?? DEFAULT_WEBHOOK_TIMEOUT_MS

  // LINE message ids are numeric strings
  let sequence = 0
  const messageId = () => `${Date.now()}${String(++sequence).padStart(6, '0')}`

  const state = {
    messages: [] as FakeLineMessage[],
    requests: [] as FakeLineRequest[],
    richMenus: new Map<string, { menu: Json; image: { contentType: string; bytes: number } | null }>(),
    defaultRichMenuId: null as string | null,
    userRichMenus: new Map<string, string>(),
    webhook: { endpoint: '', active: false },
    usedReplyTokens: new Set<string>(),
    acceptedRetryKeys: new Map<string, { requestId: string; sentMessages: Array<{ id: string; quoteToken: string }> }>(),
    deliveries: [] as FakeLineWebhookDelivery[],
    contents: new Map<string, { contentType: string; bytes: Buffer }>(),
  }

  function signToken(payload: Json): string {
    const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT', kid: 'fake-line' })).toString('base64url')
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
    const signature = createHmac('sha256', tokenKey).update(`${header}.${body}`).digest('base64url')
    return `${header}.${body}.${signature}`
  }

  /** The claims of a token this server issued, or null for anything else */
  function claimsOf(token: string): Json | null {
    const parts = token.split('.')
    if (parts.length !== 3) return null
    const [header = '', body = '', signature = ''] = parts
    const expected = createHmac('sha256', tokenKey).update(`${header}.${body}`).digest()
    const given = Buffer.from(signature, 'base64url')
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null
    const claims = parseJson(Buffer.from(body, 'base64url'))
    return isRecord(claims) ? claims : null
  }

  function issueIdToken(request: IdTokenRequest): string {
    const now = Math.floor(Date.now() / 1000)
    return signToken({
      iss: ISSUER,
      sub: request.sub,
      aud: request.aud,
      exp: now + (request.expiresInSeconds ?? DEFAULT_ID_TOKEN_SECONDS),
      iat: now,
      amr: ['linesso'],
      ...(request.name ? { name: request.name } : {}),
      ...(request.nonce ? { nonce: request.nonce } : {}),
    })
  }

  async function testWebhook(endpoint: string): Promise<FakeLineWebhookDelivery & { timestamp: string; detail: string }> {
    const payload = JSON.stringify({ destination: botUserId, events: [] })
    const signature = createHmac('sha256', options.channelSecret).update(payload).digest('base64')
    const timestamp = new Date().toISOString()
    let result: FakeLineWebhookDelivery & { detail: string }
    try {
      const response = await fetch(options.webhookTarget ? options.webhookTarget(endpoint) : endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json; charset=utf-8', 'x-line-signature': signature, 'user-agent': 'LineBotWebhook/2.0' },
        body: payload,
        signal: AbortSignal.timeout(webhookTimeoutMs),
        redirect: 'manual',
      })
      await response.arrayBuffer().catch(() => undefined)
      const success = response.status >= 200 && response.status < 300
      result = { endpoint, success, statusCode: response.status, reason: success ? 'OK' : 'ERROR_STATUS_CODE', detail: String(response.status) }
    } catch (error) {
      const timedOut = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')
      result = { endpoint, success: false, statusCode: 0, reason: timedOut ? 'REQUEST_TIMEOUT' : 'COULD_NOT_CONNECT', detail: timedOut ? 'timeout' : 'connection failed' }
    }
    state.deliveries.push({ endpoint: result.endpoint, success: result.success, statusCode: result.statusCode, reason: result.reason })
    return { ...result, timestamp }
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = req.method ?? 'GET'
    const path = new URL(req.url ?? '/', 'http://fake-line').pathname
    const requestId = randomUUID()
    const answer = (status: number, body: unknown = {}, headers: Record<string, string> = {}) => {
      res.writeHead(status, { 'content-type': 'application/json', 'x-line-request-id': requestId, ...headers })
      res.end(JSON.stringify(body))
      const line = { method, route: routeOf(path), status }
      state.requests.push(line)
      options.onRequest?.(line)
    }

    const raw = await readBody(req)
    if (raw === null) return answer(413, { message: 'Request Entity Too Large' }, { connection: 'close' })

    // ---- FCM of the BCS Go app (S17-10): /fcm/* and its /__fake/ push controls ----
    if (fcm.handle(method, path, raw, req.headers.authorization ?? '', (status, body) => answer(status, body ?? {}))) return

    // ---- LINE Login: verify an ID token (BR-LINE-02) ----
    if (method === 'POST' && path === '/oauth2/v2.1/verify') {
      const form = new URLSearchParams(raw.toString('utf8'))
      const idToken = form.get('id_token') ?? ''
      const clientId = form.get('client_id') ?? ''
      const invalid = (description: string) => answer(400, { error: 'invalid_request', error_description: description })
      if (idToken === '') return invalid('id_token is required')
      if (clientId === '') return invalid('client_id is required')
      const claims = claimsOf(idToken)
      if (!claims) return invalid('Invalid IdToken.')
      if (typeof claims.exp !== 'number' || claims.exp * 1000 <= Date.now()) return invalid('IdToken expired.')
      if (claims.aud !== clientId) return invalid('Invalid IdToken Audience.')
      const nonce = form.get('nonce')
      if (nonce !== null && claims.nonce !== nonce) return invalid('Invalid IdToken Nonce.')
      const userId = form.get('user_id')
      if (userId !== null && claims.sub !== userId) return invalid('Invalid IdToken Subject Identifier.')
      return answer(200, claims)
    }

    // ---- controls for tests and pnpm line:simulate (this machine only) ----
    if (path.startsWith('/__fake/')) {
      const body = parseJson(raw)
      if (method === 'POST' && path === '/__fake/id-token') {
        if (!isRecord(body) || typeof body.sub !== 'string' || typeof body.aud !== 'string') return answer(400, { message: 'sub and aud are required' })
        const request: IdTokenRequest = {
          sub: body.sub,
          aud: body.aud,
          ...(typeof body.expiresInSeconds === 'number' ? { expiresInSeconds: body.expiresInSeconds } : {}),
          ...(typeof body.name === 'string' ? { name: body.name } : {}),
          ...(typeof body.nonce === 'string' ? { nonce: body.nonce } : {}),
        }
        return answer(200, { idToken: issueIdToken(request) })
      }
      if (method === 'GET' && path === '/__fake/messages') return answer(200, { messages: state.messages })
      const user = /^\/__fake\/users\/([^/]+)\/richmenu$/.exec(path)
      if (method === 'GET' && user) {
        const linked = state.userRichMenus.get(decodeURIComponent(user[1] ?? '')) ?? null
        return answer(200, { richMenuId: linked, effectiveRichMenuId: linked ?? state.defaultRichMenuId })
      }
      if (method === 'GET' && path === '/__fake/state') {
        return answer(200, { defaultRichMenuId: state.defaultRichMenuId, richMenus: fake.richMenus(), webhook: state.webhook, webhookDeliveries: state.deliveries })
      }
      if (method === 'POST' && path === '/__fake/webhook') {
        if (!isRecord(body) || typeof body.endpoint !== 'string') return answer(400, { message: 'endpoint is required' })
        fake.setWebhook(body.endpoint, typeof body.active === 'boolean' ? body.active : true)
        return answer(200, {})
      }
      // S17-06: the content of an image a test sends in a chat ({ messageId, contentType, base64 })
      if (method === 'POST' && path === '/__fake/content') {
        if (!isRecord(body) || typeof body.messageId !== 'string' || typeof body.contentType !== 'string' || typeof body.base64 !== 'string') return answer(400, { message: 'messageId, contentType and base64 are required' })
        fake.putContent(body.messageId, body.contentType, Buffer.from(body.base64, 'base64'))
        return answer(200, {})
      }
      if (method === 'POST' && path === '/__fake/reset') {
        fake.reset()
        return answer(200, {})
      }
      return answer(404, { message: 'Not found' })
    }

    // ---- Messaging API: every call carries the channel access token ----
    if (!path.startsWith('/v2/bot/')) return answer(404, { message: 'Not found' })
    const authorization = req.headers.authorization ?? ''
    if (!authorization.startsWith('Bearer ')) return answer(401, { message: "Authorization header required. Must follow the scheme, 'Authorization: Bearer <ACCESS TOKEN>'" })
    const token = authorization.slice('Bearer '.length)
    const tokenOk = options.accessToken === undefined ? token.trim() !== '' : token.length === options.accessToken.length && timingSafeEqual(Buffer.from(token), Buffer.from(options.accessToken))
    if (!tokenOk) return answer(401, { message: 'Authentication failed. Confirm that the access token in the authorization header is valid.' })
    const json = parseJson(raw)

    if (method === 'POST' && path === '/v2/bot/message/push') {
      if (!isRecord(json)) return answer(400, { message: 'The request body could not be parsed as JSON' })
      if (typeof json.to !== 'string' || json.to === '') return answer(400, bodyError([{ message: 'Must not be empty', property: 'to' }]))
      const retryKey = typeof req.headers['x-line-retry-key'] === 'string' ? req.headers['x-line-retry-key'] : null
      if (retryKey !== null && !UUID.test(retryKey)) return answer(400, { message: 'The value of the X-Line-Retry-Key header is invalid' })
      const accepted = retryKey === null ? undefined : state.acceptedRetryKeys.get(retryKey)
      if (accepted) return answer(409, { message: 'The retry key is already accepted', sentMessages: accepted.sentMessages }, { 'x-line-accepted-request-id': accepted.requestId })
      const errors = messageErrors(json.messages)
      if (errors.length) return answer(400, bodyError(errors))
      // A stand-in for a recipient LINE will not deliver to; real LINE's answer for a block is not confirmed (D-03)
      if (json.to.startsWith('Ublocked')) return answer(403, { message: 'The fake LINE server refuses this recipient on purpose (a stand-in for a recipient LINE does not deliver to)' })
      if (json.to.startsWith('Udown')) return answer(500, { message: 'Internal server error (fake LINE)' })
      const messages = json.messages as Json[]
      const sentMessages = messages.map(() => ({ id: messageId(), quoteToken: hex(16) }))
      state.messages.push({ kind: 'push', to: json.to, replyToken: null, messages, retryKey, notificationDisabled: json.notificationDisabled === true, requestId, at: new Date().toISOString() })
      if (retryKey !== null) state.acceptedRetryKeys.set(retryKey, { requestId, sentMessages })
      return answer(200, { sentMessages })
    }

    if (method === 'POST' && path === '/v2/bot/message/reply') {
      if (!isRecord(json)) return answer(400, { message: 'The request body could not be parsed as JSON' })
      const replyToken = typeof json.replyToken === 'string' ? json.replyToken : ''
      if (replyToken === '' || replyToken.startsWith('expired') || state.usedReplyTokens.has(replyToken)) return answer(400, { message: 'Invalid reply token' })
      const errors = messageErrors(json.messages)
      if (errors.length) return answer(400, bodyError(errors))
      state.usedReplyTokens.add(replyToken)
      const messages = json.messages as Json[]
      const sentMessages = messages.map(() => ({ id: messageId(), quoteToken: hex(16) }))
      state.messages.push({ kind: 'reply', to: null, replyToken, messages, retryKey: null, notificationDisabled: json.notificationDisabled === true, requestId, at: new Date().toISOString() })
      return answer(200, { sentMessages })
    }

    if (method === 'GET' && path === '/v2/bot/info') {
      return answer(200, { userId: botUserId, basicId: '@bcs-fake', displayName: options.botDisplayName ?? 'BCS (fake LINE)', chatMode: 'bot', markAsReadMode: 'auto' })
    }

    if (path === '/v2/bot/channel/webhook/endpoint') {
      if (method === 'GET') return answer(200, { endpoint: state.webhook.endpoint, active: state.webhook.active })
      if (method === 'PUT') {
        const endpoint = isRecord(json) ? json.endpoint : undefined
        if (typeof endpoint !== 'string' || !/^https?:\/\//.test(endpoint) || endpoint.length > WEBHOOK_URL_MAX) return answer(400, bodyError([{ message: 'Invalid webhook endpoint URL', property: 'endpoint' }]))
        state.webhook = { endpoint, active: true }
        return answer(200, {})
      }
    }

    if (method === 'POST' && path === '/v2/bot/channel/webhook/test') {
      const endpoint = isRecord(json) && typeof json.endpoint === 'string' ? json.endpoint : state.webhook.endpoint
      if (endpoint === '') return answer(400, { message: 'The webhook endpoint is not set' })
      const { endpoint: _tested, ...result } = await testWebhook(endpoint)
      return answer(200, { success: result.success, timestamp: result.timestamp, statusCode: result.statusCode, reason: result.reason, detail: result.detail })
    }

    // ---- the content of a message a user sent (data API · S17-06) ----
    const messageContent = /^\/v2\/bot\/message\/([0-9]+)\/content$/.exec(path)
    if (method === 'GET' && messageContent) {
      const stored = state.contents.get(messageContent[1] ?? '')
      if (!stored) return answer(404, { message: 'Not found' })
      res.writeHead(200, { 'content-type': stored.contentType, 'x-line-request-id': requestId })
      res.end(stored.bytes)
      const line = { method, route: routeOf(path), status: 200 }
      state.requests.push(line)
      options.onRequest?.(line)
      return
    }

    // ---- rich menus (§9.5) ----
    if (method === 'POST' && path === '/v2/bot/richmenu') {
      const errors = richMenuErrors(json)
      if (errors.length) return answer(400, bodyError(errors))
      const richMenuId = `richmenu-${hex(16)}`
      state.richMenus.set(richMenuId, { menu: json as Json, image: null })
      return answer(200, { richMenuId })
    }
    if (method === 'GET' && path === '/v2/bot/richmenu/list') {
      return answer(200, { richmenus: [...state.richMenus].map(([richMenuId, r]) => ({ richMenuId, ...r.menu })) })
    }
    const content = /^\/v2\/bot\/richmenu\/([^/]+)\/content$/.exec(path)
    if (method === 'POST' && content) {
      const menu = state.richMenus.get(decodeURIComponent(content[1] ?? ''))
      if (!menu) return answer(404, { message: 'Not found' })
      const contentType = (req.headers['content-type'] ?? '').split(';')[0]?.trim() ?? ''
      if (contentType !== 'image/png' && contentType !== 'image/jpeg') return answer(415, { message: 'Unsupported Media Type' })
      if (raw.length > RICH_MENU_IMAGE_MAX_BYTES) return answer(413, { message: 'Request Entity Too Large' })
      if (menu.image) return answer(400, { message: 'An image has already been uploaded to the richmenu' })
      const size = imageSize(raw)
      const expected = menu.menu.size as { width: number; height: number }
      if (!size) return answer(400, { message: 'Invalid image (fake LINE reads PNG and JPEG)' })
      if (size.width !== expected.width || size.height !== expected.height) {
        return answer(400, { message: `Image size must match the rich menu size ${expected.width}x${expected.height} (got ${size.width}x${size.height})` })
      }
      menu.image = { contentType, bytes: raw.length }
      return answer(200, {})
    }
    const one = /^\/v2\/bot\/richmenu\/(richmenu-[^/]+)$/.exec(path)
    if (one) {
      const richMenuId = decodeURIComponent(one[1] ?? '')
      const menu = state.richMenus.get(richMenuId)
      if (!menu) return answer(404, { message: 'Not found' })
      if (method === 'GET') return answer(200, { richMenuId, ...menu.menu })
      if (method === 'DELETE') {
        state.richMenus.delete(richMenuId)
        if (state.defaultRichMenuId === richMenuId) state.defaultRichMenuId = null
        for (const [user, linked] of state.userRichMenus) if (linked === richMenuId) state.userRichMenus.delete(user)
        return answer(200, {})
      }
    }
    /** Why LINE would not apply this rich menu to users: it does not exist, or has no image yet */
    const notApplicable = (richMenuId: string): [number, Json] | null => {
      const menu = state.richMenus.get(richMenuId)
      if (!menu) return [404, { message: 'Not found' }]
      if (!menu.image) return [400, { message: 'must upload richmenu image before applying it to user' }]
      return null
    }
    const setDefault = /^\/v2\/bot\/user\/all\/richmenu\/([^/]+)$/.exec(path)
    if (method === 'POST' && setDefault) {
      const richMenuId = decodeURIComponent(setDefault[1] ?? '')
      const refused = notApplicable(richMenuId)
      if (refused) return answer(...refused)
      state.defaultRichMenuId = richMenuId
      return answer(200, {})
    }
    if (path === '/v2/bot/user/all/richmenu') {
      if (method === 'GET') return state.defaultRichMenuId ? answer(200, { richMenuId: state.defaultRichMenuId }) : answer(404, { message: 'no default richmenu' })
      if (method === 'DELETE') {
        state.defaultRichMenuId = null
        return answer(200, {})
      }
    }
    // Bulk link and unlink (S17-03 · BR-LINE-17): LINE answers 202 and applies the change shortly after; here at once
    if (method === 'POST' && (path === '/v2/bot/richmenu/bulk/link' || path === '/v2/bot/richmenu/bulk/unlink')) {
      const userIds = isRecord(json) && Array.isArray(json.userIds) ? json.userIds : null
      if (!userIds || userIds.length === 0 || userIds.length > 500 || !userIds.every((u) => typeof u === 'string' && u.startsWith('U'))) {
        return answer(400, { message: "The value for the 'userIds' parameter is invalid" })
      }
      if (path.endsWith('/link')) {
        const richMenuId = isRecord(json) && typeof json.richMenuId === 'string' ? json.richMenuId : ''
        const refused = notApplicable(richMenuId)
        if (refused) return answer(...refused)
        for (const u of userIds as string[]) state.userRichMenus.set(u, richMenuId)
      } else {
        for (const u of userIds as string[]) state.userRichMenus.delete(u)
      }
      return answer(202, {})
    }
    const link = /^\/v2\/bot\/user\/([^/]+)\/richmenu\/([^/]+)$/.exec(path)
    if (method === 'POST' && link) {
      const userId = decodeURIComponent(link[1] ?? '')
      const richMenuId = decodeURIComponent(link[2] ?? '')
      if (!userId.startsWith('U')) return answer(400, { message: "The value for the 'userId' parameter is invalid" })
      const refused = notApplicable(richMenuId)
      if (refused) return answer(...refused)
      state.userRichMenus.set(userId, richMenuId)
      return answer(200, {})
    }
    const userMenu = /^\/v2\/bot\/user\/([^/]+)\/richmenu$/.exec(path)
    if (userMenu) {
      const userId = decodeURIComponent(userMenu[1] ?? '')
      if (method === 'GET') {
        const linked = state.userRichMenus.get(userId)
        return linked ? answer(200, { richMenuId: linked }) : answer(404, { message: 'the user has no richmenu' })
      }
      if (method === 'DELETE') {
        state.userRichMenus.delete(userId)
        return answer(200, {})
      }
    }
    return answer(404, { message: 'Not found' })
  }

  const server = createServer((req, res) => {
    handle(req, res).catch(() => {
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ message: 'Internal server error (fake LINE)' }))
      }
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(options.port, options.host ?? '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
  const address = server.address() as AddressInfo
  const host = address.family === 'IPv6' ? `[${address.address}]` : address.address

  const fake: FakeLine = {
    url: `http://${host}:${address.port}`,
    botUserId,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
        server.closeAllConnections()
      }),
    issueIdToken,
    messages: () => [...state.messages],
    requests: () => [...state.requests],
    userRichMenu: (userId) => state.userRichMenus.get(userId) ?? null,
    defaultRichMenu: () => state.defaultRichMenuId,
    richMenus: () => [...state.richMenus].map(([richMenuId, r]) => ({ richMenuId, menu: r.menu, image: r.image })),
    webhook: () => ({ ...state.webhook }),
    setWebhook: (endpoint, active = true) => {
      state.webhook = { endpoint, active }
    },
    webhookDeliveries: () => [...state.deliveries],
    fcm,
    putContent: (messageId, contentType, bytes) => {
      state.contents.set(messageId, { contentType, bytes: Buffer.from(bytes) })
    },
    reset: () => {
      fcm.reset()
      state.messages = []
      state.contents.clear()
      state.requests = []
      state.richMenus.clear()
      state.defaultRichMenuId = null
      state.userRichMenus.clear()
      state.webhook = { endpoint: '', active: false }
      state.usedReplyTokens.clear()
      state.acceptedRetryKeys.clear()
      state.deliveries = []
    },
  }
  return fake
}
