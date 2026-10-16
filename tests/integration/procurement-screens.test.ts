import { randomUUID } from 'node:crypto'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { assignLines, consolidatePool } from '@/app/(workspace)/procurement/pool/commands'
import { canListPos, canSeePoPrices, canSeeSupplierContact, canViewPo, poReader, poRights } from '@/app/(workspace)/procurement/pos/_parts/access'
import { cancelPo, closePo, editDraft, sendToSupplier, submitDraft } from '@/app/(workspace)/procurement/pos/commands'
import { canViewRequest, taskRight } from '@/app/(workspace)/_tracking/access'
import { decideRequestTask } from '@/app/(workspace)/_tracking/commands'
import { EmailSendError, setEmailProvider, type EmailMessage } from '@/integrations/email-provider'
import { memberPrincipal } from '@/server/authz'
import { prisma } from '@/server/db/client'
import { consolidationSchedule, poolOptions } from '@/server/queries/procurement'
import { getPoAccess, getPurchaseOrderView, getVarianceView, listPurchaseOrders } from '@/server/queries/purchase-orders'
import { getTaskAccess, listMyTasks } from '@/server/queries/tasks'
import { decideTask } from '@/server/services/approvals/decide'
import { consolidateNow, listPool, runScheduledConsolidation } from '@/server/services/procurement'
import { previewPoSubmit } from '@/server/services/purchase-orders'
import { postGoodsReceipt, requestCloseShort } from '@/server/services/receiving'
import { createDraft, submitRequest } from '../support/requests'
import { createDoaOrg, type DoaOrg } from '../support/doa-org'

// The screens of unit e (S4-03, S4-04, S4-06): the procurement pool, the purchase-order pages and the decision page of
// PO and variance tasks. What the pages read (src/server/queries/procurement.ts and purchase-orders.ts, the preview
// of the route before sending a PO for approval) and the commands behind their buttons (src/app/(workspace)/procurement/
// pool|pos/commands.ts, the decision page's) refuse whoever the service refuses without changing anything, and say what
// the screen needs to show. Real Postgres (BCS_TEST_DB), an organization from the §7.4 fixtures. Monday 5 Oct 2026
// 10:00 Thai time; business days Mon–Fri; holidays 13 and 23 Oct 2026 (createDoaOrg); the cron of the demo settings
// (10:00 and 15:00 on business days, OQ-13).

const NOW = new Date('2026-10-05T03:00:00Z')
const key = () => randomUUID()
const svc = () => ({ idempotencyKey: randomUUID(), sender: null })
const ok = <T,>(r: { ok: true; data: T } | { ok: false; error: unknown }): T => {
  if (!r.ok) throw new Error(JSON.stringify(r.error))
  return r.data
}

let org: DoaOrg
let s1: string
let s2: string
let budgetLineId: string
const ctx = (code: string, at = NOW) => org.ctxOf(code, at)
const proc = () => ctx('proc_officer')
const codeOf = (memberId: string) => Object.entries(org.member).find(([, id]) => id === memberId)![0]
const principalOf = (code: string, roles: Parameters<typeof memberPrincipal>[1] = []) => memberPrincipal(org.member[code]!, roles)

beforeAll(async () => {
  org = await createDoaOrg()
  s1 = (await prisma.supplier.create({ data: { organizationId: org.organizationId, code: 'S1', nameTh: 'บริษัท วัสดุก่อสร้างทดสอบ จำกัด', taxId: '0999999000012', email: 's1@supplier.test' } })).id
  s2 = (await prisma.supplier.create({ data: { organizationId: org.organizationId, code: 'S2', nameTh: 'บริษัท ไอทีทดสอบ จำกัด', taxId: '0999999000021', email: 's2@supplier.test' } })).id
  await prisma.supplier.create({ data: { organizationId: org.organizationId, code: 'S9', nameTh: 'ผู้ขายเลิกใช้', taxId: '0999999000039', status: 'INACTIVE' } })
  await prisma.roleAssignment.create({ data: { organizationId: org.organizationId, memberId: org.member.receiver_con!, role: 'RECEIVER', scopeDepartmentId: org.department.CON!, grantedAt: NOW } })
  budgetLineId = (await prisma.budgetLine.findFirstOrThrow({ where: { organizationId: org.organizationId, code: 'CON-OPEX-2569' } })).id
})

afterEach(() => setEmailProvider(null))

/** A delivery site of its own, so a round puts only this test's lines on a PO */
async function site(): Promise<string> {
  return (await prisma.deliverySite.create({ data: { organizationId: org.organizationId, code: `SITE-${randomUUID().slice(0, 8)}`, nameTh: 'ไซต์ทดสอบ' } })).id
}

async function approveAll(subjectId: string, at = NOW) {
  for (let i = 0; i < 5; i++) {
    const task = await prisma.approvalTask.findFirst({ where: { status: 'OPEN', step: { route: { subjectId } } } })
    if (!task) return
    ok(await decideTask(ctx(codeOf(task.assigneeMemberId), at), { taskId: task.id, decision: 'APPROVE' }, svc()))
  }
}

/** An approved request of CON at a site, its lines' ids in order */
async function approvedRequest(options: { siteId: string; urgent?: boolean; requester?: string; lines?: Array<{ quantity: string; unitPrice: string; description?: string; categoryCode?: string }> }) {
  const requester = options.requester ?? 'req_con'
  const lines = options.lines ?? [{ quantity: '10', unitPrice: '100.00' }]
  const draft = ok(
    await createDraft(
      ctx(requester),
      {
        requestTypeCode: 'BUY_GOODS',
        title: 'วัสดุไซต์',
        budgetLineId,
        deliverySiteId: options.siteId,
        urgency: options.urgent ? 'URGENT' : 'NORMAL',
        lines: lines.map((l, i) => ({ description: l.description ?? `ของ ${i + 1}`, quantity: l.quantity, uom: 'ชิ้น', unitPrice: l.unitPrice, ...(l.categoryCode ? { categoryCode: l.categoryCode } : {}) })),
      },
      svc(),
    ),
  )
  const sent = ok(await submitRequest(ctx(requester), { requestId: draft.requestId }, svc()))
  await approveAll(draft.requestId)
  const request = await prisma.request.findUniqueOrThrow({ where: { id: draft.requestId }, include: { lines: { orderBy: { lineNo: 'asc' } } } })
  expect(request.status).toBe('APPROVED')
  return { id: request.id, number: sent.number, lineIds: request.lines.map((l) => l.id) }
}

/** The draft PO of these request lines with supplier S1 (or another), through the pool's own commands */
async function draftPo(requestLineIds: string[], supplierId = s1): Promise<string> {
  const assigned = await assignLines(proc(), { requestLineIds, supplierId }, key())
  expect(assigned.ok).toBe(true)
  const run = ok(await consolidateNow(proc(), svc()))
  const po = await prisma.purchaseOrder.findFirstOrThrow({ where: { id: { in: [...run.purchaseOrderIds] }, lines: { some: { sources: { some: { requestLineId: requestLineIds[0]! } } } } } })
  return po.id
}

async function approvedPo(lines?: Array<{ quantity: string; unitPrice: string; description?: string; categoryCode?: string }>, at = NOW) {
  const r = await approvedRequest({ siteId: await site(), ...(lines ? { lines } : {}) })
  const poId = await draftPo(r.lineIds)
  expect(await submitDraft(proc(), poId, key())).toEqual({ ok: true, status: 'PENDING_APPROVAL' })
  await approveAll(poId, at)
  return { poId, request: r }
}

/** A provider that keeps what it was asked to send, or refuses every message */
function provider(refuse?: EmailSendError) {
  const sent: EmailMessage[] = []
  setEmailProvider({
    async send(message) {
      sent.push(message)
      if (refuse) throw refuse
      return { messageId: randomUUID() }
    },
  })
  return sent
}

describe('[FR-P2P-001/AC2] [FR-P2P-001/AC3] the pool chooses the supplier of many lines at once, and only for procurement', () => {
  it('chooses S1 for lines of two requests in one go; the lines show their supplier and no longer need one', async () => {
    const where = await site()
    const a = await approvedRequest({ siteId: where, lines: [{ quantity: '5', unitPrice: '200.00' }, { quantity: '2', unitPrice: '50.00' }] })
    const b = await approvedRequest({ siteId: where })
    const before = ok(await listPool(proc(), { deliverySiteId: where }))
    expect(before.map((l) => l.needsSupplier)).toEqual([true, true, true])
    const outcome = await assignLines(proc(), { requestLineIds: [...a.lineIds, ...b.lineIds], supplierId: s1 }, key())
    expect(outcome).toEqual({ ok: true, assigned: 3, drafts: [] })
    const after = ok(await listPool(proc(), { deliverySiteId: where }))
    expect(after.map((l) => [l.needsSupplier, l.supplier?.code])).toEqual([
      [false, 'S1'],
      [false, 'S1'],
      [false, 'S1'],
    ])
    // Taking the choice back leaves them waiting for one again (BR-CONS-03)
    expect(await assignLines(proc(), { requestLineIds: b.lineIds, supplierId: null }, key())).toMatchObject({ ok: true, assigned: 1 })
    expect(ok(await listPool(proc(), { supplierId: 'NONE', deliverySiteId: where })).map((l) => l.requestLineId)).toEqual(b.lineIds)
    // Leave the pool as the test found it: no line with a supplier waits for another test's round
    await assignLines(proc(), { requestLineIds: a.lineIds, supplierId: null }, key())
  })

  it('refuses a requester, an inactive supplier and a malformed call, and changes nothing', async () => {
    const r = await approvedRequest({ siteId: await site() })
    expect(await assignLines(ctx('req_con'), { requestLineIds: r.lineIds, supplierId: s1 }, key())).toMatchObject({ ok: false, code: 'FORBIDDEN' })
    const inactive = (await prisma.supplier.findFirstOrThrow({ where: { organizationId: org.organizationId, code: 'S9' } })).id
    expect(await assignLines(proc(), { requestLineIds: r.lineIds, supplierId: inactive }, key())).toMatchObject({ ok: false, code: 'VALIDATION_FAILED', reason: 'SUPPLIER_INACTIVE' })
    expect(await assignLines(proc(), { requestLineIds: ['not-a-line'], supplierId: s1 }, key())).toEqual({ ok: false, code: 'VALIDATION_FAILED', field: 'requestLineIds' })
    expect(await assignLines(proc(), { requestLineIds: r.lineIds, supplierId: s1 }, 'not-a-key')).toEqual({ ok: false, code: 'VALIDATION_FAILED', field: 'idempotencyKey' })
    expect((await prisma.requestLine.findUniqueOrThrow({ where: { id: r.lineIds[0]! } })).supplierId).toBeNull()
  })

  it('[GC-CONS-03] an urgent request gets its draft at once and the screen is told which one; a normal one of the same supplier and site waits for the round', async () => {
    const where = await site()
    const r = await approvedRequest({ siteId: where, urgent: true })
    const normal = await approvedRequest({ siteId: where })
    const outcome = await assignLines(proc(), { requestLineIds: [...r.lineIds, ...normal.lineIds], supplierId: s2 }, key())
    expect(outcome).toMatchObject({ ok: true, assigned: 2, drafts: [{ supplierName: 'บริษัท ไอทีทดสอบ จำกัด', siteName: 'ไซต์ทดสอบ', kind: 'GOODS', lineCount: 1, net: '1,000.00', requestNumbers: [r.number] }] })
    if (!outcome.ok) throw new Error(JSON.stringify(outcome))
    expect(outcome.drafts).toHaveLength(1)
    // The normal request stays in the pool with its supplier until a round drafts it
    expect(ok(await listPool(proc(), { deliverySiteId: where })).map((l) => [l.requestLineId, l.supplier?.code, l.urgency])).toEqual([[normal.lineIds[0], 'S2', 'NORMAL']])
    await assignLines(proc(), { requestLineIds: normal.lineIds, supplierId: null }, key())
  })
})

describe('[FR-P2P-002/AC3] "รวมเป็นร่าง PO ตอนนี้" says what the round made and what it left in the pool', () => {
  it('makes one draft per supplier and site, lists them, and counts the lines that still need a supplier', async () => {
    const where = await site()
    const a = await approvedRequest({ siteId: where })
    const b = await approvedRequest({ siteId: where })
    const waiting = await approvedRequest({ siteId: where })
    await assignLines(proc(), { requestLineIds: [...a.lineIds, ...b.lineIds], supplierId: s1 }, key())
    const outcome = await consolidatePool(proc(), key())
    if (!outcome.ok) throw new Error(JSON.stringify(outcome))
    const mine = outcome.drafts!.filter((d) => d.requestNumbers.includes(a.number))
    expect(mine).toEqual([{ id: expect.any(String), supplierName: 'บริษัท วัสดุก่อสร้างทดสอบ จำกัด', siteName: 'ไซต์ทดสอบ', kind: 'GOODS', lineCount: 2, net: '2,000.00', requestNumbers: [a.number, b.number] }])
    const left = ok(await listPool(proc())).filter((l) => l.needsSupplier).length
    expect(outcome.left).toBe(left)
    expect(outcome.left).toBeGreaterThanOrEqual(1)
    expect(ok(await listPool(proc(), { deliverySiteId: where })).map((l) => l.requestLineId)).toEqual(waiting.lineIds)
    expect(outcome.waiting).toBe(0)
  })

  it('refuses anyone but procurement and runs no round', async () => {
    const rounds = await prisma.consolidationRun.count({ where: { organizationId: org.organizationId } })
    expect(await consolidatePool(ctx('coo'), key())).toMatchObject({ ok: false, code: 'FORBIDDEN' })
    expect(await consolidatePool(proc(), 'nope')).toEqual({ ok: false, code: 'VALIDATION_FAILED', field: 'idempotencyKey' })
    expect(await prisma.consolidationRun.count({ where: { organizationId: org.organizationId } })).toBe(rounds)
  })
})

describe('[FR-P2P-002/AC2] the pool tells when the next automatic round runs, and the rounds that ran', () => {
  it('names the next slot of the cron after now, skips weekends and holidays, and lists the latest rounds with their drafts', async () => {
    const at = (iso: string) => ({ ...proc(), now: new Date(iso) })
    // Monday 10:00 sharp: the 10:00 round is now, the next one 15:00
    expect((await consolidationSchedule(proc())).next).toEqual({ kind: 'AT', at: new Date('2026-10-05T08:00:00Z') })
    // Friday 15:30: Monday 10:00
    expect((await consolidationSchedule(at('2026-10-09T08:30:00Z'))).next).toEqual({ kind: 'AT', at: new Date('2026-10-12T03:00:00Z') })
    // Monday 12 Oct 15:30, Tuesday 13 Oct is a holiday: Wednesday 10:00
    expect((await consolidationSchedule(at('2026-10-12T08:30:00Z'))).next).toEqual({ kind: 'AT', at: new Date('2026-10-14T03:00:00Z') })

    const r = await approvedRequest({ siteId: await site() })
    await assignLines(proc(), { requestLineIds: r.lineIds, supplierId: s1 }, key())
    const outcome = await consolidatePool(proc(), key())
    if (!outcome.ok) throw new Error(JSON.stringify(outcome))
    const [latest] = (await consolidationSchedule(proc())).recent
    expect(latest).toMatchObject({ trigger: 'MANUAL', by: { id: org.member.proc_officer }, drafts: expect.arrayContaining([expect.objectContaining({ number: null, status: 'DRAFT', supplierName: 'บริษัท วัสดุก่อสร้างทดสอบ จำกัด' })]) })
  })

  it('says there is no automatic round when the cron cannot be read', async () => {
    const other = await createDoaOrg()
    const settings = (await prisma.organization.findUniqueOrThrow({ where: { id: other.organizationId } })).settings as Record<string, unknown>
    await prisma.organization.update({ where: { id: other.organizationId }, data: { settings: { ...settings, consolidation: { cron: 'every day at ten' } } } })
    expect((await consolidationSchedule(other.ctxOf('proc_officer', NOW))).next).toEqual({ kind: 'CRON_INVALID' })
  })

  it('offers the active suppliers and sites only', async () => {
    const options = await poolOptions(proc())
    expect(options.suppliers.map((s) => s.code)).toEqual(['S1', 'S2'])
    expect(options.sites.length).toBeGreaterThan(0)
  })
})

describe('[FR-P2P-003/AC2] [FR-P2P-003/AC3] the draft page edits prices, quantities, terms and the note; totals come from the server', () => {
  it('shows what each line may order, saves the changes with the version it was opened at, and computes the totals again', async () => {
    const r = await approvedRequest({ siteId: await site(), lines: [{ quantity: '10', unitPrice: '100.00' }, { quantity: '4', unitPrice: '250.00' }] })
    const poId = await draftPo(r.lineIds)
    const view = (await getPurchaseOrderView(proc(), poId))!
    expect(view).toMatchObject({ status: 'DRAFT', number: null, next: { edit: true, submit: true, send: false, cancel: false }, totals: { netSatang: 200_000n, vatSatang: 14_000n, grossSatang: 214_000n } })
    expect(view.lines.map((l) => [l.quantity, l.maxQuantity, l.sources[0]!.requestNumber, l.sources[0]!.requestLineNo])).toEqual([
      ['10', '10', r.number, 1],
      ['4', '4', r.number, 2],
    ])
    // More than the request has left is refused with what is left
    expect(await editDraft(proc(), { poId, expectedVersion: view.version, lines: [{ poLineId: view.lines[0]!.id, quantity: '11' }] }, key())).toMatchObject({ ok: false, code: 'VALIDATION_FAILED', reason: 'QUANTITY_OVER_REQUEST', left: '10' })
    const saved = await editDraft(
      proc(),
      { poId, expectedVersion: view.version, lines: [{ poLineId: view.lines[0]!.id, quantity: '8', unitPrice: '110.00' }], removeLineIds: [view.lines[1]!.id], paymentTermDays: 30, notesToSupplier: '  ส่งก่อน 10 โมง  ' },
      key(),
    )
    expect(saved).toEqual({ ok: true })
    const after = (await getPurchaseOrderView(proc(), poId))!
    expect(after).toMatchObject({ paymentTermDays: 30, notesToSupplier: 'ส่งก่อน 10 โมง', totals: { netSatang: 88_000n, vatSatang: 6_160n, grossSatang: 94_160n } })
    expect(after.lines.map((l) => [l.quantity, l.unitPriceSatang])).toEqual([['8', 11_000n]])
    // The removed line is back in the pool, and the page opened before the save is refused
    expect(ok(await listPool(proc())).some((l) => l.requestLineId === r.lineIds[1])).toBe(true)
    expect(await editDraft(proc(), { poId, expectedVersion: view.version, paymentTermDays: 45 }, key())).toMatchObject({ ok: false, code: 'CONFLICT_VERSION' })
    expect(after.track.filter((e) => e.what === 'EDITED')).toHaveLength(1)
    await assignLines(proc(), { requestLineIds: [r.lineIds[1]!], supplierId: null }, key())
  })

  it('refuses anyone but procurement, and a malformed price, without changing the draft', async () => {
    const r = await approvedRequest({ siteId: await site() })
    const poId = await draftPo(r.lineIds)
    const view = (await getPurchaseOrderView(proc(), poId))!
    expect(await editDraft(ctx('req_con'), { poId, expectedVersion: view.version, paymentTermDays: 15 }, key())).toMatchObject({ ok: false, code: 'FORBIDDEN' })
    expect(await editDraft(proc(), { poId, expectedVersion: view.version, lines: [{ poLineId: view.lines[0]!.id, unitPrice: '1,000' }] }, key())).toMatchObject({ ok: false, code: 'VALIDATION_FAILED' })
    expect((await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: poId } })).version).toBe(view.version)
  })
})

describe('[FR-P2P-003/AC1] the prices paid before show to procurement and to the approver, not to a requester', () => {
  it('lists the last approved prices of the same item newest first and warns above settings.priceAlertPct', async () => {
    const item = { description: 'สายไฟ THW 2.5 ตร.มม.', categoryCode: 'ELEC' }
    await approvedPo([{ quantity: '1', unitPrice: '1000.00', ...item }], new Date(NOW.getTime() + 60_000))
    await approvedPo([{ quantity: '1', unitPrice: '1050.00', ...item }], new Date(NOW.getTime() + 120_000))
    const { poId } = await approvedPo([{ quantity: '1', unitPrice: '1200.00', ...item }], new Date(NOW.getTime() + 180_000))
    const r = await approvedRequest({ siteId: await site(), lines: [{ quantity: '1', unitPrice: '1200.00', description: 'สายไฟ  thw 2.5 ตร.มม.', categoryCode: 'ELEC' }] })
    const draftId = await draftPo(r.lineIds)
    const view = (await getPurchaseOrderView(proc(), draftId))!
    expect(view.prices.alertPct).toBe(10)
    expect(view.prices.lines[0]!.previous.map((p) => p.unitPriceSatang)).toEqual([120_000n, 105_000n, 100_000n])
    expect(view.prices.lines[0]!.alert).toBe(false)
    // The approved PO at 1,200 was above 1,050 × 1.10: its own page warns
    expect((await getPurchaseOrderView(proc(), poId))!.prices.lines[0]!.alert).toBe(true)

    const access = (await getPoAccess(proc(), poId))!
    expect(canSeePoPrices(principalOf('proc_officer', ['PROCUREMENT']), access)).toBe(true)
    expect(canSeePoPrices(principalOf('coo'), access)).toBe(true)
    expect(canSeePoPrices(principalOf('req_con'), access)).toBe(false)
  })
})

describe('[FR-P2P-004/AC1] before sending, the page shows the route the DOA expects; after, the route it took', () => {
  it('expects the COO under PO-01, reserves nothing more at the request price, and matches the route of the submit', async () => {
    const r = await approvedRequest({ siteId: await site(), lines: [{ quantity: '10', unitPrice: '100.00' }] })
    const poId = await draftPo(r.lineIds)
    const preview = ok(await previewPoSubmit(proc(), poId))
    expect(preview).toMatchObject({ supplierActive: true, extraReserveSatang: 0n, totals: { netSatang: 100_000n, vatSatang: 7_000n, grossSatang: 107_000n, vatRateBp: 700 } })
    if (preview.route.kind !== 'ROUTE') throw new Error('no route')
    expect(preview.route).toMatchObject({ doa: { code: 'DOA-DEMO', versionNo: 1, ruleCode: 'PO-01' }, steps: [{ stepNo: 1, approver: { id: org.member.coo } }] })
    expect(preview.route.explanationTh).toContain('PO-01')

    // A higher price than the request reserves the difference at submit (BR-BUD-05)
    const view = (await getPurchaseOrderView(proc(), poId))!
    await editDraft(proc(), { poId, expectedVersion: view.version, lines: [{ poLineId: view.lines[0]!.id, unitPrice: '120.00' }] }, key())
    expect(ok(await previewPoSubmit(proc(), poId)).extraReserveSatang).toBe(20_000n)

    expect(await submitDraft(proc(), poId, key())).toEqual({ ok: true, status: 'PENDING_APPROVAL' })
    const sent = (await getPurchaseOrderView(proc(), poId))!
    expect(sent.route).toMatchObject({ doa: { ruleCode: 'PO-01' }, steps: [{ stepNo: 1, status: 'ACTIVE', approver: { id: org.member.coo } }] })
    expect(sent.waiting).toMatchObject({ kind: 'APPROVER', assignee: { id: org.member.coo } })
    expect(sent.track.map((e) => e.what)).toEqual(['DRAFTED', 'EDITED', 'SUBMITTED', 'WAIT_APPROVAL'])
    expect(sent.track.find((e) => e.what === 'SUBMITTED')!.detail).toBe(sent.number)
  })

  it('refuses the preview and the submit to anyone but procurement, and a PO that is not a draft', async () => {
    const r = await approvedRequest({ siteId: await site() })
    const poId = await draftPo(r.lineIds)
    expect(await previewPoSubmit(ctx('coo'), poId)).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    expect(await submitDraft(ctx('req_con'), poId, key())).toMatchObject({ ok: false, code: 'FORBIDDEN' })
    expect((await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: poId } })).status).toBe('DRAFT')
    expect(await submitDraft(proc(), poId, key())).toMatchObject({ ok: true })
    expect(await previewPoSubmit(proc(), poId)).toMatchObject({ ok: false, error: { code: 'INVALID_STATE_TRANSITION' } })
  })
})

describe('[FR-P2P-005/AC1] [FR-P2P-005/AC2] [FR-P2P-005/AC3] the page sends the PO, shows a bounce, and sends again only with a reason', () => {
  it('sends to the supplier and the PO is SENT with when and to whom', async () => {
    const { poId } = await approvedPo()
    const sent = provider()
    expect((await getPurchaseOrderView(proc(), poId))!.next).toMatchObject({ send: true, resend: false, cancel: true })
    expect(await sendToSupplier(proc(), { poId }, key())).toEqual({ ok: true, status: 'SENT' })
    expect(sent.map((m) => m.to)).toEqual(['s1@supplier.test'])
    const view = (await getPurchaseOrderView(proc(), poId))!
    expect(view).toMatchObject({ status: 'SENT', sentToEmail: 's1@supplier.test', sentAt: NOW, bounce: null, next: { send: false, resend: true }, waiting: { kind: 'DELIVERY' } })
    expect(view.track.filter((e) => e.state === 'done').map((e) => e.what)).toEqual(['DRAFTED', 'SUBMITTED', 'APPROVED', 'SENT'])
  })

  it('keeps a bounced PO APPROVED with the code, then sends it again only with a reason, an event each time', async () => {
    const { poId } = await approvedPo()
    provider(new EmailSendError(true, 'SMTP_550'))
    expect(await sendToSupplier(proc(), { poId }, key())).toEqual({ ok: true, status: 'APPROVED', bounce: 'SMTP_550' })
    const bounced = (await getPurchaseOrderView(proc(), poId))!
    expect(bounced).toMatchObject({ status: 'APPROVED', bounce: { code: 'SMTP_550' }, waiting: { kind: 'SEND', bounced: true }, next: { send: false, resend: true } })
    expect(bounced.track.find((e) => e.what === 'BOUNCED')).toMatchObject({ detail: 'SMTP_550' })

    provider()
    expect(await sendToSupplier(proc(), { poId }, key())).toMatchObject({ ok: false, code: 'VALIDATION_FAILED', field: 'reason' })
    expect(await sendToSupplier(proc(), { poId, reason: 'ab' }, key())).toEqual({ ok: false, code: 'VALIDATION_FAILED', field: 'reason' })
    expect(await sendToSupplier(proc(), { poId, reason: 'แก้อีเมลผู้ขายแล้ว' }, key())).toEqual({ ok: true, status: 'SENT' })
    const resent = (await getPurchaseOrderView(proc(), poId))!
    expect(resent.track.filter((e) => e.state === 'done').map((e) => e.what)).toEqual(['DRAFTED', 'SUBMITTED', 'APPROVED', 'BOUNCED', 'RESENT'])
    expect(resent.track.find((e) => e.what === 'RESENT')!.note).toBe('แก้อีเมลผู้ขายแล้ว')
    expect(resent.bounce).toBeNull()
  })

  it('refuses anyone but procurement and sends nothing', async () => {
    const { poId } = await approvedPo()
    const sent = provider()
    expect(await sendToSupplier(ctx('coo'), { poId }, key())).toMatchObject({ ok: false, code: 'FORBIDDEN' })
    expect(await sendToSupplier(ctx('req_con'), { poId }, key())).toMatchObject({ ok: false, code: 'FORBIDDEN' })
    expect(sent).toEqual([])
    expect((await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: poId } })).status).toBe('APPROVED')
  })
})

describe('[FR-P2P-010/AC1] the page cancels an approved PO with what happens to its lines and a reason', () => {
  it('returns the lines to the pool, records the reason on the timeline, and refuses without a reason or for anyone else', async () => {
    const { poId, request } = await approvedPo()
    expect(await cancelPo(proc(), { poId, disposition: 'RETURN_TO_POOL', reason: ' ' }, key())).toEqual({ ok: false, code: 'VALIDATION_FAILED', field: 'reason' })
    expect(await cancelPo(ctx('req_con'), { poId, disposition: 'RETURN_TO_POOL', reason: 'ผู้ขายแจ้งของหมด' }, key())).toMatchObject({ ok: false, code: 'FORBIDDEN' })
    expect(await cancelPo(proc(), { poId, disposition: 'SOMETHING', reason: 'ผู้ขายแจ้งของหมด' }, key())).toEqual({ ok: false, code: 'VALIDATION_FAILED', field: 'disposition' })
    expect((await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: poId } })).status).toBe('APPROVED')

    expect(await cancelPo(proc(), { poId, disposition: 'RETURN_TO_POOL', reason: 'ผู้ขายแจ้งของหมด' }, key())).toEqual({ ok: true, status: 'CANCELLED' })
    const view = (await getPurchaseOrderView(proc(), poId))!
    expect(view).toMatchObject({ status: 'CANCELLED', cancelDisposition: 'RETURN_TO_POOL', cancelReason: 'ผู้ขายแจ้งของหมด', next: { cancel: false, send: false, resend: false }, waiting: { kind: 'NONE' } })
    expect(view.track.find((e) => e.what === 'CANCELLED')).toMatchObject({ detail: 'RETURN_TO_POOL', note: 'ผู้ขายแจ้งของหมด' })
    expect(ok(await listPool(proc())).some((l) => l.requestLineId === request.lineIds[0])).toBe(true)
    await assignLines(proc(), { requestLineIds: request.lineIds, supplierId: null }, key())
  })
})

// FR-P2P-010 AC2 (closing a short PO after its shortfall is approved) belongs to receiving (S4-07): this checks only what
// the page offers and that a close asked too early is refused
describe('closing waits for every line to come in full', () => {
  it('offers no close while goods are short, refuses one asked anyway, and closes once everything came', async () => {
    const { poId } = await approvedPo([{ quantity: '10', unitPrice: '100.00' }])
    provider()
    await sendToSupplier(proc(), { poId }, key())
    const line = (await getPurchaseOrderView(proc(), poId))!.lines[0]!
    ok(await postGoodsReceipt(ctx('receiver_con'), { poId, lines: [{ poLineId: line.id, received: '6' }] }, svc()))
    expect((await getPurchaseOrderView(proc(), poId))!.next).toMatchObject({ close: false, closeNeedsShortfall: true, cancel: false })
    expect(await closePo(proc(), poId, key())).toMatchObject({ ok: false, code: 'INVALID_STATE_TRANSITION', reason: 'SHORT_NOT_APPROVED' })
    ok(await postGoodsReceipt(ctx('receiver_con'), { poId, lines: [{ poLineId: line.id, received: '4' }] }, svc()))
    const received = (await getPurchaseOrderView(proc(), poId))!
    expect(received).toMatchObject({ status: 'RECEIVED', next: { close: true, closeNeedsShortfall: false }, waiting: { kind: 'CLOSE' } })
    expect(received.track.filter((e) => e.what === 'RECEIVED')).toHaveLength(2)
    expect(await closePo(ctx('fin_officer'), poId, key())).toMatchObject({ ok: false, code: 'FORBIDDEN' })
    expect(await closePo(proc(), poId, key())).toEqual({ ok: true, status: 'CLOSED' })
  })
})

describe('the purchase-order list and who may open a PO (po.view)', () => {
  it('counts POs by status, finds one by number, and says whom each waits for', async () => {
    const { poId } = await approvedPo()
    const r = await approvedRequest({ siteId: await site() })
    const pending = await draftPo(r.lineIds)
    await submitDraft(proc(), pending, key())
    const number = (await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: pending } })).number!
    const list = await listPurchaseOrders(proc(), { q: number })
    expect(list.rows).toHaveLength(1)
    expect(list.rows[0]).toMatchObject({ id: pending, status: 'PENDING_APPROVAL', requestNumbers: [r.number], waiting: { kind: 'APPROVER', assignee: { id: org.member.coo } } })
    const approved = await listPurchaseOrders(proc(), { status: 'APPROVED' })
    expect(approved.rows.map((p) => p.id)).toContain(poId)
    expect(approved.rows.every((p) => p.status === 'APPROVED')).toBe(true)
    expect(approved.counts.APPROVED).toBe(approved.matched)
  })

  it('lists them for whoever sees every PO (po.view ORG, §9.10); the PO opens for its creator, its requesters, its approver and org-wide roles, and nobody else', async () => {
    const { poId } = await approvedPo()
    expect(canListPos(principalOf('proc_officer', ['PROCUREMENT']))).toBe(true)
    expect(canListPos(principalOf('fin_officer', ['FINANCE']))).toBe(true)
    expect(canListPos(principalOf('coo', ['EXECUTIVE']))).toBe(true)
    expect(canListPos(principalOf('auditor', ['AUDITOR']))).toBe(true)
    // A requester and an approver see their own POs only (OWN, ASSIGNED): not the list of all of them
    expect(canListPos(principalOf('req_con'))).toBe(false)
    expect(canListPos(principalOf('coo'))).toBe(false)
    const access = (await getPoAccess(proc(), poId))!
    expect(canViewPo(principalOf('proc_officer', ['PROCUREMENT']), access)).toBe(true)
    expect(canViewPo(principalOf('req_con'), access)).toBe(true)
    expect(canViewPo(principalOf('coo'), access)).toBe(true)
    expect(canViewPo(principalOf('fin_officer', ['FINANCE']), access)).toBe(true)
    expect(canViewPo(principalOf('asst_con'), access)).toBe(false)
    expect(canViewPo(principalOf('dm_it'), access)).toBe(false)
    expect(poRights(principalOf('coo'))).toEqual({ edit: false, submit: false, send: false, cancel: false, close: false })
    expect(poRights(principalOf('proc_officer', ['PROCUREMENT']))).toEqual({ edit: true, submit: true, send: true, cancel: true, close: true })
  })
})

describe('[FR-DOA-004/AC2] [FR-DOA-007/AC2] a PO task on the decision page: the creator is refused and the refusal recorded, and a second decision names who and when', () => {
  it('lists the PO for the COO, refuses its creator (GC-SOD-03), approves it, then tells a second press who decided', async () => {
    const r = await approvedRequest({ siteId: await site() })
    const poId = await draftPo(r.lineIds)
    await submitDraft(proc(), poId, key())
    const task = await prisma.approvalTask.findFirstOrThrow({ where: { status: 'OPEN', step: { route: { subjectType: 'PURCHASE_ORDER', subjectId: poId } } } })
    const inbox = await listMyTasks(ctx('coo'))
    expect(inbox.items.find((i) => i.id === task.id)?.subject).toMatchObject({ kind: 'PURCHASE_ORDER', poId, supplierName: 'บริษัท วัสดุก่อสร้างทดสอบ จำกัด', submittedBy: { id: org.member.proc_officer }, grossSatang: 107_000n })
    expect(taskRight(principalOf('coo'), (await getTaskAccess(ctx('coo'), task.id))!)).toBe('DECIDE')
    expect(taskRight(principalOf('proc_officer', ['PROCUREMENT']), (await getTaskAccess(proc(), task.id))!)).toBe('NONE')

    // The task reaches its creator (as an acting approver would): separation of duties still refuses
    await prisma.approvalTask.update({ where: { id: task.id }, data: { assigneeMemberId: org.member.proc_officer! } })
    expect(await decideRequestTask(proc(), { taskId: task.id, decision: 'APPROVE' }, key(), 'th')).toEqual({ ok: false, code: 'SOD_VIOLATION', rule: 'BR-SOD-03' })
    expect(await prisma.event.findFirstOrThrow({ where: { type: 'security.sod_blocked', aggregateId: poId } })).toMatchObject({ data: { rule: 'BR-SOD-03', subjectType: 'PURCHASE_ORDER', actorMemberId: org.member.proc_officer } })
    await prisma.approvalTask.update({ where: { id: task.id }, data: { assigneeMemberId: org.member.coo! } })

    expect(await decideRequestTask(ctx('coo'), { taskId: task.id, decision: 'APPROVE' }, key(), 'th')).toEqual({ ok: true, documentStatus: 'APPROVED' })
    const twice = await decideRequestTask(ctx('coo'), { taskId: task.id, decision: 'APPROVE' }, key(), 'th')
    expect(twice).toMatchObject({ ok: false, code: 'INVALID_STATE_TRANSITION', name: 'ผู้ใช้ coo', time: NOW.toISOString() })
    const view = (await getPurchaseOrderView(proc(), poId))!
    expect(view.track.find((e) => e.what === 'APPROVED')).toMatchObject({ actor: { id: org.member.coo }, doa: { code: 'DOA-DEMO', versionNo: 1, ruleCode: 'PO-01' }, channel: 'WEB' })
  })

  it('returns a PO to procurement with a reason; it is a draft again with its number', async () => {
    const r = await approvedRequest({ siteId: await site() })
    const poId = await draftPo(r.lineIds)
    await submitDraft(proc(), poId, key())
    const task = await prisma.approvalTask.findFirstOrThrow({ where: { status: 'OPEN', step: { route: { subjectType: 'PURCHASE_ORDER', subjectId: poId } } } })
    expect(await decideRequestTask(ctx('coo'), { taskId: task.id, decision: 'RETURN', reason: 'ต่อราคาอีกครั้ง' }, key(), 'th')).toEqual({ ok: true, documentStatus: 'DRAFT' })
    const view = (await getPurchaseOrderView(proc(), poId))!
    expect(view).toMatchObject({ status: 'DRAFT', next: { edit: true, submit: true }, waiting: { kind: 'EDIT' } })
    expect(view.number).not.toBeNull()
    expect(view.track.find((e) => e.what === 'RETURNED')).toMatchObject({ note: 'ต่อราคาอีกครั้ง', doa: { ruleCode: 'PO-01' } })
  })
})

describe('[FR-P2P-007/AC2] a variance task on the decision page: the PO line, ordered and received, the amount; approve or reject only', () => {
  it('shows the shortfall closed by procurement, goes to the DM of the department, refuses a return, and rejects with a reason', async () => {
    const { poId } = await approvedPo([{ quantity: '10', unitPrice: '100.00', description: 'ไม้อัด 4 มม.' }])
    provider()
    await sendToSupplier(proc(), { poId }, key())
    const line = (await getPurchaseOrderView(proc(), poId))!.lines[0]!
    ok(await postGoodsReceipt(ctx('receiver_con'), { poId, deliveryNoteNo: 'DN-77', lines: [{ poLineId: line.id, received: '6' }] }, svc()))
    const [varianceId] = ok(await requestCloseShort(proc(), { poId, reason: 'ผู้ขายเลิกผลิตรุ่นนี้' }, svc())).varianceIds
    const view = (await getVarianceView(proc(), varianceId!))!
    expect(view).toMatchObject({
      type: 'SHORT',
      disposition: 'CLOSE_SHORT',
      status: 'PENDING_APPROVAL',
      quantity: '4',
      amountSatang: 40_000n,
      vatSatang: 2_800n,
      grossSatang: 42_800n,
      reason: 'ผู้ขายเลิกผลิตรุ่นนี้',
      createdBy: { id: org.member.proc_officer },
      line: { description: 'ไม้อัด 4 มม.', ordered: '10', received: '6', cancelled: '0' },
      gr: null,
      route: { doa: { ruleCode: 'GRV-01' }, steps: [{ approver: { id: org.member.dm_con } }] },
    })
    expect(view.track.map((e) => e.what)).toEqual(['VARIANCE_RECORDED', 'WAIT_APPROVAL'])

    const task = await prisma.approvalTask.findFirstOrThrow({ where: { status: 'OPEN', step: { route: { subjectType: 'VARIANCE', subjectId: varianceId! } } } })
    const inbox = await listMyTasks(ctx('dm_con'))
    expect(inbox.items.find((i) => i.id === task.id)?.subject).toMatchObject({ kind: 'VARIANCE', varianceId, varianceType: 'SHORT', description: 'ไม้อัด 4 มม.', amountSatang: 40_000n })
    // The variance's approver may not open the PO itself: the page shows its number as text
    expect(canViewPo(principalOf('dm_con'), (await getPoAccess(proc(), poId))!)).toBe(false)

    expect(await decideRequestTask(ctx('dm_con'), { taskId: task.id, decision: 'RETURN', reason: 'ส่งกลับ' }, key(), 'th')).toMatchObject({ ok: false, code: 'INVALID_STATE_TRANSITION' })
    expect(await decideRequestTask(ctx('proc_officer'), { taskId: task.id, decision: 'REJECT', reason: 'ไม่ปิด' }, key(), 'th')).toMatchObject({ ok: false, code: 'FORBIDDEN' })
    expect(await decideRequestTask(ctx('dm_con'), { taskId: task.id, decision: 'REJECT', reason: 'ให้ผู้ขายส่งของที่เหลือ' }, key(), 'th')).toEqual({ ok: true, documentStatus: 'REJECTED' })
    const decided = (await getVarianceView(proc(), varianceId!))!
    expect(decided.status).toBe('REJECTED')
    expect(decided.track.find((e) => e.what === 'REJECTED')).toMatchObject({ actor: { id: org.member.dm_con }, note: 'ให้ผู้ขายส่งของที่เหลือ', doa: { ruleCode: 'GRV-01' } })
    expect((await getPurchaseOrderView(proc(), poId))!.status).toBe('PARTIALLY_RECEIVED')
  })
})

describe('a refusal for lack of budget at sending (BR-BUD-05) tells the shortfall only to who may view the budget line (§2.4 budget.view)', () => {
  it('refuses PROCUREMENT without amounts, gives a budget.view holder the shortfall, and leaves the draft as it was', async () => {
    const r = await approvedRequest({ siteId: await site(), lines: [{ quantity: '1', unitPrice: '100.00' }] })
    const poId = await draftPo(r.lineIds)
    const view = (await getPurchaseOrderView(proc(), poId))!
    // Far above what the request reserved: the extra cannot be reserved on the budget line (BR-BUD-05)
    expect(await editDraft(proc(), { poId, expectedVersion: view.version, lines: [{ poLineId: view.lines[0]!.id, unitPrice: '9000000000.00' }] }, key())).toEqual({ ok: true })
    // §2.4: PROCUREMENT has no budget.view — told that the budget is short, without what is left or missing
    expect(await submitDraft(proc(), poId, key())).toEqual({ ok: false, code: 'BUDGET_INSUFFICIENT' })
    const grant = await prisma.roleAssignment.create({ data: { organizationId: org.organizationId, memberId: org.member.proc_officer!, role: 'BUDGET_ADMIN', grantedAt: NOW } })
    try {
      expect(await submitDraft(proc(), poId, key())).toEqual({ ok: false, code: 'BUDGET_INSUFFICIENT', shortfall: expect.stringMatching(/^\d+\.\d{2}$/) })
    } finally {
      await prisma.roleAssignment.update({ where: { id: grant.id }, data: { revokedAt: NOW } })
    }
    expect((await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: poId } })).status).toBe('DRAFT')
  })
})

describe('the PO shows its budget, its source requests with their files, who made it and who sent it (§9.9 principle 5)', () => {
  it('shows what the requests reserve for a draft, what the PO reserves more when sent, and what it holds once approved', async () => {
    const r = await approvedRequest({ siteId: await site(), lines: [{ quantity: '10', unitPrice: '100.00' }] })
    const poId = await draftPo(r.lineIds)
    const draft = (await getPurchaseOrderView(proc(), poId))!
    expect(draft.budget).toEqual([
      { lineId: budgetLineId, code: 'CON-OPEX-2569', name: expect.any(String), status: 'OPEN', needSatang: 100_000n, requestReservedSatang: 100_000n, reservedSatang: 0n, committedSatang: 0n, actualSatang: 0n },
    ])
    await editDraft(proc(), { poId, expectedVersion: draft.version, lines: [{ poLineId: draft.lines[0]!.id, unitPrice: '120.00' }] }, key())
    expect(await submitDraft(proc(), poId, key())).toEqual({ ok: true, status: 'PENDING_APPROVAL' })
    expect((await getPurchaseOrderView(proc(), poId))!.budget[0]).toMatchObject({ needSatang: 120_000n, requestReservedSatang: 100_000n, reservedSatang: 20_000n, committedSatang: 0n })
    await approveAll(poId)
    expect((await getPurchaseOrderView(proc(), poId))!.budget[0]).toMatchObject({ needSatang: 120_000n, requestReservedSatang: 0n, reservedSatang: 0n, committedSatang: 120_000n })
  })

  it('lists the source requests with their files, and the facts request.view is checked with', async () => {
    const r = await approvedRequest({ siteId: await site() })
    const file = await prisma.fileObject.create({ data: { organizationId: org.organizationId, storageKey: `test/${randomUUID()}.pdf`, fileName: 'ใบเสนอราคา.pdf', mimeType: 'application/pdf', sizeBytes: 2048, status: 'AVAILABLE', uploadedById: org.member.req_con! } })
    await prisma.fileLink.create({ data: { organizationId: org.organizationId, fileId: file.id, subjectType: 'Request', subjectId: r.id, kind: 'QUOTATION' } })
    const poId = await draftPo(r.lineIds)
    const view = (await getPurchaseOrderView(proc(), poId))!
    expect(view.requests).toEqual([
      {
        id: r.id,
        number: r.number,
        title: 'วัสดุไซต์',
        requester: { id: org.member.req_con, name: expect.any(Object) },
        access: expect.objectContaining({ requestId: r.id, requesterMemberId: org.member.req_con, chargedDepartmentId: org.department.CON }),
        attachments: [{ fileId: file.id, fileName: 'ใบเสนอราคา.pdf', kind: 'QUOTATION', sizeBytes: 2048 }],
      },
    ])
    const access = (await getPoAccess(proc(), poId))!
    // The page links the request and lists its files only for whoever may open it (request.view)
    expect(canViewRequest(principalOf('req_con'), view.requests[0]!.access)).toBe(true)
    expect(canViewRequest(principalOf('coo', ['EXECUTIVE']), view.requests[0]!.access)).toBe(true)
    expect(canViewRequest(principalOf('asst_con'), view.requests[0]!.access)).toBe(false)
    expect([...poReader(principalOf('proc_officer', ['PROCUREMENT']), access, view).requests]).toEqual([r.id])
    expect([...poReader(principalOf('asst_con'), access, view).requests]).toEqual([])
  })

  it('names who made a draft and who sent it; a draft of the scheduled round was made by nobody', async () => {
    const manual = await approvedRequest({ siteId: await site() })
    const byHand = await draftPo(manual.lineIds)
    expect((await getPurchaseOrderView(proc(), byHand))!).toMatchObject({ createdBy: { id: org.member.proc_officer }, submittedBy: null })
    await submitDraft(proc(), byHand, key())
    expect((await getPurchaseOrderView(proc(), byHand))!).toMatchObject({ createdBy: { id: org.member.proc_officer }, submittedBy: { id: org.member.proc_officer } })

    const where = await site()
    const scheduled = await approvedRequest({ siteId: where })
    await assignLines(proc(), { requestLineIds: scheduled.lineIds, supplierId: s1 }, key())
    const round = await runScheduledConsolidation(org.organizationId, new Date(NOW.getTime() + 4 * 60_000))
    if (!round.ran) throw new Error(JSON.stringify(round))
    const poId = (await prisma.purchaseOrder.findFirstOrThrow({ where: { id: { in: [...round.purchaseOrderIds] }, deliverySiteId: where } })).id
    expect((await getPurchaseOrderView(proc(), poId))!).toMatchObject({ createdBy: null, submittedBy: null })
    await submitDraft(proc(), poId, key())
    // The sender owns it from then on (BR-SOD-03), but the draft was still made by the round
    expect((await getPurchaseOrderView(proc(), poId))!).toMatchObject({ createdBy: null, submittedBy: { id: org.member.proc_officer } })
    expect((await getPoAccess(proc(), poId))!.createdById).toBe(org.member.proc_officer)
  })

  it('computes a draft at the VAT rate of today, in the list too, whatever rate the round stored', async () => {
    const r = await approvedRequest({ siteId: await site() })
    const poId = await draftPo(r.lineIds)
    // As if the round had run in a period of another rate
    await prisma.purchaseOrder.update({ where: { id: poId }, data: { vatRateBp: 1000, vatSatang: 10_000n, grossSatang: 110_000n } })
    expect((await getPurchaseOrderView(proc(), poId))!.totals).toEqual({ netSatang: 100_000n, vatSatang: 7_000n, grossSatang: 107_000n, vatRateBp: 700, basis: 'TODAY' })
    expect((await listPurchaseOrders(proc(), { status: 'DRAFT' })).rows.find((row) => row.id === poId)).toMatchObject({ netSatang: 100_000n, vatSatang: 7_000n, grossSatang: 107_000n })
    await submitDraft(proc(), poId, key())
    expect((await getPurchaseOrderView(proc(), poId))!.totals).toEqual({ netSatang: 100_000n, vatSatang: 7_000n, grossSatang: 107_000n, vatRateBp: 700, basis: 'STORED' })
  })

  it("shows the supplier's e-mail to whoever sees the register in full or sends POs, and to nobody else", () => {
    expect(canSeeSupplierContact(principalOf('proc_officer', ['PROCUREMENT']))).toBe(true)
    expect(canSeeSupplierContact(principalOf('fin_officer', ['FINANCE']))).toBe(true)
    expect(canSeeSupplierContact(principalOf('auditor', ['AUDITOR']))).toBe(true)
    expect(canSeeSupplierContact(principalOf('coo', ['EXECUTIVE']))).toBe(false)
    expect(canSeeSupplierContact(principalOf('req_con'))).toBe(false)
  })
})

describe('[FR-P2P-007/AC2] a damaged-goods variance shows the photos of its receipt and the budget its PO holds', () => {
  it('lists the photo of the receipt for the approver and what the PO holds on the line', async () => {
    const { poId } = await approvedPo([{ quantity: '10', unitPrice: '100.00', description: 'ไม้อัด 6 มม.' }])
    provider()
    await sendToSupplier(proc(), { poId }, key())
    const line = (await getPurchaseOrderView(proc(), poId))!.lines[0]!
    const photo = await prisma.fileObject.create({ data: { organizationId: org.organizationId, storageKey: `test/${randomUUID()}.jpg`, fileName: 'กล่องแตก.jpg', mimeType: 'image/jpeg', sizeBytes: 900, status: 'AVAILABLE', uploadedById: org.member.receiver_con! } })
    const gr = ok(
      await postGoodsReceipt(
        ctx('receiver_con'),
        { poId, deliveryNoteNo: 'DN-88', photoFileIds: [photo.id], lines: [{ poLineId: line.id, received: '10', rejected: '2', damagedDisposition: 'ACCEPT_DAMAGED' }] },
        svc(),
      ),
    )
    const varianceId = gr.varianceIds[0]!
    const view = (await getVarianceView(proc(), varianceId))!
    expect(view).toMatchObject({ type: 'DAMAGED', disposition: 'ACCEPT_DAMAGED', status: 'PENDING_APPROVAL', quantity: '2', amountSatang: 20_000n })
    expect(view.photos).toEqual([{ fileId: photo.id, fileName: 'กล่องแตก.jpg', kind: 'PHOTO', sizeBytes: 900 }])
    expect(view.budget).toEqual({ lineId: budgetLineId, code: 'CON-OPEX-2569', name: expect.any(String), status: 'OPEN', heldSatang: 100_000n, actualSatang: 0n })
    expect(view.route).toMatchObject({ doa: { ruleCode: 'GRV-01' }, amountBasis: expect.stringMatching(/^(GROSS|NET)$/) })
  })
})
