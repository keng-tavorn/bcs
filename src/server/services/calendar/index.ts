import { z } from 'zod'
import { err, ok, type Result } from '@/core/result'
import { WEEKDAYS, type Weekday } from '@/core/sla'
import { authorize } from '@/server/authz'
import type { Ctx } from '@/server/context'
import { forTenant } from '@/server/db/tenant'
import { listHolidays, readBusinessHours, type BusinessHoursDto, type HolidayDto } from '@/server/queries/settings'
import type { RunOptions } from '../_pipeline'
import { saveOrgSettings } from '../organization/settings'
import { holidayYears, weekdayOf } from './holidays'

// The business calendar page (FR-ADM-003, BR-SLA-01): work days and hours live in settings.businessCalendar and are
// saved through organization.save_settings (admin.calendar); holidays come from the Excel import (./holidays), checked
// first and added once the admin confirms. A task gets its due time when it is assigned (BR-SLA-02), so a change counts
// for tasks assigned afterwards and a task already assigned keeps its due time (AC3).

export {
  HOLIDAY_COLUMNS,
  HOLIDAY_IMPORT_MAX_ROWS,
  checkHolidayImport,
  holidayImportTemplate,
  importHolidayRows,
  type HolidayCheckRow,
  type HolidayColumn,
  type HolidayImportCheck,
  type HolidayImportOutcome,
  type HolidayImportReason,
  type HolidayImportRowError,
  type HolidaySkippedRow,
} from './holidays'

/** Monday first, as Thai calendars and the settings write them */
export const WEEKDAY_ORDER: readonly Weekday[] = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN']

export interface CalendarHolidayDto extends HolidayDto {
  readonly weekday: Weekday
}

export interface CalendarAdminView {
  readonly hours: BusinessHoursDto
  /** Holidays from the first day of the current year in the organization's time zone, oldest first */
  readonly holidays: readonly CalendarHolidayDto[]
  /** The current year (Christian era) in the organization's time zone */
  readonly fromYear: number
  /** The years (Christian era) a holiday may be imported for: this year, which the list starts with, and later */
  readonly importYears: { readonly from: number; readonly to: number }
}

async function allowCalendar(ctx: Ctx): Promise<Result<true>> {
  const allowed = await forTenant(ctx.organizationId).$transaction((tx) => authorize(tx, ctx, 'admin.calendar'))
  return allowed.ok ? ok(true) : err(allowed.error.code, allowed.error.message, allowed.error.details)
}

/** The calendar page (admin.calendar): work days and hours, and the holidays of this year and later. */
export async function getCalendarAdminView(ctx: Ctx): Promise<Result<CalendarAdminView>> {
  const allowed = await allowCalendar(ctx)
  if (!allowed.ok) return allowed
  const hours = await readBusinessHours(ctx)
  const importYears = holidayYears(ctx.now, hours.timezone)
  const holidays = (await listHolidays(ctx, `${importYears.from}-01-01`)).map((h) => ({ ...h, weekday: weekdayOf(h.date) }))
  return ok({ hours, holidays, fromYear: importYears.from, importYears })
}

const HoursInput = z.strictObject({ workdays: z.array(z.enum(WEEKDAYS)), start: z.string(), end: z.string() })

/**
 * FR-ADM-003 AC1: saves the work days and hours. Days are written once each, Monday first; the times and the rest are
 * checked by OrgSettingsSchema inside organization.save_settings (VALIDATION_FAILED names the field).
 */
export async function saveBusinessHours(ctx: Ctx, input: { readonly workdays: readonly string[]; readonly start: string; readonly end: string }, options: RunOptions) {
  const parsed = HoursInput.safeParse(input)
  if (!parsed.success) return err('VALIDATION_FAILED', 'invalid business hours', { field: `settings.businessCalendar.${parsed.error.issues[0]?.path.join('.') ?? ''}` })
  const workdays = WEEKDAY_ORDER.filter((d) => parsed.data.workdays.includes(d))
  return saveOrgSettings(ctx, { section: 'businessCalendar', value: { workdays, start: parsed.data.start, end: parsed.data.end } }, options)
}
