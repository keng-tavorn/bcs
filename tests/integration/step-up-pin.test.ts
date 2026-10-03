import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { setEmailProvider, type EmailMessage } from '@/integrations/email-provider'
import { totp } from '@/lib/totp'
import { enableTotpWithSecret, upsertUserWithPassword } from '@/server/auth/provision'
import { consumeStepUp, grantStepUp, PIN_ONLY, policyStepUpMethods, requireStepUp, stepUpRefusalError, type StepUpOptions, type StepUpRefusal } from '@/server/auth/step-up'
import { prisma } from '@/server/db/client'
import { forTenant, type TenantTx } from '@/server/db/tenant'
import { deliverNotification } from '@/server/notifications/deliver'
import { renderNotification } from '@/server/notifications/templates'
import { decideTask } from '@/server/services/approvals/decide'
import { proposeOrgChange } from '@/server/services/org-authority'
import { createDraft, submitRequest } from '@/server/services/requests'
import { confirmIdentityForPin, setOwnPin } from '@/server/services/self/pin'
import { createDoaOrg, type DoaOrg } from '../support/doa-org'

// S5-05, FR-AUTH-005 AC2 and AC3: a decision that needs a step-up — every DOA version and authority change (BR-DOA-15),
// and every task whose DOA amount is at or above the version's stepUpThreshold (BR-TOK-05) — is refused
// STEP_UP_REQUIRED without a grant for that document; a right PIN gives a grant good once and for 5 minutes on the
// security clock (§9.3); five wrong PINs in a row lock the PIN for 15 minutes (STEP_UP_LOCKED), write
// security.pin_locked and e-mail the owner security.notice (§10.1), and that lock never fails open. Real Postgres
// (BCS_TEST_DB), the §7.4 fixtures: stepUpThreshold 100,000.00 baht; a request up to that amount goes to the VP of its
// line, policy goes to the CEO.
// Request, PO and variance decisions do not call the gate yet (see the notes of S5-05): only the policy decisions
// carry the AC2 tag here; the gate itself is tested under BR-TOK-05.

const NOW = new Date('2026-10-05T03:00:00Z')
const MINUTE = 60_000
const key = () => ({ idempotencyKey: randomUUID(), sender: null })
const PASSWORD = 'step-up-test-password-01'
const CEO_SECRET = 'C'.repeat(32)
const PINS: Record<string, string> = { ceo: '739164', vp_ops: '480263', dm_con: '915372', dm_it: '264809', vp_sup: '503817', dm_fin: '826154', dm_proc: '371946', coo: '502719' }
const WRONG = '502918'
const mails: EmailMessage[] = []

let org: DoaOrg
const member = (code: string) => org.member[code]!
const inTx = <T>(run: (tx: TenantTx) => Promise<T>) => forTenant(org.organizationId).$transaction(run)

/** The member signs in with a password (the CEO with an authenticator too) and sets their PIN the way the screens do */
async function withPin(code: string) {
  const m = await prisma.member.findUniqueOrThrow({ where: { id: member(code) } })
  const userId = await upsertUserWithPassword({ email: m.email, name: m.displayNameTh, password: PASSWORD })
  if (code === 'ceo') await enableTotpWithSecret(userId, CEO_SECRET, [])
  await prisma.member.update({ where: { id: m.id }, data: { userId } })
  const proved = await confirmIdentityForPin(org.ctxOf(code, NOW), { method: 'PASSWORD', password: PASSWORD })
  if (!proved.ok) throw new Error(`proof refused for ${code}`)
  const set = await setOwnPin(org.ctxOf(code, NOW), { memberId: m.id, pin: PINS[code]!, proofToken: proved.data.proofToken }, key())
  if (!set.ok) throw new Error(`PIN refused for ${code}: ${set.error.code}`)
}

/** A PIN step-up of the member for this document at `at` on the security clock */
const pinStepUp = (code: string, subjectType: string, subjectId: string, at: Date, pin = PINS[code]!, channel?: 'WEB' | 'LIFF', options: StepUpOptions = {}) =>
  grantStepUp({ organizationId: org.organizationId, memberId: member(code), subjectType, subjectId, method: 'PIN', pin, ...(channel ? { channel } : {}) }, at, { sender: null, ...options })

const pinState = (code: string) => prisma.member.findUniqueOrThrow({ where: { id: member(code) }, select: { pinFailedCount: true, pinLockedUntil: true } })

beforeAll(async () => {
  org = await createDoaOrg()
  await prisma.roleAssignment.create({ data: { organizationId: org.organizationId, memberId: member('admin'), role: 'ORG_ADMIN', grantedAt: NOW } })
  for (const code of Object.keys(PINS)) await withPin(code)
  setEmailProvider({
    async send(message) {
      mails.push(message)
      return { messageId: randomUUID() }
    },
  })
})
afterAll(() => setEmailProvider(null))

async function submitted(grossBaht: string) {
  const draft = await createDraft(
    org.ctxOf('req_con', NOW),
    { requestTypeCode: 'BUY_GOODS', title: 'วัสดุก่อสร้าง', priceIncludesVat: true, lines: [{ description: 'ปูนซีเมนต์', quantity: '1', uom: 'งาน', unitPrice: grossBaht }] },
    key(),
  )
  if (!draft.ok) throw new Error(`draft failed: ${draft.error.code}`)
  const sent = await submitRequest(org.ctxOf('req_con', NOW), { requestId: draft.data.requestId }, key())
  if (!sent.ok) throw new Error(`submit failed: ${sent.error.code}`)
  const route = await prisma.approvalRoute.findFirstOrThrow({
    where: { subjectType: 'REQUEST', subjectId: draft.data.requestId, status: 'ACTIVE' },
    select: { subjectType: true, subjectId: true, amountSatang: true, doaVersion: { select: { stepUpThresholdSatang: true } } },
  })
  return { subjectType: route.subjectType, subjectId: route.subjectId, amountSatang: route.amountSatang, stepUpThresholdSatang: route.doaVersion.stepUpThresholdSatang }
}

/** A pending authority change, whose task waits for the CEO */
async function authorityChangeTask(kind: 'assign' | 'reparent') {
  const proposed = await proposeOrgChange(
    org.ctxOf('admin', NOW),
    kind === 'assign'
      ? { kind: 'POSITION_ASSIGN', payload: { positionCode: 'DM', departmentId: org.department.IT!, memberId: member('admin2') }, effectiveFrom: '2026-12-01T01:00:00Z', reason: 'แต่งตั้งตามคำสั่งบริษัท' }
      : { kind: 'DEPARTMENT_REPARENT', payload: { departmentId: org.department.FIN!, newParentId: org.department.OPS! }, effectiveFrom: '2026-12-05T01:00:00Z', reason: 'ปรับโครงสร้างตามคำสั่งบริษัท' },
    key(),
  )
  if (!proposed.ok) throw new Error(`propose failed: ${proposed.error.code}`)
  const task = await prisma.approvalTask.findFirstOrThrow({ where: { status: 'OPEN', step: { route: { subjectType: 'ORG_AUTHORITY_CHANGE', subjectId: proposed.data.changeId } } } })
  expect(task.assigneeMemberId).toBe(member('ceo'))
  return { changeId: proposed.data.changeId, taskId: task.id }
}

describe('[§9.3] a step-up by PIN is good for one decision on one document, for 5 minutes', () => {
  it('grants with the right PIN only; the grant serves its document and member once, within 5 minutes on the security clock', async () => {
    const T = new Date()
    const subjectId = randomUUID()
    expect(await pinStepUp('vp_ops', 'REQUEST', subjectId, T, WRONG)).toEqual({ ok: false, reason: 'INVALID_CODE', method: 'PIN', attemptsLeft: 4 })
    const granted = await pinStepUp('vp_ops', 'REQUEST', subjectId, T)
    expect(granted).toEqual({ ok: true, grantId: expect.any(String), expiresAt: new Date(T.getTime() + 5 * MINUTE), method: 'PIN' })
    if (!granted.ok) return
    expect(await prisma.stepUpGrant.findUniqueOrThrow({ where: { id: granted.grantId } })).toMatchObject({ memberId: member('vp_ops'), subjectType: 'REQUEST', subjectId, method: 'PIN', grantedAt: T, usedAt: null })
    // The right PIN starts the count of wrong ones again
    expect(await pinState('vp_ops')).toEqual({ pinFailedCount: 0, pinLockedUntil: null })

    const use = (who: string, document: string, at: Date) => inTx((tx) => consumeStepUp(tx, { memberId: member(who), subjectType: 'REQUEST', subjectId: document, methods: PIN_ONLY }, at))
    expect(await use('vp_ops', randomUUID(), T), 'another document').toBeNull()
    expect(await use('ceo', subjectId, T), 'another member').toBeNull()
    expect(await use('vp_ops', subjectId, new Date(T.getTime() + 5 * MINUTE)), 'at 5 minutes').toBeNull()
    expect(await use('vp_ops', subjectId, new Date(T.getTime() + 5 * MINUTE - 1)), 'just before 5 minutes').toBe(granted.grantId)
    expect(await use('vp_ops', subjectId, new Date(T.getTime() + MINUTE)), 'a second time').toBeNull()
  })

  it('a second right PIN for the same document uses up the unused first grant, so one entry of the PIN decides one task', async () => {
    const T = new Date()
    const subjectId = randomUUID()
    const other = await pinStepUp('vp_ops', 'REQUEST', randomUUID(), T)
    const first = await pinStepUp('vp_ops', 'REQUEST', subjectId, T)
    const later = new Date(T.getTime() + 1000)
    const second = await pinStepUp('vp_ops', 'REQUEST', subjectId, later)
    if (!other.ok || !first.ok || !second.ok) throw new Error('step-up refused')
    expect(await prisma.stepUpGrant.findUniqueOrThrow({ where: { id: first.grantId } })).toMatchObject({ usedAt: later })
    const use = (document: string) => inTx((tx) => consumeStepUp(tx, { memberId: member('vp_ops'), subjectType: 'REQUEST', subjectId: document, methods: PIN_ONLY }, new Date(T.getTime() + 2000)))
    expect(await use(subjectId)).toBe(second.grantId)
    expect(await use(subjectId), 'the double entry gives no second decision').toBeNull()
    // The grant of another document is not touched
    expect((await prisma.stepUpGrant.findUniqueOrThrow({ where: { id: other.grantId } })).usedAt).toBeNull()
  })

  it('a member without a PIN gets no grant and is told to set one first (STEP_UP_REQUIRED, PIN_NOT_SET)', async () => {
    const refused = await pinStepUp('asst_con', 'REQUEST', randomUUID(), new Date(), PINS.ceo)
    expect(refused).toEqual({ ok: false, reason: 'NO_SECOND_FACTOR', method: 'PIN' })
    expect(stepUpRefusalError(refused as StepUpRefusal)).toMatchObject({ code: 'STEP_UP_REQUIRED', details: { method: 'PIN', reason: 'PIN_NOT_SET' } })
    expect(await prisma.stepUpGrant.count({ where: { memberId: member('asst_con') } })).toBe(0)
  })
})

describe('[BR-TOK-05] requireStepUp, the gate for request, PO and variance decisions, refuses at or above stepUpThreshold without a PIN grant', () => {
  it('a request of exactly the threshold needs the grant; one satang below needs none', async () => {
    const at = await submitted('100000.00')
    const below = await submitted('99999.99')
    expect(at).toMatchObject({ amountSatang: 10_000_000n, stepUpThresholdSatang: 10_000_000n })
    expect(below.amountSatang).toBe(9_999_999n)
    const gate = (route: typeof at) => inTx((tx) => requireStepUp(tx, { memberId: member('vp_ops'), route, methods: PIN_ONLY }, new Date()))

    expect(await gate(below)).toEqual({ ok: true, grantId: null })
    expect(await gate(at)).toMatchObject({ ok: false, error: { code: 'STEP_UP_REQUIRED', details: { subjectType: 'REQUEST', subjectId: at.subjectId, method: 'PIN' } } })
    const granted = await pinStepUp('vp_ops', 'REQUEST', at.subjectId, new Date())
    if (!granted.ok) throw new Error('step-up refused')
    expect(await gate(at)).toEqual({ ok: true, grantId: granted.grantId })
    // Used once: the next decision needs a new PIN
    expect(await gate(at)).toMatchObject({ ok: false, error: { code: 'STEP_UP_REQUIRED' } })
  })

  it('where the PIN is required, a grant of the authenticator code does not count', async () => {
    const T = new Date()
    const subjectId = randomUUID()
    const route = { subjectType: 'DOA_VERSION', subjectId, amountSatang: null, stepUpThresholdSatang: null }
    const byCode = await grantStepUp({ organizationId: org.organizationId, memberId: member('ceo'), subjectType: 'DOA_VERSION', subjectId, code: totp(CEO_SECRET, T.getTime()) }, T)
    if (!byCode.ok) throw new Error(`code refused: ${byCode.reason}`)
    expect(byCode.method).toBe('TOTP')
    expect(await inTx((tx) => consumeStepUp(tx, { memberId: member('ceo'), subjectType: 'DOA_VERSION', subjectId, methods: PIN_ONLY }, T))).toBeNull()
    expect(await inTx((tx) => requireStepUp(tx, { memberId: member('ceo'), route, methods: PIN_ONLY }, T))).toMatchObject({ ok: false, error: { code: 'STEP_UP_REQUIRED', details: { method: 'PIN' } } })
    const byPin = await pinStepUp('ceo', 'DOA_VERSION', subjectId, T)
    if (!byPin.ok) throw new Error('step-up refused')
    expect(await inTx((tx) => requireStepUp(tx, { memberId: member('ceo'), route, methods: PIN_ONLY }, T))).toEqual({ ok: true, grantId: byPin.grantId })
  })

  it('a deciding command must name the proofs it takes', async () => {
    await expect(inTx((tx) => consumeStepUp(tx, { memberId: member('ceo'), subjectType: 'DOA_VERSION', subjectId: randomUUID(), methods: [] }, new Date()))).rejects.toBeInstanceOf(TypeError)
  })
})

describe('[FR-AUTH-005/AC2] a policy decision (BR-DOA-15) without a step-up for its document is STEP_UP_REQUIRED; a PIN grant decides it once', () => {
  it('an authority change is refused without the step-up and decided with a PIN grant, which the decision names', async () => {
    const { changeId, taskId } = await authorityChangeTask('assign')
    expect(await decideTask(org.ctxOf('ceo', NOW), { taskId, decision: 'APPROVE' }, key())).toMatchObject({ ok: false, error: { code: 'STEP_UP_REQUIRED' } })
    // A grant for another document does not count
    await pinStepUp('ceo', 'ORG_AUTHORITY_CHANGE', randomUUID(), new Date())
    expect(await decideTask(org.ctxOf('ceo', NOW), { taskId, decision: 'APPROVE' }, key())).toMatchObject({ ok: false, error: { code: 'STEP_UP_REQUIRED' } })
    expect((await prisma.approvalTask.findUniqueOrThrow({ where: { id: taskId } })).status).toBe('OPEN')

    const granted = await pinStepUp('ceo', 'ORG_AUTHORITY_CHANGE', changeId, new Date(), PINS.ceo, 'LIFF')
    if (!granted.ok) throw new Error('step-up refused')
    expect(await decideTask(org.ctxOf('ceo', NOW, 'LIFF'), { taskId, decision: 'APPROVE' }, key())).toMatchObject({ ok: true })
    const decided = await prisma.event.findFirstOrThrow({ where: { organizationId: org.organizationId, type: 'approval_task.decided', aggregateId: taskId } })
    expect(decided).toMatchObject({ channel: 'LIFF', data: { decision: 'APPROVE', stepUpGrantId: granted.grantId } })
    expect(await prisma.stepUpGrant.findUniqueOrThrow({ where: { id: granted.grantId } })).toMatchObject({ method: 'PIN', usedAt: expect.any(Date) })
  })

  it('in LIFF a grant of the authenticator code no longer counts (TOTP → PIN, docs/sub-specs/S5.md); the PIN decides', async () => {
    expect(policyStepUpMethods('LIFF')).toEqual(['PIN'])
    expect(policyStepUpMethods('PWA')).toEqual(['PIN'])
    expect(policyStepUpMethods('WEB')[0], 'the PIN first, on the web too').toBe('PIN')
    const { changeId, taskId } = await authorityChangeTask('reparent')
    const T = new Date()
    const byCode = await grantStepUp({ organizationId: org.organizationId, memberId: member('ceo'), subjectType: 'ORG_AUTHORITY_CHANGE', subjectId: changeId, code: totp(CEO_SECRET, T.getTime()) }, T)
    if (!byCode.ok) throw new Error(`code refused: ${byCode.reason}`)
    expect(await decideTask(org.ctxOf('ceo', NOW, 'LIFF'), { taskId, decision: 'APPROVE' }, key())).toMatchObject({ ok: false, error: { code: 'STEP_UP_REQUIRED' } })
    expect((await prisma.stepUpGrant.findUniqueOrThrow({ where: { id: byCode.grantId } })).usedAt, 'the code grant is not used').toBeNull()
    expect((await prisma.approvalTask.findUniqueOrThrow({ where: { id: taskId } })).status).toBe('OPEN')

    const byPin = await pinStepUp('ceo', 'ORG_AUTHORITY_CHANGE', changeId, new Date(), PINS.ceo, 'LIFF')
    if (!byPin.ok) throw new Error('step-up refused')
    expect(await decideTask(org.ctxOf('ceo', NOW, 'LIFF'), { taskId, decision: 'APPROVE' }, key())).toMatchObject({ ok: true })
    const decided = await prisma.event.findFirstOrThrow({ where: { organizationId: org.organizationId, type: 'approval_task.decided', aggregateId: taskId } })
    expect(decided.data).toMatchObject({ stepUpGrantId: byPin.grantId })
  })
})

describe('[FR-AUTH-005/AC3] five wrong PINs in a row lock the PIN for 15 minutes (STEP_UP_LOCKED)', () => {
  it('counts four, locks at the fifth until 15 minutes later, refuses even the right PIN until then, and takes it after', async () => {
    const T = new Date()
    const subjectId = randomUUID()
    for (const left of [4, 3, 2, 1]) expect(await pinStepUp('dm_con', 'REQUEST', subjectId, T, WRONG)).toEqual({ ok: false, reason: 'INVALID_CODE', method: 'PIN', attemptsLeft: left })
    const until = new Date(T.getTime() + 15 * MINUTE)
    const locked = await pinStepUp('dm_con', 'REQUEST', subjectId, T, WRONG)
    expect(locked).toEqual({ ok: false, reason: 'LOCKED', method: 'PIN', retryAt: until })
    expect(await pinState('dm_con')).toEqual({ pinFailedCount: 0, pinLockedUntil: until })
    expect(stepUpRefusalError(locked as StepUpRefusal)).toEqual({ code: 'STEP_UP_LOCKED', message: expect.any(String), details: { method: 'PIN', time: until.toISOString() } })

    expect(await pinStepUp('dm_con', 'REQUEST', subjectId, new Date(T.getTime() + MINUTE))).toEqual({ ok: false, reason: 'LOCKED', method: 'PIN', retryAt: until })
    expect(await pinStepUp('dm_con', 'REQUEST', subjectId, new Date(until.getTime() - 1))).toMatchObject({ ok: false, reason: 'LOCKED' })
    expect(await prisma.stepUpGrant.count({ where: { memberId: member('dm_con') } })).toBe(0)
    // The lock ends at 15 minutes; the member has five tries again
    expect(await pinStepUp('dm_con', 'REQUEST', subjectId, until)).toMatchObject({ ok: true, method: 'PIN' })
    expect(await pinState('dm_con')).toEqual({ pinFailedCount: 0, pinLockedUntil: null })
  })

  it('records security.pin_locked with the request it came from and e-mails the owner security.notice, without the PIN', async () => {
    const T = new Date()
    const subjectId = randomUUID()
    // A request id may be any text (from a header); the correlation id is a uuid
    const trace = { requestId: `sin1::${randomUUID()}`, correlationId: randomUUID() }
    for (let i = 0; i < 5; i++) await pinStepUp('dm_it', 'DOA_VERSION', subjectId, T, WRONG, 'LIFF', trace)
    const until = new Date(T.getTime() + 15 * MINUTE).toISOString()

    const [event, ...more] = await prisma.event.findMany({ where: { organizationId: org.organizationId, type: 'security.pin_locked', aggregateId: member('dm_it') } })
    expect(more).toEqual([])
    expect(event).toMatchObject({
      aggregateType: 'Security',
      actorType: 'USER',
      actorMemberId: member('dm_it'),
      channel: 'LIFF',
      occurredAt: T,
      requestId: trace.requestId,
      correlationId: trace.correlationId,
      data: { failedAttempts: 5, lockedUntil: until, subjectType: 'DOA_VERSION', subjectId },
    })

    const notice = await prisma.notification.findFirstOrThrow({ where: { organizationId: org.organizationId, recipientMemberId: member('dm_it'), templateKey: 'security.notice' } })
    expect(notice).toMatchObject({ urgency: 'IMMEDIATE', status: 'PENDING', data: { kind: 'PIN_LOCKED', lockedUntil: until } })
    const queued = await prisma.outbox.findMany({ where: { organizationId: org.organizationId, eventName: { in: ['bcs/notification.requested', 'bcs/security.pin_locked'] } } })
    expect(queued.filter((q) => (q.payload as { notificationId?: string }).notificationId === notice.id)).toHaveLength(1)
    expect(queued.filter((q) => (q.payload as { eventId?: string }).eventId === event!.id).map((q) => (q.payload as { correlationId?: string }).correlationId)).toEqual([trace.correlationId])

    // The notification job sends it by e-mail to the account owner (§10.1)
    expect(await deliverNotification(org.organizationId, notice.id, new Date())).toEqual({ status: 'SENT', channel: 'EMAIL' })
    const owner = (await prisma.member.findUniqueOrThrow({ where: { id: member('dm_it') } })).email
    const sent = mails.filter((m) => m.to === owner)
    expect(sent).toHaveLength(1)
    const th = renderNotification(notice, 'th')
    expect(sent[0]!.subject).toBe(th.title)
    // The e-mail links to the member's own settings page
    expect(th.href).toMatch(/^\/settings\//)
    expect(sent[0]!.text).toContain(th.href!)
    expect(JSON.stringify(sent)).not.toContain(WRONG)
    expect(JSON.stringify(sent)).not.toContain(PINS.dm_it)
  })

  it('a right PIN in between starts the count again: only five wrong in a row lock', async () => {
    const T = new Date()
    const subjectId = randomUUID()
    for (let i = 0; i < 4; i++) await pinStepUp('dm_fin', 'REQUEST', subjectId, T, WRONG)
    // The fifth try is the right PIN: counted as wrong until it was checked, then the count starts again, unlocked
    expect(await pinStepUp('dm_fin', 'REQUEST', subjectId, T)).toMatchObject({ ok: true })
    expect(await pinState('dm_fin')).toEqual({ pinFailedCount: 0, pinLockedUntil: null })
    for (const left of [4, 3, 2, 1]) expect(await pinStepUp('dm_fin', 'REQUEST', subjectId, T, WRONG)).toMatchObject({ ok: false, reason: 'INVALID_CODE', attemptsLeft: left })
    expect(await pinState('dm_fin')).toEqual({ pinFailedCount: 4, pinLockedUntil: null })
    expect(await prisma.event.count({ where: { organizationId: org.organizationId, type: 'security.pin_locked', aggregateId: member('dm_fin') } })).toBe(0)
  })

  it('something that is not six digits is refused without being counted', async () => {
    for (const pin of ['12345', '1234567', 'abcdef', '']) expect(await pinStepUp('dm_fin', 'REQUEST', randomUUID(), new Date(), pin)).toMatchObject({ ok: false, reason: 'INVALID_CODE', attemptsLeft: 1 })
    expect(await pinState('dm_fin')).toEqual({ pinFailedCount: 4, pinLockedUntil: null })
    // The right PIN resets the count for the next tests
    expect(await pinStepUp('dm_fin', 'REQUEST', randomUUID(), new Date())).toMatchObject({ ok: true })
  })

  it('the lock never fails open: a step-up whose ids the event schemas would refuse is a programming error, thrown before a try is counted or a PIN checked', async () => {
    const before = await pinState('vp_ops')
    // The shape of a UUID, but version 0 and variant c: Postgres stores it, the event schemas (Zod's uuid) refuse it. If
    // it reached the lock's event, the fifth wrong PIN would fail and its count roll back: unlimited guesses.
    const notRfc = '12345678-1234-0234-c234-123456789012'
    for (let i = 0; i < 8; i++) await expect(pinStepUp('vp_ops', 'REQUEST', notRfc, new Date(), WRONG), `try ${i + 1}`).rejects.toBeInstanceOf(TypeError)
    // The right PIN is refused the same way, so the answer tells nothing about the PIN
    await expect(pinStepUp('vp_ops', 'REQUEST', notRfc, new Date())).rejects.toBeInstanceOf(TypeError)
    // A subject that is not a document of an approval route, a missing id, another channel, a correlation id that is no
    // uuid (its column is one), an invalid time
    for (const subjectType of ['Member', 'request', ' ', '']) await expect(pinStepUp('vp_ops', subjectType, randomUUID(), new Date(), WRONG), subjectType).rejects.toBeInstanceOf(TypeError)
    const base = { organizationId: org.organizationId, memberId: member('vp_ops'), subjectType: 'REQUEST', method: 'PIN' as const, pin: WRONG }
    await expect(grantStepUp({ ...base, subjectId: 'not-an-id' }, new Date(), { sender: null })).rejects.toBeInstanceOf(TypeError)
    await expect(grantStepUp({ ...base, memberId: 'someone', subjectId: randomUUID() }, new Date(), { sender: null })).rejects.toBeInstanceOf(TypeError)
    await expect(grantStepUp({ ...base, subjectId: randomUUID(), channel: 'SMS' as 'WEB' }, new Date(), { sender: null })).rejects.toBeInstanceOf(TypeError)
    await expect(grantStepUp({ ...base, subjectId: randomUUID() }, new Date(), { sender: null, correlationId: notRfc })).rejects.toBeInstanceOf(TypeError)
    await expect(grantStepUp({ ...base, subjectId: randomUUID() }, new Date(Number.NaN), { sender: null })).rejects.toBeInstanceOf(TypeError)
    expect(await pinState('vp_ops')).toEqual(before)
    expect(await prisma.stepUpGrant.count({ where: { memberId: member('vp_ops'), subjectId: notRfc } })).toBe(0)
  })

  it('the lock never fails open: when recording the lock fails, the lock it made stands and even the right PIN waits', async () => {
    const T = new Date()
    const subjectId = randomUUID()
    for (const left of [4, 3, 2, 1]) expect(await pinStepUp('coo', 'REQUEST', subjectId, T, WRONG)).toMatchObject({ ok: false, reason: 'INVALID_CODE', attemptsLeft: left })
    const until = new Date(T.getTime() + 15 * MINUTE)
    // Another transaction holds the notification key of this lock, uncommitted: writing the lock's e-mail waits for it
    // until lock_timeout and fails, as any failure of the database at that point would
    let holding!: () => void
    let release!: () => void
    const held = new Promise<void>((resolve) => (holding = resolve))
    const released = new Promise<void>((resolve) => (release = resolve))
    const blocker = prisma
      .$transaction(
        async (tx) => {
          await tx.notification.create({
            data: { organizationId: org.organizationId, recipientMemberId: member('admin'), templateKey: 'security.notice', data: {}, urgency: 'IMMEDIATE', dedupeKey: `security.notice:pin_locked:${member('coo')}:${until.toISOString()}` },
          })
          holding()
          await released
          throw new Error('rolled back on purpose')
        },
        { maxWait: 10_000, timeout: 60_000 },
      )
      .catch((error: unknown) => error)
    await held
    try {
      await expect(pinStepUp('coo', 'REQUEST', subjectId, T, WRONG)).rejects.toThrow()
    } finally {
      release()
      await blocker
    }
    // The fifth wrong PIN was counted, and the PIN locked, before it was checked: the failure afterwards undid neither
    expect(await pinState('coo')).toEqual({ pinFailedCount: 0, pinLockedUntil: until })
    expect(await pinStepUp('coo', 'REQUEST', subjectId, new Date(T.getTime() + MINUTE))).toEqual({ ok: false, reason: 'LOCKED', method: 'PIN', retryAt: until })
    expect(await prisma.stepUpGrant.count({ where: { memberId: member('coo') } })).toBe(0)
    // The failed record left nothing half-written; the lock still ends after 15 minutes
    expect(await prisma.event.count({ where: { organizationId: org.organizationId, type: 'security.pin_locked', aggregateId: member('coo') } })).toBe(0)
    expect(await pinStepUp('coo', 'REQUEST', subjectId, until)).toMatchObject({ ok: true })
  })

  it('parallel wrong PINs are counted one by one: four refused, one lock, the rest refused locked, one event', async () => {
    const T = new Date()
    const subjectId = randomUUID()
    const results = await Promise.all(Array.from({ length: 8 }, () => pinStepUp('vp_sup', 'REQUEST', subjectId, T, WRONG)))
    const until = new Date(T.getTime() + 15 * MINUTE)
    expect(results.filter((r) => !r.ok && r.reason === 'INVALID_CODE').map((r) => (r as { attemptsLeft: number }).attemptsLeft).sort()).toEqual([1, 2, 3, 4])
    expect(results.filter((r) => !r.ok && r.reason === 'LOCKED')).toEqual(Array.from({ length: 4 }, () => ({ ok: false, reason: 'LOCKED', method: 'PIN', retryAt: until })))
    expect(await prisma.event.count({ where: { organizationId: org.organizationId, type: 'security.pin_locked', aggregateId: member('vp_sup') } })).toBe(1)
    expect(await prisma.notification.count({ where: { organizationId: org.organizationId, recipientMemberId: member('vp_sup'), templateKey: 'security.notice' } })).toBe(1)
  })

  it('a new PIN, after a fresh proof, ends the lock and starts the count again (auth.pin_set says unlocked)', async () => {
    const T = new Date()
    for (let i = 0; i < 5; i++) await pinStepUp('dm_proc', 'REQUEST', randomUUID(), T, WRONG)
    expect((await pinState('dm_proc')).pinLockedUntil).toEqual(new Date(T.getTime() + 15 * MINUTE))
    const proved = await confirmIdentityForPin(org.ctxOf('dm_proc', NOW), { method: 'PASSWORD', password: PASSWORD })
    if (!proved.ok) throw new Error('proof refused')
    expect(await setOwnPin(org.ctxOf('dm_proc', NOW), { memberId: member('dm_proc'), pin: '640271', proofToken: proved.data.proofToken }, key())).toMatchObject({ ok: true, data: { replaced: true } })
    expect(await pinState('dm_proc')).toEqual({ pinFailedCount: 0, pinLockedUntil: null })
    const event = await prisma.event.findFirstOrThrow({ where: { organizationId: org.organizationId, type: 'auth.pin_set', aggregateId: member('dm_proc') }, orderBy: { seq: 'desc' } })
    expect(event.data).toEqual({ replaced: true, proof: 'PASSWORD', unlocked: true })
    expect(await pinStepUp('dm_proc', 'REQUEST', randomUUID(), new Date(), '640271')).toMatchObject({ ok: true })
  })
})
