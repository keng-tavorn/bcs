import { randomUUID } from 'node:crypto'
import ExcelJS from 'exceljs'
import { beforeAll, describe, expect, it } from 'vitest'
import { prisma } from '@/server/db/client'
import { BUDGET_IMPORT_COLUMNS, buildBudgetImportTemplate, importBudget } from '@/server/services/budget/import'
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
  await prisma.roleAssignment.create({ data: { organizationId, memberId: org.member.fin_officer!, role: 'BUDGET_ADMIN', grantedAt: NOW } })
  await prisma.fiscalYear.create({ data: { organizationId, code: 'FY2569', startsOn: new Date('2026-01-01T00:00:00Z'), endsOn: new Date('2026-12-31T00:00:00Z') } })
  await prisma.costCenter.createMany({
    data: [
      { organizationId, code: 'CC-CON', nameTh: 'ศูนย์ต้นทุนก่อสร้าง', departmentId: org.department.CON! },
      { organizationId, code: 'CC-IT', nameTh: 'ศูนย์ต้นทุนไอที', departmentId: org.department.IT! },
    ],
  })
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

const linesOf = () => prisma.budgetLine.findMany({ where: { organizationId: org.organizationId }, include: { balance: true }, orderBy: { code: 'asc' } })

describe('[FR-BUD-001/AC1] a file with a wrong row saves nothing and reports every wrong row', () => {
  it('lists each row and field with its reason', async () => {
    const bytes = await file([
      ['FY2569', 'CON', 'CC-CON', 'CON-OPEX', 'ค่าใช้จ่ายดำเนินงาน', '5101', 500000],
      ['FY2569', 'XX', 'CC-CON', 'XX-OPEX', 'แผนกไม่มีจริง', '', 1000],
      ['FY2569', 'IT', 'CC-CON', 'IT-OPEX', 'cost center ของแผนกอื่น', '', 1000],
      ['FY2569', 'CON', 'CC-CON', 'CON-OPEX', 'รหัสซ้ำในไฟล์', '', 1000],
      ['FY2569', 'CON', 'CC-CON', 'CON-CAPEX', 'ยอดผิด', '', '12.345'],
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
      ['FY2569', 'CON', 'CC-CON', 'CON-OPEX', 'ค่าใช้จ่ายดำเนินงาน', '5101', 500000],
      ['FY2569', 'XX', 'CC-CON', 'XX-OPEX', 'แผนกไม่มีจริง', '', 1000],
      ['FY2569', 'IT', 'CC-CON', 'IT-OPEX', 'cost center ของแผนกอื่น', '', 1000],
      ['FY2570', 'CON', 'CC-CON', 'CON-OPEX', 'ปีงบที่ยังไม่มี', '', 1000],
    ])
    const again = await importBudget(org.ctxOf('fin_officer', NOW), { bytes: fixed, fileName: 'งบ.xlsx' }, key())
    expect(again.ok ? [] : (again.error.details as { rows: unknown[] }).rows).toEqual([
      { row: 4, field: 'department', reason: 'UNKNOWN_DEPARTMENT' },
      { row: 5, field: 'costCenter', reason: 'COST_CENTER_OF_ANOTHER_DEPARTMENT' },
      { row: 6, field: 'fiscalYear', reason: 'UNKNOWN_FISCAL_YEAR' },
    ])
    expect(await linesOf()).toEqual([])
    expect(await prisma.budgetLedgerEntry.count({ where: { organizationId: org.organizationId } })).toBe(0)
  })

  it('only BUDGET_ADMIN imports', async () => {
    const bytes = await file([['FY2569', 'CON', 'CC-CON', 'CON-OPEX', 'ค่าใช้จ่าย', '', 1000]])
    expect(await importBudget(org.ctxOf('req_con', NOW), { bytes, fileName: 'งบ.xlsx' }, key())).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
  })
})

describe('[FR-BUD-001/AC2] each row funds its budget line, OUTSIDE → AVAILABLE, with an event', () => {
  it('creates the lines with their balances, one ledger row and one event per row', async () => {
    const bytes = await file([
      ['FY2569', 'CON', 'CC-CON', 'CON-OPEX-2569', 'ค่าใช้จ่ายดำเนินงาน ฝ่ายก่อสร้าง', '5101', 500000],
      ['FY2569', 'IT', 'CC-IT', 'IT-OPEX-2569', 'ค่าใช้จ่ายดำเนินงาน ฝ่ายไอที', '5104', '300000.50'],
    ])
    const r = await importBudget(org.ctxOf('fin_officer', NOW), { bytes, fileName: 'งบปี 2569.xlsx' }, key())
    expect(r).toMatchObject({ ok: true, data: { rows: 2, linesCreated: 2, totalSatang: '80000050' } })
    const lines = await linesOf()
    expect(lines.map((l) => [l.code, l.plannedSatang, l.balance?.availableSatang])).toEqual([
      ['CON-OPEX-2569', 50_000_000n, 50_000_000n],
      ['IT-OPEX-2569', 30_000_050n, 30_000_050n],
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
    const bytes = await file([['FY2569', 'CON', 'CC-CON', 'CON-CAPEX-2569', 'ลงทุนเครื่องมือ', '1201', 2000000]])
    expect(await importBudget(org.ctxOf('fin_officer', NOW), { bytes, fileName: 'เพิ่มงบ.xlsx' }, key())).toMatchObject({ ok: true })
    expect(await importBudget(org.ctxOf('fin_officer', NOW), { bytes, fileName: 'เพิ่มงบ.xlsx' }, key())).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED', details: { reason: 'DUPLICATE_FILE', fileName: 'เพิ่มงบ.xlsx' } } })
    expect(await importBudget(org.ctxOf('fin_officer', NOW), { bytes, fileName: 'เพิ่มงบ.xlsx' }, { ...key(), confirmDuplicate: true })).toMatchObject({ ok: true, data: { linesCreated: 0 } })
    const line = await prisma.budgetLine.findFirstOrThrow({ where: { organizationId: org.organizationId, code: 'CON-CAPEX-2569' }, include: { balance: true } })
    expect([line.plannedSatang, line.balance?.availableSatang]).toEqual([400_000_000n, 400_000_000n])
    expect(await prisma.budgetImport.findMany({ where: { organizationId: org.organizationId, fileName: 'เพิ่มงบ.xlsx' }, orderBy: { importedAt: 'asc' }, select: { confirmedDuplicate: true } })).toEqual([{ confirmedDuplicate: false }, { confirmedDuplicate: true }])
  })
})
