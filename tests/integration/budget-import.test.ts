import { createHash, randomUUID } from 'node:crypto'
import ExcelJS from 'exceljs'
import { beforeAll, describe, expect, it } from 'vitest'
import { prisma } from '@/server/db/client'
import {
  BUDGET_IMPORT_COLUMNS,
  budgetImportHistory,
  budgetImportTemplate,
  buildBudgetImportTemplate,
  importBudget,
  previewBudgetImport,
  type BudgetImportGuideTexts,
} from '@/server/services/budget/import'
import { createDoaOrg, type DoaOrg } from '../support/doa-org'

// FR-BUD-001: BUDGET_ADMIN imports the budget from the Excel template; a wrong row stops the whole file with a report per
// row (AC1); each row funds its line OUTSIDE → AVAILABLE with an event (AC2); the same file again needs confirming (AC3).

const NOW = new Date('2026-10-05T03:00:00Z')
const key = () => ({ idempotencyKey: randomUUID(), sender: null })
const LABELS = Object.fromEntries(BUDGET_IMPORT_COLUMNS.map((c) => [c, c])) as Record<(typeof BUDGET_IMPORT_COLUMNS)[number], string>

let org: DoaOrg
beforeAll(async () => {
  org = await createDoaOrg()
  const organizationId = org.organizationId
  // FY2569 and the cost centers CC-<department> come with the test organization
  await prisma.roleAssignment.create({ data: { organizationId, memberId: org.member.fin_officer!, role: 'BUDGET_ADMIN', grantedAt: NOW } })
})

/** The template with the given rows filled in from row 3 */
async function file(rows: Array<Array<string | number>>): Promise<ArrayBuffer> {
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.load(new Uint8Array(await buildBudgetImportTemplate(LABELS)).buffer as ArrayBuffer)
  const sheet = workbook.getWorksheet('Budget')!
  for (const r of rows) sheet.addRow(r)
  const buffer = await workbook.xlsx.writeBuffer()
  return new Uint8Array(buffer as ArrayBuffer).slice().buffer as ArrayBuffer
}

/** The lines this file imports (codes IMP-…); the test organization has its own lines besides */
const linesOf = () => prisma.budgetLine.findMany({ where: { organizationId: org.organizationId, code: { startsWith: 'IMP-' } }, include: { balance: true }, orderBy: { code: 'asc' } })

describe('[FR-BUD-001/AC1] a file with a wrong row saves nothing and reports every wrong row', () => {
  it('lists each row and field with its reason', async () => {
    const bytes = await file([
      ['FY2569', 'CON', 'CC-CON', 'IMP-CON-OPEX', 'ค่าใช้จ่ายดำเนินงาน', '5101', 500000],
      ['FY2569', 'XX', 'CC-CON', 'IMP-XX-OPEX', 'แผนกไม่มีจริง', '', 1000],
      ['FY2569', 'IT', 'CC-CON', 'IMP-IT-OPEX', 'cost center ของแผนกอื่น', '', 1000],
      ['FY2569', 'CON', 'CC-CON', 'IMP-CON-OPEX', 'รหัสซ้ำในไฟล์', '', 1000],
      ['FY2569', 'CON', 'CC-CON', 'IMP-CON-CAPEX', 'ยอดผิด', '', '12.345'],
    ])
    const r = await importBudget(org.ctxOf('fin_officer', NOW), { bytes, fileName: 'งบ.xlsx' }, key())
    expect(r).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED' } })
    if (r.ok) return
    const rows = (r.error.details as { rows: Array<{ row: number; field: string; reason: string }> }).rows
    // The file's own problems are found before the organization is asked
    expect(rows).toEqual([
      { row: 6, field: 'code', reason: 'DUPLICATE_IN_FILE' },
      { row: 7, field: 'amount', reason: 'INVALID_AMOUNT' },
    ])
    const fixed = await file([
      ['FY2569', 'CON', 'CC-CON', 'IMP-CON-OPEX', 'ค่าใช้จ่ายดำเนินงาน', '5101', 500000],
      ['FY2569', 'XX', 'CC-CON', 'IMP-XX-OPEX', 'แผนกไม่มีจริง', '', 1000],
      ['FY2569', 'IT', 'CC-CON', 'IMP-IT-OPEX', 'cost center ของแผนกอื่น', '', 1000],
      ['FY2570', 'CON', 'CC-CON', 'IMP-CON-OPEX', 'ปีงบที่ยังไม่มี', '', 1000],
    ])
    const again = await importBudget(org.ctxOf('fin_officer', NOW), { bytes: fixed, fileName: 'งบ.xlsx' }, key())
    expect(again.ok ? [] : (again.error.details as { rows: unknown[] }).rows).toEqual([
      { row: 4, field: 'department', reason: 'UNKNOWN_DEPARTMENT' },
      { row: 5, field: 'costCenter', reason: 'COST_CENTER_OF_ANOTHER_DEPARTMENT' },
      { row: 6, field: 'fiscalYear', reason: 'UNKNOWN_FISCAL_YEAR' },
    ])
    expect(await linesOf()).toEqual([])
    expect(await prisma.budgetImport.count({ where: { organizationId: org.organizationId } })).toBe(0)
  })

  it('only BUDGET_ADMIN imports', async () => {
    const bytes = await file([['FY2569', 'CON', 'CC-CON', 'IMP-CON-OPEX', 'ค่าใช้จ่าย', '', 1000]])
    expect(await importBudget(org.ctxOf('req_con', NOW), { bytes, fileName: 'งบ.xlsx' }, key())).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
  })
})

describe('[FR-BUD-001/AC2] each row funds its budget line, OUTSIDE → AVAILABLE, with an event', () => {
  it('creates the lines with their balances, one ledger row and one event per row', async () => {
    const bytes = await file([
      ['FY2569', 'CON', 'CC-CON', 'IMP-CON-OPEX-2569', 'ค่าใช้จ่ายดำเนินงาน ฝ่ายก่อสร้าง', '5101', 500000],
      ['FY2569', 'IT', 'CC-IT', 'IMP-IT-OPEX-2569', 'ค่าใช้จ่ายดำเนินงาน ฝ่ายไอที', '5104', '300000.50'],
    ])
    const r = await importBudget(org.ctxOf('fin_officer', NOW), { bytes, fileName: 'งบปี 2569.xlsx' }, key())
    expect(r).toMatchObject({ ok: true, data: { rows: 2, linesCreated: 2, totalSatang: '80000050' } })
    const lines = await linesOf()
    expect(lines.map((l) => [l.code, l.plannedSatang, l.balance?.availableSatang])).toEqual([
      ['IMP-CON-OPEX-2569', 50_000_000n, 50_000_000n],
      ['IMP-IT-OPEX-2569', 30_000_050n, 30_000_050n],
    ])
    for (const l of lines) {
      const ledger = await prisma.budgetLedgerEntry.findMany({ where: { budgetLineId: l.id } })
      expect(ledger.map((e) => [e.fromBucket, e.toBucket, e.amountSatang])).toEqual([['OUTSIDE', 'AVAILABLE', l.plannedSatang]])
      expect(await prisma.event.findUniqueOrThrow({ where: { id: ledger[0]!.eventId } })).toMatchObject({ type: 'budget.imported', aggregateId: l.id })
    }
  })
})

describe('[FR-BUD-001/AC3] the same file again is recognised by its checksum and needs confirming', () => {
  it('refuses a second import of the same file until it is confirmed, then adds to the lines', async () => {
    const bytes = await file([['FY2569', 'CON', 'CC-CON', 'IMP-CON-CAPEX-2569', 'ลงทุนเครื่องมือ', '1201', 2000000]])
    expect(await importBudget(org.ctxOf('fin_officer', NOW), { bytes, fileName: 'เพิ่มงบ.xlsx' }, key())).toMatchObject({ ok: true })
    expect(await importBudget(org.ctxOf('fin_officer', NOW), { bytes, fileName: 'เพิ่มงบ.xlsx' }, key())).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED', details: { reason: 'DUPLICATE_FILE', fileName: 'เพิ่มงบ.xlsx' } } })
    expect(await importBudget(org.ctxOf('fin_officer', NOW), { bytes, fileName: 'เพิ่มงบ.xlsx' }, { ...key(), confirmDuplicate: true })).toMatchObject({ ok: true, data: { linesCreated: 0 } })
    const line = await prisma.budgetLine.findFirstOrThrow({ where: { organizationId: org.organizationId, code: 'IMP-CON-CAPEX-2569' }, include: { balance: true } })
    expect([line.plannedSatang, line.balance?.availableSatang]).toEqual([400_000_000n, 400_000_000n])
    expect(await prisma.budgetImport.findMany({ where: { organizationId: org.organizationId, fileName: 'เพิ่มงบ.xlsx' }, orderBy: { importedAt: 'asc' }, select: { confirmedDuplicate: true } })).toEqual([{ confirmedDuplicate: false }, { confirmedDuplicate: true }])
  })
})

// The import page (S3-04) checks a file before anything is saved, gives the template with the organization's codes and
// lists what came in before; each needs budget.import like the import itself.

const ok = <T,>(r: { ok: true; data: T } | { ok: false; error: unknown }): T => {
  if (!r.ok) throw new Error(JSON.stringify(r.error))
  return r.data
}
/** What a check must leave as it was: the ledger, the imports and the lines */
const footprint = async () => ({
  ledger: await prisma.budgetLedgerEntry.count({ where: { organizationId: org.organizationId } }),
  imports: await prisma.budgetImport.count({ where: { organizationId: org.organizationId } }),
  lines: await prisma.budgetLine.count({ where: { organizationId: org.organizationId } }),
})

describe('[FR-BUD-001/AC1] the check before importing reports every row and saves nothing', () => {
  it('says what each right row will do and every field to fix', async () => {
    const bytes = await file([
      ['FY2569', 'CON', 'CC-CON', 'CON-OPEX-2569', 'เพิ่มงบดำเนินงาน', '5101', 25000],
      ['FY2569', 'IT', 'CC-IT', 'IMP-CHK-NEW', 'บรรทัดใหม่จากการตรวจ', '', '1234.5'],
      ['FY2569', 'XX', 'CC-CON', 'IMP-CHK-BAD', 'แผนกไม่มีจริง', '', 1000],
      ['FY2569', 'CON', 'CC-CON', 'IMP-CHK-AMT', 'ยอดผิด', '', 'หนึ่งพัน'],
    ])
    const before = await footprint()
    const check = ok(await previewBudgetImport(org.ctxOf('fin_officer', NOW), { bytes, fileName: 'ตรวจก่อน.xlsx' }))
    expect(check.rows.map((r) => [r.row, r.action, r.errors])).toEqual([
      [3, 'ADD', []],
      [4, 'CREATE', []],
      [5, null, [{ field: 'department', reason: 'UNKNOWN_DEPARTMENT' }]],
      [6, null, [{ field: 'amount', reason: 'INVALID_AMOUNT' }]],
    ])
    // A known code adds to its line (10,000,000.00 now); a new code makes a line; the cells come back as typed
    expect(check.rows[0]).toMatchObject({ amount: { amount: '25000.00' }, currentPlanned: { amount: '10000000.00' }, values: { code: 'CON-OPEX-2569', nameTh: 'เพิ่มงบดำเนินงาน' } })
    expect(check.rows[1]).toMatchObject({ amount: { amount: '1234.50' }, currentPlanned: null })
    expect(check.rows[3]).toMatchObject({ amount: null, values: { amount: 'หนึ่งพัน' } })
    expect(check).toMatchObject({ fileName: 'ตรวจก่อน.xlsx', ready: false, fileErrors: [], creates: 1, adds: 1, total: { amount: '26234.50' }, duplicate: null })
    expect(await footprint()).toEqual(before)
  })

  it('is ready when every row is right, and says a file problem once', async () => {
    const good = ok(await previewBudgetImport(org.ctxOf('fin_officer', NOW), { bytes: await file([['FY2569', 'FIN', 'CC-FIN', 'IMP-CHK-OK', 'ค่าธรรมเนียม', '', 500]]), fileName: 'ดี.xlsx' }))
    expect(good).toMatchObject({ ready: true, creates: 1, adds: 0, total: { amount: '500.00' } })
    const broken = ok(await previewBudgetImport(org.ctxOf('fin_officer', NOW), { bytes: new TextEncoder().encode('not a workbook').buffer as ArrayBuffer, fileName: 'เสีย.xlsx' }))
    expect(broken).toMatchObject({ ready: false, rows: [], fileErrors: [{ row: 0, reason: 'UNREADABLE' }] })
    const empty = ok(await previewBudgetImport(org.ctxOf('fin_officer', NOW), { bytes: await file([]), fileName: 'ว่าง.xlsx' }))
    expect(empty).toMatchObject({ ready: false, rows: [], fileErrors: [{ row: 0, reason: 'NO_ROWS' }] })
  })

  it('only BUDGET_ADMIN checks a file, gets the template or sees the past imports', async () => {
    const bytes = await file([['FY2569', 'CON', 'CC-CON', 'IMP-CHK-NO', 'ไม่มีสิทธิ์', '', 1000]])
    for (const code of ['req_con', 'dm_fin']) {
      expect(await previewBudgetImport(org.ctxOf(code, NOW), { bytes, fileName: 'x.xlsx' }), code).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
      expect(await budgetImportTemplate(org.ctxOf(code, NOW), LABELS, GUIDE), code).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
      expect(await budgetImportHistory(org.ctxOf(code, NOW)), code).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    }
  })
})

const GUIDE: BudgetImportGuideTexts = {
  sheetName: 'วิธีกรอก',
  lines: ['กรอกตั้งแต่แถว 3'],
  fiscalYearsTitle: 'ปีงบ',
  departmentsTitle: 'แผนก',
  costCentersTitle: 'cost center',
  codeHeader: 'รหัส',
  nameHeader: 'ชื่อ',
  departmentHeader: 'แผนก',
}

describe('[FR-BUD-001/AC1] the template carries the columns and a guide with the organization’s codes', () => {
  it('row 1 the column keys, row 2 the labels, and the open fiscal years, departments and cost centers in the guide', async () => {
    const template = new Uint8Array(ok(await budgetImportTemplate(org.ctxOf('fin_officer', NOW), LABELS, GUIDE))).buffer as ArrayBuffer
    const workbook = new ExcelJS.Workbook()
    await workbook.xlsx.load(template)
    expect((workbook.getWorksheet('Budget')!.getRow(1).values as unknown[]).slice(1)).toEqual([...BUDGET_IMPORT_COLUMNS])
    const guide = workbook.getWorksheet('วิธีกรอก')!
    const texts = guide.getSheetValues().flatMap((row) => (Array.isArray(row) ? row.filter((v): v is string => typeof v === 'string') : []))
    expect(texts).toEqual(expect.arrayContaining(['กรอกตั้งแต่แถว 3', 'FY2569', 'CON', 'ฝ่ายก่อสร้าง', 'CC-CON', 'CC-IT']))
    // The template itself, still empty, is read from its Budget sheet (the guide sheet is never taken for data)
    expect(ok(await previewBudgetImport(org.ctxOf('fin_officer', NOW), { bytes: template, fileName: 'แม่แบบ.xlsx' })).fileErrors).toEqual([{ row: 0, reason: 'NO_ROWS' }])
  })
})

describe('[FR-BUD-001/AC3] the check says a file was imported before, and the history shows both imports', () => {
  it('names when and by whom; the import then needs the confirmation and is listed as confirmed', async () => {
    const bytes = await file([['FY2569', 'PROC', 'CC-PROC', 'IMP-DUP-2569', 'งบซ้ำ', '', 3000]])
    expect(ok(await previewBudgetImport(org.ctxOf('fin_officer', NOW), { bytes, fileName: 'ซ้ำ.xlsx' })).duplicate).toBeNull()
    ok(await importBudget(org.ctxOf('fin_officer', NOW), { bytes, fileName: 'ซ้ำ.xlsx' }, key()))
    const again = ok(await previewBudgetImport(org.ctxOf('fin_officer', NOW), { bytes, fileName: 'ซ้ำอีก.xlsx' }))
    expect(again).toMatchObject({ ready: true, adds: 1, creates: 0, duplicate: { fileName: 'ซ้ำ.xlsx', importedAt: NOW.toISOString(), importedBy: { th: 'ผู้ใช้ fin_officer' } } })
    expect(await importBudget(org.ctxOf('fin_officer', NOW), { bytes, fileName: 'ซ้ำอีก.xlsx' }, key())).toMatchObject({ ok: false, error: { details: { reason: 'DUPLICATE_FILE' } } })
    ok(await importBudget(org.ctxOf('fin_officer', NOW), { bytes, fileName: 'ซ้ำอีก.xlsx' }, { ...key(), confirmDuplicate: true }))
    const history = ok(await budgetImportHistory(org.ctxOf('fin_officer', NOW)))
    expect(history.filter((h) => h.fileName.startsWith('ซ้ำ')).map((h) => [h.fileName, h.rows, h.total.amount, h.fiscalYearCode, h.confirmedDuplicate, h.importedBy?.th])).toEqual(
      expect.arrayContaining([
        ['ซ้ำ.xlsx', 1, '3000.00', 'FY2569', false, 'ผู้ใช้ fin_officer'],
        ['ซ้ำอีก.xlsx', 1, '3000.00', 'FY2569', true, 'ผู้ใช้ fin_officer'],
      ]),
    )
  })
})

describe('[FR-BUD-001/AC1] the import takes only the file that was checked and confirmed', () => {
  it('gives the checksum of the file checked, and refuses another file sent with it (RECHECK) without saving anything', async () => {
    const checkedFile = await file([['FY2569', 'PROC', 'CC-PROC', 'IMP-SUM-A', 'งบที่ตรวจแล้ว', '', 4000]])
    const otherFile = await file([['FY2569', 'PROC', 'CC-PROC', 'IMP-SUM-A', 'งบที่ตรวจแล้ว', '', 40000]])
    const check = ok(await previewBudgetImport(org.ctxOf('fin_officer', NOW), { bytes: checkedFile, fileName: 'ตรวจแล้ว.xlsx' }))
    expect(check.checksum).toBe(createHash('sha256').update(Buffer.from(checkedFile)).digest('hex'))
    const before = await footprint()
    for (const expectedChecksum of [check.checksum.replace(/^./, (c) => (c === '0' ? '1' : '0')), '', 'not-a-checksum']) {
      expect(await importBudget(org.ctxOf('fin_officer', NOW), { bytes: otherFile, fileName: 'ตรวจแล้ว.xlsx' }, { ...key(), expectedChecksum }), expectedChecksum).toMatchObject({
        ok: false,
        error: { code: 'VALIDATION_FAILED', details: { field: 'file', reason: 'RECHECK' } },
      })
    }
    expect(await importBudget(org.ctxOf('fin_officer', NOW), { bytes: otherFile, fileName: 'ตรวจแล้ว.xlsx' }, { ...key(), expectedChecksum: check.checksum })).toMatchObject({ ok: false, error: { details: { reason: 'RECHECK' } } })
    expect(await footprint()).toEqual(before)
    // The file checked goes in
    expect(await importBudget(org.ctxOf('fin_officer', NOW), { bytes: checkedFile, fileName: 'ตรวจแล้ว.xlsx' }, { ...key(), expectedChecksum: check.checksum })).toMatchObject({ ok: true, data: { rows: 1, totalSatang: '400000' } })
  })

  it('refuses a member who may not import before looking at the file', async () => {
    const bytes = await file([['FY2569', 'PROC', 'CC-PROC', 'IMP-SUM-B', 'ไม่มีสิทธิ์', '', 1000]])
    expect(await importBudget(org.ctxOf('req_con', NOW), { bytes, fileName: 'x.xlsx' }, { ...key(), expectedChecksum: 'not-a-checksum' })).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
  })
})

describe('[FR-BUD-001/AC1] the check says when a row adds to a line with another name, account code or cost center', () => {
  it('warns on each detail that differs, says what the line has now, and leaves the row importable', async () => {
    // A second cost center of CON, so a row may name another one of the same department
    await prisma.costCenter.create({ data: { organizationId: org.organizationId, code: 'CC-CON-2', nameTh: 'ศูนย์ต้นทุน CON สอง', departmentId: org.department.CON! } })
    const line = await prisma.budgetLine.findFirstOrThrow({ where: { organizationId: org.organizationId, code: 'CON-OPEX-2569' }, include: { costCenter: true } })
    const bytes = await file([
      ['FY2569', 'CON', 'CC-CON-2', 'CON-OPEX-2569', 'ชื่อที่พิมพ์ผิด', '5199', 1000],
      ['FY2569', 'CON', line.costCenter.code, 'CON-OPEX-2569-B', 'บรรทัดใหม่', '', 1000],
      ['FY2569', 'IT', 'CC-IT', 'IT-OPEX-2569', 'ค่าใช้จ่ายดำเนินงาน IT', '', 1000],
    ])
    const check = ok(await previewBudgetImport(org.ctxOf('fin_officer', NOW), { bytes, fileName: 'ต่างจากเดิม.xlsx' }))
    expect(check.ready).toBe(true)
    expect(check.rows.map((r) => [r.row, r.action, r.warnings])).toEqual([
      [
        3,
        'ADD',
        [
          { field: 'nameTh', reason: 'DIFFERS_FROM_LINE', current: line.nameTh },
          { field: 'accountCode', reason: 'DIFFERS_FROM_LINE', current: null },
          { field: 'costCenter', reason: 'DIFFERS_FROM_LINE', current: 'CC-CON' },
        ],
      ],
      [4, 'CREATE', []],
      // The same name, no account code and the same cost center as the line: nothing to say
      [5, 'ADD', []],
    ])
  })
})
