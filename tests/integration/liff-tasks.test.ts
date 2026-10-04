import { createHmac, randomBytes, randomUUID } from 'node:crypto'
import { createTranslator } from 'next-intl'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

// The browser of the LIFF page is what these tests choose: Next.js's request objects (next/headers) hold the cookies a
// test puts in `browser.jar`, and a server action's Set-Cookie lands there as cookies().set does it; the page cache and
// the language are Next.js's and next-intl's, Thai. Everything else — liffPage, the session lookup, the services, the
// step-up, the rotation of the session, the Events — is the real path on real Postgres. `browser.onRead` lets a test
// act between two reads of the request's cookies (the n-th read of one action), as another request would.
const browser = vi.hoisted(() => ({ jar: new Map<string, string>(), reads: 0, onRead: null as ((read: number) => Promise<void>) | null }))
vi.mock('next/headers', () => ({
  headers: async () => new Headers(),
  cookies: async () => {
    browser.reads += 1
    await browser.onRead?.(browser.reads)
    return {
      getAll: () => [...browser.jar].map(([name, value]) => ({ name, value })),
      set: (name: string, value: string) => void browser.jar.set(name, value),
    }
  },
}))
vi.mock('next/cache', () => ({ revalidatePath: () => undefined }))
vi.mock('next-intl/server', async () => {
  const intl = await import('next-intl')
  const messages = (await import('../../messages/th.json')).default as Record<string, unknown>
  const translator = (namespace?: string) => intl.createTranslator({ locale: 'th', messages, ...(namespace ? { namespace } : {}) } as Parameters<typeof intl.createTranslator>[0])
  return { getLocale: async () => 'th', getTranslations: async (options?: string | { namespace?: string }) => translator(typeof options === 'string' ? options : options?.namespace) }
})

import { downloadUrlAction } from '@/app/_lib/file-actions'
import { decidePolicy, decideRequestTask, type StepUpSession } from '@/app/(workspace)/_tracking/commands'
import { boundaryTickOf } from '@/app/(workspace)/_tracking/policy-subject'
import { decideLiffPolicyAction, decideLiffTaskAction, openLiffFileAction } from '@/app/liff/tasks/[id]/actions'
import { liffTaskResult } from '@/app/liff/tasks/_lib/result'
import { liffStepUpSession, type LiffStepUpIo } from '@/app/liff/tasks/_lib/step-up'
import { amountToSatang } from '@/core/money/dto'
import { MS_PER_HOUR } from '@/lib/constants'
import { auth } from '@/server/auth/auth'
import { isLiffSessionToken, LIFF_SESSION_TOKEN_PREFIX, setLiffVerification } from '@/server/auth/liff'
import { rotateLiffSessionAfterStepUp } from '@/server/auth/liff-session-rotation'
import { liffSessionStandsForMember } from '@/server/auth/liff-sessions'
import { enableTotpWithSecret, upsertUserWithPassword } from '@/server/auth/provision'
import { resolveSession } from '@/server/auth/session'
import { rotateSessionAfterStepUp, type SignedInSession } from '@/server/auth/session-rotation'
import { memberPrincipal } from '@/server/authz'
import { prisma } from '@/server/db/client'
import { getTaskView } from '@/server/queries/tasks'
import { budgetLineAvailable } from '@/server/services/budget/line-available'
import { submitDoaVersion } from '@/server/services/doa'
import { getDownloadUrl } from '@/server/services/files'
import { draftDoaCopy, getDoaEditor, type DraftCopyInput } from '@/server/services/doa/editor'
import { saveLineChannelSettings } from '@/server/services/line-channel'
import { createDraft, submitRequest } from '@/server/services/requests'
import { formatDateTime } from '@/ui/format'
import type { ActionOutcome } from '@/ui/tasks/outcome'
import th from '../../messages/th.json'
import { createDoaOrg, type DoaOrg } from '../support/doa-org'
import { TEST_ACCESS_TOKEN, TEST_CHANNEL_SECRET } from '../support/fake-line'
import { seedTestPins, TEST_PIN } from '../support/pin'

// S5-06 · the LIFF decision page (§9.4 /liff/tasks/[id], FR-LINE-003 AC1 AC2, FR-AUTH-005 AC2, NFR-SEC-04, FR-DOA-009
// AC3, NEW-41, FR-PLT-004 AC2). Its server actions (src/app/liff/tasks/[id]/actions.ts) run the commands of the web
// decision page with the context of channel LIFF; a decision that needs the PIN grants the step-up, then gives the
// session of the LINE sign-in — the one the action read at its start — a new token (src/server/auth/
// liff-session-rotation.ts, src/app/liff/tasks/_lib/step-up.ts) and decides: the Event and the timeline say LIFF. A
// password sign-in on a LIFF page gets a new session id the web's way. An action that finds no session of its own at its
// start sends nothing on — not even the PIN to be checked. The answers are placed and worded for the LIFF form
// (src/app/liff/tasks/_lib/result.ts). A file of the task's document opens through the page's own action, for the LIFF
// session, bound to the task: only the files of the document the task decides. What is left on a request's budget line
// is told only to whoever may read the line's figures. Real Postgres (BCS_TEST_DB), an organization of the §7.4
// fixtures (stepUpThreshold 100,000.00 baht) whose LINE channel is on.

const NOW = new Date('2026-10-05T03:00:00Z')
const key = () => ({ idempotencyKey: randomUUID(), sender: null })
const WRONG = '502918'
const LIFF_CHANNEL = '1670000003'
const PROVIDER = '1670000001'
const TOTP_SECRET = 'L'.repeat(32)

let org: DoaOrg
const member = (code: string) => org.member[code]!

beforeAll(async () => {
  org = await createDoaOrg()
  await prisma.roleAssignment.create({ data: { organizationId: org.organizationId, memberId: member('admin'), role: 'ORG_ADMIN', grantedAt: NOW } })
  await seedTestPins(org.organizationId)
  // The organization's LINE channel, on, with the LIFF channel the sessions below stand on (ADR-045, ADR-046)
  const saved = await saveLineChannelSettings(
    org.ctxOf('admin', NOW),
    {
      providerId: PROVIDER,
      messagingChannelId: '1670000002',
      channelSecret: TEST_CHANNEL_SECRET,
      channelAccessToken: TEST_ACCESS_TOKEN,
      liffId: `${LIFF_CHANNEL}-AbCdEfGh`,
      liffChannelId: LIFF_CHANNEL,
      active: true,
    },
    key(),
  )
  if (!saved.ok) throw new Error(`LINE channel not saved: ${saved.error.code}`)
  setLiffVerification({ channelId: LIFF_CHANNEL })
})
afterAll(() => setLiffVerification(null))

/** The cookie Better Auth signs for a session token (better-call: HMAC-SHA256 with the auth secret, URI-encoded) */
async function signedCookieFor(token: string): Promise<string> {
  const context = await auth.$context
  const signature = createHmac('sha256', context.secret).update(token).digest('base64')
  return `${context.authCookies.sessionToken.name}=${encodeURIComponent(`${token}.${signature}`)}`
}

/** The session cookie among Set-Cookie lines, as a browser sends it back */
const sessionCookieOf = (setCookie: readonly string[]) =>
  setCookie
    .map((c) => c.split(';')[0]!)
    .filter((c) => c.includes('session_token='))
    .join('; ')

/** The member's sign-in identity (with TOTP, as an approver's), once */
async function identityOf(code: string): Promise<string> {
  const m = await prisma.member.findUniqueOrThrow({ where: { id: member(code) } })
  if (m.userId) return m.userId
  const userId = await upsertUserWithPassword({ email: m.email, name: m.displayNameTh, password: 'liff-tasks-password-01' })
  await enableTotpWithSecret(userId, TOTP_SECRET, [])
  await prisma.member.update({ where: { id: m.id }, data: { userId } })
  return userId
}

/** The member's LINE account linked under the channel's provider (as S5-04's link records it), once */
async function linked(code: string): Promise<void> {
  const live = await prisma.channelIdentity.findFirst({ where: { organizationId: org.organizationId, memberId: member(code), unlinkedAt: null } })
  if (live) return
  await prisma.channelIdentity.create({
    data: { organizationId: org.organizationId, memberId: member(code), channel: 'LINE', providerKey: PROVIDER, externalUserId: `U${randomBytes(16).toString('hex')}`, linkedAt: new Date() },
  })
}

/** A session opened from a LIFF ID token for the member (liff.ts makes them so: the LIFF prefix, 12 hours) */
async function liffSession(code: string) {
  const userId = await identityOf(code)
  await linked(code)
  const token = `${LIFF_SESSION_TOKEN_PREFIX}${randomBytes(24).toString('base64url')}`
  const row = await prisma.session.create({ data: { id: randomUUID(), userId, token, expiresAt: new Date(Date.now() + 12 * MS_PER_HOUR) } })
  const signedIn: SignedInSession = { sessionId: row.id, userId }
  return { cookie: await signedCookieFor(token), signedIn, row }
}

/**
 * What the LIFF page's server action hands the commands (src/app/liff/tasks/_lib/step-up.ts): real time, the session the
 * action read at its start, and the LIFF session's new token after a right PIN — the cookie the browser is given is kept
 * in `rotated`. The request carries `cookie`.
 */
function liffStepUp(cookie: string, signedIn: SignedInSession): StepUpSession & { rotated: string[] } {
  const rotated: string[] = []
  const io: LiffStepUpIo = {
    headers: async () => new Headers(cookie ? { cookie } : {}),
    hold: async (setCookie) => {
      rotated.push(sessionCookieOf(setCookie))
    },
  }
  return { ...liffStepUpSession('liff', signedIn, io), sender: null, rotated }
}

/** The browser of the LIFF page holds this session cookie, as Next.js's cookies() gives it (decoded), or none */
function signInBrowser(cookie: string | null) {
  browser.jar.clear()
  if (!cookie) return
  const [name, ...value] = cookie.split('=')
  browser.jar.set(name!, decodeURIComponent(value.join('=')))
}

/** The cookies the browser sends next, as a Cookie header */
const browserCookie = () => [...browser.jar].map(([name, value]) => `${name}=${encodeURIComponent(value)}`).join('; ')

async function waitingRequest(grossBaht: string) {
  const draft = await createDraft(
    org.ctxOf('req_con', NOW),
    { requestTypeCode: 'BUY_GOODS', title: 'วัสดุก่อสร้าง', priceIncludesVat: true, lines: [{ description: 'ปูนซีเมนต์', quantity: '1', uom: 'งาน', unitPrice: grossBaht }] },
    key(),
  )
  if (!draft.ok) throw new Error(`draft failed: ${draft.error.code}`)
  const sent = await submitRequest(org.ctxOf('req_con', NOW), { requestId: draft.data.requestId }, key())
  if (!sent.ok) throw new Error(`submit failed: ${sent.error.code}`)
  const task = await prisma.approvalTask.findFirstOrThrow({ where: { status: 'OPEN', step: { route: { subjectType: 'REQUEST', subjectId: draft.data.requestId } } } })
  return { requestId: draft.data.requestId, taskId: task.id }
}

/** The answer of the LIFF form, in the Thai of tasks.errors, as the server action words it */
const tErrors = createTranslator({ locale: 'th', messages: th, namespace: 'tasks.errors' })
const answered = (outcome: ActionOutcome) => liffTaskResult(outcome, { error: (k, values) => tErrors(k, values), time: (iso) => formatDateTime('th', iso) })

const decidedEvent = (taskId: string) => prisma.event.findFirst({ where: { aggregateType: 'ApprovalTask', aggregateId: taskId, type: 'approval_task.decided' } })
const tokenOf = async (sessionId: string) => (await prisma.session.findUnique({ where: { id: sessionId } }))?.token ?? null

describe('[NFR-SEC-04] [FR-LINE-003/AC2] after a right PIN on a LIFF page the LINE sign-in gets a new session id', () => {
  it('gives the LIFF session a new token at once: the same sign-in, end and LIFF-only use; the old cookie opens nothing', async () => {
    const { cookie, signedIn, row } = await liffSession('vp_ops')
    expect(await resolveSession(new Headers({ cookie }), { channel: 'LIFF' })).toMatchObject({ kind: 'member', sessionId: row.id, member: { id: member('vp_ops') } })
    const at = Date.now()
    const rotated = await rotateLiffSessionAfterStepUp(new Headers({ cookie }), signedIn)
    if (!rotated.ok) throw new Error(`rotation refused: ${rotated.reason}`)
    const fresh = sessionCookieOf(rotated.setCookie)
    expect(fresh).toMatch(/session_token=/)
    expect(fresh).not.toBe(cookie)

    const now = await prisma.session.findUniqueOrThrow({ where: { id: row.id } })
    // A new token on the same row: still a LIFF one, never longer than the sign-in allowed (FR-AUTH-003 AC1)
    expect(now.token).not.toBe(row.token)
    expect(now.token.startsWith(LIFF_SESSION_TOKEN_PREFIX)).toBe(true)
    expect(now).toMatchObject({ userId: row.userId, createdAt: row.createdAt, expiresAt: row.expiresAt })
    expect(now.lastActiveAt!.getTime()).toBeGreaterThanOrEqual(at - 1000)
    expect(fresh).toBe(await signedCookieFor(now.token))

    // The new cookie is the member on LIFF pages, and still nothing on the workspace's (§9.4, ADR-046)
    expect(await resolveSession(new Headers({ cookie: fresh }), { channel: 'LIFF' })).toMatchObject({ kind: 'member', sessionId: row.id, member: { id: member('vp_ops') } })
    expect(await resolveSession(new Headers({ cookie: fresh }))).toEqual({ kind: 'anonymous' })
    // The old one opens nothing from now on — a page resolves no session from it, so no step-up can follow — and it
    // cannot be turned into another session
    expect(await resolveSession(new Headers({ cookie }), { channel: 'LIFF' })).toEqual({ kind: 'anonymous' })
    expect(await rotateLiffSessionAfterStepUp(new Headers({ cookie }), { sessionId: randomUUID(), userId: signedIn.userId })).toEqual({ ok: false, reason: 'NO_SESSION' })
    // The sign-in time is kept, so a LINE link that ends later still ends this session (liff-sessions.ts)
    expect(await liffSessionStandsForMember(row.id, { id: member('vp_ops'), organizationId: org.organizationId })).toBe(true)
  })

  it('two step-ups of one LIFF session at the same moment change it once, and every answer carries the token in force', async () => {
    const { cookie, signedIn, row } = await liffSession('vp_sup')
    const results = await Promise.all([0, 1, 2, 3].map(() => rotateLiffSessionAfterStepUp(new Headers({ cookie }), signedIn)))
    const cookies = results.map((r) => {
      if (!r.ok) throw new Error(`rotation refused: ${r.reason}`)
      return sessionCookieOf(r.setCookie)
    })
    expect(new Set(cookies).size).toBe(1)
    const token = await tokenOf(row.id)
    expect(cookies[0]).toBe(await signedCookieFor(token!))
    expect(await resolveSession(new Headers({ cookie: cookies[0]! }), { channel: 'LIFF' })).toMatchObject({ kind: 'member', sessionId: row.id })
  })

  it('a second tab that read the session before the first tab’s step-up still decides with its right PIN, and gets the token now in force', async () => {
    const first = await waitingRequest('100000.00')
    const second = await waitingRequest('100000.00')
    const { cookie, signedIn, row } = await liffSession('vp_ops')
    // Two tabs of one LINE sign-in send a decision each; both read the session at their start, before any PIN
    const tabA = liffStepUp(cookie, signedIn)
    const tabB = liffStepUp(cookie, signedIn)
    const ctx = org.ctxOf('vp_ops', NOW, 'LIFF')
    expect(await decideRequestTask(ctx, { taskId: first.taskId, decision: 'APPROVE', pin: TEST_PIN }, randomUUID(), 'th', tabA)).toMatchObject({ ok: true })
    // Tab A's step-up changed the token; tab B's request still carries the old cookie, and its right PIN decides too
    expect(await decideRequestTask(ctx, { taskId: second.taskId, decision: 'APPROVE', pin: TEST_PIN }, randomUUID(), 'th', tabB)).toMatchObject({ ok: true })
    const inForce = await signedCookieFor((await tokenOf(row.id))!)
    expect(inForce).not.toBe(cookie)
    expect(tabA.rotated).toEqual([inForce])
    expect(tabB.rotated).toEqual([inForce])
    expect(await decidedEvent(second.taskId)).toMatchObject({ channel: 'LIFF', data: { decision: 'APPROVE', stepUpGrantId: expect.any(String) } })
  })

  it('a session that ended while its PIN was checked gets no new id and decides nothing', async () => {
    const { requestId, taskId } = await waitingRequest('100000.00')
    const { cookie, signedIn, row } = await liffSession('vp_ops')
    // The action read the session at its start; it is signed out (ended) before the step-up gives it a new id
    const session = liffStepUp(cookie, signedIn)
    await prisma.session.delete({ where: { id: row.id } })
    expect(await decideRequestTask(org.ctxOf('vp_ops', NOW, 'LIFF'), { taskId, decision: 'APPROVE', pin: TEST_PIN }, randomUUID(), 'th', session)).toEqual({ ok: false, code: 'UNAUTHENTICATED' })
    expect(session.rotated).toEqual([])
    expect((await prisma.approvalTask.findUniqueOrThrow({ where: { id: taskId } })).status).toBe('OPEN')
    expect(await decidedEvent(taskId)).toBeNull()
    // The PIN proved itself before the session was found gone: its step-up stays unused, and lapses (5 minutes)
    expect(await prisma.stepUpGrant.findMany({ where: { memberId: member('vp_ops'), subjectId: requestId }, select: { usedAt: true } })).toEqual([{ usedAt: null }])
  })

  it('a password session is left to the web rotation, and a session signed out, ended or not the request’s own gets nothing', async () => {
    // A password session (Better Auth's own token): the LIFF rotation refuses it, the web one serves it
    const userId = await identityOf('fin_officer')
    const webToken = randomBytes(24).toString('base64url')
    const web = await prisma.session.create({ data: { id: randomUUID(), userId, token: webToken, expiresAt: new Date(Date.now() + MS_PER_HOUR) } })
    const webCookie = await signedCookieFor(webToken)
    expect(await rotateLiffSessionAfterStepUp(new Headers({ cookie: webCookie }), { sessionId: web.id, userId })).toEqual({ ok: false, reason: 'NOT_LIFF' })
    expect(await tokenOf(web.id)).toBe(webToken)
    expect((await rotateSessionAfterStepUp(new Headers({ cookie: webCookie }), { sessionId: web.id, userId })).ok).toBe(true)

    // Another LIFF session of the same member: the request's own session is the one named, or nothing changes
    const first = await liffSession('ceo')
    const second = await liffSession('ceo')
    expect(await rotateLiffSessionAfterStepUp(new Headers({ cookie: first.cookie }), second.signedIn)).toEqual({ ok: false, reason: 'NO_SESSION' })
    expect(await tokenOf(first.row.id)).toBe(first.row.token)
    expect(await tokenOf(second.row.id)).toBe(second.row.token)
    // Ended (its absolute lifetime is over), or signed out while the PIN was checked
    await prisma.session.update({ where: { id: first.row.id }, data: { expiresAt: new Date(Date.now() - 1000) } })
    expect(await rotateLiffSessionAfterStepUp(new Headers({ cookie: first.cookie }), first.signedIn)).toEqual({ ok: false, reason: 'NO_SESSION' })
    await prisma.session.delete({ where: { id: second.row.id } })
    expect(await rotateLiffSessionAfterStepUp(new Headers({ cookie: second.cookie }), second.signedIn)).toEqual({ ok: false, reason: 'NO_SESSION' })
    // No cookie at all
    expect(await rotateLiffSessionAfterStepUp(new Headers(), second.signedIn)).toEqual({ ok: false, reason: 'NO_SESSION' })
  })
})

describe('[FR-LINE-003/AC2] [FR-AUTH-005/AC2] a task at or above the threshold is decided in LIFF with the PIN', () => {
  it('approves with the right PIN: the step-up, a new LIFF session id, then the decision on channel LIFF', async () => {
    const { requestId, taskId } = await waitingRequest('100000.00')
    const { cookie, signedIn, row } = await liffSession('vp_ops')
    const session = liffStepUp(cookie, signedIn)
    const outcome = await decideRequestTask(org.ctxOf('vp_ops', NOW, 'LIFF'), { taskId, decision: 'APPROVE', pin: TEST_PIN }, randomUUID(), 'th', session)
    expect(outcome).toEqual({ ok: true, documentStatus: 'APPROVED' })
    expect(answered(outcome)).toEqual({ ok: true })
    // NFR-SEC-04: the LINE sign-in's session id changed once, and the new one is the approver's
    expect(session.rotated).toHaveLength(1)
    expect(await tokenOf(row.id)).not.toBe(row.token)
    expect(await resolveSession(new Headers({ cookie: session.rotated[0]! }), { channel: 'LIFF' })).toMatchObject({ kind: 'member', member: { id: member('vp_ops') } })
    // The decision used the step-up and records channel LIFF, which the timeline shows (FR-DOA-005 AC1)
    const [grant, ...more] = await prisma.stepUpGrant.findMany({ where: { subjectId: requestId } })
    expect(more).toEqual([])
    expect(grant).toMatchObject({ memberId: member('vp_ops'), method: 'PIN', usedAt: expect.any(Date) })
    expect(await decidedEvent(taskId)).toMatchObject({ channel: 'LIFF', data: { decision: 'APPROVE', channel: 'LIFF', stepUpGrantId: grant!.id } })
  })

  it('decides nothing without the PIN, or with a wrong one, and the LIFF form is told where and in words', async () => {
    const { taskId } = await waitingRequest('100000.00')
    const { cookie, signedIn, row } = await liffSession('vp_ops')
    const session = liffStepUp(cookie, signedIn)
    const ctx = org.ctxOf('vp_ops', NOW, 'LIFF')
    const missing = await decideRequestTask(ctx, { taskId, decision: 'APPROVE' }, randomUUID(), 'th', session)
    expect(answered(missing)).toEqual({ ok: false, at: 'pin', text: th.tasks.errors.PIN })
    const wrong = await decideRequestTask(ctx, { taskId, decision: 'APPROVE', pin: WRONG }, randomUUID(), 'th', session)
    expect(answered(wrong)).toEqual({ ok: false, at: 'pin', text: 'PIN ไม่ถูกต้อง ใส่ผิดได้อีก 4 ครั้ง ถ้าผิดครบ PIN จะถูกล็อก 15 นาที' })
    expect(JSON.stringify(answered(wrong))).not.toContain(WRONG)
    // Nothing decided, the session id kept
    expect(session.rotated).toEqual([])
    expect(await tokenOf(row.id)).toBe(row.token)
    expect((await prisma.approvalTask.findUniqueOrThrow({ where: { id: taskId } })).status).toBe('OPEN')
    expect(await decidedEvent(taskId)).toBeNull()
    // The right PIN starts the count of wrong ones again
    expect(await decideRequestTask(ctx, { taskId, decision: 'APPROVE', pin: TEST_PIN }, randomUUID(), 'th', session)).toMatchObject({ ok: true })
    expect(await prisma.member.findUniqueOrThrow({ where: { id: member('vp_ops') }, select: { pinFailedCount: true } })).toEqual({ pinFailedCount: 0 })
  })

  it('[FR-LINE-003/AC1] below the threshold approves without a PIN, no new session id, on channel LIFF', async () => {
    const { taskId } = await waitingRequest('45000.00')
    const { cookie, signedIn, row } = await liffSession('vp_ops')
    const session = liffStepUp(cookie, signedIn)
    expect(await decideRequestTask(org.ctxOf('vp_ops', NOW, 'LIFF'), { taskId, decision: 'APPROVE' }, randomUUID(), 'th', session)).toEqual({ ok: true, documentStatus: 'APPROVED' })
    expect(session.rotated).toEqual([])
    expect(await tokenOf(row.id)).toBe(row.token)
    expect(await decidedEvent(taskId)).toMatchObject({ channel: 'LIFF', data: { decision: 'APPROVE', channel: 'LIFF' } })
  })

  it('[FR-DOA-004/AC1] returns or rejects only with a reason, told before a PIN try is spent', async () => {
    const { taskId } = await waitingRequest('100000.00')
    const { cookie, signedIn } = await liffSession('vp_ops')
    const session = liffStepUp(cookie, signedIn)
    const before = await prisma.member.findUniqueOrThrow({ where: { id: member('vp_ops') }, select: { pinFailedCount: true } })
    const noReason = await decideRequestTask(org.ctxOf('vp_ops', NOW, 'LIFF'), { taskId, decision: 'REJECT', reason: ' ', pin: WRONG }, randomUUID(), 'th', session)
    expect(answered(noReason)).toEqual({ ok: false, at: 'form', text: th.tasks.errors.REASON })
    expect(await prisma.member.findUniqueOrThrow({ where: { id: member('vp_ops') }, select: { pinFailedCount: true } })).toEqual(before)
    expect(await decideRequestTask(org.ctxOf('vp_ops', NOW, 'LIFF'), { taskId, decision: 'REJECT', reason: 'ซ้ำกับคำขอเดิม', pin: TEST_PIN }, randomUUID(), 'th', session)).toEqual({
      ok: true,
      documentStatus: 'REJECTED',
    })
    expect(await decidedEvent(taskId)).toMatchObject({ channel: 'LIFF', data: { decision: 'REJECT', channel: 'LIFF' } })
  })

  it('[FR-DOA-004/AC2] a member who does not decide the task is refused in LIFF, and no PIN try is spent', async () => {
    const { requestId, taskId } = await waitingRequest('100000.00')
    // The VP of the other division, signed in with LINE: the task is vp_ops's
    const { cookie, signedIn, row } = await liffSession('vp_sup')
    const before = await prisma.member.findUniqueOrThrow({ where: { id: member('vp_sup') }, select: { pinFailedCount: true } })
    const session = liffStepUp(cookie, signedIn)
    const outcome = await decideRequestTask(org.ctxOf('vp_sup', NOW, 'LIFF'), { taskId, decision: 'APPROVE', pin: WRONG }, randomUUID(), 'th', session)
    expect(outcome).toMatchObject({ ok: false, code: 'FORBIDDEN' })
    expect(answered(outcome)).toEqual({ ok: false, at: 'form', text: th.tasks.errors.FORBIDDEN })
    // No try spent, no step-up, no new session id, nothing decided
    expect(await prisma.member.findUniqueOrThrow({ where: { id: member('vp_sup') }, select: { pinFailedCount: true } })).toEqual(before)
    expect(await prisma.stepUpGrant.count({ where: { memberId: member('vp_sup'), subjectId: requestId } })).toBe(0)
    expect(session.rotated).toEqual([])
    expect(await tokenOf(row.id)).toBe(row.token)
    expect((await prisma.approvalTask.findUniqueOrThrow({ where: { id: taskId } })).status).toBe('OPEN')
  })
})

describe('[FR-LINE-003/AC2] [NFR-SEC-04] the LIFF decision page’s action, signed in with LINE', () => {
  it('a wrong PIN says the tries left and keeps the cookie; the right one approves on channel LIFF and the browser gets the new session cookie', async () => {
    const { taskId } = await waitingRequest('100000.00')
    const { cookie, row } = await liffSession('vp_ops')
    await prisma.member.update({ where: { id: member('vp_ops') }, data: { pinFailedCount: 0, pinLockedUntil: null } })
    signInBrowser(cookie)
    expect(await decideLiffTaskAction({ taskId, decision: 'APPROVE', pin: WRONG }, randomUUID())).toEqual({
      ok: false,
      at: 'pin',
      text: 'PIN ไม่ถูกต้อง ใส่ผิดได้อีก 4 ครั้ง ถ้าผิดครบ PIN จะถูกล็อก 15 นาที',
    })
    expect(browserCookie()).toBe(cookie)
    expect(await decideLiffTaskAction({ taskId, decision: 'APPROVE', pin: TEST_PIN }, randomUUID())).toEqual({ ok: true })
    // NFR-SEC-04: the response gave the browser the session's new token; the old cookie opens nothing from now on
    const fresh = browserCookie()
    expect(fresh).not.toBe(cookie)
    expect(fresh).toBe(await signedCookieFor((await tokenOf(row.id))!))
    expect(await resolveSession(new Headers({ cookie: fresh }), { channel: 'LIFF' })).toMatchObject({ kind: 'member', sessionId: row.id, member: { id: member('vp_ops') } })
    expect(await resolveSession(new Headers({ cookie }), { channel: 'LIFF' })).toEqual({ kind: 'anonymous' })
    expect(await decidedEvent(taskId)).toMatchObject({ channel: 'LIFF', data: { decision: 'APPROVE', channel: 'LIFF', stepUpGrantId: expect.any(String) } })
  })

  it('sends nothing on without a session of the LIFF page', async () => {
    const { taskId } = await waitingRequest('100000.00')
    signInBrowser(null)
    expect(await decideLiffTaskAction({ taskId, decision: 'APPROVE', pin: TEST_PIN }, randomUUID())).toEqual({ ok: false, at: 'form', text: th.tasks.errors.UNAUTHENTICATED, signedOut: true })
    expect((await prisma.approvalTask.findUniqueOrThrow({ where: { id: taskId } })).status).toBe('OPEN')
  })

  it('a session that ends between the page’s lookup and the action’s own sends nothing on: no PIN checked, no try counted, no step-up, nothing decided', async () => {
    const { requestId, taskId } = await waitingRequest('100000.00')
    // Two wrong PINs counted already: a PIN that were checked — right, it starts the count again — would show here
    await prisma.member.update({ where: { id: member('vp_ops') }, data: { pinFailedCount: 2, pinLockedUntil: null } })
    const refused = { ok: false, at: 'form', text: th.tasks.errors.UNAUTHENTICATED, signedOut: true }
    try {
      for (const send of [
        () => decideLiffTaskAction({ taskId, decision: 'APPROVE', pin: TEST_PIN }, randomUUID()),
        // The policy action stops at the same point: a policy decision of this task would be refused as FORBIDDEN after it
        () => decideLiffPolicyAction({ taskId, decision: 'APPROVE', pin: TEST_PIN, boundaryTableConfirmed: null }, randomUUID()),
      ]) {
        const { cookie, row } = await liffSession('vp_ops')
        signInBrowser(cookie)
        // liffPage reads the request's cookies first and finds the member; the session ends (another tab signs out) before
        // the action reads them again for the session the step-up would give a new id
        browser.reads = 0
        browser.onRead = async (read) => {
          if (read === 2) await prisma.session.delete({ where: { id: row.id } })
        }
        expect(await send()).toEqual(refused)
        expect(browser.reads).toBe(2)
        browser.onRead = null
      }
    } finally {
      browser.onRead = null
    }
    expect(await prisma.member.findUniqueOrThrow({ where: { id: member('vp_ops') }, select: { pinFailedCount: true } })).toEqual({ pinFailedCount: 2 })
    expect(await prisma.stepUpGrant.count({ where: { memberId: member('vp_ops'), subjectId: requestId } })).toBe(0)
    expect((await prisma.approvalTask.findUniqueOrThrow({ where: { id: taskId } })).status).toBe('OPEN')
    expect(await decidedEvent(taskId)).toBeNull()
    await prisma.member.update({ where: { id: member('vp_ops') }, data: { pinFailedCount: 0 } })
  })

  it('[NFR-SEC-04] a password sign-in on a LIFF page gets a new session id after a right PIN too, and the browser the new cookie; the decision is on channel LIFF', async () => {
    const { taskId } = await waitingRequest('100000.00')
    // vp_ops signed in with the password in the LINE app's browser: Better Auth's own token, not a LIFF one
    const userId = await identityOf('vp_ops')
    const token = randomBytes(24).toString('base64url')
    const row = await prisma.session.create({ data: { id: randomUUID(), userId, token, expiresAt: new Date(Date.now() + MS_PER_HOUR) } })
    const cookie = await signedCookieFor(token)
    signInBrowser(cookie)
    expect(await decideLiffTaskAction({ taskId, decision: 'APPROVE', pin: TEST_PIN }, randomUUID())).toEqual({ ok: true })
    // The web rotation gave the same row a new token of Better Auth's own kind: the sign-in, its end and its use are kept
    const now = await prisma.session.findUniqueOrThrow({ where: { id: row.id } })
    expect(now.token).not.toBe(token)
    expect(isLiffSessionToken(now.token)).toBe(false)
    expect(now).toMatchObject({ userId, createdAt: row.createdAt, expiresAt: row.expiresAt })
    // The response gave the browser the new cookie; it opens the workspace and LIFF pages as before, the old one nothing
    const fresh = browserCookie()
    expect(fresh).toBe(await signedCookieFor(now.token))
    expect(await resolveSession(new Headers({ cookie: fresh }))).toMatchObject({ kind: 'member', sessionId: row.id, member: { id: member('vp_ops') } })
    expect(await resolveSession(new Headers({ cookie: fresh }), { channel: 'LIFF' })).toMatchObject({ kind: 'member', sessionId: row.id })
    expect(await resolveSession(new Headers({ cookie }), { channel: 'LIFF' })).toEqual({ kind: 'anonymous' })
    expect(await decidedEvent(taskId)).toMatchObject({ channel: 'LIFF', data: { decision: 'APPROVE', channel: 'LIFF', stepUpGrantId: expect.any(String) } })
  })
})

/** A quotation file attached to the request, as the request form attaches one */
async function quotationOf(requestId: string) {
  const file = await prisma.fileObject.create({
    data: { organizationId: org.organizationId, storageKey: `test/${randomUUID()}.pdf`, fileName: 'quotation.pdf', mimeType: 'application/pdf', sizeBytes: 1, status: 'AVAILABLE', uploadedById: member('req_con') },
  })
  await prisma.fileLink.create({ data: { organizationId: org.organizationId, fileId: file.id, subjectType: 'Request', subjectId: requestId, kind: 'QUOTATION' } })
  return file.id
}

/** The member holds the role in the organization (granted once, as the seed grants roles) */
async function holds(code: string, role: 'AUDITOR') {
  const held = await prisma.roleAssignment.findFirst({ where: { organizationId: org.organizationId, memberId: member(code), role, revokedAt: null } })
  if (!held) await prisma.roleAssignment.create({ data: { organizationId: org.organizationId, memberId: member(code), role, grantedAt: NOW } })
}

describe('[FR-PLT-004/AC2] [FR-LINE-003/AC1] a file of the task’s document opens from its LIFF page, for the LINE sign-in', () => {
  it('gives the decider a short-lived address; a member who may not see the request, or nobody signed in, gets none', async () => {
    const { requestId, taskId } = await waitingRequest('45000.00')
    const fileId = await quotationOf(requestId)
    // The approver signed in with LINE: the page's own action opens the file through its task (FR-PLT-004 AC2: at most 5 minutes) …
    signInBrowser((await liffSession('vp_ops')).cookie)
    const url = await openLiffFileAction(taskId, fileId)
    expect(url).toMatch(/X-Amz-Signature=/)
    expect(Number(new URL(url!).searchParams.get('X-Amz-Expires'))).toBeLessThanOrEqual(300)
    // … where the workspace's file action, which a LIFF session never signs in to, answers nothing
    expect(await downloadUrlAction(fileId)).toBeNull()
    // A member who may not see the request — another department's head, no role — gets nothing
    signInBrowser((await liffSession('dm_fin')).cookie)
    expect(await openLiffFileAction(taskId, fileId)).toBeNull()
    // Nobody signed in, or something that is not a task's or a file's id
    signInBrowser(null)
    expect(await openLiffFileAction(taskId, fileId)).toBeNull()
    signInBrowser((await liffSession('vp_ops')).cookie)
    expect(await openLiffFileAction(taskId, '../../etc/passwd')).toBeNull()
    expect(await openLiffFileAction('../../etc/passwd', fileId)).toBeNull()
  })

  it('opens only the files of the document its task decides — no other file the member’s roles could read in the organization', async () => {
    // Two requests wait for the same approver, each with its quotation
    const first = await waitingRequest('45000.00')
    const second = await waitingRequest('46000.00')
    const [firstFile, secondFile] = [await quotationOf(first.requestId), await quotationOf(second.requestId)]
    signInBrowser((await liffSession('vp_ops')).cookie)
    // Each opens through its own task; the approver may read both requests, yet neither opens through the other's task
    expect(await openLiffFileAction(second.taskId, secondFile)).toMatch(/X-Amz-Signature=/)
    expect((await getDownloadUrl(org.ctxOf('vp_ops', NOW, 'LIFF'), { fileId: secondFile })).ok).toBe(true)
    expect(await openLiffFileAction(first.taskId, secondFile)).toBeNull()
    expect(await openLiffFileAction(second.taskId, firstFile)).toBeNull()
    // An AUDITOR reads every request's files in the organization (request.view ORG), but decides neither task: a LINE
    // sign-in of theirs opens none of them through a LIFF task page
    await holds('auditor', 'AUDITOR')
    expect((await getDownloadUrl(org.ctxOf('auditor', NOW, 'LIFF'), { fileId: firstFile })).ok).toBe(true)
    signInBrowser((await liffSession('auditor')).cookie)
    expect(await openLiffFileAction(first.taskId, firstFile)).toBeNull()
    expect(await openLiffFileAction(second.taskId, secondFile)).toBeNull()
  })
})

describe('[FR-LINE-003/AC1] what is left on a request’s budget line, beside the decision in LIFF', () => {
  it('is told to a head of the line’s department and to the organization’s budget readers, and to nobody else', async () => {
    const line = await prisma.budgetLine.findFirstOrThrow({ where: { organizationId: org.organizationId, code: 'CON-OPEX-2569' } })
    const left = (await prisma.budgetLineBalance.findUniqueOrThrow({ where: { budgetLineId: line.id } })).availableSatang
    await holds('auditor', 'AUDITOR')
    // The VP and the DM above the line's department, and an AUDITOR (budget.view ORG): the balance, nothing else of the line
    for (const reader of ['vp_ops', 'dm_con', 'auditor']) {
      const r = await budgetLineAvailable(org.ctxOf(reader, NOW, 'LIFF'), line.id)
      expect(r, reader).toEqual({ ok: true, data: { available: { amount: expect.stringMatching(/^\d+\.\d\d$/), currency: 'THB' } } })
      if (r.ok) expect(amountToSatang(r.data.available.amount)).toBe(left)
    }
    // The approver of another division, a head of another department, a requester: the line's figures are not theirs (§2.4)
    for (const outsider of ['vp_sup', 'dm_fin', 'req_con']) {
      expect(await budgetLineAvailable(org.ctxOf(outsider, NOW, 'LIFF'), line.id), outsider).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    }
    expect(await budgetLineAvailable(org.ctxOf('vp_ops', NOW, 'LIFF'), 'not-a-line')).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } })
  })
})

/** The demo's DOA change: the DM band ends at 30,000 and the VP band starts there; sent by the admin with the tick */
async function doaVersionWaitingForCeo() {
  const v1 = (await prisma.doaVersion.findFirstOrThrow({ where: { organizationId: org.organizationId, versionNo: 1 } })).id
  const view = await getDoaEditor(org.ctxOf('admin', NOW), v1)
  if (!view.ok) throw new Error(`editor failed: ${view.error.code}`)
  const baht = (text: string) => amountToSatang(text).toString()
  const input: DraftCopyInput = {
    sourceVersionId: v1,
    effectiveDate: view.data.defaultEffectiveDate,
    changeReason: 'ขยายวงเงิน DM เป็น 30,000 บาท',
    policy: { ...view.data.policy },
    rules: view.data.rules.map((r) => ({
      code: r.code,
      documentType: r.documentType,
      band: r.band ? { ...r.band, ...(r.code === 'PR-01' ? { upper: baht('30000.00') } : r.code === 'PR-02' ? { lower: baht('30000.00') } : {}) } : null,
      steps: r.steps.map((s) => ({ approver: { ...s.approver }, slaMinutes: s.slaMinutes })),
    })),
  }
  const saved = await draftDoaCopy(org.ctxOf('admin', NOW), input, key())
  if (!saved.ok) throw new Error(`draft failed: ${saved.error.code}`)
  const sent = await submitDoaVersion(org.ctxOf('admin', NOW), { versionId: saved.data.versionId, boundaryTableConfirmed: true }, key())
  if (!sent.ok) throw new Error(`submit failed: ${sent.error.code}`)
  const task = await prisma.approvalTask.findFirstOrThrow({ where: { status: 'OPEN', step: { route: { subjectType: 'DOA_VERSION', subjectId: saved.data.versionId } } } })
  return { versionId: saved.data.versionId, taskId: task.id }
}

describe('[FR-DOA-009/AC3] [BR-DOA-15] [FR-AUTH-005/AC2] a DOA version approved in LIFF (NEW-41)', () => {
  it('is not approved before the boundary table is ticked; with the tick of the table the page showed and the PIN it is published, on channel LIFF, with a new session id', async () => {
    const { versionId, taskId } = await doaVersionWaitingForCeo()
    const ceo = memberPrincipal(member('ceo'), ['EXECUTIVE'])
    const ctx = org.ctxOf('ceo', NOW, 'LIFF')
    const view = await getTaskView(ctx, taskId)
    const tick = boundaryTickOf(view!)
    // The page shows the table, so the form sends its tick with the version the table compared with
    expect(tick).not.toBeNull()
    // The CEO, signed in with LINE
    const { cookie, signedIn, row } = await liffSession('ceo')

    // Unticked: refused before the PIN is tried, said at the tick
    const unticked = await decidePolicy(ctx, ceo, { taskId, decision: 'APPROVE', pin: TEST_PIN, boundaryTableConfirmed: false, boundaryBaselineId: tick!.baselineId }, randomUUID(), 'th', liffStepUp(cookie, signedIn))
    expect(answered(unticked)).toEqual({ ok: false, at: 'tick', text: th.tasks.errors.BOUNDARY_NOT_CONFIRMED })
    // Left out (a form that did not send it): the service itself asks for the tick (BR-AUTH-05), and approves nothing
    const leftOut = await decidePolicy(ctx, ceo, { taskId, decision: 'APPROVE', pin: TEST_PIN }, randomUUID(), 'th', liffStepUp(cookie, signedIn))
    expect(answered(leftOut)).toEqual({ ok: false, at: 'tick', text: th.tasks.errors.BOUNDARY_NOT_CONFIRMED })
    expect((await prisma.doaVersion.findUniqueOrThrow({ where: { id: versionId } })).status).toBe('PENDING_APPROVAL')
    expect(await decidedEvent(taskId)).toBeNull()

    // (a form that sent no tick at all had its right PIN checked first, and its session's token changed then)
    const before = (await tokenOf(row.id))!
    const session = liffStepUp(await signedCookieFor(before), signedIn)
    const approved = await decidePolicy(ctx, ceo, { taskId, decision: 'APPROVE', pin: TEST_PIN, boundaryTableConfirmed: true, boundaryBaselineId: tick!.baselineId }, randomUUID(), 'th', session)
    expect(approved).toEqual({ ok: true, documentStatus: 'PUBLISHED' })
    // NFR-SEC-04 for a policy decision too: the LINE sign-in's session got a new token, once, and the browser holds it
    const after = (await tokenOf(row.id))!
    expect(after).not.toBe(before)
    expect(after.startsWith(LIFF_SESSION_TOKEN_PREFIX)).toBe(true)
    expect(session.rotated).toEqual([await signedCookieFor(after)])
    expect(cookie).not.toBe(await signedCookieFor(after))
    expect(await decidedEvent(taskId)).toMatchObject({
      channel: 'LIFF',
      data: { decision: 'APPROVE', subjectType: 'DOA_VERSION', subjectId: versionId, channel: 'LIFF', boundaryTableConfirmed: true, stepUpGrantId: expect.any(String) },
    })
  })
})
