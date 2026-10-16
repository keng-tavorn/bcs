import { randomUUID } from 'node:crypto'
import { beforeAll, describe, expect, it } from 'vitest'
import { STEP_UP_TTL_MS } from '@/lib/constants'
import { prisma } from '@/server/db/client'
import { decideTask } from '@/server/services/approvals/decide'
import { assignSupplier, consolidateNow } from '@/server/services/procurement'
import { submitPo } from '@/server/services/purchase-orders'
import { postGoodsReceipt, requestCloseShort } from '@/server/services/receiving'
import { createDraft, submitRequest } from '../support/requests'
import { createDoaOrg, type DoaOrg } from '../support/doa-org'
import { p2p } from '../support/p2p'
import { pinStepUp, seedTestPins } from '../support/pin'

// S5-05, FR-AUTH-005 AC2 (BR-TOK-05, ADR-047 item 8): a request, purchase-order or variance task whose amount the DOA
// counted is at or above its version's stepUpThreshold is decided — approved, returned or rejected alike — only with
// the decider's PIN step-up for that document, given in the last 5 minutes on the security clock and used once by the
// decision, which names it (approval_task.decided stepUpGrantId). Without one the decision is STEP_UP_REQUIRED and
// nothing moves; a grant of the authenticator code (made before S5-05) never counts; one satang below the threshold no
// step-up is asked. Real Postgres (BCS_TEST_DB), an organization of the §7.4 fixtures whose approvers have the PIN the
// demo seed gives them (seedDevPins): stepUpThreshold 100,000.00 baht, a request up to that amount goes to the VP of its
// line. A PO and a variance are tested at their own amounts: the version's threshold is set to the amount the route
// counted (and one satang above it) on this test organization, so the boundary is exact.

const NOW = new Date('2026-10-05T03:00:00Z')
const key = () => ({ idempotencyKey: randomUUID(), sender: null })
const ok = <T,>(r: { ok: true; data: T } | { ok: false; error: unknown }): T => {
  if (!r.ok) throw new Error(JSON.stringify(r.error))
  return r.data
}

let org: DoaOrg
let flow: ReturnType<typeof p2p>
let supplierId: string
const member = (code: string) => org.member[code]!

beforeAll(async () => {
  org = await createDoaOrg()
  expect((await seedTestPins(org.organizationId)).set).toBeGreaterThan(0)
  supplierId = (await prisma.supplier.create({ data: { organizationId: org.organizationId, code: 'S1', nameTh: 'ผู้ขายหนึ่ง', taxId: '0999999000012' } })).id
  await prisma.roleAssignment.create({ data: { organizationId: org.organizationId, memberId: member('receiver_con'), role: 'RECEIVER', scopeDepartmentId: org.department.CON!, grantedAt: NOW } })
  flow = p2p(org, NOW)
})

/** The open task of a document and what its route counted */
async function openTaskOf(subjectId: string) {
  const task = await prisma.approvalTask.findFirstOrThrow({
    where: { status: 'OPEN', step: { route: { subjectId } } },
    include: { step: { select: { route: { select: { subjectType: true, amountBasis: true, amountSatang: true, doaVersionId: true, doaVersion: { select: { stepUpThresholdSatang: true } } } } } } },
  })
  return { id: task.id, assigneeMemberId: task.assigneeMemberId, route: task.step.route }
}

/** A request of `grossBaht` (VAT included) sent for approval: its task waits for the VP of CON's line */
async function waitingRequest(grossBaht: string) {
  const draft = ok(
    await createDraft(org.ctxOf('req_con', NOW), { requestTypeCode: 'BUY_GOODS', title: 'วัสดุก่อสร้าง', priceIncludesVat: true, lines: [{ description: 'ปูนซีเมนต์', quantity: '1', uom: 'งาน', unitPrice: grossBaht }] }, key()),
  )
  ok(await submitRequest(org.ctxOf('req_con', NOW), { requestId: draft.requestId }, key()))
  return { requestId: draft.requestId, task: await openTaskOf(draft.requestId) }
}

/** A live grant of the authenticator code, as grantStepUp made them before S5-05: no code path makes one any more */
async function totpGrantOfBefore(memberId: string, subjectType: string, subjectId: string): Promise<string> {
  const at = new Date()
  const grant = await prisma.stepUpGrant.create({
    data: { organizationId: org.organizationId, memberId, purpose: 'DECIDE', subjectType, subjectId, method: 'TOTP', grantedAt: at, expiresAt: new Date(at.getTime() + STEP_UP_TTL_MS) },
  })
  return grant.id
}

const decidedEvent = (taskId: string) => prisma.event.findFirstOrThrow({ where: { organizationId: org.organizationId, type: 'approval_task.decided', aggregateId: taskId } })
const taskStatus = async (taskId: string) => (await prisma.approvalTask.findUniqueOrThrow({ where: { id: taskId } })).status
const grantUsedAt = async (grantId: string) => (await prisma.stepUpGrant.findUniqueOrThrow({ where: { id: grantId } })).usedAt

/** Sets the threshold of the version a route was made under, and puts the one of the fixture back afterwards */
async function withThreshold<T>(doaVersionId: string, thresholdSatang: bigint, run: () => Promise<T>): Promise<T> {
  const before = (await prisma.doaVersion.findUniqueOrThrow({ where: { id: doaVersionId } })).stepUpThresholdSatang
  await prisma.doaVersion.update({ where: { id: doaVersionId }, data: { stepUpThresholdSatang: thresholdSatang } })
  try {
    return await run()
  } finally {
    await prisma.doaVersion.update({ where: { id: doaVersionId }, data: { stepUpThresholdSatang: before } })
  }
}

/** Sets the amount basis of the fixture's DOA version (in effect) while `run` routes and decides, and puts it back */
async function withBasis<T>(amountBasis: 'GROSS' | 'NET', run: () => Promise<T>): Promise<T> {
  const version = await prisma.doaVersion.findFirstOrThrow({ where: { organizationId: org.organizationId, status: 'PUBLISHED' }, orderBy: { effectiveFrom: 'desc' } })
  await prisma.doaVersion.update({ where: { id: version.id }, data: { amountBasis } })
  try {
    return await run()
  } finally {
    await prisma.doaVersion.update({ where: { id: version.id }, data: { amountBasis: version.amountBasis } })
  }
}

/** The request's lines on one PO of the supplier, sent for approval by procurement: its task waits for the COO */
async function waitingPo(): Promise<string> {
  const pr = await flow.approvedRequest(await flow.fundedLine(1_000_000n), [{ quantity: '10', unitPrice: '1100.00' }])
  const site = await prisma.deliverySite.create({ data: { organizationId: org.organizationId, code: `SITE-${randomUUID().slice(0, 8)}`, nameTh: 'ไซต์ทดสอบ', address: 'ถนนทดสอบ' } })
  await prisma.request.update({ where: { id: pr.id }, data: { deliverySiteId: site.id } })
  const proc = org.ctxOf('proc_officer', NOW)
  ok(await assignSupplier(proc, { requestLineIds: pr.lines.map((l) => l.id), supplierId }, key()))
  const run = ok(await consolidateNow(proc, key()))
  const po = await prisma.purchaseOrder.findFirstOrThrow({ where: { id: { in: [...run.purchaseOrderIds] }, deliverySiteId: site.id } })
  ok(await submitPo(proc, { poId: po.id }, key()))
  return po.id
}

/** A PO received 6 of 10, whose close-short waits for the DM of CON (GRV-01, GC-GR-04) */
async function waitingVariance(): Promise<{ varianceId: string; poId: string }> {
  const pr = await flow.approvedRequest(await flow.fundedLine(1_000_000n), [{ quantity: '10', unitPrice: '1100.00' }])
  const po = await flow.approvedPo(pr.lines.map((l) => l.id), supplierId)
  await prisma.purchaseOrder.update({ where: { id: po.id }, data: { status: 'SENT', sentAt: NOW } })
  ok(await postGoodsReceipt(org.ctxOf('receiver_con', NOW), { poId: po.id, lines: [{ poLineId: po.lines[0]!.id, received: '6' }] }, key()))
  const asked = ok(await requestCloseShort(org.ctxOf('proc_officer', NOW), { poId: po.id, reason: 'ผู้ขายเลิกผลิต' }, key()))
  return { varianceId: asked.varianceIds[0]!, poId: po.id }
}

describe('[FR-AUTH-005/AC2] a request at or above stepUpThreshold is decided only with a PIN step-up for it', () => {
  it('at exactly the threshold approve, return and reject are refused without a step-up, and a grant of the authenticator code does not count', async () => {
    const { requestId, task } = await waitingRequest('100000.00')
    expect(task.route).toMatchObject({ subjectType: 'REQUEST', amountSatang: 10_000_000n, doaVersion: { stepUpThresholdSatang: 10_000_000n } })
    expect(task.assigneeMemberId).toBe(member('vp_ops'))
    const vp = org.ctxOf('vp_ops', NOW)
    const refusal = { ok: false, error: { code: 'STEP_UP_REQUIRED', details: { subjectType: 'REQUEST', subjectId: requestId, method: 'PIN' } } }
    expect(await decideTask(vp, { taskId: task.id, decision: 'APPROVE' }, key())).toMatchObject(refusal)
    expect(await decideTask(vp, { taskId: task.id, decision: 'RETURN', reason: 'แยกรายการให้ชัดเจน' }, key())).toMatchObject(refusal)
    expect(await decideTask(vp, { taskId: task.id, decision: 'REJECT', reason: 'ซ้ำกับคำขออื่น' }, key())).toMatchObject(refusal)
    // A step-up for another document, or by another member, does not count either
    await pinStepUp(org.organizationId, member('vp_ops'), 'REQUEST', randomUUID())
    await pinStepUp(org.organizationId, member('vp_sup'), 'REQUEST', requestId)
    expect(await decideTask(vp, { taskId: task.id, decision: 'APPROVE' }, key())).toMatchObject(refusal)
    const byCode = await totpGrantOfBefore(member('vp_ops'), 'REQUEST', requestId)
    expect(await decideTask(vp, { taskId: task.id, decision: 'APPROVE' }, key())).toMatchObject(refusal)
    expect(await grantUsedAt(byCode), 'the code grant is not used').toBeNull()
    // Nothing moved: no comment for the refused return or rejection, the request still waits
    expect(await taskStatus(task.id)).toBe('OPEN')
    expect(await prisma.request.findUniqueOrThrow({ where: { id: requestId } })).toMatchObject({ status: 'PENDING_APPROVAL' })
    expect(await prisma.comment.count({ where: { subjectId: requestId } })).toBe(0)
  })

  it('at exactly the threshold the PIN step-up approves it once, and the decision names the step-up', async () => {
    const { requestId, task } = await waitingRequest('100000.00')
    const grantId = await pinStepUp(org.organizationId, member('vp_ops'), 'REQUEST', requestId)
    expect(await decideTask(org.ctxOf('vp_ops', NOW), { taskId: task.id, decision: 'APPROVE' }, key())).toMatchObject({ ok: true, data: { documentStatus: 'APPROVED' } })
    expect(await decidedEvent(task.id)).toMatchObject({ channel: 'WEB', data: { decision: 'APPROVE', subjectType: 'REQUEST', subjectId: requestId, stepUpGrantId: grantId } })
    expect(await grantUsedAt(grantId)).toEqual(expect.any(Date))
  })

  it('at the threshold a return and a rejection are made with the PIN step-up too', async () => {
    const returned = await waitingRequest('100000.00')
    const forReturn = await pinStepUp(org.organizationId, member('vp_ops'), 'REQUEST', returned.requestId)
    expect(await decideTask(org.ctxOf('vp_ops', NOW), { taskId: returned.task.id, decision: 'RETURN', reason: 'แยกรายการให้ชัดเจน' }, key())).toMatchObject({ ok: true, data: { documentStatus: 'RETURNED' } })
    expect(await decidedEvent(returned.task.id)).toMatchObject({ data: { decision: 'RETURN', stepUpGrantId: forReturn } })

    const rejected = await waitingRequest('100000.00')
    const forReject = await pinStepUp(org.organizationId, member('vp_ops'), 'REQUEST', rejected.requestId)
    expect(await decideTask(org.ctxOf('vp_ops', NOW), { taskId: rejected.task.id, decision: 'REJECT', reason: 'ซ้ำกับคำขออื่น' }, key())).toMatchObject({ ok: true, data: { documentStatus: 'REJECTED' } })
    expect(await decidedEvent(rejected.task.id)).toMatchObject({ data: { decision: 'REJECT', stepUpGrantId: forReject } })
  })

  it('one satang below the threshold it is decided with no step-up, and the decision names none', async () => {
    const { task } = await waitingRequest('99999.99')
    expect(task.route.amountSatang).toBe(9_999_999n)
    expect(await decideTask(org.ctxOf('vp_ops', NOW), { taskId: task.id, decision: 'APPROVE' }, key())).toMatchObject({ ok: true, data: { documentStatus: 'APPROVED' } })
    expect((await decidedEvent(task.id)).data).not.toHaveProperty('stepUpGrantId')
  })

  it('compares the amount on the DOA basis: under a version that counts before VAT, gross at the threshold needs no PIN and net at it does', async () => {
    const version = await prisma.doaVersion.findFirstOrThrow({ where: { organizationId: org.organizationId, status: 'PUBLISHED' }, orderBy: { effectiveFrom: 'desc' } })
    // A threshold of 90,000.00 baht keeps both requests under the amount that asks for three quotations (ATT-QUOTES)
    const threshold = 9_000_000n
    await withThreshold(version.id, threshold, () =>
      withBasis('NET', async () => {
        const vp = org.ctxOf('vp_ops', NOW)
        // 90,000.00 with VAT is below 90,000.00 before VAT: no step-up on this basis, though the gross is at the threshold
        const grossAt = await waitingRequest('90000.00')
        expect(grossAt.task.route).toMatchObject({ amountBasis: 'NET', doaVersion: { stepUpThresholdSatang: threshold } })
        expect(grossAt.task.route.amountSatang!).toBeLessThan(threshold)
        expect(await decideTask(vp, { taskId: grossAt.task.id, decision: 'APPROVE' }, key())).toMatchObject({ ok: true, data: { documentStatus: 'APPROVED' } })
        expect((await decidedEvent(grossAt.task.id)).data).not.toHaveProperty('stepUpGrantId')

        // 96,300.00 with VAT is 90,000.00 before VAT: at the threshold, refused without the PIN and decided with it
        const netAt = await waitingRequest('96300.00')
        expect(netAt.task.route).toMatchObject({ amountBasis: 'NET', amountSatang: threshold })
        expect(netAt.task.assigneeMemberId).toBe(member('vp_ops'))
        expect(await decideTask(vp, { taskId: netAt.task.id, decision: 'APPROVE' }, key())).toMatchObject({
          ok: false,
          error: { code: 'STEP_UP_REQUIRED', details: { subjectType: 'REQUEST', subjectId: netAt.requestId, method: 'PIN' } },
        })
        const grantId = await pinStepUp(org.organizationId, member('vp_ops'), 'REQUEST', netAt.requestId)
        expect(await decideTask(vp, { taskId: netAt.task.id, decision: 'APPROVE' }, key())).toMatchObject({ ok: true, data: { documentStatus: 'APPROVED' } })
        expect(await decidedEvent(netAt.task.id)).toMatchObject({ data: { decision: 'APPROVE', stepUpGrantId: grantId } })
      }),
    )
  })
})

describe('[FR-AUTH-005/AC2] a purchase order at or above stepUpThreshold is decided only with a PIN step-up for it', () => {
  it('at exactly the threshold approve, return and reject are refused without one, a code grant does not count, and the PIN approves', async () => {
    const poId = await waitingPo()
    const task = await openTaskOf(poId)
    expect(task.assigneeMemberId).toBe(member('coo'))
    const coo = org.ctxOf('coo', NOW)
    const amount = task.route.amountSatang!
    await withThreshold(task.route.doaVersionId, amount, async () => {
      const refusal = { ok: false, error: { code: 'STEP_UP_REQUIRED', details: { subjectType: 'PURCHASE_ORDER', subjectId: poId, method: 'PIN' } } }
      expect(await decideTask(coo, { taskId: task.id, decision: 'APPROVE' }, key())).toMatchObject(refusal)
      expect(await decideTask(coo, { taskId: task.id, decision: 'RETURN', reason: 'ต่อราคาอีกครั้ง' }, key())).toMatchObject(refusal)
      expect(await decideTask(coo, { taskId: task.id, decision: 'REJECT', reason: 'ไม่จำเป็นต้องสั่ง' }, key())).toMatchObject(refusal)
      const byCode = await totpGrantOfBefore(member('coo'), 'PURCHASE_ORDER', poId)
      expect(await decideTask(coo, { taskId: task.id, decision: 'APPROVE' }, key())).toMatchObject(refusal)
      expect(await grantUsedAt(byCode)).toBeNull()
      expect(await taskStatus(task.id)).toBe('OPEN')
      expect(await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: poId } })).toMatchObject({ status: 'PENDING_APPROVAL' })

      const grantId = await pinStepUp(org.organizationId, member('coo'), 'PURCHASE_ORDER', poId)
      expect(await decideTask(coo, { taskId: task.id, decision: 'APPROVE' }, key())).toMatchObject({ ok: true, data: { documentStatus: 'APPROVED' } })
      expect(await decidedEvent(task.id)).toMatchObject({ data: { decision: 'APPROVE', subjectType: 'PURCHASE_ORDER', subjectId: poId, stepUpGrantId: grantId } })
      expect(await grantUsedAt(grantId)).toEqual(expect.any(Date))
    })
  })

  it('one satang below the threshold it is decided with no step-up', async () => {
    const poId = await waitingPo()
    const task = await openTaskOf(poId)
    await withThreshold(task.route.doaVersionId, task.route.amountSatang! + 1n, async () => {
      expect(await decideTask(org.ctxOf('coo', NOW), { taskId: task.id, decision: 'APPROVE' }, key())).toMatchObject({ ok: true, data: { documentStatus: 'APPROVED' } })
    })
    expect((await decidedEvent(task.id)).data).not.toHaveProperty('stepUpGrantId')
  })
})

describe('[FR-AUTH-005/AC2] a receiving variance at or above stepUpThreshold is decided only with a PIN step-up for it', () => {
  it('at exactly the threshold approve and reject are refused without one, a code grant does not count, and the PIN approves', async () => {
    const { varianceId, poId } = await waitingVariance()
    const task = await openTaskOf(varianceId)
    expect(task.assigneeMemberId).toBe(member('dm_con'))
    const dm = org.ctxOf('dm_con', NOW)
    await withThreshold(task.route.doaVersionId, task.route.amountSatang!, async () => {
      const refusal = { ok: false, error: { code: 'STEP_UP_REQUIRED', details: { subjectType: 'VARIANCE', subjectId: varianceId, method: 'PIN' } } }
      expect(await decideTask(dm, { taskId: task.id, decision: 'APPROVE' }, key())).toMatchObject(refusal)
      expect(await decideTask(dm, { taskId: task.id, decision: 'REJECT', reason: 'ให้ผู้ขายส่งของที่เหลือ' }, key())).toMatchObject(refusal)
      const byCode = await totpGrantOfBefore(member('dm_con'), 'VARIANCE', varianceId)
      expect(await decideTask(dm, { taskId: task.id, decision: 'APPROVE' }, key())).toMatchObject(refusal)
      expect(await grantUsedAt(byCode)).toBeNull()
      expect(await prisma.variance.findUniqueOrThrow({ where: { id: varianceId } })).toMatchObject({ status: 'PENDING_APPROVAL' })

      const grantId = await pinStepUp(org.organizationId, member('dm_con'), 'VARIANCE', varianceId)
      expect(await decideTask(dm, { taskId: task.id, decision: 'APPROVE' }, key())).toMatchObject({ ok: true, data: { documentStatus: 'APPROVED' } })
      expect(await decidedEvent(task.id)).toMatchObject({ data: { decision: 'APPROVE', subjectType: 'VARIANCE', subjectId: varianceId, stepUpGrantId: grantId } })
    })
    // The close-short did what it does once approved (GC-GR-04)
    expect(await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: poId } })).toMatchObject({ status: 'CLOSED' })
  })

  it('one satang below the threshold it is decided with no step-up', async () => {
    const { varianceId } = await waitingVariance()
    const task = await openTaskOf(varianceId)
    await withThreshold(task.route.doaVersionId, task.route.amountSatang! + 1n, async () => {
      expect(await decideTask(org.ctxOf('dm_con', NOW), { taskId: task.id, decision: 'REJECT', reason: 'ให้ผู้ขายส่งของที่เหลือ' }, key())).toMatchObject({ ok: true, data: { documentStatus: 'REJECTED' } })
    })
    expect((await decidedEvent(task.id)).data).not.toHaveProperty('stepUpGrantId')
  })
})
