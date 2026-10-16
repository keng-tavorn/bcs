// pnpm line:simulate <kind> [options] — sends the app a LINE webhook signed exactly as LINE signs one (S5-02, FR-LINE-005),
// so the webhook can be tried on this machine without the LINE app:
//   follow    [--user U…] [--unblocked]          a user adds the account (or unblocks it)
//   unfollow  [--user U…]                         a user blocks the account
//   postback  --data "v=1&a=approve&k=<id>" [--user U…]   a button of a card was tapped
//   message   [--text "…"] [--user U…]            a user wrote something (the app keeps no text)
//   redeliver                                     the last webhook sent again, marked isRedelivery (BR-LINE-04)
// Where it goes: --url, or APP_URL/api/webhooks/line/<channelKey>; the key is --channel-key, or read from the database
// (the only LINE channel there, or the one of --org <organization code>). Signed with LINE_MESSAGING_CHANNEL_SECRET of
// .env, or --secret (e.g. a wrong one, to see 401). Local only (APP_ENV=local). Prints what was sent and the status the
// app answered — never the secret or the signature. The last webhook is kept in node_modules/.cache/bcs (or
// LINE_SIMULATE_STATE_FILE) for `redeliver`.
// Tests import the builders and signLineWebhook, so the integration tests send webhooks signed by this very code.
import { createHash, createHmac, randomBytes } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import pg from 'pg'

export const SIMULATE_KINDS = ['follow', 'unfollow', 'postback', 'message', 'redeliver'] as const
export type SimulateKind = (typeof SIMULATE_KINDS)[number]

/** A LINE user id: "U" and 32 hexadecimal digits */
const LINE_USER_ID = /^U[0-9a-f]{32}$/
const CHANNEL_KEY = /^[A-Za-z0-9_-]{24}$/
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
/** The user of every kind when --user is not given, so follow and unfollow act on the same one */
export const DEFAULT_SIMULATED_USER_ID = `U${createHash('sha256').update('bcs pnpm line:simulate').digest('hex').slice(0, 32)}`
const DEFAULT_MESSAGE_TEXT = 'สวัสดี'
const DEFAULT_STATE_FILE = path.join('node_modules', '.cache', 'bcs', 'line-simulate-last.json')

// ---------- what LINE sends (developers.line.biz/en/reference/messaging-api/#webhook-event-objects) ----------

export interface LineWebhookEventJson {
  readonly type: string
  readonly mode: 'active' | 'standby'
  readonly timestamp: number
  readonly source: { readonly type: 'user'; readonly userId: string } | { readonly type: 'group'; readonly groupId: string; readonly userId?: string }
  readonly webhookEventId: string
  readonly deliveryContext: { readonly isRedelivery: boolean }
  readonly replyToken?: string
  readonly follow?: { readonly isUnblocked: boolean }
  readonly postback?: { readonly data: string }
  readonly message?: { readonly type: 'text'; readonly id: string; readonly quoteToken: string; readonly text: string } | { readonly type: 'image'; readonly id: string; readonly quoteToken: string; readonly contentProvider: { readonly type: 'line' } } | { readonly type: 'sticker'; readonly id: string; readonly packageId: string; readonly stickerId: string }
}

export interface LineWebhookJson {
  /** The bot's user id */
  readonly destination: string
  readonly events: readonly LineWebhookEventJson[]
}

/** A ULID, as LINE's webhookEventId: 10 characters of time and 16 random, Crockford base32 */
export function newWebhookEventId(at: number = Date.now()): string {
  let time = ''
  let rest = at
  for (let i = 0; i < 10; i++) {
    time = CROCKFORD[rest % 32]! + time
    rest = Math.floor(rest / 32)
  }
  const random = [...randomBytes(16)].map((b) => CROCKFORD[b % 32]!).join('')
  return time + random
}

/** A reply token as LINE makes them: 32 hexadecimal digits */
export function newReplyToken(): string {
  return randomBytes(16).toString('hex')
}

export function newLineUserId(): string {
  return `U${randomBytes(16).toString('hex')}`
}

export interface SimulatedEventOptions {
  readonly userId: string
  readonly webhookEventId?: string
  readonly timestamp?: number
  /** Events that can be answered carry one; null leaves it out */
  readonly replyToken?: string | null
  readonly mode?: 'active' | 'standby'
  /** A group chat instead of the user's own chat with the account */
  readonly groupId?: string
}

function base(type: string, options: SimulatedEventOptions, answerable: boolean) {
  const timestamp = options.timestamp ?? Date.now()
  const replyToken = options.replyToken === undefined ? (answerable ? newReplyToken() : null) : options.replyToken
  return {
    type,
    mode: options.mode ?? 'active',
    timestamp,
    source: options.groupId ? { type: 'group' as const, groupId: options.groupId, userId: options.userId } : { type: 'user' as const, userId: options.userId },
    webhookEventId: options.webhookEventId ?? newWebhookEventId(timestamp),
    deliveryContext: { isRedelivery: false },
    ...(replyToken ? { replyToken } : {}),
  }
}

/** One event of each kind LINE sends to BCS, shaped as LINE documents them */
export const lineEvents = {
  follow: (options: SimulatedEventOptions & { readonly unblocked?: boolean }): LineWebhookEventJson => ({ ...base('follow', options, true), follow: { isUnblocked: options.unblocked ?? false } }),
  unfollow: (options: SimulatedEventOptions): LineWebhookEventJson => base('unfollow', options, false),
  postback: (options: SimulatedEventOptions & { readonly data: string }): LineWebhookEventJson => ({ ...base('postback', options, true), postback: { data: options.data } }),
  message: (options: SimulatedEventOptions & { readonly text: string; readonly messageId?: string }): LineWebhookEventJson => ({
    ...base('message', options, true),
    message: { type: 'text', id: options.messageId ?? lineMessageId(), quoteToken: randomBytes(16).toString('hex'), text: options.text },
  }),
  // S17-06: a picture sent in the chat; its content is what the fake LINE server holds for messageId (putContent)
  image: (options: SimulatedEventOptions & { readonly messageId?: string }): LineWebhookEventJson => ({
    ...base('message', options, true),
    message: { type: 'image', id: options.messageId ?? lineMessageId(), quoteToken: randomBytes(16).toString('hex'), contentProvider: { type: 'line' } },
  }),
  sticker: (options: SimulatedEventOptions): LineWebhookEventJson => ({ ...base('message', options, true), message: { type: 'sticker', id: lineMessageId(), packageId: '446', stickerId: '1988' } }),
}

let messageSequence = 0
/** LINE's message ids are numeric strings */
export const lineMessageId = () => `${Date.now()}${String(++messageSequence).padStart(4, '0')}`

/** The same event delivered again by LINE: same webhookEventId, isRedelivery true */
export function redelivered(event: LineWebhookEventJson): LineWebhookEventJson {
  return { ...event, deliveryContext: { isRedelivery: true } }
}

/** The webhook body as LINE sends it: the exact string that is signed and posted */
export function buildLineWebhook(events: readonly LineWebhookEventJson[], destination = `U${'0'.repeat(32)}`): { readonly json: LineWebhookJson; readonly body: string } {
  const json: LineWebhookJson = { destination, events }
  return { json, body: JSON.stringify(json) }
}

/**
 * x-line-signature as LINE computes it: base64(HMAC-SHA256(channel secret, body)) over the body's bytes (BR-LINE-03).
 * Written here on its own rather than taken from the app (src/integrations/line/signature.ts), so a mistake in the
 * app's check cannot hide behind the same mistake here.
 */
export function signLineWebhook(channelSecret: string, body: string | Uint8Array): string {
  if (channelSecret === '') throw new TypeError('a channel secret is needed to sign a webhook')
  return createHmac('sha256', Buffer.from(channelSecret, 'utf8')).update(typeof body === 'string' ? Buffer.from(body, 'utf8') : body).digest('base64')
}

/** Posts a signed body as LINE does; `signature` null sends no x-line-signature */
export async function postLineWebhook(url: string, body: string, signature: string | null, doFetch: typeof fetch = fetch): Promise<{ readonly status: number }> {
  const response = await doFetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=utf-8', 'user-agent': 'LineBotWebhook/2.0', ...(signature === null ? {} : { 'x-line-signature': signature }) },
    body,
    redirect: 'manual',
  })
  await response.arrayBuffer().catch(() => undefined)
  return { status: response.status }
}

/** APP_URL (with or without a trailing slash) and the channel's webhook path */
export function defaultWebhookUrl(appUrl: string, channelKey: string): string {
  return `${appUrl.replace(/\/+$/, '')}/api/webhooks/line/${encodeURIComponent(channelKey)}`
}

// ---------- the command line ----------

export interface SimulateArgs {
  readonly kind: SimulateKind
  readonly userId: string
  readonly data: string | null
  readonly text: string
  readonly unblocked: boolean
  readonly url: string | null
  readonly channelKey: string | null
  readonly org: string | null
  readonly secret: string | null
}

const VALUE_OPTIONS = new Set(['--user', '--data', '--text', '--url', '--channel-key', '--org', '--secret'])

/** The kind and options of `pnpm line:simulate`, or the problem with them (in Thai, like the other scripts) */
export function parseSimulateArgs(argv: readonly string[]): { readonly ok: true; readonly args: SimulateArgs } | { readonly ok: false; readonly problem: string } {
  const [kind, ...rest] = argv
  if (!kind || !(SIMULATE_KINDS as readonly string[]).includes(kind)) return { ok: false, problem: `ระบุชนิดก่อน: ${SIMULATE_KINDS.join(' | ')}` }
  const values = new Map<string, string>()
  let unblocked = false
  for (let i = 0; i < rest.length; i++) {
    const option = rest[i]!
    if (option === '--unblocked') {
      unblocked = true
      continue
    }
    if (!VALUE_OPTIONS.has(option)) return { ok: false, problem: `ไม่รู้จักตัวเลือก ${option}` }
    const value = rest[++i]
    if (value === undefined || value.startsWith('--')) return { ok: false, problem: `${option} ต้องมีค่าต่อท้าย` }
    values.set(option, value)
  }
  const userId = values.get('--user') ?? DEFAULT_SIMULATED_USER_ID
  if (!LINE_USER_ID.test(userId)) return { ok: false, problem: '--user ต้องเป็น LINE user id: U ตามด้วยเลขฐานสิบหก 32 ตัว' }
  const data = values.get('--data') ?? null
  if (kind === 'postback' && !data) return { ok: false, problem: 'postback ต้องมี --data เช่น "v=1&a=approve&k=<tokenId>"' }
  const channelKey = values.get('--channel-key') ?? null
  if (channelKey !== null && !CHANNEL_KEY.test(channelKey)) return { ok: false, problem: '--channel-key ต้องเป็นตัวอักษร ตัวเลข - หรือ _ 24 ตัว (ดูที่หน้าตั้งค่า LINE)' }
  return {
    ok: true,
    args: {
      kind: kind as SimulateKind,
      userId,
      data,
      text: values.get('--text') ?? DEFAULT_MESSAGE_TEXT,
      unblocked,
      url: values.get('--url') ?? null,
      channelKey,
      org: values.get('--org') ?? null,
      secret: values.get('--secret') ?? null,
    },
  }
}

/** The event of one command (redeliver is handled from the saved webhook) */
export function eventFor(args: SimulateArgs): LineWebhookEventJson {
  switch (args.kind) {
    case 'follow':
      return lineEvents.follow({ userId: args.userId, unblocked: args.unblocked })
    case 'unfollow':
      return lineEvents.unfollow({ userId: args.userId })
    case 'postback':
      return lineEvents.postback({ userId: args.userId, data: args.data ?? '' })
    case 'message':
      return lineEvents.message({ userId: args.userId, text: args.text })
    case 'redeliver':
      throw new TypeError('redeliver sends the saved webhook again')
  }
}

class SimulateStop extends Error {}

/** The channel key from the database: the only LINE channel, or the one of --org */
async function channelKeyFromDatabase(org: string | null): Promise<string> {
  const url = process.env.DATABASE_URL
  if (!url) throw new SimulateStop('ไม่มี DATABASE_URL ใน .env — ระบุ --channel-key หรือ --url แทน')
  const client = new pg.Client({ connectionString: url })
  await client.connect()
  try {
    const rows = (
      await client.query<{ channelKey: string; code: string }>(
        `SELECT c."channelKey", o.code FROM "LineChannelConfig" c JOIN "Organization" o ON o.id = c."organizationId" ${org ? 'WHERE o.code = $1' : ''} ORDER BY o.code`,
        org ? [org] : [],
      )
    ).rows
    if (rows.length === 0) throw new SimulateStop(org ? `องค์กร ${org} ยังไม่มีค่า LINE channel` : 'ยังไม่มีค่า LINE channel ในฐานข้อมูล — ใส่ LINE_* ใน .env แล้วรัน pnpm db:seed หรือบันทึกที่หน้าตั้งค่า LINE')
    if (rows.length > 1) throw new SimulateStop(`มี LINE channel หลายองค์กร (${rows.map((r) => r.code).join(', ')}) — ระบุ --org หรือ --channel-key`)
    return rows[0]!.channelKey
  } finally {
    await client.end()
  }
}

interface SavedWebhook {
  readonly url: string
  readonly json: LineWebhookJson
}

async function main(): Promise<void> {
  const appEnv = process.env.APP_ENV ?? 'local'
  if (appEnv !== 'local') throw new SimulateStop(`ใช้ได้เฉพาะ APP_ENV=local (ตอนนี้ ${appEnv}) — บน staging ใช้แอป LINE จริง`)
  const parsed = parseSimulateArgs(process.argv.slice(2))
  if (!parsed.ok) throw new SimulateStop(parsed.problem)
  const args = parsed.args
  const secret = args.secret ?? process.env.LINE_MESSAGING_CHANNEL_SECRET?.trim() ?? ''
  if (!secret) throw new SimulateStop('ไม่มี LINE_MESSAGING_CHANNEL_SECRET ใน .env — ใส่ค่าเดียวกับที่บันทึกในหน้าตั้งค่า LINE หรือระบุ --secret')
  const stateFile = process.env.LINE_SIMULATE_STATE_FILE?.trim() || DEFAULT_STATE_FILE

  let saved: SavedWebhook
  if (args.kind === 'redeliver') {
    let last: SavedWebhook
    try {
      last = JSON.parse(await readFile(stateFile, 'utf8')) as SavedWebhook
    } catch {
      throw new SimulateStop('ยังไม่มี webhook ที่ส่งครั้งล่าสุด — ส่ง follow unfollow postback หรือ message ก่อน')
    }
    saved = { url: args.url ?? last.url, json: { ...last.json, events: last.json.events.map(redelivered) } }
  } else {
    const appUrl = process.env.APP_URL?.trim() || 'http://localhost:3000'
    const url = args.url ?? defaultWebhookUrl(appUrl, args.channelKey ?? (await channelKeyFromDatabase(args.org)))
    saved = { url, json: buildLineWebhook([eventFor(args)]).json }
  }
  const body = JSON.stringify(saved.json)
  let status: number
  try {
    status = (await postLineWebhook(saved.url, body, signLineWebhook(secret, body))).status
  } catch {
    throw new SimulateStop(`ส่งไป ${saved.url} ไม่ได้ — เปิดเว็บด้วย pnpm dev แล้วลองใหม่`)
  }
  await mkdir(path.dirname(stateFile), { recursive: true })
  await writeFile(stateFile, JSON.stringify(saved), 'utf8')
  const sent = saved.json.events.map((e) => `${e.type} ${e.webhookEventId}${e.deliveryContext.isRedelivery ? ' (ส่งซ้ำ)' : ''}`).join(', ')
  const meaning: Record<number, string> = { 200: 'รับแล้ว', 401: 'signature ไม่ตรงกับ channel secret ของแอป', 404: 'ไม่มี channel นี้', 413: 'body ใหญ่เกิน', 500: 'แอปบันทึกไม่ได้' }
  console.log(`ส่ง ${sent} ไป ${saved.url} → ${status}${meaning[status] ? ` ${meaning[status]}` : ''}`)
  if (status !== 200) process.exitCode = 1
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  await main().catch((error: unknown) => {
    // Only the kind of an unexpected error is printed: its text could quote a connection string or a value
    const code = (error as { code?: unknown } | null)?.code
    const kind = typeof code === 'string' ? code : error instanceof Error ? error.name : 'unknown'
    console.error(`line:simulate หยุด: ${error instanceof SimulateStop ? error.message : `เกิดข้อผิดพลาดที่ไม่คาดไว้ (${kind})`}`)
    process.exit(1)
  })
}
