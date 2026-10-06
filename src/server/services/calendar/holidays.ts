import { TZDate } from '@date-fns/tz'
import ExcelJS from 'exceljs'
import { z } from 'zod'
import { err, ok, type Result } from '@/core/result'
import { WEEKDAYS, type Weekday } from '@/core/sla'
import { authorize } from '@/server/authz'
import type { Ctx } from '@/server/context'
import { lockRowsForUpdate } from '@/server/db/sql/locks'
import { forTenant } from '@/server/db/tenant'
import { defineCommand, runCommand, type CommandOutcome, type RunOptions } from '../_pipeline'

// Holidays of the business calendar from the Excel template (FR-ADM-003 AC2, BR-SLA-01), in two steps because an added
// holiday cannot be removed or renamed (§10.2 has no event for that) and it moves the due time of every task assigned
// later. Step 1 reads the file: if any row is wrong the answer lists each wrong row and column; otherwise it says which
// dates would be added and which the calendar has already (skipped, their names stay). Nothing is saved. Step 2, after
// the admin confirms what step 1 showed, adds those dates with one holiday.imported event. New holidays count for tasks
// assigned afterwards; a task keeps the due time it was given (AC3).

export const HOLIDAY_COLUMNS = ['date', 'nameTh'] as const
export type HolidayColumn = (typeof HOLIDAY_COLUMNS)[number]
export const HOLIDAY_SHEET = 'Holidays'
export const HOLIDAY_IMPORT_MAX_ROWS = 500
export const HOLIDAY_NAME_MAX_LENGTH = 200
const FIRST_DATA_ROW = 3
/** A year this far beyond the current Christian-era year is a Buddhist-era year (2570 → 2027) */
const BE_DETECT_GAP = 400
const BE_OFFSET = 543
/** Years after the current one a holiday may fall in: a typo such as 2062 for 2026 is reported instead of saved */
const YEARS_AHEAD = 10

/**
 * The years (Christian era) a holiday may be imported for: the current year in the organization's time zone, which the
 * calendar page lists from 1 January, up to YEARS_AHEAD later. Earlier years would be saved but never shown.
 */
export function holidayYears(now: Date, timezone: string): { readonly from: number; readonly to: number } {
  const year = new TZDate(now.getTime(), timezone).getFullYear()
  return { from: year, to: year + YEARS_AHEAD }
}

/** Day of the week of a "YYYY-MM-DD" date */
export const weekdayOf = (date: string): Weekday => WEEKDAYS[new Date(`${date}T00:00:00Z`).getUTCDay()]!

export type HolidayImportReason =
  | 'REQUIRED'
  | 'INVALID_DATE'
  | 'DATE_OUT_OF_RANGE'
  | 'TOO_LONG'
  | 'DUPLICATE_IN_FILE'
  | 'NO_ROWS'
  | 'TOO_MANY_ROWS'
  | 'UNREADABLE'
  | 'MISSING_HEADER'

export interface HolidayImportRowError {
  readonly row: number
  readonly field: HolidayColumn | 'file'
  readonly reason: HolidayImportReason
}

export interface HolidayImportRow {
  readonly row: number
  /** "YYYY-MM-DD" (Christian era) */
  readonly date: string
  readonly nameTh: string
}

/** The template's second sheet, in the words of the screen (passed in by the caller). */
export interface HolidayTemplateGuide {
  readonly sheetName: string
  readonly lines: readonly string[]
}

/** The template: column keys on row 1, the screen's labels on row 2, data from row 3; then the guide sheet. */
export async function buildHolidayImportTemplate(labels: Record<HolidayColumn, string>, guide?: HolidayTemplateGuide): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook()
  const sheet = workbook.addWorksheet(HOLIDAY_SHEET)
  sheet.addRow([...HOLIDAY_COLUMNS])
  sheet.addRow(HOLIDAY_COLUMNS.map((c) => labels[c]))
  sheet.getRow(1).font = { bold: true }
  sheet.views = [{ state: 'frozen', ySplit: 2 }]
  sheet.getColumn(1).width = 18
  sheet.getColumn(2).width = 40
  // Dates typed into the date column stay text, so Excel never turns 13/10/2569 into another date
  sheet.getColumn(1).numFmt = '@'
  if (guide) {
    const help = workbook.addWorksheet(guide.sheetName)
    for (const line of guide.lines) help.addRow([line])
    help.getColumn(1).width = 100
  }
  return Buffer.from(await workbook.xlsx.writeBuffer())
}

/** A formula cell counts as the value it shows */
function shown(value: ExcelJS.CellValue): ExcelJS.CellValue {
  return value && typeof value === 'object' && !(value instanceof Date) && 'result' in value ? ((value.result ?? null) as ExcelJS.CellValue) : value
}

function text(value: ExcelJS.CellValue): string {
  const v = shown(value)
  if (v === null || v === undefined || v instanceof Date) return ''
  if (typeof v === 'object' && 'richText' in v) return v.richText.map((p) => p.text).join('').trim()
  if (typeof v === 'object' && 'text' in v && typeof v.text === 'string') return v.text.trim()
  if (typeof v === 'object') return ''
  return String(v).trim()
}

const isBlank = (value: ExcelJS.CellValue) => !(shown(value) instanceof Date) && text(value) === ''

const pad = (n: number) => String(n).padStart(2, '0')

/** A real calendar date as "YYYY-MM-DD", or null. */
function calendarDate(year: number, month: number, day: number): string | null {
  const d = new Date(Date.UTC(year, month - 1, day))
  return d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === day ? `${year}-${pad(month)}-${pad(day)}` : null
}

/** Whether a "YYYY-MM-DD" date falls in the years a holiday may be imported for */
const inYears = (date: string, years: { readonly from: number; readonly to: number }) => {
  const year = Number(date.slice(0, 4))
  return year >= years.from && year <= years.to
}

/** Year, month and day written in a cell: an Excel date (read at UTC midnight), "YYYY-MM-DD" or "D/M/YYYY". */
function cellParts(value: ExcelJS.CellValue): [number, number, number] | null {
  const raw = shown(value)
  if (raw instanceof Date) return Number.isNaN(raw.getTime()) ? null : [raw.getUTCFullYear(), raw.getUTCMonth() + 1, raw.getUTCDate()]
  const s = text(raw)
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s)
  if (iso) return [Number(iso[1]), Number(iso[2]), Number(iso[3])]
  const dmy = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s)
  return dmy ? [Number(dmy[3]), Number(dmy[2]), Number(dmy[1])] : null
}

/**
 * The date of a cell as "YYYY-MM-DD", or null when it is no date. A year far beyond the current one is a Buddhist-era
 * year (typed as 13/10/2569, or an Excel date that took 2569 as its year) and is turned into the Christian era.
 */
function cellDate(value: ExcelJS.CellValue, currentYear: number): string | null {
  const parts = cellParts(value)
  if (!parts) return null
  const [year, month, day] = parts
  return calendarDate(year > currentYear + BE_DETECT_GAP ? year - BE_OFFSET : year, month, day)
}

/** Reads and checks the file on its own; never throws on bad input. `now` and `timezone` decide the current year. */
export async function parseHolidayImport(bytes: ArrayBuffer, now: Date, timezone: string): Promise<{ rows: HolidayImportRow[]; errors: HolidayImportRowError[] }> {
  const workbook = new ExcelJS.Workbook()
  try {
    await workbook.xlsx.load(bytes)
  } catch {
    return { rows: [], errors: [{ row: 0, field: 'file', reason: 'UNREADABLE' }] }
  }
  const sheet = workbook.getWorksheet(HOLIDAY_SHEET) ?? workbook.worksheets[0]
  if (!sheet) return { rows: [], errors: [{ row: 0, field: 'file', reason: 'UNREADABLE' }] }
  const columns = new Map<HolidayColumn, number>()
  sheet.getRow(1).eachCell((cell, col) => {
    const key = text(cell.value) as HolidayColumn
    if ((HOLIDAY_COLUMNS as readonly string[]).includes(key)) columns.set(key, col)
  })
  if (!columns.has('date') || !columns.has('nameTh')) return { rows: [], errors: [{ row: 1, field: 'file', reason: 'MISSING_HEADER' }] }

  const years = holidayYears(now, timezone)
  const rows: HolidayImportRow[] = []
  const errors: HolidayImportRowError[] = []
  const seen = new Set<string>()
  for (let r = FIRST_DATA_ROW; r <= sheet.rowCount; r++) {
    const dateCell = sheet.getRow(r).getCell(columns.get('date')!).value
    const nameTh = text(sheet.getRow(r).getCell(columns.get('nameTh')!).value)
    const noDate = isBlank(dateCell)
    if (noDate && !nameTh) continue
    const before = errors.length
    const date = noDate ? null : cellDate(dateCell, years.from)
    if (noDate) errors.push({ row: r, field: 'date', reason: 'REQUIRED' })
    else if (date === null) errors.push({ row: r, field: 'date', reason: 'INVALID_DATE' })
    else if (!inYears(date, years)) errors.push({ row: r, field: 'date', reason: 'DATE_OUT_OF_RANGE' })
    else if (seen.has(date)) errors.push({ row: r, field: 'date', reason: 'DUPLICATE_IN_FILE' })
    if (!nameTh) errors.push({ row: r, field: 'nameTh', reason: 'REQUIRED' })
    else if (nameTh.length > HOLIDAY_NAME_MAX_LENGTH) errors.push({ row: r, field: 'nameTh', reason: 'TOO_LONG' })
    if (date) seen.add(date)
    if (errors.length === before && date) rows.push({ row: r, date, nameTh })
  }
  if (rows.length + errors.length === 0) errors.push({ row: 0, field: 'file', reason: 'NO_ROWS' })
  if (rows.length > HOLIDAY_IMPORT_MAX_ROWS) errors.push({ row: 0, field: 'file', reason: 'TOO_MANY_ROWS' })
  return { rows, errors }
}

const dateKey = (d: Date) => d.toISOString().slice(0, 10)

export interface HolidayCheckRow {
  /** "YYYY-MM-DD" (Christian era) */
  readonly date: string
  readonly nameTh: string
  readonly weekday: Weekday
}

export interface HolidaySkippedRow extends HolidayCheckRow {
  /** The name the calendar has for this date, which stays */
  readonly calendarNameTh: string
}

export interface HolidayImportCheck {
  /** Dates the import would add, oldest first */
  readonly add: readonly HolidayCheckRow[]
  /** Dates of the file the calendar has already, oldest first: skipped, their names stay */
  readonly skip: readonly HolidaySkippedRow[]
}

/**
 * Step 1 of the import (FR-ADM-003 AC2, admin.calendar): reads and checks the file and says what step 2 would add and
 * skip. Saves nothing. VALIDATION_FAILED lists every wrong row and column (details.rows).
 */
export async function checkHolidayImport(ctx: Ctx, bytes: ArrayBuffer): Promise<Result<HolidayImportCheck>> {
  const db = forTenant(ctx.organizationId)
  const allowed = await db.$transaction((tx) => authorize(tx, ctx, 'admin.calendar'))
  if (!allowed.ok) return err(allowed.error.code, allowed.error.message, allowed.error.details)
  const org = await db.organization.findUniqueOrThrow({ where: { id: ctx.organizationId }, select: { timezone: true } })
  const { rows, errors } = await parseHolidayImport(bytes, ctx.now, org.timezone)
  if (errors.length) return err('VALIDATION_FAILED', 'the file has rows to fix; nothing was saved', { field: 'file', rows: [...errors].sort((a, b) => a.row - b.row) })
  const known = new Map(
    (await db.holiday.findMany({ where: { date: { in: rows.map((r) => new Date(`${r.date}T00:00:00Z`)) } }, select: { date: true, nameTh: true } })).map((h) => [dateKey(h.date), h.nameTh]),
  )
  const byDate = [...rows].sort((a, b) => a.date.localeCompare(b.date))
  const add: HolidayCheckRow[] = []
  const skip: HolidaySkippedRow[] = []
  for (const r of byDate) {
    const row = { date: r.date, nameTh: r.nameTh, weekday: weekdayOf(r.date) }
    const calendarNameTh = known.get(r.date)
    if (calendarNameTh === undefined) add.push(row)
    else skip.push({ ...row, calendarNameTh })
  }
  return ok({ add, skip })
}

const ImportInput = z.strictObject({
  rows: z
    .array(z.strictObject({ date: z.iso.date(), nameTh: z.string().trim().min(1).max(HOLIDAY_NAME_MAX_LENGTH) }))
    .min(1)
    .max(HOLIDAY_IMPORT_MAX_ROWS),
})

export interface HolidayImportOutcome {
  /** Dates added to the calendar */
  readonly added: number
  /** Dates already in the calendar by then (kept as they were) */
  readonly skipped: number
}

const refuse = (reason: 'INVALID_DATE' | 'DATE_OUT_OF_RANGE' | 'DUPLICATE_IN_FILE', date: string) =>
  ({ ok: false, error: { code: 'VALIDATION_FAILED', message: `holiday ${date} refused: ${reason}`, details: { field: 'rows', reason, date } } }) as const

export const importHolidaysCommand = defineCommand({
  name: 'holiday.import',
  capability: 'admin.calendar',
  input: ImportInput,
  async execute(tx, input, ctx): Promise<CommandOutcome<HolidayImportOutcome>> {
    const allowed = await authorize(tx, ctx, 'admin.calendar')
    if (!allowed.ok) return { ok: false, error: allowed.error }
    // One calendar change at a time, so two imports of the same date cannot both add it
    await lockRowsForUpdate(tx, 'Organization', ctx.organizationId, [ctx.organizationId])
    // The rows come back from the screen after step 1: every rule of the file is checked again
    const org = await tx.organization.findUniqueOrThrow({ where: { id: ctx.organizationId }, select: { timezone: true } })
    const years = holidayYears(ctx.now, org.timezone)
    const seen = new Set<string>()
    for (const r of input.rows) {
      const [y, m, d] = r.date.split('-').map(Number) as [number, number, number]
      if (calendarDate(y, m, d) !== r.date) return refuse('INVALID_DATE', r.date)
      if (!inYears(r.date, years)) return refuse('DATE_OUT_OF_RANGE', r.date)
      if (seen.has(r.date)) return refuse('DUPLICATE_IN_FILE', r.date)
      seen.add(r.date)
    }
    const dates = input.rows.map((r) => new Date(`${r.date}T00:00:00Z`))
    const existing = new Set((await tx.holiday.findMany({ where: { date: { in: dates } }, select: { date: true } })).map((h) => dateKey(h.date)))
    const added = input.rows.filter((r) => !existing.has(r.date))
    if (added.length === 0) {
      return { ok: false, error: { code: 'VALIDATION_FAILED', message: 'every date is in the calendar already', details: { field: 'rows', reason: 'NOTHING_NEW', skipped: input.rows.length } } }
    }
    await tx.holiday.createMany({ data: added.map((r) => ({ organizationId: ctx.organizationId, date: new Date(`${r.date}T00:00:00Z`), nameTh: r.nameTh })) })
    return {
      ok: true,
      result: { added: added.length, skipped: input.rows.length - added.length },
      events: [{ type: 'holiday.imported', aggregateType: 'Organization', aggregateId: ctx.organizationId, data: { dates: added.map((r) => r.date).sort(), via: 'ADMIN' } }],
    }
  },
})

/**
 * Step 2 of the import (FR-ADM-003 AC2): adds the dates step 1 showed and the admin confirmed, in one command. Dates the
 * calendar has by now are skipped; when none is new nothing is written (no event) and the answer says added 0.
 */
export async function importHolidayRows(ctx: Ctx, input: { readonly rows: ReadonlyArray<{ readonly date: string; readonly nameTh: string }> }, options: RunOptions): Promise<Result<HolidayImportOutcome>> {
  const result = await runCommand(ctx, importHolidaysCommand, input, options)
  if (!result.ok && result.error.details?.reason === 'NOTHING_NEW') return ok({ added: 0, skipped: Number(result.error.details.skipped ?? 0) })
  return result
}

/** The Excel template of the holiday import, for admins only like the rest of /admin/calendar. */
export async function holidayImportTemplate(ctx: Ctx, labels: Record<HolidayColumn, string>, guide?: HolidayTemplateGuide): Promise<Result<Buffer>> {
  const allowed = await forTenant(ctx.organizationId).$transaction((tx) => authorize(tx, ctx, 'admin.calendar'))
  if (!allowed.ok) return err(allowed.error.code, allowed.error.message, allowed.error.details)
  return ok(await buildHolidayImportTemplate(labels, guide))
}
