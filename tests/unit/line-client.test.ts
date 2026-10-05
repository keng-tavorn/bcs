import { createServer, type IncomingHttpHeaders, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createLineClient, isLineApiError, LineApiError, type LineMessage, type LineRichMenu } from '@/integrations/line'
import { TEST_ACCESS_TOKEN, withFakeLine } from '../support/fake-line'

// The LINE Messaging API client (src/integrations/line) against the fake LINE server: the calls of the connection test,
// push and reply, rich menus through both LINE hosts, and every failure sorted into permanent (do not retry: bad token,
// bad request, refused) or transient (retry, then e-mail: LINE down, rate limit, no answer) with LINE's status and
// message but never the request body or the token. Building blocks of S5-04, S5-05 and S5-08: each describe names the
// rule it checks; the ACs of FR-LINE-* get their own tests with the features that use the client.

const line = withFakeLine()
const api = () => line.client.channel(TEST_ACCESS_TOKEN)
const text = (value: string): LineMessage => ({ type: 'text', text: value })
const PRIVATE_TEXT = 'ข้อความส่วนตัวของผู้ใช้ 0812345678'

async function failure(run: () => Promise<unknown>): Promise<LineApiError> {
  try {
    await run()
  } catch (error) {
    if (isLineApiError(error)) return error
    throw error
  }
  throw new Error('expected a LineApiError')
}

/** A server that accepts connections and never answers */
async function silentServer(): Promise<{ url: string; close: () => void; server: Server }> {
  const server = createServer(() => undefined)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return { url: `http://127.0.0.1:${port}`, server, close: () => (server.closeAllConnections(), server.close()) }
}

/** The smallest PNG the fake reads: the signature and an IHDR chunk with the size */
function png(width: number, height: number): Uint8Array {
  const bytes = Buffer.alloc(33)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes, 0)
  bytes.writeUInt32BE(13, 8)
  bytes.write('IHDR', 12, 'ascii')
  bytes.writeUInt32BE(width, 16)
  bytes.writeUInt32BE(height, 20)
  bytes[24] = 8
  bytes[25] = 2
  return new Uint8Array(bytes)
}

const LIFF = 'https://liff.line.me/1234567890-AbCdEfGh'
const unlinkedMenu: LineRichMenu = {
  size: { width: 2500, height: 843 },
  selected: true,
  name: 'BCS UNLINKED',
  chatBarText: 'เมนู BCS',
  areas: [
    { bounds: { x: 0, y: 0, width: 1250, height: 843 }, action: { type: 'uri', uri: `${LIFF}/link` } },
    { bounds: { x: 1250, y: 0, width: 1250, height: 843 }, action: { type: 'uri', uri: `${LIFF}/help` } },
  ],
}

describe('[FR-ADM-006/AC3] the client reads what the connection test checks', () => {
  it('reads the bot info with the channel access token', async () => {
    const bot = await api().getBotInfo()
    expect(bot).toMatchObject({ userId: line.fake.botUserId, basicId: '@bcs-fake', chatMode: 'bot' })
  })

  it('sets and reads the webhook endpoint, and asks LINE to test it', async () => {
    expect(await api().getWebhookEndpoint()).toEqual({ endpoint: '', active: false })
    await api().setWebhookEndpoint('http://127.0.0.1:9/api/webhooks/line/abc')
    expect(await api().getWebhookEndpoint()).toEqual({ endpoint: 'http://127.0.0.1:9/api/webhooks/line/abc', active: true })
    // Nothing listens on port 9: LINE reports that it could not connect, the call itself succeeds
    const test = await api().testWebhookEndpoint()
    expect(test).toMatchObject({ success: false, reason: 'COULD_NOT_CONNECT', statusCode: 0 })
    expect(typeof test.timestamp).toBe('string')
  })

  it('a token LINE does not accept is UNAUTHORIZED and permanent, with LINE status and words', async () => {
    const error = await failure(() => line.client.channel('not-the-token-of-this-channel').getBotInfo())
    expect(error).toMatchObject({ kind: 'permanent', reason: 'UNAUTHORIZED', status: 401, operation: 'botInfo' })
    expect(error.lineMessage).toMatch(/Authentication failed/)
    expect(error.requestId).toBeTruthy()
    expect(error.permanent).toBe(true)
  })
})

describe('[NFR-AVL-03] a failed send says whether trying again can help, and never carries the message or the token (NFR-SEC-09)', () => {
  it('pushes to a friend and records it at LINE', async () => {
    const before = line.fake.messages().length
    const sent = await api().pushMessage('U00000000000000000000000000000001', [text('งานอนุมัติใหม่')])
    expect(sent.sentMessages).toHaveLength(1)
    expect(sent.duplicate).toBe(false)
    expect(line.fake.messages().slice(before)).toMatchObject([{ kind: 'push', to: 'U00000000000000000000000000000001', messages: [{ type: 'text', text: 'งานอนุมัติใหม่' }] }])
  })

  // The fake answers 403 for "Ublocked…" ids; what real LINE answers a push to a user who blocked the OA is not confirmed
  // until D-03, so this proves how a 403 is sorted, not that a block shows up as one
  it('a refusal from LINE (403) is permanent: do not retry, fall back to e-mail', async () => {
    const error = await failure(() => api().pushMessage('Ublocked0000000000000000000000001', [text(PRIVATE_TEXT)]))
    expect(error).toMatchObject({ kind: 'permanent', reason: 'FORBIDDEN', status: 403, operation: 'push' })
    expect(error.lineMessage).toBeTruthy()
    for (const shown of [String(error), error.message, JSON.stringify(error)]) {
      expect(shown).not.toContain(PRIVATE_TEXT)
      expect(shown).not.toContain(TEST_ACCESS_TOKEN)
      expect(shown).not.toContain('Ublocked')
    }
  })

  it('LINE failing (5xx) is transient', async () => {
    const error = await failure(() => api().pushMessage('Udown00000000000000000000000000001', [text(PRIVATE_TEXT)]))
    expect(error).toMatchObject({ kind: 'transient', reason: 'SERVER_ERROR', status: 500 })
    expect(error.message).not.toContain(PRIVATE_TEXT)
  })

  it('a rate limit or quota (429) is transient', async () => {
    const limited = createLineClient({
      apiBaseUrl: 'https://api.line.test',
      dataApiBaseUrl: 'https://api-data.line.test',
      fetch: async () => Response.json({ message: 'You have reached your monthly limit.' }, { status: 429 }),
    })
    const error = await failure(() => limited.channel(TEST_ACCESS_TOKEN).pushMessage('U1', [text('x')]))
    expect(error).toMatchObject({ kind: 'transient', reason: 'RATE_LIMITED', status: 429, lineMessage: 'You have reached your monthly limit.' })
  })

  it('no connection, no answer in time and a call the caller gave up are transient', async () => {
    const closed = await silentServer()
    closed.close()
    const unreachable = createLineClient({ apiBaseUrl: closed.url, dataApiBaseUrl: closed.url })
    expect(await failure(() => unreachable.channel(TEST_ACCESS_TOKEN).getBotInfo())).toMatchObject({ kind: 'transient', reason: 'NETWORK', status: null })

    const silent = await silentServer()
    try {
      const client = createLineClient({ apiBaseUrl: silent.url, dataApiBaseUrl: silent.url })
      expect(await failure(() => client.channel(TEST_ACCESS_TOKEN).getBotInfo({ timeoutMs: 200 }))).toMatchObject({ kind: 'transient', reason: 'TIMEOUT' })
      const gaveUp = new AbortController()
      setTimeout(() => gaveUp.abort(), 50)
      expect(await failure(() => client.channel(TEST_ACCESS_TOKEN).getBotInfo({ signal: gaveUp.signal }))).toMatchObject({ kind: 'transient', reason: 'ABORTED' })
    } finally {
      silent.close()
    }
  })

  it('an answer that is not what LINE sends is transient BAD_RESPONSE', async () => {
    const odd = createLineClient({ apiBaseUrl: 'https://api.line.test', dataApiBaseUrl: 'https://api-data.line.test', fetch: async () => new Response('<html>proxy</html>', { status: 200 }) })
    expect(await failure(() => odd.channel(TEST_ACCESS_TOKEN).getBotInfo())).toMatchObject({ kind: 'transient', reason: 'BAD_RESPONSE', status: 200 })
  })

  it('a push retried with the same retry key goes out once (409 from LINE is a duplicate, not a failure)', async () => {
    const before = line.fake.messages().length
    const retryKey = '0198c6d2-1111-7000-8000-000000000001'
    const first = await api().pushMessage('U00000000000000000000000000000002', [text('a')], { retryKey })
    const again = await api().pushMessage('U00000000000000000000000000000002', [text('a')], { retryKey })
    expect(first.duplicate).toBe(false)
    expect(again.duplicate).toBe(true)
    expect(again.requestId).toBe(first.requestId)
    expect(again.sentMessages.map((m) => m.id)).toEqual(first.sentMessages.map((m) => m.id))
    expect(line.fake.messages().length - before).toBe(1)
    await expect(api().pushMessage('U1', [text('a')], { retryKey: 'not-a-uuid' })).rejects.toThrow(TypeError)
  })
})

describe('[BR-LINE-07] a reply token answers once', () => {
  it('replies with the reply token, and the same token again is refused as permanent', async () => {
    const sent = await api().replyMessage('reply-token-0001', [text('ตัดสินแล้ว')])
    expect(sent.sentMessages).toHaveLength(1)
    expect(line.fake.messages().at(-1)).toMatchObject({ kind: 'reply', replyToken: 'reply-token-0001', to: null })
    expect(await failure(() => api().replyMessage('reply-token-0001', [text('อีกครั้ง')]))).toMatchObject({ kind: 'permanent', reason: 'BAD_REQUEST', lineMessage: 'Invalid reply token' })
  })
})

describe("[BR-LINE-09] a message over LINE's limits is refused before anything is sent (§4.7 rule 5)", () => {
  it('refuses postback data over 300 characters as LIMIT_EXCEEDED and LINE receives nothing', async () => {
    const requests = line.fake.requests().length
    const card: LineMessage = {
      type: 'flex',
      altText: 'งานอนุมัติ',
      contents: { type: 'bubble', footer: { type: 'box', layout: 'vertical', contents: [{ type: 'button', action: { type: 'postback', label: 'อนุมัติ', data: 'd'.repeat(301) } }] } },
    }
    const error = await failure(() => api().pushMessage('U00000000000000000000000000000003', [card]))
    expect(error).toMatchObject({ kind: 'permanent', reason: 'LIMIT_EXCEEDED', status: null })
    expect(error.details).toEqual([{ message: 'POSTBACK_DATA: 301 > 300', property: 'messages[0].contents.footer.contents[0].action.data' }])
    expect(line.fake.requests()).toHaveLength(requests)
  })
})

describe('[§9.5] rich menus: created at LINE, image through the data API, switched per user', () => {
  it('creates, uploads, sets the default, links and unlinks a user, lists and deletes', async () => {
    // Route the data host to the fake as well, and remember which host each call went to
    const hosts: string[] = []
    const client = createLineClient({
      apiBaseUrl: line.fake.url,
      dataApiBaseUrl: 'http://api-data.line.test',
      fetch: async (input, init) => {
        const url = String(input)
        hosts.push(new URL(url).host)
        return fetch(url.replace('http://api-data.line.test', line.fake.url), init)
      },
    }).channel(TEST_ACCESS_TOKEN)

    const richMenuId = await client.createRichMenu(unlinkedMenu)
    expect(richMenuId).toMatch(/^richmenu-/)
    // A menu without its image cannot be applied (LINE: "must upload richmenu image before applying it to user")
    expect(await failure(() => client.setDefaultRichMenu(richMenuId))).toMatchObject({ kind: 'permanent', reason: 'BAD_REQUEST' })
    hosts.length = 0
    await client.uploadRichMenuImage(richMenuId, png(2500, 843), 'image/png')
    expect(hosts).toEqual(['api-data.line.test'])
    expect(await failure(() => client.uploadRichMenuImage(richMenuId, png(2500, 843), 'image/png'))).toMatchObject({ kind: 'permanent', status: 400 })

    await client.setDefaultRichMenu(richMenuId)
    expect(await client.getDefaultRichMenuId()).toBe(richMenuId)
    const user = 'U00000000000000000000000000000004'
    expect(await client.getUserRichMenuId(user)).toBeNull()
    await client.linkRichMenuToUser(user, richMenuId)
    expect(await client.getUserRichMenuId(user)).toBe(richMenuId)
    expect(line.fake.userRichMenu(user)).toBe(richMenuId)
    await client.unlinkRichMenuFromUser(user)
    expect(await client.getUserRichMenuId(user)).toBeNull()

    expect((await client.listRichMenus()).map((m) => [m.richMenuId, m.name, m.areas.length])).toContainEqual([richMenuId, 'BCS UNLINKED', 2])
    await client.deleteRichMenu(richMenuId)
    expect((await client.listRichMenus()).some((m) => m.richMenuId === richMenuId)).toBe(false)
    expect(await client.getDefaultRichMenuId()).toBeNull()
    // Only the two uploads went to the data host; everything else to the API host
    expect(hosts.filter((h) => h === 'api-data.line.test')).toHaveLength(2)
    expect(hosts.filter((h) => h !== 'api-data.line.test').every((h) => h === new URL(line.fake.url).host)).toBe(true)
  })

  it('refuses an image that does not match the menu size', async () => {
    const richMenuId = await api().createRichMenu(unlinkedMenu)
    expect(await failure(() => api().uploadRichMenuImage(richMenuId, png(2500, 1686), 'image/png'))).toMatchObject({ kind: 'permanent', status: 400 })
  })

  it('refuses, before any request, a user id or menu id that would reach another endpoint ("all" is every user)', async () => {
    const richMenuId = await api().createRichMenu(unlinkedMenu)
    await api().uploadRichMenuImage(richMenuId, png(2500, 843), 'image/png')
    const requests = line.fake.requests().length
    // "all" would set or cancel the default menu of every user; "." and ".." are resolved by the URL parser
    for (const userId of ['all', '.', '..', '../all', 'U../all', 'U1/richmenu', 'U1?x=1', 'U1%2F', 'Cgroup0001', '']) {
      await expect(api().linkRichMenuToUser(userId, richMenuId), userId).rejects.toThrow(TypeError)
      await expect(api().unlinkRichMenuFromUser(userId), userId).rejects.toThrow(TypeError)
      await expect(api().getUserRichMenuId(userId), userId).rejects.toThrow(TypeError)
    }
    for (const menuId of ['..', '.', 'all', 'richmenu-../list', 'richmenu-', `${richMenuId}/content`, '']) {
      await expect(api().deleteRichMenu(menuId), menuId).rejects.toThrow(TypeError)
      await expect(api().setDefaultRichMenu(menuId), menuId).rejects.toThrow(TypeError)
      await expect(api().linkRichMenuToUser('U00000000000000000000000000000005', menuId), menuId).rejects.toThrow(TypeError)
      await expect(api().uploadRichMenuImage(menuId, png(2500, 843), 'image/png'), menuId).rejects.toThrow(TypeError)
    }
    expect(line.fake.requests()).toHaveLength(requests)
    expect(line.fake.defaultRichMenu()).not.toBe(richMenuId)
    // The error names what was wrong, never the value (a LINE user id is personal data)
    await expect(api().linkRichMenuToUser('Usecret/../all', richMenuId)).rejects.toThrow(/^the LINE user id is not an id LINE makes$/)
    // LINE's own ids, and the fake's test ids, pass
    await api().linkRichMenuToUser('U0123456789abcdef0123456789abcdef', richMenuId)
    await api().linkRichMenuToUser('Ublocked0000000000000000000000001', richMenuId)
    expect(line.fake.userRichMenu('U0123456789abcdef0123456789abcdef')).toBe(richMenuId)
  })
})

describe('[NFR-SEC-07] the channel access token, a secret of the organization, goes to the LINE hosts it was given and nowhere else', () => {
  let target: Server
  let redirector: Server
  const seen: IncomingHttpHeaders[] = []
  let redirectUrl = ''
  beforeAll(async () => {
    target = createServer((req, res) => {
      seen.push(req.headers)
      res.end('{}')
    })
    await new Promise<void>((resolve) => target.listen(0, '127.0.0.1', resolve))
    const targetUrl = `http://127.0.0.1:${(target.address() as AddressInfo).port}`
    redirector = createServer((req, res) => {
      res.writeHead(302, { location: `${targetUrl}${req.url ?? '/'}` })
      res.end()
    })
    await new Promise<void>((resolve) => redirector.listen(0, '127.0.0.1', resolve))
    redirectUrl = `http://127.0.0.1:${(redirector.address() as AddressInfo).port}`
  })
  afterAll(() => {
    for (const s of [target, redirector]) {
      s.closeAllConnections()
      s.close()
    }
  })

  it('refuses to follow a redirect, so the token never reaches the other host', async () => {
    const client = createLineClient({ apiBaseUrl: redirectUrl, dataApiBaseUrl: redirectUrl })
    expect(await failure(() => client.channel(TEST_ACCESS_TOKEN).getBotInfo())).toMatchObject({ kind: 'transient', reason: 'NETWORK' })
    expect(seen).toEqual([])
  })

  it('needs a token to talk to LINE at all, and a recipient or reply token to send', async () => {
    expect(() => line.client.channel('  ')).toThrow(TypeError)
    const requests = line.fake.requests().length
    await expect(api().pushMessage('', [text('x')])).rejects.toThrow(TypeError)
    await expect(api().replyMessage('', [text('x')])).rejects.toThrow(TypeError)
    expect(line.fake.requests()).toHaveLength(requests)
  })
})
