import { createHash, randomUUID } from 'node:crypto'
import ExcelJS from 'exceljs'
import { beforeAll, describe, expect, it } from 'vitest'
import { prisma } from '@/server/db/client'
import { exportExpress } from '@/server/services/exports/express'
import { getExportOverview } from '@/server/services/exports/view'
import { getDownloadUrl } from '@/server/services/files'
import { createDoaOrg, type DoaOrg } from '../support/doa-org'
import { TEST_EXPRESS_HEADERS, TEST_EXPRESS_LAYOUT, testExpressColumn, testExpressRow } from '../support/express-layout'
import { setExpressLayout } from '../support/set-express-layout'

// S4-09 (spec §7.13, BR-EXP-01 to BR-EXP-04, FR-P2P-009 AC1 AC2 AC4): FINANCE exports the invoices not exported yet in
// the organization's Express layout; the file shows its rows, total and sha256 and is kept as an ExportJob; invoices
// of suppliers without a vendor code are kept out and listed; exporting again needs a reason; without a layout nothing
// is exported. The Express format itself is unknown until the customer's sample file arrives (OQ-10), so the
// organization here exports in the TEST FIXTURE layout of tests/support/express-layout.ts — not the Express format —
// and the expected rows are built from that fixture. The invoices are set up directly (the invoice service is tested in
// invoices.test.ts); the export reads them only.

const NOW = new Date('2026-10-05T03:00:00Z')
const key = () => ({ idempotencyKey: randomUUID(), sender: null })

let org: DoaOrg
let budgetLineId: string
const ok = <T,>(r: { ok: true; data: T } | { ok: false; error: unknown }): T => {
  if (!r.ok) throw new Error(JSON.stringify(r.error))
  return r.data
}
const fin = () => org.ctxOf('fin_officer', NOW)

beforeAll(async () => {
  // The test fixture's layout (not the Express format, OQ-10): set here so every expected row below follows it
  org = await createDoaOrg({ express: TEST_EXPRESS_LAYOUT })
  await prisma.roleAssignment.create({ data: { organizationId: org.organizationId, memberId: org.member.fin_officer!, role: 'FINANCE', grantedAt: NOW } })
  budgetLineId = (await prisma.budgetLine.findFirstOrThrow({ where: { organizationId: org.organizationId, code: 'CON-OPEX-2569' } })).id
  await prisma.budgetLine.update({ where: { id: budgetLineId }, data: { accountCode: '5101-01' } })
})

let seq = 0
/** An invoice of `netSatang` + 7 % VAT on a PO of a supplier with or without an Express vendor code */
async function invoiceOf(supplier: { code: string; vendorCode: string | null }, netSatang: bigint, invoiceNo: string) {
  seq++
  const s =
    (await prisma.supplier.findFirst({ where: { organizationId: org.organizationId, code: supplier.code } })) ??
    (await prisma.supplier.create({ data: { organizationId: org.organizationId, code: supplier.code, nameTh: `บริษัท ${supplier.code} จำกัด`, taxId: '0999999000012', branchCode: String(10000 + seq), expressVendorCode: supplier.vendorCode } }))
  const vat = (netSatang * 7n + 50n) / 100n
  const po = await prisma.purchaseOrder.create({ data: { organizationId: org.organizationId, number: `PO-2569-${String(9000 + seq).padStart(5, '0')}`, status: 'SENT', supplierId: s.id, netSatang, vatSatang: vat, grossSatang: netSatang + vat, vatRateBp: 700 } })
  const line = await prisma.poLine.create({ data: { organizationId: org.organizationId, poId: po.id, lineNo: 1, description: 'ของ', quantity: '1', uom: 'ชิ้น', unitPriceSatang: netSatang, netSatang, budgetLineId } })
  const invoice = await prisma.invoiceConfirmation.create({
    data: { organizationId: org.organizationId, poId: po.id, supplierId: s.id, invoiceNo, invoiceNoNormalized: invoiceNo.replace(/\s/g, '').toUpperCase(), invoiceDate: new Date('2026-10-01T00:00:00Z'), netSatang, vatSatang: vat, grossSatang: netSatang + vat, recordedById: org.member.fin_officer!, recordedAt: NOW },
  })
  await prisma.invoiceLineAllocation.create({ data: { organizationId: org.organizationId, invoiceId: invoice.id, poLineId: line.id, netSatang } })
  return invoice
}

async function download(fileId: string, ctx = fin()): Promise<Uint8Array> {
  const url = ok(await getDownloadUrl(ctx, { fileId })).url
  return new Uint8Array(await (await fetch(url)).arrayBuffer())
}

async function rowsOf(bytes: Uint8Array): Promise<string[][]> {
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.load(bytes.buffer as ArrayBuffer)
  const rows: string[][] = []
  workbook.worksheets[0]!.eachRow((row) => rows.push((row.values as unknown[]).slice(1).map((v) => String(v ?? ''))))
  return rows
}

describe('[FR-P2P-009/AC1] [FR-P2P-009/AC2] FINANCE exports the invoices not exported yet, with rows, total and checksum', () => {
  it('writes the organization’s layout, keeps the ExportJob and marks the invoices; nothing is exported twice', async () => {
    const a = await invoiceOf({ code: 'SA', vendorCode: 'V0101' }, 1_000_000n, 'A-001')
    const b = await invoiceOf({ code: 'SA', vendorCode: 'V0101' }, 250_050n, 'A-002')
    const result = ok(await exportExpress(fin(), {}, key()))
    expect(result).toMatchObject({ rowCount: 2, excluded: [] })
    // 10,000.00 + 700.00 and 2,500.50 + 175.04
    expect(result.total).toBe('13375.54')
    const job = await prisma.exportJob.findUniqueOrThrow({ where: { id: result.exportJobId } })
    expect(job).toMatchObject({ kind: 'EXPRESS_AP', status: 'COMPLETED', rowCount: 2, totalSatang: 1_337_554n, checksum: result.checksum, fileId: result.fileId, reason: null })
    const bytes = await download(result.fileId)
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(result.checksum)
    const rows = await rowsOf(bytes)
    // The columns of the layout, in its order, and every value the export can write (BR-EXP-01)
    expect(rows[0]).toEqual(TEST_EXPRESS_HEADERS)
    expect(rows[1]).toEqual(
      testExpressRow({
        expressVendorCode: 'V0101',
        invoiceNo: 'A-001',
        invoiceDate: '01/10/2569',
        supplierCode: 'SA',
        supplierName: 'บริษัท SA จำกัด',
        supplierTaxId: '0999999000012',
        supplierBranch: expect.stringMatching(/^\d{5}$/),
        poNumber: expect.stringMatching(/^PO-2569-/),
        net: '10000.00',
        vat: '700.00',
        gross: '10700.00',
        budgetLineCode: 'CON-OPEX-2569',
        costCenterCode: 'CC-CON',
        accountCode: '5101-01',
      }),
    )
    // BR-EXP-03: the rows of the file add up to the total shown
    const sum = rows.slice(1).reduce((s, r) => s + BigInt(r[testExpressColumn('gross')]!.replace('.', '')), 0n)
    expect(sum).toBe(job.totalSatang)
    expect(await prisma.invoiceConfirmation.findMany({ where: { id: { in: [a.id, b.id] } }, select: { exportJobId: true } })).toEqual([{ exportJobId: job.id }, { exportJobId: job.id }])
    expect(await prisma.event.findFirstOrThrow({ where: { aggregateId: job.id, type: 'export.generated' } })).toMatchObject({ data: { rowCount: 2, totalSatang: '1337554', again: false } })
    expect(await prisma.notification.findFirstOrThrow({ where: { templateKey: 'export.ready', recipientMemberId: org.member.fin_officer } })).toBeTruthy()
    expect(await exportExpress(fin(), {}, key())).toMatchObject({ ok: false, error: { details: { reason: 'NOTHING_TO_EXPORT' } } })
  })

  it('exports again only with a reason, as a new job', async () => {
    const c = await invoiceOf({ code: 'SA', vendorCode: 'V0101' }, 10_000n, 'A-003')
    const first = ok(await exportExpress(fin(), {}, key()))
    expect(await exportExpress(fin(), { invoiceIds: [c.id] }, key())).toMatchObject({ ok: false, error: { details: { reason: 'REASON_REQUIRED' } } })
    const again = ok(await exportExpress(fin(), { invoiceIds: [c.id], reason: 'ไฟล์เดิมนำเข้าไม่สำเร็จ' }, key()))
    expect(again.exportJobId).not.toBe(first.exportJobId)
    expect(await prisma.exportJob.findUniqueOrThrow({ where: { id: again.exportJobId } })).toMatchObject({ reason: 'ไฟล์เดิมนำเข้าไม่สำเร็จ', rowCount: 1 })
  })

  it('writes CSV in Windows-874 with Christian-era dates when the layout asks for it', async () => {
    await setExpressLayout(org.organizationId, { ...TEST_EXPRESS_LAYOUT, fileType: 'csv', encoding: 'WINDOWS-874', dateFormat: 'CE' })
    try {
      await invoiceOf({ code: 'SA', vendorCode: 'V0101' }, 100n, 'CSV-1')
      const result = ok(await exportExpress(fin(), {}, key()))
      const bytes = await download(result.fileId)
      // No byte order mark, and the platform's own Windows-874 decoder gives the Thai headers back whole
      expect([...bytes.slice(0, 3)]).not.toEqual([0xef, 0xbb, 0xbf])
      const [header, row] = new TextDecoder('windows-874').decode(bytes).split('\r\n')
      expect(header).toBe(TEST_EXPRESS_HEADERS.join(','))
      const cells = row!.split(',')
      expect([cells[testExpressColumn('invoiceNo')], cells[testExpressColumn('invoiceDate')], cells[testExpressColumn('gross')]]).toEqual(['CSV-1', '01/10/2026', '1.07'])
      expect((await prisma.fileObject.findUniqueOrThrow({ where: { id: result.fileId } })).mimeType).toBe('text/csv')
    } finally {
      await setExpressLayout(org.organizationId, TEST_EXPRESS_LAYOUT)
    }
  })
})

describe('[FR-P2P-009/AC4] invoices of suppliers without an Express vendor code are kept out and listed (BR-EXP-04)', () => {
  it('lists them, and exports them once the code is filled', async () => {
    const missing = await invoiceOf({ code: 'SB', vendorCode: null }, 50_000n, 'B-001')
    const withCode = await invoiceOf({ code: 'SA', vendorCode: 'V0101' }, 50_000n, 'B-002')
    const result = ok(await exportExpress(fin(), {}, key()))
    expect(result.excluded).toEqual([{ invoiceId: missing.id, supplierCode: 'SB' }])
    expect(result.rowCount).toBe(1)
    expect((await prisma.invoiceConfirmation.findUniqueOrThrow({ where: { id: missing.id } })).exportedAt).toBeNull()
    expect((await prisma.invoiceConfirmation.findUniqueOrThrow({ where: { id: withCode.id } })).exportedAt).not.toBeNull()
    await prisma.supplier.updateMany({ where: { organizationId: org.organizationId, code: 'SB' }, data: { expressVendorCode: 'V0202' } })
    expect(ok(await exportExpress(fin(), {}, key()))).toMatchObject({ rowCount: 1, excluded: [] })
  })
})

describe('[FR-P2P-009/AC1] only FINANCE exports and downloads the Express file', () => {
  it('refuses others, and the file downloads for FINANCE only', async () => {
    await invoiceOf({ code: 'SA', vendorCode: 'V0101' }, 1_000n, 'P-001')
    for (const who of ['proc_officer', 'req_con', 'auditor']) expect(await exportExpress(org.ctxOf(who, NOW), {}, key()), who).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    const result = ok(await exportExpress(fin(), {}, key()))
    expect(await getDownloadUrl(org.ctxOf('req_con', NOW), { fileId: result.fileId })).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
  })
})

describe('[FR-P2P-009/AC1] without a layout nothing is exported (the demo’s state until the customer’s sample file, OQ-10)', () => {
  it('is refused with MAPPING_NOT_SET, first or again; no file, no job, no event, and the invoice still waits for the first file', async () => {
    const waiting = await invoiceOf({ code: 'SA', vendorCode: 'V0101' }, 5_000n, 'N-001')
    await setExpressLayout(org.organizationId, { ...TEST_EXPRESS_LAYOUT, mapping: [] })
    try {
      const jobs = await prisma.exportJob.count({ where: { organizationId: org.organizationId } })
      const events = await prisma.event.count({ where: { organizationId: org.organizationId, type: 'export.generated' } })
      const refused = { ok: false, error: { code: 'VALIDATION_FAILED', details: { reason: 'MAPPING_NOT_SET' } } }
      expect(await exportExpress(fin(), {}, key())).toMatchObject(refused)
      expect(await exportExpress(fin(), { invoiceIds: [waiting.id], reason: 'ลองส่งออกอีกครั้ง' }, key())).toMatchObject(refused)
      // The screen shows no layout (so no button to make a file) and the invoice among those waiting
      const overview = ok(await getExportOverview(fin()))
      expect(overview.layout).toBeNull()
      expect(overview.ready.shown.map((i) => i.invoiceNo)).toEqual(['N-001'])
      expect(await prisma.exportJob.count({ where: { organizationId: org.organizationId } })).toBe(jobs)
      expect(await prisma.event.count({ where: { organizationId: org.organizationId, type: 'export.generated' } })).toBe(events)
      expect(await prisma.invoiceConfirmation.findUniqueOrThrow({ where: { id: waiting.id } })).toMatchObject({ exportedAt: null, exportJobId: null })
    } finally {
      await setExpressLayout(org.organizationId, TEST_EXPRESS_LAYOUT)
    }
    // Once there is a layout, the invoice that waited goes into the next file
    expect(ok(await exportExpress(fin(), {}, key()))).toMatchObject({ rowCount: 1, total: '53.50' })
  })
})
