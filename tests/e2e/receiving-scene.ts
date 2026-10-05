import { randomUUID } from 'node:crypto'
import { amountToSatang } from '@/core/money/dto'
import { systemClock } from '@/lib/clock'
import { deriveSeedBackupCodes, deriveSeedTotpSecret } from '@/lib/totp'
import { enableTotpWithSecret, upsertUserWithPassword } from '@/server/auth/provision'
import { makeCtx } from '@/server/context'
import { prisma } from '@/server/db/client'
import { decideTask } from '@/server/services/approvals/decide'
import { createDelegation, revokeDelegation } from '@/server/services/delegations'
import { grantRole } from '@/server/services/members/roles'
import { assignSupplier } from '@/server/services/procurement'
import { submitPo } from '@/server/services/purchase-orders'
import { sendPurchaseOrder } from '@/server/services/purchase-orders/send'
import { postGoodsReceipt } from '@/server/services/receiving'
import { createDraft, submitRequest } from '@/server/services/requests'
import { E2E_DB } from '../support/e2e-env'
import { lineWithRoom } from './budget-room'

// Run by tests/e2e/receiving.spec.ts against the e2e database only (S4-07, FR-P2P-006, FR-P2P-007, FR-P2P-010 AC2): sent
// POs for the receiving screens, made through the services — an urgent request of a fresh member of the construction
// department (so it gets a PO of its own at once, and nobody else's pool lines or "my requests" change), approved by
// whoever holds the DM's task, drafted by procurement, approved by the COO and e-mailed to the supplier (Mailpit). The
// receiver of each Playwright project is its own (TOTP codes never repeat): receiver_con on the phone (demo scene 8),
// a fresh RECEIVER on the desktop. The request takes a construction budget line with room left for it, the capital line
// first: the specs of the run spend the same lines, and the operating line is the one the demo's scenes and the specs
// that count on its room ask for (request-form.spec.ts, liff-requests.spec.ts); when neither has room, a budget admin
// tops the capital line up through the budget import (tests/e2e/budget-room.ts). The DOA routes by amount, not by line,
// and a receipt never shows its budget line. Prints what the spec needs as JSON on the last line.
//   SCENE_MODE  demo        plywood, nails and PPE (scene 1 + H11 of the demo, scaled to the DM's band)
//               sod         a fresh RECEIVER approves the request acting for the DM (delegation), so may not receive it
//               variance    10 bags of cement, for receiving more than ordered
//               closeShort  10 bags of cement of which 6 came, for PROCUREMENT to close short
//   SCENE_RUN   a short unique suffix for fresh members · SCENE_RECEIVER  a seeded receiver, or empty for a fresh one
if (new URL(process.env.DATABASE_URL ?? 'postgresql://x/none').pathname !== `/${E2E_DB}`) throw new Error('the receiving scene runs in the e2e database only')
const mode = process.env.SCENE_MODE ?? ''
const run = process.env.SCENE_RUN ?? ''
if (!['demo', 'sod', 'variance', 'closeShort'].includes(mode)) throw new Error('SCENE_MODE must be demo, sod, variance or closeShort')
if (!/^[a-z0-9]{3,20}$/.test(run)) throw new Error('SCENE_RUN must be 3 to 20 lowercase letters or digits')
const password = process.env.SEED_DEV_PASSWORD
const totpKey = process.env.SEED_TOTP_KEY
if (!password || !totpKey) throw new Error('SEED_DEV_PASSWORD and SEED_TOTP_KEY are needed')

const now = () => systemClock.now()
const key = () => ({ idempotencyKey: randomUUID(), sender: null })
const org = await prisma.organization.findFirstOrThrow({ where: { code: 'DEMO' }, select: { id: true } })
const con = await prisma.department.findFirstOrThrow({ where: { organizationId: org.id, code: 'CON' }, select: { id: true } })
const ctxOf = (memberId: string) => makeCtx({ organizationId: org.id, actor: { type: 'USER', memberId }, channel: 'WEB', now: now() })
const memberOf = async (code: string) => (await prisma.member.findFirstOrThrow({ where: { organizationId: org.id, employeeCode: code }, select: { id: true } })).id
function must<T>(label: string, r: { ok: true; data: T } | { ok: false; error: unknown }): T {
  if (!r.ok) throw new Error(`${label} failed: ${JSON.stringify(r.error)}`)
  return r.data
}

const [admin, procurement, dmCon] = await Promise.all([memberOf('admin'), memberOf('proc_officer'), memberOf('dm_con')])

/** A member of the construction department nobody else uses; a RECEIVER (with TOTP like the seeded ones) when asked */
async function freshMember(code: string, nameTh: string, receiver: boolean): Promise<string> {
  const email = `${code}@demo.bcs.local`
  const userId = await upsertUserWithPassword({ email, name: nameTh, password: password! })
  const member = await prisma.member.upsert({
    where: { organizationId_email: { organizationId: org.id, email } },
    create: { organizationId: org.id, userId, email, displayNameTh: nameTh, employeeCode: code, status: 'ACTIVE', primaryDepartmentId: con.id },
    update: {},
    select: { id: true },
  })
  if (receiver) {
    // A role through the members service (ORG_ADMIN grants it); members with a role sign in with TOTP (FR-AUTH-002 AC1)
    must('grant RECEIVER', await grantRole(ctxOf(admin), { memberId: member.id, role: 'RECEIVER' }, key()))
    await enableTotpWithSecret(userId, deriveSeedTotpSecret(totpKey!, code), deriveSeedBackupCodes(totpKey!, code))
  }
  return member.id
}

/** Every open task of the document, decided "approve" by whoever holds it (the DM, or the delegate acting for the DM) */
async function approveOpen(subjectId: string) {
  for (let i = 0; i < 5; i++) {
    const task = await prisma.approvalTask.findFirst({ where: { status: 'OPEN', step: { route: { subjectId } } }, select: { id: true, assigneeMemberId: true } })
    if (!task) return
    must('approve', await decideTask(ctxOf(task.assigneeMemberId), { taskId: task.id, decision: 'APPROVE' }, key()))
  }
}

type Line = { description: string; quantity: string; uom: string; unitPrice: string }

/** What the lines reserve: whole quantities times their prices before VAT, in satang (BR-MONEY-01: no floating point) */
function netOf(lines: readonly Line[]): bigint {
  return lines.reduce((sum, l) => {
    if (!/^\d+$/.test(l.quantity)) throw new Error(`the scene's quantities are whole: ${l.quantity}`)
    return sum + BigInt(l.quantity) * amountToSatang(l.unitPrice)
  }, 0n)
}

/** An urgent request drafted into its own PO at once (BR-CONS-02), approved and e-mailed to the supplier */
async function sentPo(requester: string, title: string, lines: Line[]): Promise<{ poId: string; number: string; requestNumber: string }> {
  const [budgetLine, site, supplier] = await Promise.all([
    lineWithRoom(['CON-CAPEX-2569', 'CON-OPEX-2569'], netOf(lines)),
    prisma.deliverySite.findFirstOrThrow({ where: { organizationId: org.id, code: 'SITE-A' }, select: { id: true } }),
    prisma.supplier.findFirstOrThrow({ where: { organizationId: org.id, code: 'S1' }, select: { id: true } }),
  ])
  const draft = must('draft', await createDraft(ctxOf(requester), { requestTypeCode: 'BUY_GOODS', title, urgency: 'URGENT', budgetLineId: budgetLine.id, deliverySiteId: site.id, lines }, key()))
  const sent = must('submit', await submitRequest(ctxOf(requester), { requestId: draft.requestId }, key()))
  await approveOpen(draft.requestId)
  const requestLines = await prisma.requestLine.findMany({ where: { requestId: draft.requestId }, orderBy: { lineNo: 'asc' }, select: { id: true } })
  const assigned = must('assign supplier', await assignSupplier(ctxOf(procurement), { requestLineIds: requestLines.map((l) => l.id), supplierId: supplier.id }, key()))
  const poId = assigned.purchaseOrderIds[0]
  if (!poId) throw new Error('the urgent request made no draft PO')
  must('submit PO', await submitPo(ctxOf(procurement), { poId }, key()))
  await approveOpen(poId)
  const mailed = must('send PO', await sendPurchaseOrder(ctxOf(procurement), { poId }, key()))
  if (!mailed.sent) throw new Error(`the PO e-mail bounced: ${mailed.bounce}`)
  const po = await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: poId }, select: { number: true, status: true } })
  if (po.status !== 'SENT') throw new Error(`the PO is ${po.status}, not SENT`)
  return { poId, number: po.number!, requestNumber: sent.number }
}

const receiverCode = process.env.SCENE_RECEIVER || `e2e-rcv-${run}`
const receiverName = process.env.SCENE_RECEIVER ? null : 'ผู้ตรวจรับ ทดสอบหน้างาน'
const cement: Line[] = [{ description: 'ปูนซีเมนต์ 50 กก.', quantity: '10', uom: 'ถุง', unitPrice: '150.00' }]
let out: Record<string, unknown>

switch (mode) {
  case 'demo': {
    // The receiver exists before the PO goes out, so the PO-sent notification takes them to the receiving page
    if (receiverName) await freshMember(receiverCode, receiverName, true)
    const requester = await freshMember(`e2e-rcv-${run}-req`, 'ผู้ขอ ทดสอบตรวจรับ', false)
    const po = await sentPo(requester, 'ไม้อัด ตะปู และชุด PPE สำหรับไซต์ A', [
      { description: 'ไม้อัด 10 มม.', quantity: '10', uom: 'แผ่น', unitPrice: '520.00' },
      { description: 'ตะปู 2 นิ้ว', quantity: '1000', uom: 'ตัว', unitPrice: '1.20' },
      { description: 'ชุด PPE', quantity: '10', uom: 'ชุด', unitPrice: '850.00' },
    ])
    out = { ...po, receiver: receiverCode }
    break
  }
  case 'sod': {
    // ADR-038 ข้อ 8: a delegate who approved counts as an approver, so the delegate may not receive (BR-SOD-02)
    const approverCode = `e2e-rcv-${run}-sod`
    const approver = await freshMember(approverCode, 'ผู้ตรวจรับ ที่อนุมัติแทน', true)
    const requesterCode = `e2e-rcv-${run}-own`
    const requester = await freshMember(requesterCode, 'ผู้ขอ รับของเอง', false)
    const startsAt = new Date(now().getTime() - 60_000)
    const delegation = must(
      'delegate',
      await createDelegation(ctxOf(dmCon), { delegateMemberId: approver, startsAt: startsAt.toISOString(), endsAt: new Date(startsAt.getTime() + 3_600_000).toISOString(), documentTypes: ['PURCHASE_REQUEST'], reason: 'ทดสอบการตรวจรับ' }, key()),
    )
    let po: Awaited<ReturnType<typeof sentPo>>
    try {
      po = await sentPo(requester, 'ชุด PPE สำรองหน้างาน', [{ description: 'ชุด PPE', quantity: '2', uom: 'ชุด', unitPrice: '850.00' }])
    } finally {
      // The DM's own tasks come back to the DM at once; other specs never meet this delegation
      must('revoke', await revokeDelegation(ctxOf(dmCon), { delegationId: delegation.delegationId }, key()))
    }
    out = { ...po, approverReceiver: approverCode, requester: requesterCode }
    break
  }
  case 'variance': {
    if (receiverName) await freshMember(receiverCode, receiverName, true)
    const requester = await freshMember(`e2e-rcv-${run}-req`, 'ผู้ขอ ทดสอบรับเกิน', false)
    out = { ...(await sentPo(requester, 'ปูนซีเมนต์สำหรับเทพื้น', cement)), receiver: receiverCode }
    break
  }
  default: {
    // closeShort: 6 of the 10 bags came (the requester received them: requesters may receive under the demo DOA)
    const requester = await freshMember(`e2e-rcv-${run}-req`, 'ผู้ขอ ทดสอบปิดไม่ครบ', false)
    const po = await sentPo(requester, 'ปูนซีเมนต์ที่ผู้ขายส่งไม่ครบ', cement)
    const line = await prisma.poLine.findFirstOrThrow({ where: { poId: po.poId }, select: { id: true } })
    const gr = must('receive 6', await postGoodsReceipt(ctxOf(requester), { poId: po.poId, deliveryNoteNo: 'DN-6', lines: [{ poLineId: line.id, received: '6' }] }, key()))
    out = { ...po, grNumber: gr.number }
  }
}

console.log(JSON.stringify(out))
await prisma.$disconnect()
