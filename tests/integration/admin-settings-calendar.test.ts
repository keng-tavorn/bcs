import { randomUUID } from 'node:crypto'
import ExcelJS from 'exceljs'
import { beforeAll, describe, expect, it } from 'vitest'
import { makeCtx, type Ctx } from '@/server/context'
import { prisma } from '@/server/db/client'
import { checkHolidayImport, getCalendarAdminView, holidayImportTemplate, importHolidayRows, saveBusinessHours } from '@/server/services/calendar'
import { createDraft, submitRequest } from '../support/requests'
import { createDoaOrg, type DoaOrg } from '../support/doa-org'

// S2-13 · FR-ADM-003 (BR-SLA-01..03): ORG_ADMIN sets the work days and hours (saved through organization.save_settings)
// and imports the year's holidays from Excel in two steps (check the file, then add what the check showed once the admin
// confirmed it); a task gets its due time when it is assigned, so a changed calendar counts for tasks assigned
// afterwards while tasks already assigned keep theirs.

// Monday 5 Oct 2026 10:00 Thai time
const NOW = new Date('2026-10-05T03:00:00Z')
const key = () => ({ idempotencyKey: randomUUID(), sender: null })

let org: DoaOrg
let admin: Ctx
beforeAll(async () => {
  org = await createDoaOrg()
  await prisma.roleAssignment.create({ data: { organizationId: org.organizationId, memberId: org.member.admin!, role: 'ORG_ADMIN', grantedAt: NOW } })
  admin = makeCtx({ organizationId: org.organizationId, actor: { type: 'USER', memberId: org.member.admin! }, channel: 'WEB', now: NOW })
})

const LABELS = { date: 'วันที่', nameTh: 'ชื่อวันหยุด' }

/** A filled copy of the template: keys on row 1, labels on row 2, data from row 3 */
async function holidayFile(rows: Array<[ExcelJS.CellValue, ExcelJS.CellValue]>): Promise<ArrayBuffer> {
  const template = await holidayImportTemplate(admin, LABELS)
  if (!template.ok) throw new Error('template refused')
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.load(new Uint8Array(template.data).buffer as ArrayBuffer)
  const sheet = workbook.getWorksheet('Holidays')!
  for (const row of rows) {
    const added = sheet.addRow(row)
    // A date pasted from another sheet keeps its date format, so Excel stores a date and not text
    if (row[0] instanceof Date) added.getCell(1).numFmt = 'd/m/yyyy'
  }
  const buffer = await workbook.xlsx.writeBuffer()
  return new Uint8Array(buffer as ArrayBuffer).buffer as ArrayBuffer
}

/** The rows the screen sends back after the check: the dates to add and the dates to skip, as the file had them */
const checkedRows = (check: { add: ReadonlyArray<{ date: string; nameTh: string }>; skip: ReadonlyArray<{ date: string; nameTh: string }> }) =>
  [...check.add, ...check.skip].map(({ date, nameTh }) => ({ date, nameTh }))

/** What the screen does: check the file, then add what the check showed (the admin ticked the confirmation) */
async function importFile(ctx: Ctx, file: ArrayBuffer) {
  const checked = await checkHolidayImport(ctx, file)
  if (!checked.ok) return checked
  return importHolidayRows(ctx, { rows: checkedRows(checked.data) }, key())
}

const storedCalendar = async () => ((await prisma.organization.findUniqueOrThrow({ where: { id: org.organizationId } })).settings as { businessCalendar: unknown }).businessCalendar
const holidayDates = async () => (await prisma.holiday.findMany({ where: { organizationId: org.organizationId }, orderBy: { date: 'asc' } })).map((h) => h.date.toISOString().slice(0, 10))
const importEvents = () => prisma.event.count({ where: { organizationId: org.organizationId, type: 'holiday.imported' } })

describe('[FR-ADM-003/AC1] the admin sets the work days and hours; the defaults follow A-07', () => {
  it('shows Monday to Friday 08:30–17:30 in Thai time, then saves new days and hours with an event', async () => {
    const view = await getCalendarAdminView(admin)
    expect(view).toMatchObject({
      ok: true,
      data: { hours: { workdays: ['MON', 'TUE', 'WED', 'THU', 'FRI'], start: '08:30', end: '17:30', timezone: 'Asia/Bangkok' }, fromYear: 2026, importYears: { from: 2026, to: 2036 } },
    })
    if (!view.ok) return
    // This year's holidays of the fixture (13 and 23 Oct), oldest first
    expect(view.data.holidays.map((h) => [h.date, h.weekday])).toEqual([
      ['2026-10-13', 'TUE'],
      ['2026-10-23', 'FRI'],
    ])

    // Days arrive in any order and twice; they are stored once each, Monday first
    const saved = await saveBusinessHours(admin, { workdays: ['SAT', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'MON'], start: '08:00', end: '17:00' }, key())
    expect(saved).toMatchObject({ ok: true })
    expect(await storedCalendar()).toEqual({ workdays: ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'], start: '08:00', end: '17:00' })
    const events = await prisma.event.findMany({ where: { organizationId: org.organizationId, type: 'organization.settings_updated' } })
    expect(events.map((e) => [e.data, e.actorMemberId])).toEqual([[{ section: 'businessCalendar' }, org.member.admin]])
    // Back to the defaults for the other tests of this file
    expect(await saveBusinessHours(admin, { workdays: ['MON', 'TUE', 'WED', 'THU', 'FRI'], start: '08:30', end: '17:30' }, key())).toMatchObject({ ok: true })
  })

  it('refuses hours that end before they start, a day that is not a weekday, and no work day at all', async () => {
    const before = await storedCalendar()
    expect(await saveBusinessHours(admin, { workdays: ['MON'], start: '17:30', end: '08:30' }, key())).toMatchObject({
      ok: false,
      error: { code: 'VALIDATION_FAILED', details: { field: 'settings.businessCalendar.end' } },
    })
    expect(await saveBusinessHours(admin, { workdays: [], start: '08:30', end: '17:30' }, key())).toMatchObject({
      ok: false,
      error: { code: 'VALIDATION_FAILED', details: { field: 'settings.businessCalendar.workdays' } },
    })
    expect(await saveBusinessHours(admin, { workdays: ['MON'], start: '8:30', end: '17:30' }, key())).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED' } })
    expect(await saveBusinessHours(admin, { workdays: ['HOLIDAY' as 'MON'], start: '08:30', end: '17:30' }, key())).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED' } })
    expect(await storedCalendar()).toEqual(before)
  })

  it('a member without admin.calendar can neither read nor save the calendar (deny)', async () => {
    const member = org.ctxOf('req_con', NOW)
    expect(await getCalendarAdminView(member)).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    const before = await storedCalendar()
    expect(await saveBusinessHours(member, { workdays: ['MON'], start: '08:00', end: '12:00' }, key())).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    expect(await storedCalendar()).toEqual(before)
  })
})

describe('[FR-ADM-003/AC2] the year’s holidays come from the Excel template, checked first and added once confirmed', () => {
  it('lists every wrong row and column and saves nothing until the file is right', async () => {
    const before = await holidayDates()
    const file = await holidayFile([
      ['2027-04-13', 'วันสงกรานต์'],
      ['31/02/2570', 'วันที่ไม่มีจริง'],
      ['', 'ไม่มีวันที่'],
      ['2027-04-14', ''],
      ['2027-04-13', 'ซ้ำในไฟล์'],
      ['2099-01-01', 'ไกลเกินไป'],
      // Last year: the page lists holidays from 1 January of this year, so it would be saved but never shown
      ['31/12/2568', 'ปีที่แล้ว'],
    ])
    const result = await checkHolidayImport(admin, file)
    expect(result).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED', details: { field: 'file' } } })
    if (result.ok) return
    expect(result.error.details?.rows).toEqual([
      { row: 4, field: 'date', reason: 'INVALID_DATE' },
      { row: 5, field: 'date', reason: 'REQUIRED' },
      { row: 6, field: 'nameTh', reason: 'REQUIRED' },
      { row: 7, field: 'date', reason: 'DUPLICATE_IN_FILE' },
      { row: 8, field: 'date', reason: 'DATE_OUT_OF_RANGE' },
      { row: 9, field: 'date', reason: 'DATE_OUT_OF_RANGE' },
    ])
    expect(await holidayDates()).toEqual(before)
    expect(await importEvents()).toBe(0)
  })

  it('says what it would add and skip without saving, then adds the confirmed dates with one holiday.imported event', async () => {
    const before = await holidayDates()
    const file = await holidayFile([
      ['2027-04-13', 'วันสงกรานต์'],
      ['14/04/2570', 'วันสงกรานต์'],
      [new Date(Date.UTC(2027, 3, 15)), 'วันสงกรานต์'],
      ['2026-10-13', 'วันนวมินทรมหาราช (มีแล้ว)'],
    ])
    // Step 1 (Christian or Buddhist era, text or Excel dates): the dates to add and the date the calendar has, oldest first
    const checked = await checkHolidayImport(admin, file)
    expect(checked).toEqual({
      ok: true,
      data: {
        add: [
          { date: '2027-04-13', nameTh: 'วันสงกรานต์', weekday: 'TUE' },
          { date: '2027-04-14', nameTh: 'วันสงกรานต์', weekday: 'WED' },
          { date: '2027-04-15', nameTh: 'วันสงกรานต์', weekday: 'THU' },
        ],
        skip: [{ date: '2026-10-13', nameTh: 'วันนวมินทรมหาราช (มีแล้ว)', weekday: 'TUE', calendarNameTh: 'วันหยุด' }],
      },
    })
    if (!checked.ok) return
    // Checking saves nothing
    expect(await holidayDates()).toEqual(before)
    expect(await importEvents()).toBe(0)

    // Step 2: the rows the check showed; the date the calendar has is skipped again
    const rows = checkedRows(checked.data)
    expect(await importHolidayRows(admin, { rows }, key())).toEqual({ ok: true, data: { added: 3, skipped: 1 } })
    expect(await holidayDates()).toEqual(['2026-10-13', '2026-10-23', '2027-04-13', '2027-04-14', '2027-04-15'])
    // The date it had keeps its name
    expect((await prisma.holiday.findFirstOrThrow({ where: { organizationId: org.organizationId, date: new Date('2026-10-13T00:00:00Z') } })).nameTh).toBe('วันหยุด')
    const events = await prisma.event.findMany({ where: { organizationId: org.organizationId, type: 'holiday.imported' } })
    expect(events.map((e) => [e.aggregateType, e.aggregateId, e.data, e.actorMemberId])).toEqual([
      ['Organization', org.organizationId, { dates: ['2027-04-13', '2027-04-14', '2027-04-15'], via: 'ADMIN' }, org.member.admin],
    ])

    // The same file again has nothing to add; the same rows again (another tab) add nothing and write no event
    expect(await checkHolidayImport(admin, file)).toMatchObject({ ok: true, data: { add: [], skip: [{ date: '2026-10-13' }, { date: '2027-04-13' }, { date: '2027-04-14' }, { date: '2027-04-15' }] } })
    expect(await importHolidayRows(admin, { rows }, key())).toEqual({ ok: true, data: { added: 0, skipped: 4 } })
    expect(await importEvents()).toBe(1)
  })

  it('checks the confirmed rows again when they are added', async () => {
    const before = await holidayDates()
    const add = (rows: Array<Record<string, unknown>>) => importHolidayRows(admin, { rows } as never, key())
    expect(await add([{ date: '2027-02-30', nameTh: 'ไม่มีจริง' }])).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED' } })
    expect(await add([{ date: '2025-12-31', nameTh: 'ปีที่แล้ว' }])).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED', details: { reason: 'DATE_OUT_OF_RANGE', date: '2025-12-31' } } })
    expect(
      await add([
        { date: '2027-05-04', nameTh: 'วันฉัตรมงคล' },
        { date: '2027-05-04', nameTh: 'ซ้ำ' },
      ]),
    ).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED', details: { reason: 'DUPLICATE_IN_FILE', date: '2027-05-04' } } })
    expect(await add([{ date: '2027-05-04', nameTh: '   ' }])).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED' } })
    expect(await add([{ date: '2027-05-04', nameTh: 'วันฉัตรมงคล', row: 3 }])).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED' } })
    expect(await add([])).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED' } })
    expect(await holidayDates()).toEqual(before)
  })

  it('refuses a file that is not the template or has no rows', async () => {
    expect(await checkHolidayImport(admin, new TextEncoder().encode('not excel').buffer as ArrayBuffer)).toMatchObject({
      ok: false,
      error: { details: { rows: [{ row: 0, field: 'file', reason: 'UNREADABLE' }] } },
    })
    const empty = await holidayFile([])
    expect(await checkHolidayImport(admin, empty)).toMatchObject({ ok: false, error: { details: { rows: [{ row: 0, field: 'file', reason: 'NO_ROWS' }] } } })
    const workbook = new ExcelJS.Workbook()
    workbook.addWorksheet('Holidays').addRow(['วันที่', 'ชื่อ'])
    const noHeader = new Uint8Array((await workbook.xlsx.writeBuffer()) as ArrayBuffer).buffer as ArrayBuffer
    expect(await checkHolidayImport(admin, noHeader)).toMatchObject({ ok: false, error: { details: { rows: [{ row: 1, field: 'file', reason: 'MISSING_HEADER' }] } } })
  })

  it('only an organization admin may download the template, check a file or add holidays (deny)', async () => {
    const member = org.ctxOf('dm_con', NOW)
    expect(await holidayImportTemplate(member, LABELS)).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    const [before, eventsBefore] = [await holidayDates(), await importEvents()]
    expect(await checkHolidayImport(member, await holidayFile([['2027-05-04', 'วันฉัตรมงคล']]))).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    expect(await importHolidayRows(member, { rows: [{ date: '2027-05-04', nameTh: 'วันฉัตรมงคล' }] }, key())).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    expect(await holidayDates()).toEqual(before)
    expect(await importEvents()).toBe(eventsBefore)
  })
})

describe('[FR-ADM-003/AC3] a changed calendar counts for tasks assigned afterwards; assigned tasks keep their due time', () => {
  async function submit(requester: string, grossBaht: string) {
    const ctx = org.ctxOf(requester, NOW)
    const draft = await createDraft(ctx, { requestTypeCode: 'BUY_GOODS', title: 'วัสดุสิ้นเปลือง', priceIncludesVat: true, lines: [{ description: 'วัสดุ', quantity: '1', uom: 'งาน', unitPrice: grossBaht }] }, key())
    if (!draft.ok) throw new Error(`draft failed: ${draft.error.code}`)
    const sent = await submitRequest(ctx, { requestId: draft.data.requestId }, key())
    if (!sent.ok) throw new Error(`submit failed: ${sent.error.code}`)
    return prisma.approvalTask.findFirstOrThrow({ where: { step: { route: { subjectType: 'REQUEST', subjectId: draft.data.requestId } } } })
  }

  it('keeps the first task due on Tuesday 09:00 and gives the next one the new hours and holiday', async () => {
    // Monday 10:00 + 8 business hours of 08:30–17:30 = Tuesday 09:00 (PR-01, DM of CON)
    const first = await submit('req_con', '10000.00')
    expect(first).toMatchObject({ assigneeMemberId: org.member.dm_con, dueAt: new Date('2026-10-06T02:00:00Z') })

    // Mornings only, Saturday too, and Tuesday 6 Oct becomes a holiday
    expect(await saveBusinessHours(admin, { workdays: ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'], start: '08:00', end: '12:00' }, key())).toMatchObject({ ok: true })
    expect(await importFile(admin, await holidayFile([['2026-10-06', 'วันหยุดพิเศษ']]))).toEqual({ ok: true, data: { added: 1, skipped: 0 } })

    const second = await submit('req_con', '12000.00')
    // Monday 10:00–12:00 (2 h) · Tuesday holiday · Wednesday 08:00–12:00 (4 h) · Thursday 08:00–10:00 (2 h)
    expect(second.dueAt).toEqual(new Date('2026-10-08T03:00:00Z'))
    expect((await prisma.approvalTask.findUniqueOrThrow({ where: { id: first.id } })).dueAt).toEqual(new Date('2026-10-06T02:00:00Z'))
  })
})
