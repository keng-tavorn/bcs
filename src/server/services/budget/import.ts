import { createHash } from 'node:crypto'
import ExcelJS from 'exceljs'
import { z } from 'zod'
import { fund } from '@/core/budget'
import { amountToSatang } from '@/core/money/dto'
import { err, ok, type Result } from '@/core/result'
import { BUDGET_IMPORT_MAX_ROWS } from '@/lib/constants'
import { newId } from '@/lib/ids'
import { authorize } from '@/server/authz'
import type { Ctx } from '@/server/context'
import { forTenant, type TenantTx } from '@/server/db/tenant'
import type { EventDraft } from '@/server/events/append'
import { defineCommand, runCommand, type CommandOutcome, type RunOptions } from '../_pipeline'
import { applyBudget } from '@/server/budget/ledger'

// Budget import from the Excel template (FR-BUD-001): fiscal year, department, cost center, code, name, account and
// amount per row. Every row is checked first; if any is wrong, each wrong row and field is reported and nothing is
// saved (AC1). Each row funds its budget line, OUTSIDE → AVAILABLE, with its own event (AC2): a new code makes a new
// line, a known code adds to it. The same file again is recognised by its checksum and needs confirming (AC3).

export const BUDGET_IMPORT_COLUMNS = ['fiscalYear', 'department', 'costCenter', 'code', 'nameTh', 'accountCode', 'amount'] as const
export type BudgetImportColumn = (typeof BUDGET_IMPORT_COLUMNS)[number]
export const BUDGET_IMPORT_SHEET = 'Budget'
const FIRST_DATA_ROW = 3

export type BudgetImportReason =
  | 'REQUIRED'
  | 'TOO_LONG'
  | 'INVALID_AMOUNT'
  | 'DUPLICATE_IN_FILE'
  | 'UNKNOWN_FISCAL_YEAR'
  | 'FISCAL_YEAR_CLOSED'
  | 'UNKNOWN_DEPARTMENT'
  | 'UNKNOWN_COST_CENTER'
  | 'COST_CENTER_OF_ANOTHER_DEPARTMENT'
  | 'LINE_OF_ANOTHER_DEPARTMENT'
  | 'NO_ROWS'
  | 'TOO_MANY_ROWS'
  | 'UNREADABLE'
  | 'MISSING_HEADER'

export interface BudgetImportRowError {
  readonly row: number
  readonly field: BudgetImportColumn | 'file'
  readonly reason: BudgetImportReason
}

export interface BudgetImportRow {
  readonly row: number
  readonly fiscalYear: string
  readonly department: string
  readonly costCenter: string
  readonly code: string
  readonly nameTh: string
  readonly accountCode: string | null
  /** Baht text, at most two decimals, above zero */
  readonly amount: string
}

const AMOUNT = /^\d{1,13}(\.\d{1,2})?$/

function text(value: ExcelJS.CellValue): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'object' && 'richText' in value) return value.richText.map((p) => p.text).join('').trim()
  if (typeof value === 'object' && 'text' in value && typeof value.text === 'string') return value.text.trim()
  if (typeof value === 'object' && 'result' in value) return text((value.result ?? null) as ExcelJS.CellValue)
  return String(value).trim()
}

/** The template: column keys on row 1, the screen's labels on row 2, data from row 3 */
export async function buildBudgetImportTemplate(labels: Record<BudgetImportColumn, string>): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook()
  const sheet = workbook.addWorksheet(BUDGET_IMPORT_SHEET)
  sheet.addRow([...BUDGET_IMPORT_COLUMNS])
  sheet.addRow(BUDGET_IMPORT_COLUMNS.map((c) => labels[c]))
  sheet.getRow(1).font = { bold: true }
  sheet.views = [{ state: 'frozen', ySplit: 2 }]
  BUDGET_IMPORT_COLUMNS.forEach((_, i) => (sheet.getColumn(i + 1).width = 24))
  return Buffer.from(await workbook.xlsx.writeBuffer())
}

/** Reads and checks the file on its own; never throws on bad input */
export async function parseBudgetImport(bytes: ArrayBuffer): Promise<{ rows: BudgetImportRow[]; errors: BudgetImportRowError[] }> {
  const workbook = new ExcelJS.Workbook()
  try {
    await workbook.xlsx.load(bytes)
  } catch {
    return { rows: [], errors: [{ row: 0, field: 'file', reason: 'UNREADABLE' }] }
  }
  const sheet = workbook.getWorksheet(BUDGET_IMPORT_SHEET) ?? workbook.worksheets[0]
  if (!sheet) return { rows: [], errors: [{ row: 0, field: 'file', reason: 'UNREADABLE' }] }
  const columns = new Map<BudgetImportColumn, number>()
  sheet.getRow(1).eachCell((cell, col) => {
    const key = text(cell.value) as BudgetImportColumn
    if ((BUDGET_IMPORT_COLUMNS as readonly string[]).includes(key)) columns.set(key, col)
  })
  if (BUDGET_IMPORT_COLUMNS.some((c) => c !== 'accountCode' && !columns.has(c))) return { rows: [], errors: [{ row: 1, field: 'file', reason: 'MISSING_HEADER' }] }

  const rows: BudgetImportRow[] = []
  const errors: BudgetImportRowError[] = []
  const seen = new Set<string>()
  for (let r = FIRST_DATA_ROW; r <= sheet.rowCount; r++) {
    const cell = (c: BudgetImportColumn) => (columns.has(c) ? text(sheet.getRow(r).getCell(columns.get(c)!).value) : '')
    const raw = Object.fromEntries(BUDGET_IMPORT_COLUMNS.map((c) => [c, cell(c)])) as Record<BudgetImportColumn, string>
    if (BUDGET_IMPORT_COLUMNS.every((c) => raw[c] === '')) continue
    const before = errors.length
    for (const c of ['fiscalYear', 'department', 'costCenter', 'code', 'nameTh', 'amount'] as const) if (!raw[c]) errors.push({ row: r, field: c, reason: 'REQUIRED' })
    for (const c of ['fiscalYear', 'department', 'costCenter', 'code', 'accountCode'] as const) if (raw[c].length > 50) errors.push({ row: r, field: c, reason: 'TOO_LONG' })
    if (raw.nameTh.length > 200) errors.push({ row: r, field: 'nameTh', reason: 'TOO_LONG' })
    // Excel keeps numbers as numbers: 500000 or 1234.5 arrive as text without a thousands separator
    const amount = raw.amount.replace(/,/g, '')
    if (raw.amount && (!AMOUNT.test(amount) || amountToSatang(amount) <= 0n)) errors.push({ row: r, field: 'amount', reason: 'INVALID_AMOUNT' })
    const key = `${raw.fiscalYear}|${raw.code}`
    if (raw.code && seen.has(key)) errors.push({ row: r, field: 'code', reason: 'DUPLICATE_IN_FILE' })
    seen.add(key)
    if (errors.length === before) {
      rows.push({ row: r, fiscalYear: raw.fiscalYear, department: raw.department, costCenter: raw.costCenter, code: raw.code, nameTh: raw.nameTh, accountCode: raw.accountCode || null, amount })
    }
  }
  if (rows.length + errors.length === 0) errors.push({ row: 0, field: 'file', reason: 'NO_ROWS' })
  if (rows.length > BUDGET_IMPORT_MAX_ROWS) errors.push({ row: 0, field: 'file', reason: 'TOO_MANY_ROWS' })
  return { rows, errors }
}

/** Rows checked against the organization: fiscal year, department and cost center exist and belong together */
async function checkAgainstOrganization(tx: TenantTx, rows: readonly BudgetImportRow[]): Promise<BudgetImportRowError[]> {
  const [years, departments, costCenters, lines] = await Promise.all([
    tx.fiscalYear.findMany({ select: { id: true, code: true, status: true } }),
    tx.department.findMany({ select: { id: true, code: true } }),
    tx.costCenter.findMany({ select: { id: true, code: true, departmentId: true, active: true } }),
    tx.budgetLine.findMany({ select: { fiscalYearId: true, code: true, departmentId: true } }),
  ])
  const errors: BudgetImportRowError[] = []
  for (const r of rows) {
    const year = years.find((y) => y.code === r.fiscalYear)
    const department = departments.find((d) => d.code === r.department)
    const costCenter = costCenters.find((c) => c.code === r.costCenter && c.active)
    if (!year) errors.push({ row: r.row, field: 'fiscalYear', reason: 'UNKNOWN_FISCAL_YEAR' })
    else if (year.status === 'CLOSED') errors.push({ row: r.row, field: 'fiscalYear', reason: 'FISCAL_YEAR_CLOSED' })
    if (!department) errors.push({ row: r.row, field: 'department', reason: 'UNKNOWN_DEPARTMENT' })
    if (!costCenter) errors.push({ row: r.row, field: 'costCenter', reason: 'UNKNOWN_COST_CENTER' })
    else if (department && costCenter.departmentId !== department.id) errors.push({ row: r.row, field: 'costCenter', reason: 'COST_CENTER_OF_ANOTHER_DEPARTMENT' })
    const line = year ? lines.find((l) => l.fiscalYearId === year.id && l.code === r.code) : undefined
    if (line && department && line.departmentId !== department.id) errors.push({ row: r.row, field: 'code', reason: 'LINE_OF_ANOTHER_DEPARTMENT' })
  }
  return errors
}

const ImportInput = z.strictObject({
  fileName: z.string().trim().min(1).max(255),
  checksum: z.string().regex(/^[0-9a-f]{64}$/),
  confirmDuplicate: z.boolean().default(false),
  rows: z
    .array(
      z.strictObject({
        row: z.number().int(),
        fiscalYear: z.string().min(1).max(50),
        department: z.string().min(1).max(50),
        costCenter: z.string().min(1).max(50),
        code: z.string().min(1).max(50),
        nameTh: z.string().min(1).max(200),
        accountCode: z.string().max(50).nullable(),
        amount: z.string().regex(AMOUNT),
      }),
    )
    .min(1)
    .max(BUDGET_IMPORT_MAX_ROWS),
})

export interface BudgetImportOutcome {
  readonly importId: string
  readonly rows: number
  readonly linesCreated: number
  readonly totalSatang: string
}

export const importBudgetCommand = defineCommand({
  name: 'budget.import',
  capability: 'budget.import',
  input: ImportInput,
  async execute(tx, input, ctx): Promise<CommandOutcome<BudgetImportOutcome>> {
    const allowed = await authorize(tx, ctx, 'budget.import')
    if (!allowed.ok) return { ok: false, error: allowed.error }
    const errors = await checkAgainstOrganization(tx, input.rows)
    if (errors.length) return { ok: false, error: { code: 'VALIDATION_FAILED', message: 'the file has rows to fix; nothing was saved', details: { field: 'file', rows: errors.sort((a, b) => a.row - b.row) } } }
    // AC3: the same file again needs confirming before its amounts are added
    const previous = await tx.budgetImport.findFirst({ where: { checksum: input.checksum }, orderBy: { importedAt: 'desc' }, select: { importedAt: true, fileName: true } })
    if (previous && !input.confirmDuplicate) {
      return { ok: false, error: { code: 'VALIDATION_FAILED', message: 'this file was imported before', details: { field: 'file', reason: 'DUPLICATE_FILE', importedAt: previous.importedAt.toISOString(), fileName: previous.fileName } } }
    }

    const [years, departments, costCenters] = await Promise.all([
      tx.fiscalYear.findMany({ select: { id: true, code: true } }),
      tx.department.findMany({ select: { id: true, code: true } }),
      tx.costCenter.findMany({ select: { id: true, code: true } }),
    ])
    const importId = newId()
    let linesCreated = 0
    const lineIds: string[] = []
    for (const r of input.rows) {
      const fiscalYearId = years.find((y) => y.code === r.fiscalYear)!.id
      let line = await tx.budgetLine.findFirst({ where: { fiscalYearId, code: r.code }, select: { id: true } })
      if (!line) {
        line = await tx.budgetLine.create({
          data: {
            organizationId: ctx.organizationId,
            fiscalYearId,
            departmentId: departments.find((d) => d.code === r.department)!.id,
            costCenterId: costCenters.find((c) => c.code === r.costCenter)!.id,
            code: r.code,
            nameTh: r.nameTh,
            accountCode: r.accountCode,
            plannedSatang: 0n,
          },
          select: { id: true },
        })
        await tx.budgetLineBalance.create({ data: { organizationId: ctx.organizationId, budgetLineId: line.id } })
        linesCreated++
      }
      lineIds.push(line.id)
    }
    // AC2: each row funds its line with its own ledger rows and event
    const funded = await applyBudget(
      tx,
      ctx,
      input.rows.map((r, i) => ({
        budgetLineId: lineIds[i]!,
        event: 'budget.imported' as const,
        document: { type: 'IMPORT' as const, id: importId },
        run: (s) => fund(s, amountToSatang(r.amount), importId),
      })),
    )
    if (!funded.ok) return { ok: false, error: funded.error }
    const total = input.rows.reduce((sum, r) => sum + amountToSatang(r.amount), 0n)
    await tx.budgetImport.create({
      data: {
        id: importId,
        organizationId: ctx.organizationId,
        fiscalYearId: years.find((y) => y.code === input.rows[0]!.fiscalYear)!.id,
        checksum: input.checksum,
        fileName: input.fileName,
        rows: input.rows.length,
        totalSatang: total,
        importedById: ctx.actor.type === 'USER' ? ctx.actor.memberId : null,
        confirmedDuplicate: Boolean(previous),
        importedAt: ctx.now,
      },
    })
    const events: EventDraft[] = funded.events
    return { ok: true, result: { importId, rows: input.rows.length, linesCreated, totalSatang: total.toString() }, events }
  },
})

/** Reads the file, checks every row, then imports all of them in one command or reports each wrong row (AC1) */
export async function importBudget(ctx: Ctx, file: { bytes: ArrayBuffer; fileName: string }, options: RunOptions & { confirmDuplicate?: boolean }): Promise<Result<BudgetImportOutcome>> {
  const allowed = await forTenant(ctx.organizationId).$transaction((tx) => authorize(tx, ctx, 'budget.import'))
  if (!allowed.ok) return allowed
  const { rows, errors } = await parseBudgetImport(file.bytes)
  if (errors.length) return err('VALIDATION_FAILED', 'the file has rows to fix; nothing was saved', { field: 'file', rows: [...errors].sort((a, b) => a.row - b.row) })
  const checksum = createHash('sha256').update(Buffer.from(file.bytes)).digest('hex')
  const { confirmDuplicate = false, ...run } = options
  const result = await runCommand(ctx, importBudgetCommand, { fileName: file.fileName, checksum, confirmDuplicate, rows }, run)
  return result.ok ? ok(result.data) : result
}
