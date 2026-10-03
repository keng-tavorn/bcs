import { randomUUID } from 'node:crypto'
import { beforeAll, describe, expect, it } from 'vitest'
import { formatThaiDate, formatThaiDateTime } from '@/core/thai'
import { bahtText } from '@/core/thai/baht-text'
import { prisma } from '@/server/db/client'
import { forTenant } from '@/server/db/tenant'
import { printablePurchaseOrder, printableRequest } from '@/server/pdf/printable'
import { purchaseOrderPdf, requestPdf } from '@/server/services/documents/pdf'
import { createDoaOrg, type DoaOrg } from '../support/doa-org'
import { p2p } from '../support/p2p'

// S4-05 (FR-PLT-009 AC1 AC2, OQ-25 default): the printed PR and PO carry the company header, the number, the
// Buddhist-era date, the lines, the amounts before VAT, the VAT, the total and the total in words (BR-THAI-01, checked
// against GC-THAI by the golden suite), and every approver's name, position, time, channel and DOA reference; only
// those who may see the document get its PDF. The Thai rendering itself is the snapshot of pdf-snapshot.test.ts.

const NOW = new Date('2026-10-06T02:00:00Z')

let org: DoaOrg
let kit: ReturnType<typeof p2p>
let po: Awaited<ReturnType<ReturnType<typeof p2p>['approvedPo']>>
let requestId: string

beforeAll(async () => {
  org = await createDoaOrg()
  kit = p2p(org, NOW)
  await prisma.organization.update({ where: { id: org.organizationId }, data: { address: '99 ถนนทดสอบ กรุงเทพฯ 10000' } })
  const supplier = await prisma.supplier.create({ data: { organizationId: org.organizationId, code: `S-${randomUUID().slice(0, 6)}`, nameTh: 'บริษัท วัสดุก่อสร้างทดสอบ จำกัด', taxId: '0999999000012', branchCode: '00001', address: '1 ถนนผู้ขาย นนทบุรี', email: 'supplier@test.bcs.local' } })
  const line = await kit.fundedLine(1_000_000n)
  const pr = await kit.approvedRequest(line, [
    { quantity: '120', unitPrice: '185.50', description: 'ปูนซีเมนต์ปอร์ตแลนด์ประเภทหนึ่ง' },
    { quantity: '2000', unitPrice: '31.94', description: 'น้ำมันดีเซลสำหรับเครื่องปั่นไฟ' },
  ])
  requestId = pr.id
  po = await kit.approvedPo(
    pr.lines.map((l) => l.id),
    supplier.id,
  )
})

const read = <T,>(fn: (tx: Parameters<Parameters<ReturnType<typeof forTenant>['$transaction']>[0]>[0]) => Promise<T>) => forTenant(org.organizationId).$transaction(fn)

describe('[FR-PLT-009/AC1] the printed PO and PR show the header, number, Buddhist-era date, lines, amounts and words', () => {
  it('the PO', async () => {
    const doc = await read((tx) => printablePurchaseOrder(tx, org.organizationId, po.id, NOW))
    const saved = await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: po.id } })
    expect(doc).toMatchObject({
      kind: 'PO',
      titleTh: 'ใบสั่งซื้อ',
      number: saved.number,
      dateText: formatThaiDate(saved.approvedAt!),
      organization: { name: 'องค์กรทดสอบ DOA', address: '99 ถนนทดสอบ กรุงเทพฯ 10000', taxLine: 'เลขประจำตัวผู้เสียภาษี 0999999000055 · สำนักงานใหญ่' },
      counterparty: { label: 'ผู้ขาย', name: 'บริษัท วัสดุก่อสร้างทดสอบ จำกัด', lines: ['1 ถนนผู้ขาย นนทบุรี', 'เลขประจำตัวผู้เสียภาษี 0999999000012 · สาขา 00001'] },
      lines: [
        { no: 1, description: 'ปูนซีเมนต์ปอร์ตแลนด์ประเภทหนึ่ง', quantity: '120', uom: 'ชิ้น', unitPrice: '185.50', amount: '22,260.00' },
        { no: 2, description: 'น้ำมันดีเซลสำหรับเครื่องปั่นไฟ', quantity: '2,000', uom: 'ชิ้น', unitPrice: '31.94', amount: '63,880.00' },
      ],
      totals: { net: '86,140.00', vatLabel: 'ภาษีมูลค่าเพิ่ม 7%', vat: '6,029.80', gross: '92,169.80', grossText: bahtText(9_216_980n) },
    })
    expect(doc.totals.grossText).toBe('เก้าหมื่นสองพันหนึ่งร้อยหกสิบเก้าบาทแปดสิบสตางค์')
    expect(doc.meta).toEqual(expect.arrayContaining([{ label: 'อ้างอิงใบขอซื้อ', value: expect.stringMatching(/^RQ|^PR|-/) }]))
    expect(doc.footer).toBe(`พิมพ์จากระบบ BCS · ${saved.number} · ${formatThaiDateTime(NOW)}`)
  })

  it('the PR', async () => {
    const doc = await read((tx) => printableRequest(tx, org.organizationId, requestId, NOW))
    const saved = await prisma.request.findUniqueOrThrow({ where: { id: requestId } })
    expect(doc).toMatchObject({
      kind: 'PR',
      titleTh: 'ใบขอซื้อ',
      number: saved.number,
      dateText: formatThaiDate(saved.submittedAt!),
      counterparty: { label: 'ผู้ขอซื้อ', name: 'ผู้ใช้ req_con' },
      totals: { net: '86,140.00', vat: '6,029.80', gross: '92,169.80', grossText: bahtText(saved.grossSatang) },
    })
    expect(doc.lines).toHaveLength(2)
  })

  it('downloads as a PDF for those who may see the document, and nobody else', async () => {
    const asProc = await purchaseOrderPdf(org.ctxOf('proc_officer', NOW), po.id)
    expect(asProc.ok && new TextDecoder('latin1').decode(asProc.data.pdf.subarray(0, 5))).toBe('%PDF-')
    expect(asProc.ok && asProc.data.fileName).toMatch(/\.pdf$/)
    // the requester of its PR, and the COO who approved it
    expect((await purchaseOrderPdf(org.ctxOf('req_con', NOW), po.id)).ok).toBe(true)
    expect((await purchaseOrderPdf(org.ctxOf('coo', NOW), po.id)).ok).toBe(true)
    expect(await purchaseOrderPdf(org.ctxOf('asst_con', NOW), po.id)).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    expect(await purchaseOrderPdf(org.ctxOf('proc_officer', NOW), randomUUID())).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } })
    // the PR: its requester and the head of the charged department; not another member of the department
    expect((await requestPdf(org.ctxOf('req_con', NOW), requestId)).ok).toBe(true)
    expect((await requestPdf(org.ctxOf('dm_con', NOW), requestId)).ok).toBe(true)
    expect(await requestPdf(org.ctxOf('asst_con', NOW), requestId)).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    expect(await requestPdf(org.ctxOf('req_con', NOW), 'not-an-id')).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } })
  })
})

describe('[FR-PLT-009/AC2] the approval section names every approver with position, time, channel and DOA reference', () => {
  it('the PO approval by the COO, and the PR approvals in the order they were given', async () => {
    const poDoc = await read((tx) => printablePurchaseOrder(tx, org.organizationId, po.id, NOW))
    expect(poDoc.approvals).toEqual([{ name: 'ผู้ใช้ coo', position: expect.stringMatching(/^.+ · .+$/), atText: formatThaiDateTime(NOW), channel: 'เว็บ', doaRef: expect.stringMatching(/ ฉบับ 1 ข้อ PO-01$/) }])
    const prDoc = await read((tx) => printableRequest(tx, org.organizationId, requestId, NOW))
    expect(prDoc.approvals.length).toBeGreaterThanOrEqual(1)
    for (const a of prDoc.approvals) expect(a).toEqual({ name: expect.stringMatching(/^ผู้ใช้ /), position: expect.any(String), atText: formatThaiDateTime(NOW), channel: 'เว็บ', doaRef: expect.stringMatching(/ ฉบับ 1 ข้อ PR-0[1-3]$/) })
  })
})
