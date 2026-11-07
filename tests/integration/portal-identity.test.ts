import { randomUUID } from 'node:crypto'
import { existsSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { POST as postLink } from '@/app/portal/[org]/api/link/route'
import { POST as postLoginLink } from '@/app/portal/[org]/api/login-link/route'
import { POST as postOtp } from '@/app/portal/[org]/api/otp/route'
import { POST as postSignOut } from '@/app/portal/[org]/api/sign-out/route'
import { setEmailProvider, type EmailMessage } from '@/integrations/email-provider'
import { getEnv } from '@/lib/env'
import { logger } from '@/lib/logger'
import { resolveSession } from '@/server/auth/session'
import { prisma } from '@/server/db/client'
import { setDefaultOutboxSender } from '@/server/events/outbox'
import { sendSupplierNotice } from '@/server/notifications/supplier-notices'
import { consumePortalLink, verifyPortalOtp } from '@/server/portal/commands'
import { resolvePortalOrg, type PortalOrg } from '@/server/portal/org'
import { readPortalSession } from '@/server/portal/session'
import { createP2Org } from '../support/p2-org'

// S7-04 (ADR-183 · BR-PORTAL ข้อ 01 ถึง ข้อ 04 · FR-SUP-101 AC2 AC7): the portal's own sign-in, through its route handlers
// as the browser posts them — an e-mailed link used once, a six-digit code from the same browser, a session under
// /portal/<org> with its CSRF token — and what it never is: a Workspace session, a session of another organization, a
// code tried elsewhere, an answer that tells whether an e-mail is on record.

const ROOT = path.resolve(import.meta.dirname, '..', '..')
const ORIGIN = new URL(getEnv().APP_URL).origin
const UA = 'Mozilla/5.0 (iPhone) portal-test'

interface Browser {
  readonly ip: string
  readonly ua: string
  readonly jar: Map<string, string>
}
const browser = (ip = `10.7.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`, ua = UA): Browser => ({ ip, ua, jar: new Map() })

type Handler = (request: Request, ctx: { params: Promise<{ org: string }> }) => Promise<Response>

/** A form POSTed as the browser does; Set-Cookie of the answer goes into its jar */
async function post(handler: Handler, org: PortalOrg | string, route: string, form: Record<string, string>, b: Browser, options: { origin?: string | null } = {}) {
  const code = typeof org === 'string' ? org : org.code
  const headers = new Headers({ 'content-type': 'application/x-www-form-urlencoded', 'x-forwarded-for': b.ip, 'user-agent': b.ua })
  if (options.origin !== null) headers.set('origin', options.origin ?? ORIGIN)
  if (b.jar.size) headers.set('cookie', [...b.jar].map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('; '))
  const res = await handler(new Request(`${ORIGIN}/portal/${code}/api/${route}`, { method: 'POST', headers, body: new URLSearchParams(form).toString() }), { params: Promise.resolve({ org: code }) })
  for (const c of res.headers.getSetCookie()) {
    const [pair] = c.split(';')
    const at = pair!.indexOf('=')
    const value = decodeURIComponent(pair!.slice(at + 1))
    if (value) b.jar.set(pair!.slice(0, at), value)
    else b.jar.delete(pair!.slice(0, at))
  }
  return res
}
const location = (res: Response) => new URL(res.headers.get('location') ?? 'http://x/')

let orgA: PortalOrg
let orgB: PortalOrg
const mails: EmailMessage[] = []

/** A taxpayer id with its check digit (BR-TAXID-01), different for every supplier */
function taxId(): string {
  const digits = Array.from({ length: 12 }, (_, i) => (i === 0 ? 0 : Math.floor(Math.random() * 10)))
  const sum = digits.reduce((s, d, i) => s + d * (13 - i), 0)
  return digits.join('') + String((11 - (sum % 11)) % 10)
}

async function supplierWithContact(organizationId: string, email: string) {
  const supplier = await prisma.supplier.create({ data: { organizationId, code: `P-${randomUUID().slice(0, 6)}`, nameTh: 'บริษัท พอร์ทัล จำกัด', taxId: taxId(), email: `register-${randomUUID().slice(0, 6)}@supplier.test` } })
  const contact = await prisma.supplierContact.create({ data: { organizationId, supplierId: supplier.id, nameTh: 'สมชาย ผู้ติดต่อ', email, isPrimary: true } })
  return { supplier, contact }
}

/** A contact of its own for each test: the limits count per contact and per e-mail (BR-PORTAL ข้อ 04) */
async function fresh(org: PortalOrg = orgA) {
  return (await supplierWithContact(org.organizationId, `c-${randomUUID().slice(0, 8)}@supplier.test`)).contact
}

/** The last notice of a template to the contact, with its data */
async function lastNotice(contactId: string, templateKey: string) {
  return prisma.supplierNotice.findFirstOrThrow({ where: { contactId, templateKey }, orderBy: { createdAt: 'desc' } })
}

/** Asks for a link, uses it, and returns the code e-mailed */
async function linkAndCode(org: PortalOrg, email: string, b: Browser) {
  const asked = await post(postLoginLink, org, 'login-link', { email }, b)
  expect([asked.status, asked.headers.get('location')]).toEqual([303, expect.stringContaining('sent=1')])
  const contact = await prisma.supplierContact.findFirstOrThrow({ where: { organizationId: org.organizationId, email } })
  const url = ((await lastNotice(contact.id, 'supplier.login_link')).data as { url: string }).url
  const token = url.split('/link/')[1]!
  const used = await post(postLink, org, 'link', { token }, b)
  expect(location(used).pathname).toBe(`/portal/${org.code}/otp`)
  const code = ((await lastNotice(contact.id, 'supplier.otp')).data as { code: string }).code
  return { token, code, contactId: contact.id }
}

beforeAll(async () => {
  setDefaultOutboxSender(null)
  setEmailProvider({
    async send(m) {
      mails.push(m)
      return { messageId: randomUUID() }
    },
  })
  const [a, b] = [await createP2Org(), await createP2Org()]
  orgA = (await resolvePortalOrg((await prisma.organization.findUniqueOrThrow({ where: { id: a.organizationId } })).code))!
  orgB = (await resolvePortalOrg((await prisma.organization.findUniqueOrThrow({ where: { id: b.organizationId } })).code))!
})
afterAll(() => setEmailProvider(null))

describe('[FR-SUP-101/AC2] a link used once, a six-digit code from the same browser, a new session', () => {
  it('signs in: the code arrives by e-mail without a link, the session is a new HttpOnly cookie under /portal/<org> with a CSRF token, and every event is the contact\'s own (INV-SUP-05)', async () => {
    const contactA = await fresh()
    const b = browser()
    const { code, contactId } = await linkAndCode(orgA, contactA.email, b)
    expect(code).toMatch(/^\d{6}$/)
    const res = await post(postOtp, orgA, 'otp', { code }, b)
    expect(location(res).pathname).toBe(`/portal/${orgA.code}`)
    const cookies = res.headers.getSetCookie().join('\n')
    expect(cookies).toMatch(new RegExp(`bcs_portal=[^;]+;.*Path=/portal/${orgA.code}`, 'i'))
    expect(cookies).toMatch(/bcs_portal=[^;]+;[^\n]*HttpOnly/i)
    expect(cookies).toMatch(/bcs_portal_csrf=[^;]+/)
    expect(b.jar.has('bcs_portal_otp')).toBe(false)
    const state = await readPortalSession(orgA, b.jar.get('bcs_portal'), new Date())
    expect(state?.contact.id).toBe(contactId)
    expect(state?.ctx).toMatchObject({ channel: 'PORTAL', actor: { type: 'SUPPLIER', supplierContactId: contactId } })
    expect((await prisma.supplierContact.findUniqueOrThrow({ where: { id: contactId } })).firstSignedInAt).not.toBeNull()
    const events = await prisma.event.findMany({ where: { organizationId: orgA.organizationId, aggregateId: contactId, channel: 'PORTAL' } })
    expect(events.map((e) => e.type)).toEqual(expect.arrayContaining(['portal_session.link_requested', 'portal_session.otp_requested', 'portal_session.signed_in']))
    for (const e of events) expect(e).toMatchObject({ actorType: 'SUPPLIER', actorSupplierContactId: contactId, actorMemberId: null })
    // no code, token, e-mail or IP in any event (NFR-SEC-09)
    expect(JSON.stringify(events.map((e) => e.data))).not.toMatch(new RegExp(`${code}|${contactA.email}|10\\.7\\.`))
    // the code's e-mail has no link; once sent the notice keeps no code
    const otp = await lastNotice(contactId, 'supplier.otp')
    expect(await sendSupplierNotice(orgA.organizationId, otp.id, new Date())).toBe('SENT')
    expect(mails.at(-1)!.text).toContain(code)
    expect(mails.at(-1)!.text).not.toMatch(/https?:\/\//)
    expect(((await prisma.supplierNotice.findUniqueOrThrow({ where: { id: otp.id } })).data as Record<string, unknown>).code).toBeUndefined()
  })

  it('a link used again is TOKEN_USED; a token nobody issued is TOKEN_INVALID', async () => {
    const contactA = await fresh()
    const b = browser()
    const { token } = await linkAndCode(orgA, contactA.email, b)
    expect(location(await post(postLink, orgA, 'link', { token }, browser())).searchParams.get('error')).toBe('TOKEN_USED')
    expect(location(await post(postLink, orgA, 'link', { token: 'not-a-token' }, browser())).searchParams.get('error')).toBe('TOKEN_INVALID')
  })

  it('wrong codes count down, the fifth locks the code for 15 minutes, and the right code is then refused too', async () => {
    const contactA = await fresh()
    const b = browser()
    const { code } = await linkAndCode(orgA, contactA.email, b)
    const wrong = code === '000000' ? '111111' : '000000'
    for (const remaining of [4, 3, 2, 1]) {
      const r = location(await post(postOtp, orgA, 'otp', { code: wrong }, b))
      expect([r.searchParams.get('error'), r.searchParams.get('remaining')]).toEqual(['OTP_INVALID', String(remaining)])
    }
    const locked = location(await post(postOtp, orgA, 'otp', { code: wrong }, b))
    expect(locked.searchParams.get('error')).toBe('OTP_LOCKED')
    expect(location(await post(postOtp, orgA, 'otp', { code }, b)).searchParams.get('error')).toBe('OTP_LOCKED')
    expect(b.jar.has('bcs_portal')).toBe(false)
  })

  it('at minute 10 exactly the code has expired; at 9:59 it still opens a session (BR-PORTAL ข้อ 02)', async () => {
    const contactA = await fresh()
    for (const [after, expected] of [
      [10 * 60_000, 'OTP_EXPIRED'],
      [9 * 60_000 + 59_000, 'OK'],
    ] as const) {
      const t0 = new Date()
      const meta = { ip: '10.9.9.9', userAgent: UA, now: t0 }
      const b = browser()
      await post(postLoginLink, orgA, 'login-link', { email: contactA.email }, b)
      const token = ((await lastNotice(contactA.id, 'supplier.login_link')).data as { url: string }).url.split('/link/')[1]!
      const used = await consumePortalLink(orgA, { token }, meta)
      if (!used.ok) throw new Error(JSON.stringify(used.error))
      const code = ((await lastNotice(contactA.id, 'supplier.otp')).data as { code: string }).code
      const r = await verifyPortalOtp(orgA, { challengeId: used.data.challengeId, token, code }, { ...meta, now: new Date(t0.getTime() + after) })
      expect(r.ok ? 'OK' : r.error.code).toBe(expected)
    }
  })

  it('the code from another browser (user agent or IP) is OTP_INVALID and counts no attempt', async () => {
    const contactA = await fresh()
    const meta = { ip: '10.8.8.8', userAgent: UA, now: new Date() }
    const b = browser()
    await post(postLoginLink, orgA, 'login-link', { email: contactA.email }, b)
    const token = ((await lastNotice(contactA.id, 'supplier.login_link')).data as { url: string }).url.split('/link/')[1]!
    const used = await consumePortalLink(orgA, { token }, meta)
    if (!used.ok) throw new Error(JSON.stringify(used.error))
    const code = ((await lastNotice(contactA.id, 'supplier.otp')).data as { code: string }).code
    expect(await verifyPortalOtp(orgA, { challengeId: used.data.challengeId, token, code }, { ...meta, userAgent: 'Other/1.0' })).toMatchObject({ ok: false, error: { code: 'OTP_INVALID' } })
    expect(await verifyPortalOtp(orgA, { challengeId: used.data.challengeId, token, code }, { ...meta, ip: '10.8.8.9' })).toMatchObject({ ok: false, error: { code: 'OTP_INVALID' } })
    expect(await verifyPortalOtp(orgA, { challengeId: used.data.challengeId, token: 'another', code }, meta)).toMatchObject({ ok: false, error: { code: 'OTP_INVALID' } })
    expect((await prisma.portalOtpChallenge.findUniqueOrThrow({ where: { id: used.data.challengeId } })).attempts).toBe(0)
    expect(await verifyPortalOtp(orgA, { challengeId: used.data.challengeId, token, code }, meta)).toMatchObject({ ok: true })
  })

  it('a POST without its CSRF token or from another origin is FORBIDDEN reason CSRF and recorded; with it, the session ends', async () => {
    const contactA = await fresh()
    const b = browser()
    const { code } = await linkAndCode(orgA, contactA.email, b)
    await post(postOtp, orgA, 'otp', { code }, b)
    const noToken = await post(postSignOut, orgA, 'sign-out', {}, b)
    expect(noToken.status).toBe(403)
    expect(await noToken.json()).toEqual({ code: 'FORBIDDEN', reason: 'CSRF' })
    const otherOrigin = await post(postSignOut, orgA, 'sign-out', { csrf: b.jar.get('bcs_portal_csrf')! }, b, { origin: 'https://evil.example' })
    expect(otherOrigin.status).toBe(403)
    expect(await prisma.event.count({ where: { organizationId: orgA.organizationId, type: 'portal_session.csrf_rejected' } })).toBeGreaterThanOrEqual(2)
    // the pre-session posts check the origin too
    expect((await post(postLoginLink, orgA, 'login-link', { email: contactA.email }, browser(), { origin: null })).status).toBe(403)
    const session = b.jar.get('bcs_portal')!
    const out = await post(postSignOut, orgA, 'sign-out', { csrf: b.jar.get('bcs_portal_csrf')! }, b)
    expect(location(out).pathname).toBe(`/portal/${orgA.code}/login`)
    expect(await readPortalSession(orgA, session, new Date())).toBeNull()
  })

  it('an e-mail nobody holds gets the same answer and no notice', async () => {
    const before = await prisma.supplierNotice.count({ where: { organizationId: orgA.organizationId } })
    const r = await post(postLoginLink, orgA, 'login-link', { email: `nobody-${randomUUID().slice(0, 6)}@supplier.test` }, browser())
    expect(location(r).searchParams.get('sent')).toBe('1')
    expect(await prisma.supplierNotice.count({ where: { organizationId: orgA.organizationId } })).toBe(before)
  })
})

describe('[FR-SUP-101/AC7] the portal session is its own and its organization\'s only', () => {
  it('a session of organization A is no session of B (404), and B\'s path never receives A\'s cookie', async () => {
    const contactA = await fresh()
    const b = browser()
    const { code } = await linkAndCode(orgA, contactA.email, b)
    const signedIn = await post(postOtp, orgA, 'otp', { code }, b)
    expect(signedIn.headers.getSetCookie().find((c) => c.startsWith('bcs_portal='))).toMatch(new RegExp(`Path=/portal/${orgA.code}(;|$)`, 'i'))
    expect(await readPortalSession(orgB, b.jar.get('bcs_portal'), new Date())).toBeNull()
    expect((await post(postSignOut, orgB, 'sign-out', { csrf: b.jar.get('bcs_portal_csrf')! }, b)).status).toBe(404)
  })

  it('the same person in two organizations has two contacts, two sessions and two cookie paths', async () => {
    const email = `both-${randomUUID().slice(0, 8)}@supplier.test`
    await supplierWithContact(orgA.organizationId, email)
    await supplierWithContact(orgB.organizationId, email)
    const [inA, inB] = [browser(), browser()]
    await post(postOtp, orgA, 'otp', { code: (await linkAndCode(orgA, email, inA)).code }, inA)
    await post(postOtp, orgB, 'otp', { code: (await linkAndCode(orgB, email, inB)).code }, inB)
    const [a, b] = [await readPortalSession(orgA, inA.jar.get('bcs_portal'), new Date()), await readPortalSession(orgB, inB.jar.get('bcs_portal'), new Date())]
    expect(a!.contact.id).not.toBe(b!.contact.id)
    expect(await readPortalSession(orgA, inB.jar.get('bcs_portal'), new Date())).toBeNull()
  })

  it('the Workspace does not take bcs_portal, and the portal does not take a Workspace cookie (ADR-007)', async () => {
    const contactA = await fresh()
    const b = browser()
    const { code } = await linkAndCode(orgA, contactA.email, b)
    await post(postOtp, orgA, 'otp', { code }, b)
    const onlyPortal = new Headers({ cookie: `bcs_portal=${b.jar.get('bcs_portal')}` })
    expect((await resolveSession(onlyPortal)).kind).not.toBe('member')
    // a Workspace session cookie posted to the portal is no portal session
    const workspace = browser()
    workspace.jar.set('better-auth.session_token', 'x.y')
    expect((await post(postSignOut, orgA, 'sign-out', { csrf: 'x' }, workspace)).status).toBe(404)
  })

  it('every portal route handler lives under /portal/[org]/api; none under /api/portal or /api/auth', () => {
    expect(existsSync(path.join(ROOT, 'src/app/api/portal'))).toBe(false)
    const auth = path.join(ROOT, 'src/app/api/auth')
    const authFiles = existsSync(auth) ? readdirSync(auth, { recursive: true }).map(String) : []
    expect(authFiles.filter((f) => /portal/i.test(f))).toEqual([])
    const portalApi = readdirSync(path.join(ROOT, 'src/app/portal/[org]/api'), { recursive: true }).map(String).filter((f) => f.endsWith('route.ts'))
    expect(portalApi.length).toBeGreaterThanOrEqual(5)
  })

  it('the fourth request of a window is RATE_LIMITED for a known and an unknown e-mail alike, with security.rate_limited (BR-PORTAL ข้อ 04)', async () => {
    const contactA = await fresh()
    for (const email of [contactA.email, `nobody-${randomUUID().slice(0, 6)}@supplier.test`]) {
      const answers: string[] = []
      for (let i = 0; i < 4; i++) {
        const r = location(await post(postLoginLink, orgA, 'login-link', { email }, browser()))
        answers.push(r.searchParams.get('error') ?? 'sent')
      }
      expect(answers).toEqual(['sent', 'sent', 'sent', 'RATE_LIMITED'])
    }
    const limited = await prisma.event.findFirst({ where: { organizationId: orgA.organizationId, type: 'security.rate_limited' } })
    expect(limited).toMatchObject({ actorType: 'SYSTEM', data: { scopeKind: 'CONTACT', bucket: 'LINK', contactId: null } })
    // per IP: the eleventh link asked from one address in a window
    const one = browser('10.250.250.250')
    const ip: string[] = []
    for (let i = 0; i < 11; i++) ip.push(location(await post(postLoginLink, orgA, 'login-link', { email: `ip-${i}-${randomUUID().slice(0, 4)}@supplier.test` }, one)).searchParams.get('error') ?? 'sent')
    expect(ip.at(-1)).toBe('RATE_LIMITED')
    expect(ip.slice(0, 10).every((x) => x === 'sent')).toBe(true)
  })
})

describe('[BR-PORTAL-02] nothing secret reaches the log (NFR-SEC-09)', () => {
  it('a whole sign-in, a wrong code and a refused request log no e-mail, code, token or IP', async () => {
    const lines: unknown[] = []
    const record = (...args: unknown[]) => void lines.push(args)
    const sink = { trace: record, debug: record, info: record, warn: record, error: record, fatal: record } as unknown as typeof logger
    const spies = [
      vi.spyOn(logger, 'child').mockImplementation((() => ({ ...sink, child: () => sink })) as never),
      ...(['trace', 'debug', 'info', 'warn', 'error', 'fatal'] as const).map((level) => vi.spyOn(logger, level).mockImplementation(record as never)),
    ]
    try {
      const contact = await fresh()
      const b = browser('10.66.66.66')
      const { code, token } = await linkAndCode(orgA, contact.email, b)
      await post(postOtp, orgA, 'otp', { code: code === '000000' ? '111111' : '000000' }, b)
      await post(postOtp, orgA, 'otp', { code }, b)
      await post(postLink, orgA, 'link', { token }, b)
      for (let i = 0; i < 4; i++) await post(postLoginLink, orgA, 'login-link', { email: contact.email }, b)
      const text = JSON.stringify(lines)
      for (const secret of [contact.email, code, token, '10.66.66.66', b.jar.get('bcs_portal') ?? 'none', b.jar.get('bcs_portal_csrf') ?? 'none']) expect(text.includes(secret), secret).toBe(false)
    } finally {
      for (const spy of spies) spy.mockRestore()
    }
  })
})
