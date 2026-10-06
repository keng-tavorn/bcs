import { randomUUID } from 'node:crypto'
import { beforeAll, describe, expect, it } from 'vitest'
import { editDraft, submitDraft } from '@/app/(workspace)/procurement/pos/commands'
import { prisma } from '@/server/db/client'
import { setDefaultOutboxSender } from '@/server/events/outbox'
import { getPurchaseOrderView } from '@/server/queries/purchase-orders'
import { assignSupplier, consolidateNow, listPool } from '@/server/services/procurement'
import { updateSupplier } from '@/server/services/suppliers'
import { poErrorKey, type PoOutcome } from '@/ui/purchase-order/outcome'
import en from '../../messages/en.json'
import th from '../../messages/th.json'
import { createDoaOrg, type DoaOrg } from '../support/doa-org'
import { p2p } from '../support/p2p'

// §9.9 principle 7 on the purchase-order page, through the commands behind its buttons
// (src/app/(workspace)/procurement/pos/commands.ts): a refusal says what happened and how to fix it, and the fix it gives
// is the one that works — a supplier made inactive is activated again in the supplier register, a line without a source
// request is taken off the draft, a line that orders several request lines is taken off and drafted again, one line per
// request line — and a line taken off a draft is back in the procurement pool with the supplier it had, as the
// confirmation "เอาบรรทัด {n} ออกแล้ว …" says. Real Postgres (BCS_TEST_DB). The words themselves:
// tests/unit/po-refusal-words.test.ts and tests/unit/po-draft-editor.test.tsx.

const NOW = new Date('2026-10-05T03:00:00Z') // Monday 10:00 Thai time
const svc = () => ({ idempotencyKey: randomUUID(), sender: null })
const ok = <T,>(r: { ok: true; data: T } | { ok: false; error: unknown }): T => {
  if (!r.ok) throw new Error(JSON.stringify(r.error))
  return r.data
}

let org: DoaOrg
beforeAll(async () => {
  setDefaultOutboxSender(null)
  org = await createDoaOrg()
})

const proc = () => org.ctxOf('proc_officer', NOW)

let suppliers = 0
/** A supplier of the register, active, for one test alone */
async function supplier(nameTh: string): Promise<string> {
  const n = String(++suppliers).padStart(6, '0')
  return (await prisma.supplier.create({ data: { organizationId: org.organizationId, code: `S-FIX-${n}`, nameTh, taxId: `0999999${n}`, email: `s-${n}@supplier.test` } })).id
}

const poOf = (poId: string) => prisma.purchaseOrder.findUniqueOrThrow({ where: { id: poId }, include: { lines: { orderBy: { lineNo: 'asc' }, include: { sources: true } } } })

/** The draft PO of one approved request's lines with `supplierId`, made by procurement's round on a site of its own */
async function draftOf(supplierId: string, lines: Array<{ quantity: string; unitPrice: string; description?: string }>) {
  const flow = p2p(org, NOW)
  const request = await flow.approvedRequest(await flow.fundedLine(100_000n), lines)
  const site = await prisma.deliverySite.create({ data: { organizationId: org.organizationId, code: `SITE-${randomUUID().slice(0, 8)}`, nameTh: 'ไซต์ทดสอบ', address: 'ถนนทดสอบ' } })
  await prisma.request.update({ where: { id: request.id }, data: { deliverySiteId: site.id } })
  ok(await assignSupplier(proc(), { requestLineIds: request.lines.map((l) => l.id), supplierId }, svc()))
  const run = ok(await consolidateNow(proc(), svc()))
  const po = await prisma.purchaseOrder.findFirstOrThrow({ where: { id: { in: [...run.purchaseOrderIds] }, deliverySiteId: site.id }, select: { id: true } })
  return { po: await poOf(po.id), request, siteId: site.id }
}

/** The words the page shows for a refusal, in both languages (purchaseOrder.errors) */
function wordsOf(outcome: PoOutcome): { th: string; en: string } {
  if (outcome.ok) throw new Error('expected a refusal')
  const key = poErrorKey(outcome)
  return { th: th.purchaseOrder.errors[key], en: en.purchaseOrder.errors[key] }
}

describe('[FR-P2P-003/AC2] a line taken off a draft is back in the procurement pool with the supplier it had, as its confirmation says', () => {
  it('takes line 2 off through the page: its request line waits in the pool with the same supplier, and the draft orders line 1 alone', async () => {
    const supplierId = await supplier('บริษัท ผู้ขายเดิม จำกัด')
    const { po, request } = await draftOf(supplierId, [
      { quantity: '10', unitPrice: '100.00', description: 'ปูนซีเมนต์' },
      { quantity: '5', unitPrice: '20.00', description: 'ทราย' },
    ])
    expect(po.lines.map((l) => [l.lineNo, l.description])).toEqual([
      [1, 'ปูนซีเมนต์'],
      [2, 'ทราย'],
    ])
    expect(await editDraft(proc(), { poId: po.id, expectedVersion: po.version, removeLineIds: [po.lines[1]!.id] }, randomUUID())).toEqual({ ok: true })

    // The request line keeps the supplier procurement chose for it: back in the pool with it, no new choice needed
    expect((await prisma.requestLine.findUniqueOrThrow({ where: { id: request.lines[1]!.id }, select: { supplierId: true } })).supplierId).toBe(supplierId)
    const back = ok(await listPool(proc())).find((row) => row.requestLineId === request.lines[1]!.id)
    expect(back).toMatchObject({ quantity: '5', supplier: { id: supplierId, nameTh: 'บริษัท ผู้ขายเดิม จำกัด' }, needsSupplier: false })
    // The draft orders the other line alone, numbered 1
    const view = (await getPurchaseOrderView(proc(), po.id))!
    expect(view.lines.map((l) => [l.lineNo, l.description, l.quantity])).toEqual([[1, 'ปูนซีเมนต์', '10']])
  })
})

describe('the refusals of the purchase-order page say how to fix them, and the fix they give works (§9.9 principle 7)', () => {
  it('SUPPLIER_INACTIVE: a supplier made inactive after the page opened is activated again in the supplier register, then the PO goes for approval', async () => {
    const supplierId = await supplier('บริษัท ผู้ขายถูกปิด จำกัด')
    const { po } = await draftOf(supplierId, [{ quantity: '2', unitPrice: '1000.00' }])
    const version = async () => (await prisma.supplier.findUniqueOrThrow({ where: { id: supplierId }, select: { version: true } })).version
    ok(await updateSupplier(proc(), { supplierId, expectedVersion: await version(), status: 'INACTIVE' }, svc()))

    const refused = await submitDraft(proc(), po.id, randomUUID())
    expect(refused).toMatchObject({ ok: false, code: 'VALIDATION_FAILED', reason: 'SUPPLIER_INACTIVE' })
    // The same words as the notice the page shows before sending when the supplier is inactive already
    expect(wordsOf(refused)).toEqual({ th: th.purchaseOrder.actions.submit.supplierInactive, en: en.purchaseOrder.actions.submit.supplierInactive })
    expect(wordsOf(refused).th).toContain('เปิดใช้ผู้ขายที่ทะเบียนผู้ขายก่อน แล้วกลับมาส่ง')
    expect(await poOf(po.id)).toMatchObject({ status: 'DRAFT', number: null })

    // The fix it gives: procurement activates the supplier in the register (supplier.manage), then sends the PO
    ok(await updateSupplier(proc(), { supplierId, expectedVersion: await version(), status: 'ACTIVE' }, svc()))
    expect(await submitDraft(proc(), po.id, randomUUID())).toEqual({ ok: true, status: 'PENDING_APPROVAL' })
  })

  it('NO_SOURCE_REQUEST: the line without a source request shows none under the lines; taken off in the draft’s editing, the PO goes for approval', async () => {
    const { po } = await draftOf(await supplier('บริษัท ผู้ขายบรรทัดไม่มีที่มา จำกัด'), [{ quantity: '1', unitPrice: '1000.00', description: 'สายไฟ' }])
    // A line slipped in without a source (no service makes one, OQ-24)
    await prisma.poLine.create({ data: { organizationId: org.organizationId, poId: po.id, lineNo: 2, description: 'ไม่มีที่มา', quantity: '1', uom: 'ชิ้น', unitPriceSatang: 100n, netSatang: 100n, budgetLineId: po.lines[0]!.budgetLineId } })

    const refused = await submitDraft(proc(), po.id, randomUUID())
    expect(refused).toMatchObject({ ok: false, code: 'VALIDATION_FAILED', reason: 'NO_SOURCE_REQUEST' })
    expect(wordsOf(refused).th).toContain('เอาบรรทัดนั้นออกที่ส่วน “แก้ไขร่าง” แล้วส่งขออนุมัติอีกครั้ง')
    expect(wordsOf(refused).en).toContain('Take those lines off under “Edit the draft”, then send it for approval again.')
    // Where the words point: under the lines, that line has no source request to show ("จากคำขอ …"), the other has its own
    const view = (await getPurchaseOrderView(proc(), po.id))!
    expect(view.lines.map((l) => [l.description, l.sources.length])).toEqual([
      ['สายไฟ', 1],
      ['ไม่มีที่มา', 0],
    ])

    // The fix it gives: take that line off the draft, then send the PO
    const sourceless = view.lines.find((l) => l.sources.length === 0)!
    expect(await editDraft(proc(), { poId: po.id, expectedVersion: view.version, removeLineIds: [sourceless.id] }, randomUUID())).toEqual({ ok: true })
    expect(await submitDraft(proc(), po.id, randomUUID())).toEqual({ ok: true, status: 'PENDING_APPROVAL' })
  })

  it('MERGED_LINE: a line that orders two request lines keeps its quantity; taken off and drafted again, each request line is a line of its own whose quantity changes', async () => {
    const supplierId = await supplier('บริษัท ผู้ขายบรรทัดรวม จำกัด')
    const { po, request, siteId } = await draftOf(supplierId, [
      { quantity: '10', unitPrice: '100.00', description: 'ปูนซีเมนต์' },
      { quantity: '5', unitPrice: '100.00', description: 'ปูนซีเมนต์' },
      { quantity: '3', unitPrice: '50.00', description: 'ทราย' },
    ])
    // Lines 1 and 2 as one line of 15 that orders both request lines (BR-CONS-04's merging is not built yet, so the
    // test merges them)
    const [first, second, third] = po.lines
    await prisma.poLineSource.update({ where: { id: second!.sources[0]!.id }, data: { poLineId: first!.id } })
    await prisma.poLine.update({ where: { id: first!.id }, data: { quantity: '15', netSatang: 150_000n } })
    await prisma.poLine.delete({ where: { id: second!.id } })
    await prisma.poLine.update({ where: { id: third!.id }, data: { lineNo: 2 } })
    const merged = (await getPurchaseOrderView(proc(), po.id))!
    expect(merged.lines.map((l) => [l.lineNo, l.quantity, l.sources.length, l.maxQuantity])).toEqual([
      [1, '15', 2, null],
      [2, '3', 1, '3'],
    ])

    const refused = await editDraft(proc(), { poId: po.id, expectedVersion: merged.version, lines: [{ poLineId: first!.id, quantity: '12' }] }, randomUUID())
    expect(refused).toMatchObject({ ok: false, code: 'VALIDATION_FAILED', reason: 'MERGED_LINE' })
    expect(wordsOf(refused).th).toContain('ให้เอาบรรทัดนี้ออก กลับเข้ากองรอจัดซื้อ แล้วกด “รวมเป็นร่าง PO ตอนนี้” ที่กองรอจัดซื้อ')
    expect((await poOf(po.id)).lines.map((l) => l.quantity.toString())).toEqual(['15', '3'])

    // The fix it gives: take the line off — both request lines are back in the pool with their supplier — and draft
    // them again: one line per request line, and the quantity of either changes
    expect(await editDraft(proc(), { poId: po.id, expectedVersion: merged.version, removeLineIds: [first!.id] }, randomUUID())).toEqual({ ok: true })
    const run = ok(await consolidateNow(proc(), svc()))
    const again = await prisma.purchaseOrder.findFirstOrThrow({ where: { id: { in: [...run.purchaseOrderIds] }, deliverySiteId: siteId }, select: { id: true } })
    const redrafted = await poOf(again.id)
    expect(redrafted).toMatchObject({ status: 'DRAFT', supplierId })
    expect(redrafted.lines.map((l) => [l.sources.map((s) => s.requestLineId), l.quantity.toString()])).toEqual([
      [[request.lines[0]!.id], '10'],
      [[request.lines[1]!.id], '5'],
    ])
    expect(await editDraft(proc(), { poId: again.id, expectedVersion: redrafted.version, lines: [{ poLineId: redrafted.lines[0]!.id, quantity: '8' }] }, randomUUID())).toEqual({ ok: true })
    expect((await poOf(again.id)).lines.map((l) => l.quantity.toString())).toEqual(['8', '5'])
  })
})
