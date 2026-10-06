import ExcelJS from 'exceljs'
import type { BudgetDashboardDto, BudgetFiguresDto } from './dashboard'

// The Excel file of the budget dashboard (spec §11.2 "ส่งออก Excel"): what the page shows, in the same order — each
// department's total followed by its budget lines, then the total of everything shown — for the fiscal year and the
// scope the member sees. It is built from the dashboard's own result (budgetDashboard checks budget.view), so the file
// never holds more than the screen. Amounts are written as text "12345.50" like the Express file (BR-MONEY-01: money
// never passes through floating point); shares are percent with two decimals. Reading it changes nothing.

export const BUDGET_EXPORT_COLUMNS = [
  'kind',
  'departmentCode',
  'departmentName',
  'lineCode',
  'lineName',
  'costCenter',
  'status',
  'planned',
  'available',
  'reserved',
  'committed',
  'actual',
  'usedPct',
  'heldPct',
  'availablePct',
  'low',
] as const
export type BudgetExportColumn = (typeof BUDGET_EXPORT_COLUMNS)[number]

// Amounts and shares line up on the right, as on the page
const RIGHT_ALIGNED: ReadonlySet<BudgetExportColumn> = new Set(['planned', 'available', 'reserved', 'committed', 'actual', 'usedPct', 'heldPct', 'availablePct'])
const COLUMN_WIDTH = 18
const NAME_WIDTH = 40

export interface BudgetExportTexts {
  readonly sheetName: string
  /** Lines above the table: what it is, the fiscal year, the scope and when the figures were read */
  readonly heading: readonly string[]
  readonly headers: Readonly<Record<BudgetExportColumn, string>>
  readonly kinds: { readonly line: string; readonly department: string; readonly total: string }
  readonly status: Readonly<Record<'OPEN' | 'FROZEN' | 'CLOSED', string>>
  /** Written in the column `low` of a line or total below digest.budgetLowPct */
  readonly low: string
  /** Department names in the reader's language */
  readonly departmentName: (department: BudgetDashboardDto['departments'][number]) => string
}

/** 1234 → "12.34" (basis points as a percent with two decimals); empty when nothing is planned */
export function percentText(bp: number | null): string {
  if (bp === null) return ''
  return `${Math.floor(bp / 100)}.${String(bp % 100).padStart(2, '0')}`
}

function amounts(f: BudgetFiguresDto, lowText: string): Pick<Record<BudgetExportColumn, string>, 'planned' | 'available' | 'reserved' | 'committed' | 'actual' | 'usedPct' | 'heldPct' | 'availablePct' | 'low'> {
  return {
    planned: f.planned.amount,
    available: f.available.amount,
    reserved: f.reserved.amount,
    committed: f.committed.amount,
    actual: f.actual.amount,
    usedPct: percentText(f.usedBp),
    heldPct: percentText(f.heldBp),
    availablePct: percentText(f.availableBp),
    low: f.low ? lowText : '',
  }
}

/** The rows of the file, in the order of the page: each department's total, its lines, then the total */
export function budgetExportRows(dashboard: BudgetDashboardDto, texts: BudgetExportTexts): Array<Record<BudgetExportColumn, string>> {
  const rows: Array<Record<BudgetExportColumn, string>> = []
  for (const d of dashboard.departments) {
    const name = texts.departmentName(d)
    rows.push({ kind: texts.kinds.department, departmentCode: d.code, departmentName: name, lineCode: '', lineName: '', costCenter: '', status: '', ...amounts(d, texts.low) })
    for (const l of dashboard.lines.filter((x) => x.departmentId === d.id)) {
      rows.push({ kind: texts.kinds.line, departmentCode: d.code, departmentName: name, lineCode: l.code, lineName: l.nameTh, costCenter: l.costCenterCode, status: texts.status[l.status], ...amounts(l, texts.low) })
    }
  }
  rows.push({ kind: texts.kinds.total, departmentCode: '', departmentName: '', lineCode: '', lineName: '', costCenter: '', status: '', ...amounts(dashboard.total, texts.low) })
  return rows
}

export async function budgetDashboardWorkbook(dashboard: BudgetDashboardDto, texts: BudgetExportTexts): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook()
  const sheet = workbook.addWorksheet(texts.sheetName)
  for (const line of texts.heading) sheet.addRow([line])
  sheet.getRow(1).font = { bold: true }
  sheet.addRow([])
  const header = sheet.addRow(BUDGET_EXPORT_COLUMNS.map((c) => texts.headers[c]))
  header.font = { bold: true }
  sheet.views = [{ state: 'frozen', ySplit: header.number }]
  for (const row of budgetExportRows(dashboard, texts)) {
    const added = sheet.addRow(BUDGET_EXPORT_COLUMNS.map((c) => row[c]))
    if (row.kind !== texts.kinds.line) added.font = { bold: true }
    BUDGET_EXPORT_COLUMNS.forEach((c, i) => {
      const cell = added.getCell(i + 1)
      // Text, so Excel keeps "12345.50" exactly as the ledger has it; right-aligned like the page
      cell.numFmt = '@'
      if (RIGHT_ALIGNED.has(c)) cell.alignment = { horizontal: 'right' }
    })
  }
  BUDGET_EXPORT_COLUMNS.forEach((c, i) => (sheet.getColumn(i + 1).width = c === 'lineName' || c === 'departmentName' ? NAME_WIDTH : COLUMN_WIDTH))
  return Buffer.from(await workbook.xlsx.writeBuffer())
}
