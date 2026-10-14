import { createHash } from 'node:crypto'
import ExcelJS from 'exceljs'
import { z } from 'zod'
import { fund } from '@/core/budget'
import { amountToSatang, toMoneyDto, type MoneyDto } from '@/core/money/dto'
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

/** The guide sheet of the template: how to fill it, and the codes the organization has today */
export interface BudgetImportGuide {
  readonly sheetName: string
  readonly lines: readonly string[]
  readonly fiscalYears: { readonly title: string; readonly codes: readonly string[] }
  readonly departments: { readonly title: string; readonly headers: readonly [string, string]; readonly rows: ReadonlyArray<readonly [string, string]> }
  readonly costCenters: { readonly title: string; readonly headers: readonly [string, string, string]; readonly rows: ReadonlyArray<readonly [string, string, string]> }
}

/** The template: column keys on row 1, the screen's labels on row 2, data from row 3; with a guide sheet when given */
export async function buildBudgetImportTemplate(labels: Record<BudgetImportColumn, string>, guide?: BudgetImportGuide): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook()
  const sheet = workbook.addWorksheet(BUDGET_IMPORT_SHEET)
  sheet.addRow([...BUDGET_IMPORT_COLUMNS])
  sheet.addRow(BUDGET_IMPORT_COLUMNS.map((c) => labels[c]))
  sheet.getRow(1).font = { bold: true }
  sheet.views = [{ state: 'frozen', ySplit: 2 }]
  BUDGET_IMPORT_COLUMNS.forEach((_, i) => (sheet.getColumn(i + 1).width = 24))
  if (guide) {
    const help = workbook.addWorksheet(guide.sheetName)
    for (const line of guide.lines) help.addRow([line])
    help.addRow([])
    help.addRow([guide.fiscalYears.title]).font = { bold: true }
    for (const code of guide.fiscalYears.codes) help.addRow([code])
    help.addRow([])
    help.addRow([guide.departments.title]).font = { bold: true }
    help.addRow([...guide.departments.headers]).font = { bold: true }
    for (const row of guide.departments.rows) help.addRow([...row])
    help.addRow([])
    help.addRow([guide.costCenters.title]).font = { bold: true }
    help.addRow([...guide.costCenters.headers]).font = { bold: true }
    for (const row of guide.costCenters.rows) help.addRow([...row])
    help.getColumn(1).width = 24
    help.getColumn(2).width = 40
    help.getColumn(3).width = 24
  }
  return Buffer.from(await workbook.xlsx.writeBuffer())
}

/** The texts of a file row as they were typed, for the report of the screen */
export interface BudgetImportCells {
  readonly row: number
  readonly values: Readonly<Record<BudgetImportColumn, string>>
}

/** Reads and checks the file on its own; never throws on bad input. `cells` holds every filled row as typed. */
export async function parseBudgetImport(bytes: ArrayBuffer): Promise<{ rows: BudgetImportRow[]; errors: BudgetImportRowError[]; cells: BudgetImportCells[] }> {
  const workbook = new ExcelJS.Workbook()
  try {
    await workbook.xlsx.load(bytes)
  } catch {
    return { rows: [], errors: [{ row: 0, field: 'file', reason: 'UNREADABLE' }], cells: [] }
  }
  const sheet = workbook.getWorksheet(BUDGET_IMPORT_SHEET) ?? workbook.worksheets[0]
  if (!sheet) return { rows: [], errors: [{ row: 0, field: 'file', reason: 'UNREADABLE' }], cells: [] }
  const columns = new Map<BudgetImportColumn, number>()
  sheet.getRow(1).eachCell((cell, col) => {
    const key = text(cell.value) as BudgetImportColumn
    if ((BUDGET_IMPORT_COLUMNS as readonly string[]).includes(key)) columns.set(key, col)
  })
  if (BUDGET_IMPORT_COLUMNS.some((c) => c !== 'accountCode' && !columns.has(c))) return { rows: [], errors: [{ row: 1, field: 'file', reason: 'MISSING_HEADER' }], cells: [] }

  const rows: BudgetImportRow[] = []
  const errors: BudgetImportRowError[] = []
  const cells: BudgetImportCells[] = []
  const seen = new Set<string>()
  for (let r = FIRST_DATA_ROW; r <= sheet.rowCount; r++) {
    const cell = (c: BudgetImportColumn) => (columns.has(c) ? text(sheet.getRow(r).getCell(columns.get(c)!).value) : '')
    const raw = Object.fromEntries(BUDGET_IMPORT_COLUMNS.map((c) => [c, cell(c)])) as Record<BudgetImportColumn, string>
    if (BUDGET_IMPORT_COLUMNS.every((c) => raw[c] === '')) continue
    cells.push({ row: r, values: raw })
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
  return { rows, errors, cells }
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
    // S6-15 (OQ-105 default): an import that adds to lines that had budget already goes on without DOA, and every AUDITOR
    // sees it in their digest
    // (a line's first row in the file tells what it had before the import; its later rows add to this file's own amount)
    const first = funded.lines.filter((l, i) => funded.lines.findIndex((x) => x.budgetLineId === l.budgetLineId) === i)
    const toppedUp = new Set(first.filter((l) => l.before.available + l.before.reserved + l.before.committed + l.before.actual > 0n).map((l) => l.budgetLineId))
    const auditors = toppedUp.size ? [...new Set((await tx.roleAssignment.findMany({ where: { role: 'AUDITOR', revokedAt: null, member: { status: 'ACTIVE' } }, select: { memberId: true } })).map((r) => r.memberId))] : []
    const notifications = auditors.map((recipientMemberId) => ({
      recipientMemberId,
      templateKey: 'audit.budget_topped_up',
      data: { importId, lines: toppedUp.size },
      urgency: 'DIGEST' as const,
      dedupeKey: `audit.budget_topped_up:${importId}:${recipientMemberId}`,
    }))
    return { ok: true, result: { importId, rows: input.rows.length, linesCreated, totalSatang: total.toString() }, events, notifications }
  },
})

/** sha256 of the file's bytes: the same file again is recognised by it (AC3) */
const fileChecksum = (bytes: ArrayBuffer) => createHash('sha256').update(Buffer.from(bytes)).digest('hex')

const CHECKSUM = /^[0-9a-f]{64}$/

/**
 * Reads the file, checks every row, then imports all of them in one command or reports each wrong row (AC1). The
 * import page passes the checksum of the file the member checked and confirmed (`expectedChecksum`): a different file
 * is refused (RECHECK) and nothing is saved, so the confirmation always covers what is imported.
 */
export async function importBudget(
  ctx: Ctx,
  file: { bytes: ArrayBuffer; fileName: string },
  options: RunOptions & { confirmDuplicate?: boolean; expectedChecksum?: string },
): Promise<Result<BudgetImportOutcome>> {
  const allowed = await forTenant(ctx.organizationId).$transaction((tx) => authorize(tx, ctx, 'budget.import'))
  if (!allowed.ok) return allowed
  const { confirmDuplicate = false, expectedChecksum, ...run } = options
  const checksum = fileChecksum(file.bytes)
  if (expectedChecksum !== undefined && (!CHECKSUM.test(expectedChecksum) || expectedChecksum !== checksum)) {
    return err('VALIDATION_FAILED', 'the file is not the one that was checked; nothing was saved', { field: 'file', reason: 'RECHECK' })
  }
  const { rows, errors } = await parseBudgetImport(file.bytes)
  if (errors.length) return err('VALIDATION_FAILED', 'the file has rows to fix; nothing was saved', { field: 'file', rows: [...errors].sort((a, b) => a.row - b.row) })
  const result = await runCommand(ctx, importBudgetCommand, { fileName: file.fileName, checksum, confirmDuplicate, rows }, run)
  return result.ok ? ok(result.data) : result
}

// ---------- screen support (S3-04 /budgets/import): the template with its guide, the check before importing, history ----------

/** The guide sheet's texts; the codes come from the organization */
export interface BudgetImportGuideTexts {
  readonly sheetName: string
  readonly lines: readonly string[]
  readonly fiscalYearsTitle: string
  readonly departmentsTitle: string
  readonly costCentersTitle: string
  readonly codeHeader: string
  readonly nameHeader: string
  readonly departmentHeader: string
}

/** GET the template for BUDGET_ADMIN (budget.import), with a guide sheet listing the open fiscal years, departments and cost centers */
export async function budgetImportTemplate(ctx: Ctx, labels: Record<BudgetImportColumn, string>, texts: BudgetImportGuideTexts): Promise<Result<Buffer>> {
  const guide = await forTenant(ctx.organizationId).$transaction(async (tx) => {
    const allowed = await authorize(tx, ctx, 'budget.import')
    if (!allowed.ok) return allowed
    const [years, departments, costCenters] = await Promise.all([
      tx.fiscalYear.findMany({ where: { status: 'OPEN' }, select: { code: true }, orderBy: { startsOn: 'asc' } }),
      tx.department.findMany({ where: { active: true }, select: { id: true, code: true, nameTh: true }, orderBy: { code: 'asc' } }),
      tx.costCenter.findMany({ where: { active: true }, select: { code: true, nameTh: true, departmentId: true }, orderBy: { code: 'asc' } }),
    ])
    const departmentCode = new Map(departments.map((d) => [d.id, d.code]))
    return ok<BudgetImportGuide>({
      sheetName: texts.sheetName,
      lines: texts.lines,
      fiscalYears: { title: texts.fiscalYearsTitle, codes: years.map((y) => y.code) },
      departments: { title: texts.departmentsTitle, headers: [texts.codeHeader, texts.nameHeader], rows: departments.map((d) => [d.code, d.nameTh] as const) },
      costCenters: {
        title: texts.costCentersTitle,
        headers: [texts.codeHeader, texts.nameHeader, texts.departmentHeader],
        rows: costCenters.map((c) => [c.code, c.nameTh, departmentCode.get(c.departmentId) ?? ''] as const),
      },
    })
  })
  if (!guide.ok) return guide
  return ok(await buildBudgetImportTemplate(labels, guide.data))
}

export interface NameDto {
  readonly th: string
  readonly en: string | null
}

/**
 * A row that adds to an existing line but gives another name, account code or cost center than the line has: the
 * import adds the amount to the line as it is and changes none of these, so the check says so before anyone confirms
 */
export interface BudgetImportRowWarning {
  readonly field: 'nameTh' | 'accountCode' | 'costCenter'
  readonly reason: 'DIFFERS_FROM_LINE'
  /** What the line has now (null: no account code) */
  readonly current: string | null
}

export interface BudgetImportPreviewRowDto {
  readonly row: number
  /** The cells as typed */
  readonly values: Readonly<Record<BudgetImportColumn, string>>
  /** The amount read from the row, when it is one */
  readonly amount: MoneyDto | null
  readonly errors: ReadonlyArray<{ readonly field: BudgetImportColumn; readonly reason: BudgetImportReason }>
  /** CREATE: a new budget line · ADD: adds to the line with this code in this fiscal year · null: the row is wrong */
  readonly action: 'CREATE' | 'ADD' | null
  /** The planned amount of the line the row adds to, now */
  readonly currentPlanned: MoneyDto | null
  /** ADD rows only: what in the row differs from the line it adds to, and stays as the line has it */
  readonly warnings: readonly BudgetImportRowWarning[]
}

export interface BudgetImportPreviewDto {
  readonly fileName: string
  /** sha256 of the file checked: the import page sends it back, and a different file is refused (RECHECK) */
  readonly checksum: string
  readonly rows: readonly BudgetImportPreviewRowDto[]
  /** Problems of the whole file: unreadable, no header, no rows, too many rows */
  readonly fileErrors: ReadonlyArray<{ readonly row: number; readonly reason: BudgetImportReason }>
  /** No wrong row and no file problem: the import may go ahead */
  readonly ready: boolean
  /** The rows that are right, added up */
  readonly total: MoneyDto
  readonly creates: number
  readonly adds: number
  /** The same file (sha256) was imported before: importing it again adds its amounts again and needs confirming (AC3) */
  readonly duplicate: { readonly importedAt: string; readonly fileName: string; readonly importedBy: NameDto | null } | null
}

/**
 * Checks a file the way the import will, and changes nothing (FR-BUD-001 AC1 AC3, §9.9 nothing irreversible without a
 * confirmation): each filled row with what it will do — make a new line or add to one — or every field to fix, the
 * problems of the whole file, and whether the same file was imported before. The import checks everything again.
 */
export async function previewBudgetImport(ctx: Ctx, file: { bytes: ArrayBuffer; fileName: string }): Promise<Result<BudgetImportPreviewDto>> {
  return forTenant(ctx.organizationId).$transaction(async (tx) => {
    const allowed = await authorize(tx, ctx, 'budget.import')
    if (!allowed.ok) return allowed
    const { rows, errors, cells } = await parseBudgetImport(file.bytes)
    const fileErrors = errors.filter((e) => e.field === 'file').map((e) => ({ row: e.row, reason: e.reason }))
    const organizationErrors = rows.length ? await checkAgainstOrganization(tx, rows) : []
    const rowErrors = [...errors.filter((e) => e.field !== 'file'), ...organizationErrors]
    const lines = rows.length
      ? await tx.budgetLine.findMany({
          where: { code: { in: [...new Set(rows.map((r) => r.code))] } },
          select: { code: true, nameTh: true, accountCode: true, plannedSatang: true, costCenter: { select: { code: true } }, fiscalYear: { select: { code: true } } },
        })
      : []
    const parsed = new Map(rows.map((r) => [r.row, r]))

    const report = cells.map((c): BudgetImportPreviewRowDto => {
      const own = rowErrors.filter((e) => e.row === c.row).map((e) => ({ field: e.field as BudgetImportColumn, reason: e.reason }))
      const row = parsed.get(c.row)
      const line = row ? lines.find((l) => l.code === row.code && l.fiscalYear.code === row.fiscalYear) : undefined
      const right = own.length === 0 && row !== undefined
      const warnings: BudgetImportRowWarning[] =
        right && line
          ? [
              ...(row.nameTh !== line.nameTh ? [{ field: 'nameTh' as const, reason: 'DIFFERS_FROM_LINE' as const, current: line.nameTh }] : []),
              ...((row.accountCode ?? null) !== (line.accountCode ?? null) ? [{ field: 'accountCode' as const, reason: 'DIFFERS_FROM_LINE' as const, current: line.accountCode }] : []),
              ...(row.costCenter !== line.costCenter.code ? [{ field: 'costCenter' as const, reason: 'DIFFERS_FROM_LINE' as const, current: line.costCenter.code }] : []),
            ]
          : []
      return {
        row: c.row,
        values: c.values,
        amount: row ? toMoneyDto(amountToSatang(row.amount)) : null,
        errors: own,
        action: right ? (line ? 'ADD' : 'CREATE') : null,
        currentPlanned: right && line ? toMoneyDto(line.plannedSatang) : null,
        warnings,
      }
    })
    const right = report.filter((r) => r.action !== null)
    const checksum = fileChecksum(file.bytes)
    const previous = await tx.budgetImport.findFirst({
      where: { checksum },
      orderBy: { importedAt: 'desc' },
      select: { importedAt: true, fileName: true, importedBy: { select: { displayNameTh: true, displayNameEn: true } } },
    })
    return ok({
      fileName: file.fileName,
      checksum,
      rows: report,
      fileErrors,
      ready: fileErrors.length === 0 && report.length > 0 && right.length === report.length,
      total: toMoneyDto(right.reduce((sum, r) => sum + amountToSatang(r.amount!.amount), 0n)),
      creates: right.filter((r) => r.action === 'CREATE').length,
      adds: right.filter((r) => r.action === 'ADD').length,
      duplicate: previous
        ? { importedAt: previous.importedAt.toISOString(), fileName: previous.fileName, importedBy: previous.importedBy ? { th: previous.importedBy.displayNameTh, en: previous.importedBy.displayNameEn } : null }
        : null,
    })
  })
}

/** How many past imports the page lists */
export const BUDGET_IMPORT_HISTORY_ROWS = 10

export interface BudgetImportHistoryDto {
  readonly id: string
  readonly fileName: string
  readonly importedAt: string
  readonly rows: number
  readonly total: MoneyDto
  readonly fiscalYearCode: string
  readonly importedBy: NameDto | null
  readonly confirmedDuplicate: boolean
}

/** The latest imports, newest first (budget.import): what came in, when and by whom */
export async function budgetImportHistory(ctx: Ctx): Promise<Result<readonly BudgetImportHistoryDto[]>> {
  return forTenant(ctx.organizationId).$transaction(async (tx) => {
    const allowed = await authorize(tx, ctx, 'budget.import')
    if (!allowed.ok) return allowed
    const imports = await tx.budgetImport.findMany({
      orderBy: { importedAt: 'desc' },
      take: BUDGET_IMPORT_HISTORY_ROWS,
      select: {
        id: true,
        fileName: true,
        importedAt: true,
        rows: true,
        totalSatang: true,
        confirmedDuplicate: true,
        fiscalYear: { select: { code: true } },
        importedBy: { select: { displayNameTh: true, displayNameEn: true } },
      },
    })
    return ok(
      imports.map((i) => ({
        id: i.id,
        fileName: i.fileName,
        importedAt: i.importedAt.toISOString(),
        rows: i.rows,
        total: toMoneyDto(i.totalSatang),
        fiscalYearCode: i.fiscalYear.code,
        importedBy: i.importedBy ? { th: i.importedBy.displayNameTh, en: i.importedBy.displayNameEn } : null,
        confirmedDuplicate: i.confirmedDuplicate,
      })),
    )
  })
}
