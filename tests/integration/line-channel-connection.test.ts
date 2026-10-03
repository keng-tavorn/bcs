import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import path from 'node:path'
import { createTranslator, type AbstractIntlMessages } from 'next-intl'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createLineClient, isValidLineSignature, type LineClient, type LineRichMenu, setLineClient } from '@/integrations/line'
import { getEnv } from '@/lib/env'
import { STORED_ROLES } from '@/server/authz/permissions'
import { makeCtx, systemCtx, type Ctx } from '@/server/context'
import { prisma } from '@/server/db/client'
import { lineWebhookUrl } from '@/server/queries/line-channel'
import {
  LINE_CHECK_REASONS,
  LINE_CONNECTION_CHECKS,
  openLineChannel,
  saveLineChannelSettings,
  testLineConnection,
  type LineConnectionCheck,
  type LineConnectionCheckId,
  type LineConnectionReport,
} from '@/server/services/line-channel'
import { createMember, createOrg } from '../support/factory'
import { TEST_ACCESS_TOKEN, TEST_CHANNEL_SECRET, withFakeLine } from '../support/fake-line'

// S5-01 · FR-ADM-006 AC3: the "test connection" button checks that LINE accepts the access token, that the webhook URL
// at LINE is APP_URL/api/webhooks/line/<channelKey> with "Use webhook" on, that LINE can reach it (LINE's own test
// webhook, signed with the channel secret), that the LIFF ID is set and is this environment's LIFF app, and that both
// rich menus exist — PASS or FAIL for each with what to do. Run against the fake LINE server. LINE reaches APP_URL on the
// internet; here the fake delivers APP_URL to a stand-in of the webhook route that checks the signature with the secret
// saved in BCS, as the real route does (BR-LINE-03). Every reason of every check is produced by a case of its own.

// The LIFF app of this test environment (ADR-024: one per environment). Set before any module reads the environment
// (getEnv() keeps what it read first), and put back after this file.
const ENV_LIFF = vi.hoisted(() => {
  const before = { NEXT_PUBLIC_LIFF_ID: process.env.NEXT_PUBLIC_LIFF_ID, LINE_LIFF_CHANNEL_ID: process.env.LINE_LIFF_CHANNEL_ID }
  const values = { liffId: '1650000003-AbCdEfGh', liffChannelId: '1650000003' }
  process.env.NEXT_PUBLIC_LIFF_ID = values.liffId
  process.env.LINE_LIFF_CHANNEL_ID = values.liffChannelId
  return { ...values, before }
})
afterAll(() => {
  for (const [name, value] of Object.entries(ENV_LIFF.before)) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
})

const NOW = new Date('2026-10-05T03:00:00Z')
const key = () => ({ idempotencyKey: randomUUID(), sender: null })
const OTHER_SECRET = 'fedcba9876543210fedcba9876543210'
const OTHER_TOKEN = 'test-only-other-channel-access-token-2222222222'
const SECRETS = [TEST_CHANNEL_SECRET, TEST_ACCESS_TOKEN, OTHER_SECRET, OTHER_TOKEN]
const VALID = {
  providerId: '1650000001',
  messagingChannelId: '1650000002',
  channelSecret: TEST_CHANNEL_SECRET,
  channelAccessToken: TEST_ACCESS_TOKEN,
  liffId: ENV_LIFF.liffId,
  liffChannelId: ENV_LIFF.liffChannelId,
  active: true,
}

// The app's webhook route, standing in for /api/webhooks/line/[channelKey] (S5-02): 404 for an unknown key, 401 for a
// signature made with another secret than the one saved, 200 otherwise (after `delayMs`). A `closed` route is delivered
// to a port where nothing listens.
interface Route {
  readonly orgId: string
  readonly delayMs: number
  readonly closed: boolean
}
const routes = new Map<string, Route>()
let receiver: Server
let receiverOrigin = ''
let closedOrigin = ''

const line = withFakeLine({
  webhookTimeoutMs: 400,
  webhookTarget: (endpoint) => {
    const url = new URL(endpoint)
    if (url.origin !== new URL(getEnv().APP_URL).origin) return endpoint
    const channelKey = decodeURIComponent(url.pathname.split('/').at(-1) ?? '')
    return `${routes.get(channelKey)?.closed ? closedOrigin : receiverOrigin}${url.pathname}`
  },
})

beforeAll(async () => {
  receiver = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      void (async () => {
        const match = /^\/api\/webhooks\/line\/([^/?]+)$/.exec(req.url ?? '')
        const route = match ? routes.get(decodeURIComponent(match[1]!)) : undefined
        if (!route) {
          res.statusCode = 404
          res.end()
          return
        }
        const opened = await openLineChannel(route.orgId)
        const header = req.headers['x-line-signature']
        const valid = opened.ok && isValidLineSignature(opened.channel.channelSecret, Buffer.concat(chunks), typeof header === 'string' ? header : null)
        setTimeout(() => {
          res.statusCode = valid ? 200 : 401
          res.end()
        }, route.delayMs)
      })()
    })
  })
  await new Promise<void>((resolve) => receiver.listen(0, '127.0.0.1', resolve))
  receiverOrigin = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}`
  const closed = createServer()
  await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve))
  closedOrigin = `http://127.0.0.1:${(closed.address() as AddressInfo).port}`
  await new Promise<void>((resolve) => closed.close(() => resolve()))
})
afterAll(() => {
  receiver.closeAllConnections()
  receiver.close()
})

const menu = (name: string): LineRichMenu => ({
  size: { width: 2500, height: 843 },
  selected: true,
  name,
  chatBarText: 'เมนู',
  areas: [{ bounds: { x: 0, y: 0, width: 2500, height: 843 }, action: { type: 'uri', uri: `https://liff.line.me/${ENV_LIFF.liffId}/help` } }],
})

interface Setup {
  readonly orgId: string
  readonly admin: Ctx
  readonly ctxOf: (memberId: string) => Ctx
  readonly channelKey: string
  /** APP_URL/api/webhooks/line/<channelKey> */
  readonly expected: string
}

/** An organization whose ORG_ADMIN saved `values`; the stand-in route knows its channel key */
async function configured(values: Partial<typeof VALID> = {}, route: Partial<Omit<Route, 'orgId'>> = {}): Promise<Setup> {
  const org = await createOrg()
  const admin = await createMember(org.id, 'ผู้ดูแล')
  await prisma.roleAssignment.create({ data: { organizationId: org.id, memberId: admin.id, role: 'ORG_ADMIN', grantedAt: NOW } })
  const ctxOf = (memberId: string) => makeCtx({ organizationId: org.id, actor: { type: 'USER', memberId }, channel: 'WEB', now: NOW })
  const saved = await saveLineChannelSettings(ctxOf(admin.id), { ...VALID, ...values }, key())
  if (!saved.ok) throw new Error(`settings refused: ${saved.error.code}`)
  routes.set(saved.data.channelKey, { orgId: org.id, delayMs: route.delayMs ?? 0, closed: route.closed ?? false })
  return { orgId: org.id, admin: ctxOf(admin.id), ctxOf, channelKey: saved.data.channelKey, expected: lineWebhookUrl(getEnv().APP_URL, saved.data.channelKey) }
}

/** A channel set up right: saved, its webhook URL registered at the fake LINE with "Use webhook" on */
async function ready(values: Partial<typeof VALID> = {}, route: Partial<Omit<Route, 'orgId'>> = {}): Promise<Setup> {
  const setup = await configured(values, route)
  line.fake.setWebhook(setup.expected, true)
  return setup
}

/** Both rich menus made at the fake LINE and stored on the channel, as pnpm line:richmenu will (S5-04) */
async function withRichMenus(setup: Setup): Promise<{ linked: string; unlinked: string }> {
  const api = line.client.channel(TEST_ACCESS_TOKEN)
  const unlinked = await api.createRichMenu(menu('BCS UNLINKED'))
  const linked = await api.createRichMenu(menu('BCS LINKED'))
  await prisma.lineChannelConfig.update({ where: { organizationId: setup.orgId }, data: { richMenuLinkedId: linked, richMenuUnlinkedId: unlinked } })
  return { linked, unlinked }
}

type Answer = (init: RequestInit | undefined) => Response | Promise<Response>
/** LINE answering some calls ("METHOD /path") as given, and every other call as the fake does */
function lineAnswering(answers: Readonly<Record<string, Answer>>): LineClient {
  return createLineClient({
    apiBaseUrl: line.fake.url,
    dataApiBaseUrl: line.fake.url,
    fetch: async (input, init) => {
      const answer = answers[`${init?.method ?? 'GET'} ${new URL(String(input)).pathname}`]
      return answer ? answer(init) : fetch(input, init)
    },
  })
}
const lineError =
  (status: number, message: string): Answer =>
  () =>
    Response.json({ message }, { status, headers: { 'x-line-request-id': randomUUID() } })
/** A call LINE never answers: it ends only when the caller gives up */
const hang: Answer = (init) =>
  new Promise<Response>((_resolve, reject) => {
    const signal = init?.signal
    if (!signal) return
    signal.addEventListener('abort', () => reject(signal.reason as Error), { once: true })
  })

type Checks = Record<LineConnectionCheckId, LineConnectionCheck>
async function run(setup: Setup, options: { client?: LineClient; budgetMs?: number; ctx?: Ctx } = {}): Promise<{ report: LineConnectionReport; checks: Checks }> {
  setLineClient(options.client ?? line.client)
  try {
    const result = await testLineConnection(options.ctx ?? setup.admin, options.budgetMs === undefined ? {} : { budgetMs: options.budgetMs })
    if (!result.ok) throw new Error(`connection test refused: ${result.error.code}`)
    expect(result.data.checks.map((c) => c.id)).toEqual([...LINE_CONNECTION_CHECKS])
    expect(result.data.webhookUrl).toBe(setup.expected)
    const text = JSON.stringify(result.data)
    for (const secret of SECRETS) expect(text).not.toContain(secret)
    return { report: result.data, checks: Object.fromEntries(result.data.checks.map((c) => [c.id, c])) as Checks }
  } finally {
    setLineClient(line.client)
  }
}
const outcome = (check: LineConnectionCheck) => [check.status, check.reason]

// ---- the messages, in Thai and English, formatted the way the screen will (next-intl) ----
const bundle = (locale: 'th' | 'en') => JSON.parse(readFileSync(path.join(import.meta.dirname, '..', '..', 'messages', `${locale}.json`), 'utf8')) as AbstractIntlMessages
const BUNDLES = { th: bundle('th'), en: bundle('en') }

/** The text the screen shows for a check, and every problem next-intl had formatting it (a missing value, bad syntax) */
function shown(locale: 'th' | 'en', check: LineConnectionCheck): { text: string; problems: string[] } {
  const problems: string[] = []
  const translate = createTranslator({ locale, messages: BUNDLES[locale], namespace: 'lineSettings', onError: (error) => problems.push(error.message) }) as unknown as (
    key: string,
    values: Record<string, string | number>,
  ) => string
  return { text: translate(check.messageKey, { ...check.params }), problems }
}

function expectWords(check: LineConnectionCheck): void {
  for (const locale of ['th', 'en'] as const) {
    const { text, problems } = shown(locale, check)
    expect(problems, `${locale} ${check.messageKey}`).toEqual([])
    expect(text, `${locale} ${check.messageKey}`).not.toMatch(/[{}]/)
    expect(text, `${locale} ${check.messageKey}`).not.toContain(`lineSettings.${check.messageKey}`)
    for (const secret of SECRETS) expect(text).not.toContain(secret)
  }
}

// ---- one case per reason of every check: how to get it, and the values its message gets ----
interface Case {
  readonly setup: Setup
  readonly client?: LineClient
  readonly params: Record<string, string | number>
}

const WEBHOOK_TEST = 'POST /v2/bot/channel/webhook/test'
const WEBHOOK_ENDPOINT = 'GET /v2/bot/channel/webhook/endpoint'
const RICH_MENU_LIST = 'GET /v2/bot/richmenu/list'
const BOT_INFO = 'GET /v2/bot/info'
const OTHER_LIFF = { liffId: '1650000088-Other', liffChannelId: '1650000088' }

/** A channel whose access token LINE refuses, with both rich menus stored */
async function tokenRefused(): Promise<Setup> {
  const setup = await configured({ channelAccessToken: OTHER_TOKEN })
  await withRichMenus(setup)
  return setup
}

const CASES: { readonly [C in LineConnectionCheckId]: Partial<Record<(typeof LINE_CHECK_REASONS)[C][number], () => Promise<Case>>> } = {
  accessToken: {
    ok: async () => ({ setup: await ready(), params: { botName: 'BCS (fake LINE)', basicId: '@bcs-fake' } }),
    tokenUnreadable: async () => {
      // A sealed token copied from another organization does not open here (ENCRYPTION_KEY changed or tampering alike)
      const setup = await ready()
      const other = await configured()
      const otherRow = await prisma.lineChannelConfig.findUniqueOrThrow({ where: { organizationId: other.orgId } })
      await prisma.lineChannelConfig.update({ where: { organizationId: setup.orgId }, data: { channelAccessTokenEnc: otherRow.channelAccessTokenEnc } })
      return { setup, params: {} }
    },
    unauthorized: async () => ({ setup: await configured({ channelAccessToken: OTHER_TOKEN }), params: {} }),
    forbidden: async () => ({ setup: await ready(), client: lineAnswering({ [BOT_INFO]: lineError(403, 'Access to this API is not available for your account') }), params: {} }),
    unreachable: async () => ({ setup: await ready(), client: lineAnswering({ [BOT_INFO]: lineError(503, 'Service Unavailable') }), params: { cause: 503 } }),
    rejected: async () => ({ setup: await ready(), client: lineAnswering({ [BOT_INFO]: lineError(400, 'Invalid request') }), params: { status: 400, detail: 'Invalid request' } }),
  },
  webhookUrl: {
    ok: async () => {
      const setup = await ready()
      return { setup, params: { expected: setup.expected } }
    },
    needsAccessToken: async () => {
      const setup = await tokenRefused()
      return { setup, params: { expected: setup.expected } }
    },
    notSet: async () => {
      const setup = await configured()
      line.fake.setWebhook('', false)
      return { setup, params: { expected: setup.expected } }
    },
    mismatch: async () => {
      const setup = await configured()
      line.fake.setWebhook('https://old-bcs.example.com/api/webhooks/line/old', true)
      return { setup, params: { expected: setup.expected, registered: 'https://old-bcs.example.com/api/webhooks/line/old' } }
    },
    inactive: async () => {
      const setup = await configured()
      line.fake.setWebhook(setup.expected, false)
      return { setup, params: { expected: setup.expected } }
    },
    unreachable: async () => {
      const setup = await ready()
      return { setup, client: lineAnswering({ [WEBHOOK_ENDPOINT]: lineError(500, 'Internal Server Error') }), params: { cause: 500, expected: setup.expected } }
    },
    rejected: async () => {
      const setup = await ready()
      return { setup, client: lineAnswering({ [WEBHOOK_ENDPOINT]: lineError(403, 'Not allowed') }), params: { status: 403, detail: 'Not allowed', expected: setup.expected } }
    },
  },
  webhookReachable: {
    ok: async () => {
      const setup = await ready()
      return { setup, params: { expected: setup.expected } }
    },
    needsAccessToken: async () => {
      const setup = await tokenRefused()
      return { setup, params: { expected: setup.expected } }
    },
    couldNotConnect: async () => {
      const setup = await ready({}, { closed: true })
      return { setup, params: { expected: setup.expected } }
    },
    timeout: async () => {
      // The route answers after 1.5 s; LINE (the fake) waits 400 ms
      const setup = await ready({}, { delayMs: 1500 })
      return { setup, params: { expected: setup.expected } }
    },
    signatureRefused: async () => {
      // The secret saved in BCS is not the one LINE signs with: our route answers 401 (BR-LINE-03)
      const setup = await ready({ channelSecret: OTHER_SECRET })
      return { setup, params: { expected: setup.expected } }
    },
    errorStatus: async () => {
      const setup = await ready()
      routes.delete(setup.channelKey)
      return { setup, params: { expected: setup.expected, statusCode: 404 } }
    },
    unclassified: async () => {
      const setup = await ready()
      const answer: Answer = () => Response.json({ success: false, timestamp: NOW.toISOString(), statusCode: 0, reason: 'UNCLASSIFIED', detail: 'unexpected error' })
      return { setup, client: lineAnswering({ [WEBHOOK_TEST]: answer }), params: { expected: setup.expected, detail: 'unexpected error' } }
    },
    unreachable: async () => {
      const setup = await ready()
      return { setup, client: lineAnswering({ [WEBHOOK_TEST]: lineError(502, 'Bad Gateway') }), params: { cause: 502, expected: setup.expected } }
    },
    rejected: async () => {
      const setup = await ready()
      return {
        setup,
        client: lineAnswering({ [WEBHOOK_TEST]: lineError(400, 'Invalid webhook endpoint URL') }),
        params: { status: 400, detail: 'Invalid webhook endpoint URL', expected: setup.expected },
      }
    },
  },
  liffId: {
    ok: async () => ({ setup: await ready(), params: { liffId: ENV_LIFF.liffId } }),
    notSet: async () => ({ setup: await ready({ liffId: '', liffChannelId: '' }), params: {} }),
    channelNotSet: async () => ({ setup: await ready({ liffChannelId: '' }), params: { liffId: ENV_LIFF.liffId } }),
    channelMismatch: async () => ({ setup: await ready({ liffChannelId: '1650000077' }), params: { liffId: ENV_LIFF.liffId, liffChannelId: '1650000077' } }),
    // envNotSet needs an environment without a LIFF app: tests/integration/line-channel-connection-env.test.ts
    envMismatch: async () => ({
      // A consistent pair, but not the LIFF app this environment runs: LIFF sign-in would fail (ADR-024)
      setup: await ready(OTHER_LIFF),
      params: { ...OTHER_LIFF, envLiffId: ENV_LIFF.liffId, envLiffChannelId: ENV_LIFF.liffChannelId },
    }),
  },
  richMenus: {
    ok: async () => {
      const setup = await ready()
      await withRichMenus(setup)
      return { setup, params: {} }
    },
    notCreated: async () => ({ setup: await ready(), params: {} }),
    needsAccessToken: async () => ({ setup: await tokenRefused(), params: {} }),
    missingAtLine: async () => {
      const setup = await ready()
      const { linked } = await withRichMenus(setup)
      await line.client.channel(TEST_ACCESS_TOKEN).deleteRichMenu(linked)
      return { setup, params: { missing: 'LINKED' } }
    },
    unreachable: async () => {
      const setup = await ready()
      await withRichMenus(setup)
      return { setup, client: lineAnswering({ [RICH_MENU_LIST]: lineError(500, 'Internal Server Error') }), params: { cause: 500 } }
    },
    rejected: async () => {
      const setup = await ready()
      await withRichMenus(setup)
      return { setup, client: lineAnswering({ [RICH_MENU_LIST]: lineError(403, 'Not allowed') }), params: { status: 403, detail: 'Not allowed' } }
    },
  },
}
/** Reasons whose case needs another environment, in another file */
const ELSEWHERE: Partial<Record<LineConnectionCheckId, readonly string[]>> = { liffId: ['envNotSet'] }

const ALL_CASES = LINE_CONNECTION_CHECKS.flatMap((check) =>
  Object.entries(CASES[check] as Record<string, () => Promise<Case>>).map(([reason, arrange]) => ({ name: `${check}.${reason}`, check, reason, arrange })),
)

describe('[FR-ADM-006/AC3] the connection test passes every check for a channel set up right', () => {
  it('reports PASS for the token, the webhook URL, LINE reaching it, the LIFF ID and both rich menus', async () => {
    const setup = await ready()
    await withRichMenus(setup)
    const { report } = await run(setup)
    expect(report.passed).toBe(true)
    expect(report.checks.map((c) => [c.id, c.status, c.reason])).toEqual([
      ['accessToken', 'PASS', 'ok'],
      ['webhookUrl', 'PASS', 'ok'],
      ['webhookReachable', 'PASS', 'ok'],
      ['liffId', 'PASS', 'ok'],
      ['richMenus', 'PASS', 'ok'],
    ])
    // LINE really sent a signed webhook to APP_URL's route, and the route accepted the signature
    expect(line.fake.webhookDeliveries().at(-1)).toMatchObject({ endpoint: setup.expected, success: true, statusCode: 200 })
  })

  it('needs a saved channel first (NOT_FOUND) and calls LINE for nothing', async () => {
    const org = await createOrg()
    const admin = await createMember(org.id, 'ผู้ดูแล')
    await prisma.roleAssignment.create({ data: { organizationId: org.id, memberId: admin.id, role: 'ORG_ADMIN', grantedAt: NOW } })
    const calls = line.fake.requests().length
    const ctx = makeCtx({ organizationId: org.id, actor: { type: 'USER', memberId: admin.id }, channel: 'WEB', now: NOW })
    expect(await testLineConnection(ctx)).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } })
    expect(line.fake.requests()).toHaveLength(calls)
  })
})

describe('[FR-ADM-006/AC3] each check gives every one of its reasons, with what to do in Thai and English', () => {
  it('has a case here for every reason (or names the file that has it)', () => {
    for (const check of LINE_CONNECTION_CHECKS) {
      const here = Object.keys(CASES[check])
      expect([...here, ...(ELSEWHERE[check] ?? [])].sort(), check).toEqual([...LINE_CHECK_REASONS[check]].sort())
    }
  })

  it.each(ALL_CASES)('$name', async ({ check, reason, arrange }) => {
    const { setup, client, params } = await arrange()
    const { checks, report } = await run(setup, client ? { client } : {})
    const result = checks[check]
    expect(outcome(result)).toEqual([reason === 'ok' ? 'PASS' : 'FAIL', reason])
    expect(result.messageKey).toBe(`checks.${check}.${reason}`)
    expect(result.params).toEqual(params)
    expect(report.passed).toBe(report.checks.every((c) => c.status === 'PASS'))
    // The words the screen shows: every value the message names is given, in both languages
    expectWords(result)
  })

  it('tells a wrong URL at LINE apart from LINE not reaching ours: the test webhook goes to APP_URL', async () => {
    const setup = await configured()
    line.fake.setWebhook('https://old-bcs.example.com/api/webhooks/line/old', true)
    const { checks } = await run(setup)
    expect(outcome(checks.webhookUrl)).toEqual(['FAIL', 'mismatch'])
    expect(outcome(checks.webhookReachable)).toEqual(['PASS', 'ok'])
  })

  it('a token LINE refuses: the checks that need it say so instead of failing again, and the LIFF check still runs', async () => {
    const { checks } = await run(await tokenRefused())
    expect(LINE_CONNECTION_CHECKS.map((id) => outcome(checks[id]))).toEqual([
      ['FAIL', 'unauthorized'],
      ['FAIL', 'needsAccessToken'],
      ['FAIL', 'needsAccessToken'],
      ['PASS', 'ok'],
      ['FAIL', 'needsAccessToken'],
    ])
  })
})

describe('[FR-ADM-006/AC3] the test answers within its time budget, the checks after the token side by side', () => {
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

  it('checks the token first, then asks LINE the three other things at the same time; the report keeps its order', async () => {
    const setup = await ready()
    await withRichMenus(setup)
    const calls: Array<{ route: string; start: number; end: number }> = []
    const client = createLineClient({
      apiBaseUrl: line.fake.url,
      dataApiBaseUrl: line.fake.url,
      fetch: async (input, init) => {
        const route = `${init?.method ?? 'GET'} ${new URL(String(input)).pathname}`
        const start = performance.now()
        if (route !== BOT_INFO) await sleep(150)
        const response = await fetch(input, init)
        calls.push({ route, start, end: performance.now() })
        return response
      },
    })
    const { report } = await run(setup, { client })
    expect(report.passed).toBe(true)
    const botInfo = calls.find((c) => c.route === BOT_INFO)!
    const others = calls.filter((c) => [WEBHOOK_ENDPOINT, WEBHOOK_TEST, RICH_MENU_LIST].includes(c.route))
    expect(others.map((c) => c.route).sort()).toEqual([WEBHOOK_ENDPOINT, WEBHOOK_TEST, RICH_MENU_LIST].sort())
    // The token was checked before anything else was asked
    for (const other of others) expect(other.start).toBeGreaterThanOrEqual(botInfo.end)
    // Each of the three started before any of them finished: they ran side by side, not one after another
    expect(Math.max(...others.map((c) => c.start))).toBeLessThan(Math.min(...others.map((c) => c.end)))
  })

  it('a call LINE has not answered when the budget ends is reported unreachable (TIMEOUT); the rest of the report stands', async () => {
    const setup = await ready()
    await withRichMenus(setup)
    const started = performance.now()
    const { checks, report } = await run(setup, { client: lineAnswering({ [WEBHOOK_TEST]: hang, [RICH_MENU_LIST]: hang }), budgetMs: 400 })
    const elapsed = performance.now() - started
    expect(report.passed).toBe(false)
    expect(outcome(checks.accessToken)).toEqual(['PASS', 'ok'])
    expect(outcome(checks.webhookUrl)).toEqual(['PASS', 'ok'])
    expect(checks.webhookReachable).toMatchObject({ status: 'FAIL', reason: 'unreachable', params: { cause: 'TIMEOUT', expected: setup.expected } })
    expect(checks.richMenus).toMatchObject({ status: 'FAIL', reason: 'unreachable', params: { cause: 'TIMEOUT' } })
    expect(outcome(checks.liffId)).toEqual(['PASS', 'ok'])
    for (const id of ['webhookReachable', 'richMenus'] as const) expectWords(checks[id])
    // Both waits ended with the budget, together: far less than either call's own limit (5 s and 15 s)
    expect(elapsed).toBeLessThan(3_000)
  })
})

describe('[FR-ADM-006/AC2] the server opens the sealed channel for its own work only when the values open', () => {
  it('gives the webhook and the senders the secret and an API bound to the token; refuses a missing or unreadable channel', async () => {
    const setup = await configured()
    const opened = await openLineChannel(setup.orgId)
    expect(opened).toMatchObject({ ok: true, channel: { organizationId: setup.orgId, channelKey: setup.channelKey, channelSecret: TEST_CHANNEL_SECRET, active: true } })
    if (!opened.ok) return
    expect(await opened.channel.api.getBotInfo()).toMatchObject({ basicId: '@bcs-fake' })

    expect(await openLineChannel((await createOrg()).id)).toEqual({ ok: false, reason: 'NOT_CONFIGURED' })
    const other = await configured()
    const otherRow = await prisma.lineChannelConfig.findUniqueOrThrow({ where: { organizationId: other.orgId } })
    await prisma.lineChannelConfig.update({ where: { organizationId: setup.orgId }, data: { channelSecretEnc: otherRow.channelSecretEnc } })
    expect(await openLineChannel(setup.orgId)).toEqual({ ok: false, reason: 'SECRET_UNREADABLE' })
  })
})

describe('[FR-ADM-006/AC3] only an ORG_ADMIN of the organization runs the test, and nothing reaches LINE otherwise', () => {
  it('refuses every other role, a deactivated admin, an admin of another organization, the BCS team and the system before calling LINE', async () => {
    const setup = await ready()
    const actors: Array<[string, Ctx]> = []
    for (const role of STORED_ROLES.filter((r) => r !== 'ORG_ADMIN')) {
      const member = await createMember(setup.orgId, role)
      await prisma.roleAssignment.create({ data: { organizationId: setup.orgId, memberId: member.id, role, grantedAt: NOW } })
      actors.push([role, setup.ctxOf(member.id)])
    }
    actors.push(['REQUESTER', setup.ctxOf((await createMember(setup.orgId, 'ผู้ขอ')).id)])
    const deactivated = await createMember(setup.orgId, 'ผู้ดูแลที่ปิดใช้งาน')
    await prisma.roleAssignment.create({ data: { organizationId: setup.orgId, memberId: deactivated.id, role: 'ORG_ADMIN', grantedAt: NOW } })
    await prisma.member.update({ where: { id: deactivated.id }, data: { status: 'DEACTIVATED' } })
    actors.push(['deactivated ORG_ADMIN', setup.ctxOf(deactivated.id)])
    const elsewhere = await configured()
    const otherAdmin = await prisma.roleAssignment.findFirstOrThrow({ where: { organizationId: elsewhere.orgId, role: 'ORG_ADMIN' } })
    actors.push(['ORG_ADMIN of another organization', setup.ctxOf(otherAdmin.memberId)])
    actors.push(['PLATFORM_ADMIN', makeCtx({ organizationId: setup.orgId, actor: { type: 'PLATFORM_ADMIN', platformAdminId: randomUUID() }, channel: 'WEB', now: NOW })])
    actors.push(['SYSTEM', systemCtx(setup.orgId, NOW, 'line-test')])

    const calls = line.fake.requests().length
    const deliveries = line.fake.webhookDeliveries().length
    for (const [who, ctx] of actors) {
      expect(await testLineConnection(ctx), who).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    }
    expect(line.fake.requests()).toHaveLength(calls)
    expect(line.fake.webhookDeliveries()).toHaveLength(deliveries)
  })
})

describe('[FR-ADM-006/AC3] every result has its words in Thai and English', () => {
  it('has a title and a message for every reason of every check, in both languages', () => {
    for (const locale of ['th', 'en'] as const) {
      const checks = (BUNDLES[locale].lineSettings as AbstractIntlMessages).checks as Record<string, Record<string, unknown>>
      for (const check of LINE_CONNECTION_CHECKS) {
        expect(typeof checks[check]?.title, `${locale} ${check}.title`).toBe('string')
        for (const reason of LINE_CHECK_REASONS[check]) expect(typeof checks[check]?.[reason], `${locale} ${check}.${reason}`).toBe('string')
      }
    }
  })
})
