import type { SettingsFailure, SettingsOutcome } from './outcome'

// Shapes of the holiday import of /admin/calendar (FR-ADM-003 AC2), shared by the page (server), its actions and the
// import form (client). Two steps: check the file (nothing is saved), then add the dates the check showed once the
// admin confirms them, because an added holiday cannot be removed or renamed afterwards.

export const HOLIDAY_WEEKDAYS = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'] as const
export type HolidayWeekday = (typeof HOLIDAY_WEEKDAYS)[number]

export interface HolidayCheckRowView {
  /** "YYYY-MM-DD" */
  readonly date: string
  readonly nameTh: string
  readonly weekday: HolidayWeekday
}

export interface HolidayCheckView {
  /** Dates the import would add, oldest first */
  readonly add: readonly HolidayCheckRowView[]
  /** Dates the calendar has already, with the name it keeps */
  readonly skip: ReadonlyArray<HolidayCheckRowView & { readonly calendarNameTh: string }>
}

/** Step 1: the filled template goes up as a file (FormData) and comes back checked, or with the rows to fix */
export type CheckHolidaysAction = (formData: FormData) => Promise<{ readonly ok: true; readonly check: HolidayCheckView } | SettingsFailure>
/** Step 2: the dates and names the check showed, added once the admin confirmed */
export type ImportHolidaysAction = (input: { rows: Array<{ date: string; nameTh: string }> }, idempotencyKey: string) => Promise<SettingsOutcome>
