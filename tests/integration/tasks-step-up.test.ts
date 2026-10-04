import { createHmac, randomBytes, randomUUID } from 'node:crypto'
import { parseSetCookieHeader } from 'better-auth/cookies'
import { MutableRequestCookiesAdapter, responseCookiesToRequestCookies } from 'next/dist/server/web/spec-extension/adapters/request-cookies'
import { RequestCookies } from 'next/dist/server/web/spec-extension/cookies'
import { beforeAll, describe, expect, it } from 'vitest'
import { decidePolicy, decideRequestTask } from '@/app/(workspace)/_tracking/commands'
import { withHeldCookies } from '@/app/_lib/held-cookies'
import { getEnv } from '@/lib/env'
import { auth } from '@/server/auth/auth'
import { LIFF_SESSION_TOKEN_PREFIX } from '@/server/auth/liff'
import { upsertUserWithPassword } from '@/server/auth/provision'
import { resolveSession } from '@/server/auth/session'
import { rotateSessionAfterStepUp, type SignedInSession } from '@/server/auth/session-rotation'
import { listMySessions } from '@/server/auth/sessions'
import { memberPrincipal } from '@/server/authz'
import { prisma } from '@/server/db/client'
import { getTaskAccess, getTaskView, listMyTasks } from '@/server/queries/tasks'
import { proposeOrgChange } from '@/server/services/org-authority'
import { createDraft, submitRequest } from '@/server/services/requests'
import { taskErrorKey, toActionFailure, type ActionOutcome } from '@/ui/tasks/outcome'
import { createDoaOrg, type DoaOrg } from '../support/doa-org'
import { seedTestPins, TEST_PIN, testStepUpSession } from '../support/pin'

// S5-05 on the web decision page (FR-AUTH-005 AC2, NFR-SEC-04): the commands behind its buttons
// (src/app/(workspace)/_tracking/commands.ts) take the PIN with a decision that needs a step-up — a policy task, or an
// amount at or above the DOA version's stepUpThreshold — grant the step-up on the security clock, change the session id,
// then decide, in that order. Only the task's decider spends a PIN try, a wrong or missing PIN decides nothing and says
// what to do, and the PIN goes nowhere but the check. The task list and the decision page flag every task that needs the
// PIN. Then the session id change itself (src/server/auth/session-rotation.ts), and the page the action renders again
// reading the new id (src/app/_lib/session.ts, with Next.js's own cookie stores). Real Postgres (BCS_TEST_DB), the §7.4
// fixtures: stepUpThreshold 100,000.00 baht.

const NOW = new Date('2026-10-05T03:00:00Z')
const key = () => ({ idempotencyKey: randomUUID(), sender: null })
const WRONG = '502918'
const PASSWORD = 'tasks-step-up-password-01'

let org: DoaOrg
const member = (code: string) => org.member[code]!

beforeAll(async () => {
  org = await createDoaOrg()
  await prisma.roleAssignment.create({ data: { organizationId: org.organizationId, memberId: member('admin'), role: 'ORG_ADMIN', grantedAt: NOW } })
  await seedTestPins(org.organizationId)
})

async function waitingRequest(requester: string, grossBaht: string) {
  const draft = await createDraft(
    org.ctxOf(requester, NOW),
    { requestTypeCode: 'BUY_GOODS', title: 'วัสดุก่อสร้าง', priceIncludesVat: true, lines: [{ description: 'ปูนซีเมนต์', quantity: '1', uom: 'งาน', unitPrice: grossBaht }] },
    key(),
  )
  if (!draft.ok) throw new Error(`draft failed: ${draft.error.code}`)
  const sent = await submitRequest(org.ctxOf(requester, NOW), { requestId: draft.data.requestId }, key())
  if (!sent.ok) throw new Error(`submit failed: ${sent.error.code}`)
  const task = await prisma.approvalTask.findFirstOrThrow({ where: { status: 'OPEN', step: { route: { subjectType: 'REQUEST', subjectId: draft.data.requestId } } } })
  return { requestId: draft.data.requestId, taskId: task.id }
}

const pinState = (code: string) => prisma.member.findUniqueOrThrow({ where: { id: member(code) }, select: { pinFailedCount: true, pinLockedUntil: true } })
const grantsOf = (subjectId: string) => prisma.stepUpGrant.findMany({ where: { subjectId }, select: { memberId: true, method: true, usedAt: true } })
const taskStatus = async (taskId: string) => (await prisma.approvalTask.findUniqueOrThrow({ where: { id: taskId } })).status
const keyOf = (outcome: ActionOutcome) => (outcome.ok ? null : taskErrorKey(outcome))

describe('[FR-AUTH-005/AC2] the decision page decides a task at the threshold with the PIN, then a new session id', () => {
  it('flags the task in the inbox and on the page, and only there: a request below the threshold asks for no PIN', async () => {
    const at = await waitingRequest('req_con', '100000.00')
    const below = await waitingRequest('req_con', '99999.99')
    const inbox = await listMyTasks(org.ctxOf('vp_ops', NOW))
    expect(inbox.items.find((i) => i.id === at.taskId)).toMatchObject({ stepUp: true })
    expect(inbox.items.find((i) => i.id === below.taskId)).toMatchObject({ stepUp: false })
    expect(await getTaskView(org.ctxOf('vp_ops', NOW), at.taskId)).toMatchObject({ stepUp: true, policy: null })
    expect(await getTaskView(org.ctxOf('vp_ops', NOW), below.taskId)).toMatchObject({ stepUp: false })
    expect(await getTaskAccess(org.ctxOf('vp_ops', NOW), at.taskId)).toMatchObject({ stepUp: true })
    expect(await getTaskAccess(org.ctxOf('vp_ops', NOW), below.taskId)).toMatchObject({ stepUp: false })
  })

  it('approves with the right PIN: the step-up is granted, the session id changes, and the decision uses the step-up', async () => {
    const { requestId, taskId } = await waitingRequest('req_con', '100000.00')
    const session = testStepUpSession()
    expect(await decideRequestTask(org.ctxOf('vp_ops', NOW), { taskId, decision: 'APPROVE', pin: TEST_PIN }, randomUUID(), 'th', session)).toEqual({ ok: true, documentStatus: 'APPROVED' })
    expect(session.rotated).toHaveLength(1)
    const [grant, ...more] = await prisma.stepUpGrant.findMany({ where: { subjectId: requestId } })
    expect(more).toEqual([])
    expect(grant).toMatchObject({ memberId: member('vp_ops'), method: 'PIN', usedAt: expect.any(Date) })
    const decided = await prisma.event.findFirstOrThrow({ where: { type: 'approval_task.decided', aggregateId: taskId } })
    expect(decided).toMatchObject({ channel: 'WEB', data: { stepUpGrantId: grant!.id } })
    // The PIN is in no event or command record of the decision
    const asText = (rows: unknown) => JSON.stringify(rows, (_, v: unknown) => (typeof v === 'bigint' ? v.toString() : v))
    const written = asText(await prisma.event.findMany({ where: { organizationId: org.organizationId, aggregateId: { in: [taskId, requestId] } } })) + asText(await prisma.commandLog.findMany({ where: { organizationId: org.organizationId } }))
    expect(written).not.toContain(TEST_PIN)
  })

  it('returns with the PIN too, and tells a return without its reason before a PIN try is spent', async () => {
    const { taskId } = await waitingRequest('req_con', '100000.00')
    const session = testStepUpSession()
    const before = await pinState('vp_ops')
    expect(await decideRequestTask(org.ctxOf('vp_ops', NOW), { taskId, decision: 'RETURN', reason: ' ก ', pin: WRONG }, randomUUID(), 'th', session)).toEqual({ ok: false, code: 'VALIDATION_FAILED', field: 'reason' })
    expect(await pinState('vp_ops')).toEqual(before)
    expect(await decideRequestTask(org.ctxOf('vp_ops', NOW), { taskId, decision: 'RETURN', reason: 'แยกรายการให้ชัดเจน', pin: TEST_PIN }, randomUUID(), 'th', session)).toEqual({ ok: true, documentStatus: 'RETURNED' })
    expect(session.rotated).toHaveLength(1)
  })

  it('a wrong PIN decides nothing, keeps the session id and says how many tries are left; a missing or malformed PIN is told before a try', async () => {
    const { requestId, taskId } = await waitingRequest('req_con', '100000.00')
    const session = testStepUpSession()
    const before = await pinState('vp_ops')
    // Told before anything is checked or counted
    for (const pin of [undefined, '12345', '12345a', '1234567']) {
      expect(await decideRequestTask(org.ctxOf('vp_ops', NOW), { taskId, decision: 'APPROVE', ...(pin === undefined ? {} : { pin }) }, randomUUID(), 'th', session), String(pin)).toEqual({ ok: false, code: 'VALIDATION_FAILED', field: 'pin' })
    }
    expect(await pinState('vp_ops')).toEqual(before)
    const wrong = await decideRequestTask(org.ctxOf('vp_ops', NOW), { taskId, decision: 'APPROVE', pin: WRONG }, randomUUID(), 'th', session)
    expect(wrong).toEqual({ ok: false, code: 'VALIDATION_FAILED', field: 'pin', reason: 'WRONG', attemptsLeft: 4 })
    expect(keyOf(wrong)).toBe('PIN_INVALID')
    expect(JSON.stringify(wrong)).not.toContain(WRONG)
    expect(session.rotated).toEqual([])
    expect(await taskStatus(taskId)).toBe('OPEN')
    expect(await grantsOf(requestId)).toEqual([])
    // The right PIN starts the count of wrong ones again
    expect(await decideRequestTask(org.ctxOf('vp_ops', NOW), { taskId, decision: 'APPROVE', pin: TEST_PIN }, randomUUID(), 'th', session)).toMatchObject({ ok: true })
    expect(await pinState('vp_ops')).toEqual({ pinFailedCount: 0, pinLockedUntil: null })
  })

  it('five wrong PINs lock it: the page says until when, and even the right PIN decides nothing until then', async () => {
    const { taskId } = await waitingRequest('fin_officer', '100000.00')
    expect((await prisma.approvalTask.findUniqueOrThrow({ where: { id: taskId } })).assigneeMemberId).toBe(member('vp_sup'))
    const session = testStepUpSession()
    let last: ActionOutcome = { ok: true }
    for (let i = 0; i < 5; i++) last = await decideRequestTask(org.ctxOf('vp_sup', NOW), { taskId, decision: 'APPROVE', pin: WRONG }, randomUUID(), 'th', session)
    const { pinLockedUntil } = await pinState('vp_sup')
    expect(last).toEqual({ ok: false, code: 'STEP_UP_LOCKED', time: pinLockedUntil!.toISOString() })
    expect(keyOf(last)).toBe('PIN_LOCKED')
    expect(await decideRequestTask(org.ctxOf('vp_sup', NOW), { taskId, decision: 'APPROVE', pin: TEST_PIN }, randomUUID(), 'th', session)).toMatchObject({ ok: false, code: 'STEP_UP_LOCKED' })
    expect(session.rotated).toEqual([])
    expect(await taskStatus(taskId)).toBe('OPEN')
  })

  it('a decider without a PIN is told to set one first (PIN_NOT_SET, the page links to /settings/pin)', async () => {
    const { taskId } = await waitingRequest('req_con', '100000.00')
    await prisma.member.update({ where: { id: member('vp_ops') }, data: { transactionPinHash: null } })
    try {
      const outcome = await decideRequestTask(org.ctxOf('vp_ops', NOW), { taskId, decision: 'APPROVE', pin: TEST_PIN }, randomUUID(), 'th', testStepUpSession())
      expect(outcome).toEqual({ ok: false, code: 'STEP_UP_REQUIRED', reason: 'PIN_NOT_SET' })
      expect(keyOf(outcome)).toBe('PIN_NOT_SET')
      expect(await taskStatus(taskId)).toBe('OPEN')
    } finally {
      await seedTestPins(org.organizationId)
    }
  })

  it('a member who does not decide the task spends no PIN try on it, and the service refuses them', async () => {
    const { requestId, taskId } = await waitingRequest('req_con', '100000.00')
    const session = testStepUpSession()
    const before = await pinState('vp_sup')
    expect(await decideRequestTask(org.ctxOf('vp_sup', NOW), { taskId, decision: 'APPROVE', pin: WRONG }, randomUUID(), 'th', session)).toEqual({ ok: false, code: 'FORBIDDEN' })
    expect(await pinState('vp_sup')).toEqual(before)
    expect(await grantsOf(requestId)).toEqual([])
    expect(session.rotated).toEqual([])
  })

  it('below the threshold a PIN sent along is not read: no try, no grant, no new session id', async () => {
    const { requestId, taskId } = await waitingRequest('req_con', '45000.00')
    const session = testStepUpSession()
    const before = await pinState('vp_ops')
    expect(await decideRequestTask(org.ctxOf('vp_ops', NOW), { taskId, decision: 'APPROVE', pin: WRONG }, randomUUID(), 'th', session)).toEqual({ ok: true, documentStatus: 'APPROVED' })
    expect(await pinState('vp_ops')).toEqual(before)
    expect(await grantsOf(requestId)).toEqual([])
    expect(session.rotated).toEqual([])
  })

  it('when the session can no longer change (signed out meanwhile), nothing is decided and the grant stays unused', async () => {
    const { requestId, taskId } = await waitingRequest('req_con', '100000.00')
    const session = { ...testStepUpSession(), rotateSession: async () => false }
    expect(await decideRequestTask(org.ctxOf('vp_ops', NOW), { taskId, decision: 'APPROVE', pin: TEST_PIN }, randomUUID(), 'th', session)).toEqual({ ok: false, code: 'UNAUTHENTICATED' })
    expect(await taskStatus(taskId)).toBe('OPEN')
    expect(await grantsOf(requestId)).toEqual([{ memberId: member('vp_ops'), method: 'PIN', usedAt: null }])
  })

  it('decides a policy change with the PIN the same way, and a wrong PIN there decides nothing', async () => {
    const proposed = await proposeOrgChange(
      org.ctxOf('admin', NOW),
      { kind: 'POSITION_ASSIGN', payload: { positionCode: 'DM', departmentId: org.department.IT!, memberId: member('admin2') }, effectiveFrom: '2026-12-01T01:00:00Z', reason: 'แต่งตั้งตามคำสั่งบริษัท' },
      key(),
    )
    if (!proposed.ok) throw new Error(`propose failed: ${proposed.error.code}`)
    const task = await prisma.approvalTask.findFirstOrThrow({ where: { status: 'OPEN', step: { route: { subjectId: proposed.data.changeId } } } })
    const ceo = memberPrincipal(member('ceo'), ['EXECUTIVE'])
    const session = testStepUpSession()
    const wrong = await decidePolicy(org.ctxOf('ceo', NOW), ceo, { taskId: task.id, decision: 'APPROVE', pin: WRONG }, randomUUID(), 'th', session)
    expect(wrong).toEqual({ ok: false, code: 'VALIDATION_FAILED', field: 'pin', reason: 'WRONG', attemptsLeft: 4 })
    expect(session.rotated).toEqual([])
    expect(await decidePolicy(org.ctxOf('ceo', NOW), ceo, { taskId: task.id, decision: 'APPROVE', pin: TEST_PIN }, randomUUID(), 'th', session)).toEqual({ ok: true, documentStatus: 'SCHEDULED' })
    expect(session.rotated).toHaveLength(1)
    expect((await prisma.event.findFirstOrThrow({ where: { type: 'approval_task.decided', aggregateId: task.id } })).data).toMatchObject({ stepUpGrantId: expect.any(String) })
  })

  it('tells each refusal of the PIN apart for the page (unit of the screen words)', () => {
    expect(taskErrorKey(toActionFailure({ code: 'VALIDATION_FAILED', details: { field: 'pin' } }))).toBe('PIN')
    expect(taskErrorKey(toActionFailure({ code: 'STEP_UP_REQUIRED', details: { subjectType: 'REQUEST', method: 'PIN' } }))).toBe('STEP_UP')
  })
})

/** Signs a member in with the password through Better Auth's HTTP handler and returns the session cookie */
async function signedIn(code: string): Promise<string> {
  const m = await prisma.member.findUniqueOrThrow({ where: { id: member(code) } })
  const userId = await upsertUserWithPassword({ email: m.email, name: m.displayNameTh, password: PASSWORD })
  await prisma.member.update({ where: { id: m.id }, data: { userId } })
  const env = getEnv()
  const res = await auth.handler(
    new Request(`${env.BETTER_AUTH_URL}/api/auth/sign-in/email`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: env.APP_URL, 'x-forwarded-for': `198.18.41.${Math.floor(Math.random() * 200) + 1}` },
      body: JSON.stringify({ email: m.email, password: PASSWORD }),
    }),
  )
  expect(res.status).toBe(200)
  return res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ')
}

const sessionsOf = async (code: string) => {
  const m = await prisma.member.findUniqueOrThrow({ where: { id: member(code) }, select: { userId: true } })
  return prisma.session.findMany({ where: { userId: m.userId! }, orderBy: { createdAt: 'asc' } })
}

/** The session a request with this cookie is signed in with, as the decision page's server action reads it */
async function signedInAs(cookie: string): Promise<SignedInSession> {
  const state = await resolveSession(new Headers({ cookie }))
  if (state.kind !== 'member' && state.kind !== 'needs-2fa-setup') throw new Error(`no member session: ${state.kind}`)
  return { sessionId: state.sessionId, userId: state.userId }
}

/** The session cookie among Set-Cookie lines, as a browser sends it back */
const sessionCookieOf = (setCookie: readonly string[]) =>
  setCookie
    .map((c) => c.split(';')[0]!)
    .filter((c) => c.includes('session_token='))
    .join('; ')

/** The cookie Better Auth signs for a session token (better-call: HMAC-SHA256 with the auth secret, URI-encoded) */
async function signedCookieFor(token: string): Promise<string> {
  const context = await auth.$context
  const signature = createHmac('sha256', context.secret).update(token).digest('base64')
  return `${context.authCookies.sessionToken.name}=${encodeURIComponent(`${token}.${signature}`)}`
}

describe('[NFR-SEC-04] [FR-AUTH-005/AC2] after a step-up the browser gets a new session id for the same sign-in', () => {
  it('gives the session a new id at once with the same absolute lifetime: the old cookie opens nothing, the new one signs the member in, one device row', async () => {
    const cookie = await signedIn('req_con')
    const signed = await signedInAs(cookie)
    const [old, ...others] = await sessionsOf('req_con')
    expect(others).toEqual([])
    const at = Date.now()
    const rotated = await rotateSessionAfterStepUp(new Headers({ cookie }), signed)
    if (!rotated.ok) throw new Error(`rotation refused: ${rotated.reason}`)
    const fresh = sessionCookieOf(rotated.setCookie)
    expect(fresh).toMatch(/session_token=/)
    expect(fresh).not.toBe(cookie)

    const rows = await sessionsOf('req_con')
    expect(rows).toHaveLength(1)
    const now = rows[0]!
    // A new session id (the token its cookie carries), never longer than the sign-in allowed (FR-AUTH-003 AC1); the
    // step-up is activity
    expect(now.token).not.toBe(old!.token)
    expect(now).toMatchObject({ id: old!.id, userId: old!.userId, createdAt: old!.createdAt, expiresAt: old!.expiresAt })
    expect(now.lastActiveAt!.getTime()).toBeGreaterThanOrEqual(at - 1000)

    // The new cookie is the member's session, the same sign-in; the old one opens nothing from now on — not even for a
    // moment — and cannot be turned into another session
    expect(await resolveSession(new Headers({ cookie: fresh }))).toMatchObject({ kind: 'member', sessionId: old!.id, member: { id: member('req_con') } })
    expect(await resolveSession(new Headers({ cookie }))).toEqual({ kind: 'anonymous' })
    expect(await rotateSessionAfterStepUp(new Headers({ cookie }), { sessionId: randomUUID(), userId: signed.userId })).toEqual({ ok: false, reason: 'NO_SESSION' })
    // FR-AUTH-003 AC3: the devices list shows this browser once, as the current one
    expect(await listMySessions(signed.userId, signed.sessionId)).toEqual([expect.objectContaining({ id: signed.sessionId, current: true })])
    expect(await sessionsOf('req_con')).toHaveLength(1)
  })

  it('deletes the sessions of the same sign-in that have ended, and refuses a request without a session', async () => {
    const cookie = await signedIn('asst_con')
    const signed = await signedInAs(cookie)
    const [current] = await sessionsOf('asst_con')
    const ended = await prisma.session.create({ data: { id: randomUUID(), userId: current!.userId, token: `ended-${randomUUID()}`, expiresAt: new Date(Date.now() - 1000), createdAt: new Date(Date.now() - 2000) } })
    const rotated = await rotateSessionAfterStepUp(new Headers({ cookie }), signed)
    expect(rotated.ok).toBe(true)
    expect(await prisma.session.findUnique({ where: { id: ended.id } })).toBeNull()
    expect(await rotateSessionAfterStepUp(new Headers(), signed)).toEqual({ ok: false, reason: 'NO_SESSION' })
  })

  it('two step-ups of one session at the same moment change it once, and every answer carries the session id in force', async () => {
    const cookie = await signedIn('auditor')
    const signed = await signedInAs(cookie)
    // Four tabs of one browser decide at once, each after a right PIN
    const results = await Promise.all([0, 1, 2, 3].map(() => rotateSessionAfterStepUp(new Headers({ cookie }), signed)))
    const cookies = results.map((r) => {
      if (!r.ok) throw new Error(`rotation refused: ${r.reason}`)
      return sessionCookieOf(r.setCookie)
    })
    expect(new Set(cookies).size).toBe(1)
    const [row, ...more] = await sessionsOf('auditor')
    expect(more).toEqual([])
    expect(row).toMatchObject({ id: signed.sessionId })
    expect(cookies[0]).toBe(await signedCookieFor(row!.token))
    expect(await resolveSession(new Headers({ cookie: cookies[0]! }))).toMatchObject({ kind: 'member', sessionId: signed.sessionId })
    expect(await resolveSession(new Headers({ cookie }))).toEqual({ kind: 'anonymous' })
  })

  it('the page the server action renders again reads the new session id from the cookies Next.js holds after the action, not from the old Cookie header', async () => {
    const cookie = await signedIn('fin_officer')
    const signed = await signedInAs(cookie)
    const sessionCookieName = (await auth.$context).authCookies.sessionToken.name
    // What the request came with — the session cookie and another one, URI-encoded — stays in headers() for the whole
    // request
    const incoming = new Headers({ cookie: `${cookie}; bcs_other=a%20b%2Bc`, 'user-agent': 'bcs-int-test' })
    // The cookies of a server action's request as Next.js holds them (next/dist/server/async-storage/request-store.js):
    // the request's own, made mutable…
    const held = MutableRequestCookiesAdapter.wrap(new RequestCookies(incoming))
    const rotated = await rotateSessionAfterStepUp(incoming, signed)
    if (!rotated.ok) throw new Error(`rotation refused: ${rotated.reason}`)
    // …with what the action set over them: the nextCookies() plugin sets each Set-Cookie of a Better Auth endpoint, decoded
    for (const line of rotated.setCookie) for (const [name, value] of parseSetCookieHeader(line)) held.set(name, value.value)
    // …which synchronizeMutableCookies hands to cookies() for the page rendered again after the action
    const jar = responseCookiesToRequestCookies(held).getAll()

    // The Cookie header the request came with names the token the step-up just replaced: it opens nothing
    expect(await resolveSession(incoming)).toEqual({ kind: 'anonymous' })
    // Written from cookies(), it is the member's session, the same sign-in; the other headers and cookies are kept as sent
    const current = withHeldCookies(incoming, jar)
    expect(await resolveSession(current)).toMatchObject({ kind: 'member', sessionId: signed.sessionId, member: { id: member('fin_officer') } })
    expect(current.get('cookie')).toContain(sessionCookieOf(rotated.setCookie))
    expect(current.get('cookie')).toContain('bcs_other=a%20b%2Bc')
    expect(current.get('user-agent')).toBe('bcs-int-test')
    expect(incoming.get('cookie')).toBe(`${cookie}; bcs_other=a%20b%2Bc`)

    // A cookie deleted during the request (empty) is left out: no session, and no Cookie header when none is left
    held.delete(sessionCookieName)
    const signedOut = withHeldCookies(incoming, responseCookiesToRequestCookies(held).getAll())
    expect(signedOut.get('cookie')).not.toContain(`${sessionCookieName}=`)
    expect(signedOut.get('cookie')).toContain('bcs_other=a%20b%2Bc')
    expect(await resolveSession(signedOut)).toEqual({ kind: 'anonymous' })
    expect(withHeldCookies(incoming, []).has('cookie')).toBe(false)
  })

  it('hands no session id to a request whose session was signed out or has ended, or that names another session; a LIFF session is refused', async () => {
    // Signed out while the PIN was checked
    const signedOut = await signedIn('proc_officer')
    const gone = await signedInAs(signedOut)
    await prisma.session.delete({ where: { id: gone.sessionId } })
    expect(await rotateSessionAfterStepUp(new Headers({ cookie: signedOut }), gone)).toEqual({ ok: false, reason: 'NO_SESSION' })

    // The member signed in on a second device: a request whose own session is live never gets the other one
    const first = await signedIn('receiver_con')
    const firstSession = await signedInAs(first)
    const other = await prisma.session.create({ data: { id: randomUUID(), userId: firstSession.userId, token: randomBytes(24).toString('base64url'), expiresAt: new Date(Date.now() + 60 * 60 * 1000) } })
    const secondSession: SignedInSession = { sessionId: other.id, userId: firstSession.userId }
    const tokens = async () => (await sessionsOf('receiver_con')).map((s) => s.token).sort()
    const before = await tokens()
    expect(before).toHaveLength(2)
    expect(await rotateSessionAfterStepUp(new Headers({ cookie: first }), secondSession)).toEqual({ ok: false, reason: 'NO_SESSION' })
    expect(await tokens()).toEqual(before)

    // Ended (its absolute lifetime is over)
    await prisma.session.update({ where: { id: firstSession.sessionId }, data: { expiresAt: new Date(Date.now() - 1000) } })
    expect(await rotateSessionAfterStepUp(new Headers({ cookie: first }), firstSession)).toEqual({ ok: false, reason: 'NO_SESSION' })

    // A session opened from a LIFF ID token is renewed by a new ID token only (src/server/auth/liff.ts)
    const liffToken = `${LIFF_SESSION_TOKEN_PREFIX}${randomBytes(24).toString('base64url')}`
    const liff = await prisma.session.create({ data: { id: randomUUID(), userId: secondSession.userId, token: liffToken, expiresAt: new Date(Date.now() + 60 * 60 * 1000) } })
    expect(await rotateSessionAfterStepUp(new Headers({ cookie: await signedCookieFor(liffToken) }), { sessionId: liff.id, userId: secondSession.userId })).toEqual({ ok: false, reason: 'REFUSED' })
    expect((await prisma.session.findUniqueOrThrow({ where: { id: liff.id } })).token).toBe(liffToken)
  })
})
