import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { isValidLineSignature, lineSignature } from '@/integrations/line'
import { imageSize, startFakeLine, type FakeLine } from '../../scripts/lib/fake-line'
import { TEST_ACCESS_TOKEN, TEST_CHANNEL_SECRET } from '../support/fake-line'

// The fake LINE server (scripts/lib/fake-line.ts) that local development, the integration tests and e2e use instead of
// LINE: it must behave like LINE where BCS depends on it — the verify endpoint accepts only ID tokens it issued, with
// LINE's errors; the webhook test is signed like LINE signs webhooks; pushes to "Ublocked…" and "Udown…" fail on
// purpose; LINE's limits are enforced on their own. It listens on this machine only. A test tool: each describe names
// the rule the fake stands in for, not an AC of the features that will use it.

let fake: FakeLine
beforeAll(async () => {
  fake = await startFakeLine({ port: 0, channelSecret: TEST_CHANNEL_SECRET, accessToken: TEST_ACCESS_TOKEN, webhookTimeoutMs: 300 })
})
afterAll(async () => {
  await fake.close()
})

const LIFF_CHANNEL = '2000000001'
const USER = 'U0123456789abcdef0123456789abcdef'

async function verify(form: Record<string, string>) {
  const res = await fetch(`${fake.url}/oauth2/v2.1/verify`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(form) })
  return { status: res.status, body: (await res.json()) as Record<string, unknown> }
}

const bot = (path: string, init: RequestInit = {}) =>
  fetch(`${fake.url}${path}`, { ...init, headers: { authorization: `Bearer ${TEST_ACCESS_TOKEN}`, 'content-type': 'application/json', ...init.headers } })
const push = (to: string, messages: unknown) => bot('/v2/bot/message/push', { method: 'POST', body: JSON.stringify({ to, messages }) })

describe("[BR-LINE-02] the fake verifies only the ID tokens it issued, with LINE's answers", () => {
  it('accepts its own token for the right channel and returns the claims LINE returns', async () => {
    const idToken = fake.issueIdToken({ sub: USER, aud: LIFF_CHANNEL, name: 'สมชาย' })
    const r = await verify({ id_token: idToken, client_id: LIFF_CHANNEL })
    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({ iss: 'https://access.line.me', sub: USER, aud: LIFF_CHANNEL, name: 'สมชาย' })
    expect(r.body.exp).toBeGreaterThan(Date.now() / 1000)
  })

  it('refuses a forged, an expired and a wrong-audience token, and checks nonce and user_id when sent', async () => {
    const good = fake.issueIdToken({ sub: USER, aud: LIFF_CHANNEL, nonce: 'n-1' })
    const [header, body] = good.split('.')
    const forgedBody = Buffer.from(JSON.stringify({ iss: 'https://access.line.me', sub: 'Uattacker', aud: LIFF_CHANNEL, exp: 4102444800 })).toString('base64url')
    const cases: Array<[string, Record<string, string>, string]> = [
      ['unknown', { id_token: 'eyJhbGciOiJIUzI1NiJ9.e30.c2lnbmF0dXJl', client_id: LIFF_CHANNEL }, 'Invalid IdToken.'],
      ['changed payload', { id_token: `${header}.${forgedBody}.${good.split('.')[2]}`, client_id: LIFF_CHANNEL }, 'Invalid IdToken.'],
      ['not a JWT', { id_token: `${header}.${body}`, client_id: LIFF_CHANNEL }, 'Invalid IdToken.'],
      ['expired', { id_token: fake.issueIdToken({ sub: USER, aud: LIFF_CHANNEL, expiresInSeconds: -5 }), client_id: LIFF_CHANNEL }, 'IdToken expired.'],
      ['wrong audience', { id_token: good, client_id: '1999999999' }, 'Invalid IdToken Audience.'],
      ['wrong nonce', { id_token: good, client_id: LIFF_CHANNEL, nonce: 'n-2' }, 'Invalid IdToken Nonce.'],
      ['wrong user', { id_token: good, client_id: LIFF_CHANNEL, user_id: 'U-other' }, 'Invalid IdToken Subject Identifier.'],
    ]
    for (const [name, form, description] of cases) {
      const r = await verify(form)
      expect(r, name).toEqual({ status: 400, body: { error: 'invalid_request', error_description: description } })
    }
    // A token of another fake (another key) is unknown here
    const other = await startFakeLine({ port: 0, channelSecret: TEST_CHANNEL_SECRET })
    try {
      const r = await verify({ id_token: other.issueIdToken({ sub: USER, aud: LIFF_CHANNEL }), client_id: LIFF_CHANNEL })
      expect(r.body.error_description).toBe('Invalid IdToken.')
    } finally {
      await other.close()
    }
  })

  it('issues tokens over HTTP for e2e (LIFF_MOCK) and pnpm line:simulate', async () => {
    const res = await fetch(`${fake.url}/__fake/id-token`, { method: 'POST', body: JSON.stringify({ sub: USER, aud: LIFF_CHANNEL, expiresInSeconds: 60 }) })
    const { idToken } = (await res.json()) as { idToken: string }
    expect((await verify({ id_token: idToken, client_id: LIFF_CHANNEL })).status).toBe(200)
  })
})

describe('[FR-ADM-006/AC3] the fake tests a webhook URL the way LINE does: a signed webhook, then the answer', () => {
  let receiver: Server
  let receiverUrl = ''
  const received: Array<{ body: string; valid: boolean; agent: string | undefined }> = []
  let answer = 200
  let delayMs = 0
  beforeAll(async () => {
    receiver = createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (c: Buffer) => chunks.push(c))
      req.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8')
        const signature = req.headers['x-line-signature']
        received.push({ body, valid: isValidLineSignature(TEST_CHANNEL_SECRET, body, typeof signature === 'string' ? signature : null), agent: req.headers['user-agent'] })
        setTimeout(() => {
          res.statusCode = answer
          res.end()
        }, delayMs)
      })
    })
    await new Promise<void>((resolve) => receiver.listen(0, '127.0.0.1', resolve))
    receiverUrl = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}/api/webhooks/line/key`
  })
  afterAll(() => {
    receiver.closeAllConnections()
    receiver.close()
  })

  async function test(endpoint?: string) {
    const res = await bot('/v2/bot/channel/webhook/test', { method: 'POST', body: JSON.stringify(endpoint === undefined ? {} : { endpoint }) })
    return { status: res.status, body: (await res.json()) as Record<string, unknown> }
  }

  it('signs `{"destination":…,"events":[]}` with the channel secret (x-line-signature) and reports OK', async () => {
    answer = 200
    const r = await test(receiverUrl)
    expect(r).toMatchObject({ status: 200, body: { success: true, statusCode: 200, reason: 'OK', detail: '200' } })
    const last = received.at(-1)!
    expect(JSON.parse(last.body)).toEqual({ destination: fake.botUserId, events: [] })
    expect(last.valid).toBe(true)
    expect(last.agent).toBe('LineBotWebhook/2.0')
  })

  it('reports the endpoint status, no connection and no answer in time like LINE', async () => {
    answer = 401
    expect((await test(receiverUrl)).body).toMatchObject({ success: false, reason: 'ERROR_STATUS_CODE', statusCode: 401 })
    answer = 200
    delayMs = 1000
    expect((await test(receiverUrl)).body).toMatchObject({ success: false, reason: 'REQUEST_TIMEOUT', statusCode: 0 })
    delayMs = 0
    expect((await test('http://127.0.0.1:9/api/webhooks/line/key')).body).toMatchObject({ success: false, reason: 'COULD_NOT_CONNECT', statusCode: 0 })
  })

  it('tests the registered URL when none is given, and refuses when none is set', async () => {
    fake.setWebhook('', false)
    expect((await test()).status).toBe(400)
    fake.setWebhook(receiverUrl, true)
    expect((await test()).body).toMatchObject({ success: true })
    expect(fake.webhookDeliveries().at(-1)).toMatchObject({ endpoint: receiverUrl, success: true })
  })

  it('delivers to where a test maps the public URL, and reports the URL as given, as LINE resolves it on the internet', async () => {
    const publicUrl = 'https://bcs.example.com/api/webhooks/line/key'
    const routed = await startFakeLine({ port: 0, channelSecret: TEST_CHANNEL_SECRET, webhookTarget: (endpoint) => endpoint.replace('https://bcs.example.com', receiverUrl.replace('/api/webhooks/line/key', '')) })
    try {
      answer = 200
      const before = received.length
      const res = await fetch(`${routed.url}/v2/bot/channel/webhook/test`, { method: 'POST', headers: { authorization: 'Bearer any', 'content-type': 'application/json' }, body: JSON.stringify({ endpoint: publicUrl }) })
      expect(await res.json()).toMatchObject({ success: true, statusCode: 200 })
      expect(received).toHaveLength(before + 1)
      expect(received.at(-1)!.valid).toBe(true)
      expect(routed.webhookDeliveries()).toEqual([{ endpoint: publicUrl, success: true, statusCode: 200, reason: 'OK' }])
    } finally {
      await routed.close()
    }
  })
})

// The 403 is a stand-in: what real LINE answers a push to a user who blocked the OA is not confirmed until D-03
describe('[NFR-AVL-03] the fake fails on purpose for "Ublocked…" (403) and "Udown…" (500) recipients, so the e-mail fallback can be tested', () => {
  it('answers 403 for "Ublocked…", 500 for "Udown…" and records neither', async () => {
    const before = fake.messages().length
    expect((await push('Ublocked01', [{ type: 'text', text: 'x' }])).status).toBe(403)
    expect((await push('Udown01', [{ type: 'text', text: 'x' }])).status).toBe(500)
    expect(fake.messages()).toHaveLength(before)
  })
})

describe("[BR-LINE-09] the fake answers the Messaging API like LINE (LINE's limits on their own, the access token), keeps what was sent and listens on this machine only", () => {
  it('refuses with LINE error shape: an altText over 400, postback data over 300, 6 messages, a missing token', async () => {
    const flex = (altText: string, data = 'v=1') => ({ type: 'flex', altText, contents: { type: 'bubble', footer: { type: 'box', layout: 'vertical', contents: [{ type: 'button', action: { type: 'postback', label: 'ok', data } }] } } })
    const longAlt = await push(USER, [flex('a'.repeat(401))])
    expect(longAlt.status).toBe(400)
    expect(await longAlt.json()).toEqual({ message: 'The request body has 1 error(s)', details: [{ message: 'Length must be between 1 and 400', property: 'messages[0].altText' }] })
    const longData = (await (await push(USER, [flex('ok', 'd'.repeat(301))])).json()) as { details: Array<{ property: string }> }
    expect(longData.details.map((d) => d.property)).toEqual(['messages[0].contents.footer.contents[0].action.data'])
    expect((await push(USER, Array.from({ length: 6 }, () => ({ type: 'text', text: 'x' })))).status).toBe(400)
    const noToken = await fetch(`${fake.url}/v2/bot/info`)
    expect(noToken.status).toBe(401)
    const wrongToken = await fetch(`${fake.url}/v2/bot/info`, { headers: { authorization: 'Bearer another-token' } })
    expect(((await wrongToken.json()) as { message: string }).message).toMatch(/Authentication failed/)
  })

  it('keeps what was sent for tests, and reset forgets it', async () => {
    expect((await push(USER, [{ type: 'text', text: 'เก็บไว้' }])).status).toBe(200)
    const listed = (await (await fetch(`${fake.url}/__fake/messages`)).json()) as { messages: Array<{ to: string }> }
    expect(listed.messages.at(-1)).toMatchObject({ to: USER })
    fake.reset()
    expect(fake.messages()).toEqual([])
    expect(fake.webhook()).toEqual({ endpoint: '', active: false })
  })

  it('listens on this machine only', () => {
    expect(new URL(fake.url).hostname).toBe('127.0.0.1')
  })
})

describe('[§9.5] the fake reads the size of rich menu images as LINE checks it (2500 × 843)', () => {
  it('reads PNG and JPEG sizes and nothing else', () => {
    const png = Buffer.alloc(33)
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png, 0)
    png.writeUInt32BE(2500, 16)
    png.writeUInt32BE(843, 20)
    expect(imageSize(png)).toEqual({ width: 2500, height: 843 })
    // SOI, an APP0 segment of 16 bytes, then SOF0 with height 843 and width 2500
    const jpeg = Buffer.concat([
      Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]),
      Buffer.alloc(14),
      Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, 0x03, 0x4b, 0x09, 0xc4, 0x03]),
      Buffer.alloc(12),
    ])
    expect(imageSize(jpeg)).toEqual({ width: 2500, height: 843 })
    expect(imageSize(Buffer.from('GIF89a........'))).toBeNull()
  })
})

describe('[BR-LINE-03] x-line-signature is base64 HMAC-SHA256 of the raw body with the channel secret', () => {
  it('accepts the exact signature only, in constant time on the raw bytes', () => {
    const body = '{"destination":"U1","events":[]}'
    const signature = lineSignature(TEST_CHANNEL_SECRET, body)
    expect(isValidLineSignature(TEST_CHANNEL_SECRET, body, signature)).toBe(true)
    expect(isValidLineSignature(TEST_CHANNEL_SECRET, Buffer.from(body), signature)).toBe(true)
    expect(isValidLineSignature(TEST_CHANNEL_SECRET, `${body} `, signature)).toBe(false)
    expect(isValidLineSignature('ffffffffffffffffffffffffffffffff', body, signature)).toBe(false)
    for (const header of [null, undefined, '', 'abc', `${signature}=`, signature.replace(/.$/, '')]) {
      expect(isValidLineSignature(TEST_CHANNEL_SECRET, body, header), String(header)).toBe(false)
    }
    expect(() => lineSignature('', body)).toThrow(TypeError)
  })
})
