import { createHash } from 'node:crypto'
import ExcelJS from 'exceljs'
import { z } from 'zod'
import { err, ok, type Result } from '@/core/result'
import { latestSlot, parseCron } from '@/core/schedule'
import { taxDateOf } from '@/core/vat'
import { roundHalfUpDiv } from '@/core/money/math'
import { MS_PER_DAY, PERCENT_TENTHS_SCALE } from '@/lib/constants'
import { csv, utf8WithBom } from '@/lib/encoding'
import { newId } from '@/lib/ids'
import { logger } from '@/lib/logger'
import { getEmailProvider } from '@/integrations/email-provider'
import { putObject, readObject } from '@/integrations/storage'
import { authorize, loadPrincipal } from '@/server/authz'
import { makeCtx, systemCtx, type Ctx } from '@/server/context'
import { forTenant, type TenantTx } from '@/server/db/tenant'
import { defineCommand, runCommand, type CommandOutcome, type RunOptions } from '../_pipeline'
import '../exports/file-policy'
import { reportScope, scopeCovers } from './access'
import { computeKpis, type Ratio } from './kpi'

export { reportScope } from './access'

// The report framework (spec §11.3, FR-VIS-002 AC1 AC3): a report has parameters, columns, a scope rule, an Excel or CSV
// export with its sha256 (ExportJob REPORT) and schedules that email the file to members on a cron. Each report reads
// within the caller's report.view scope: the whole organization (FINANCE, PROCUREMENT, EXECUTIVE, AUDITOR) or the
// departments a department head heads; a scheduled file goes only to recipients whose own report.view covers the scope
// it is made for. The seven reports of the proposal wait for OQ-09 (NEW-08); the first report of the framework is the
// KPI view of §11.4 (FR-VIS-003), which BCS defines itself. Reports live here rather than in src/server/queries/reports
// because the KPI re-runs the DOA engine with the organization's policy (§4.10 boundaries).

const DateParam = z.iso.date()
const KpiParams = z.strictObject({ from: DateParam, to: DateParam })
export type KpiParams = z.infer<typeof KpiParams>

export interface Column {
  readonly key: string
  readonly header: { readonly th: string; readonly en: string }
  /** In the file only (a unit, a code for machines): the screen says the same in its own words */
  readonly fileOnly?: boolean
}

/** A parameter as the report screen asks for it: a calendar day (YYYY-MM-DD) for now */
export interface ReportParamField {
  readonly key: string
  readonly kind: 'date'
}

interface ReportDefinition<P> {
  readonly code: string
  readonly params: z.ZodType<P>
  /** The filters of the report screen, in order (FR-VIS-002 AC1 "ตัวกรอง") */
  readonly paramFields: readonly ReportParamField[]
  readonly columns: readonly Column[]
  rows(tx: TenantTx, ctx: Ctx, params: P, departmentIds: readonly string[] | null): Promise<Array<Record<string, string>>>
}

const percentText = (r: Ratio): string => {
  if (r.denominator === null || r.denominator === 0) return ''
  // one decimal, half up, in integers (no floating point)
  const tenths = roundHalfUpDiv(BigInt(r.numerator) * PERCENT_TENTHS_SCALE, BigInt(r.denominator))
  return `${tenths / 10n}.${tenths % 10n}`
}
const MINUTES_PER_HOUR = 60n
/** Business minutes as hours with one decimal, half up ("1.5"), the way the KPI page and the report page show them */
const hoursText = (minutes: number | null) => {
  if (minutes === null) return ''
  const tenths = roundHalfUpDiv(BigInt(minutes) * 10n, MINUTES_PER_HOUR)
  return `${tenths / 10n}.${tenths % 10n}`
}
/** [from, to) of whole Thai days: from 00:00 of `from` to 00:00 after `to` */
export const periodOf = (p: KpiParams) => ({ from: new Date(`${p.from}T00:00:00+07:00`), to: new Date(new Date(`${p.to}T00:00:00+07:00`).getTime() + MS_PER_DAY) })

/**
 * What each KPI measure is, in Thai, as the file says it for the 60-day review (FR-VIS-003 AC3) — the same words as the
 * screens' messages (reports.measures, reports.kinds; a test compares them). The code stays in its own column.
 */
const MEASURE_TH: Readonly<Record<string, string>> = {
  PO_APPROVED_OVER_ACCOUNTING_PURCHASES: 'PO ที่อนุมัติ ÷ เอกสารซื้อในระบบบัญชี',
  DECISIONS_NOT_BY_DOA: 'การอนุมัติที่ผิด DOA',
  DECISIONS_WITH_DOA_REFERENCE: 'การตัดสินที่อ้าง DOA ฉบับและข้อครบ',
  MEDIAN_SUBMIT_TO_FIRST_PO_HOURS: 'มัธยฐานเวลาส่งคำขอถึงอนุมัติ PO แรก',
  MEDIAN_DECISION_HOURS: 'มัธยฐานเวลาตัดสินต่อขั้น',
  TASKS_PAST_DUE: 'ขั้นที่เกินกำหนด (SLA)',
  TASKS_ON_FAILED_BUDGET_CHECK: 'งานอนุมัติของคำขอที่ตรวจงบไม่ผ่าน',
  DECISIONS_ON_LINE_ALL: 'การตัดสินผ่าน LINE หรือ LIFF ทุกชนิดเอกสาร',
}
const KIND_TH: Readonly<Record<string, string>> = {
  PURCHASE_REQUEST: 'คำขอซื้อ',
  PURCHASE_ORDER: 'ใบสั่งซื้อ',
  VARIANCE: 'ผลต่างจากการตรวจรับ',
  DOA_VERSION: 'ฉบับ DOA',
  ORG_AUTHORITY_CHANGE: 'การเปลี่ยนโครงสร้างอำนาจ',
}
const LINE_PREFIX = 'DECISIONS_ON_LINE_'
/** A KPI measure code in Thai; a code without words stays the code */
export function kpiMeasureTh(code: string): string {
  if (MEASURE_TH[code]) return MEASURE_TH[code]
  const kind = code.startsWith(LINE_PREFIX) ? code.slice(LINE_PREFIX.length) : null
  return kind ? `การตัดสินผ่าน LINE หรือ LIFF ของ${KIND_TH[kind] ?? kind}` : code
}
const UNIT_TH = { percent: '%', hours: 'ชั่วโมงทำการ', count: 'รายการ' } as const

const KPI: ReportDefinition<KpiParams> = {
  code: 'KPI',
  params: KpiParams,
  paramFields: [
    { key: 'from', kind: 'date' },
    { key: 'to', kind: 'date' },
  ],
  columns: [
    { key: 'kpi', header: { th: 'ตัวชี้วัด', en: 'KPI' } },
    { key: 'name', header: { th: 'สิ่งที่วัด', en: 'Measure' } },
    { key: 'value', header: { th: 'ค่า', en: 'Value' } },
    { key: 'unit', header: { th: 'หน่วย', en: 'Unit' }, fileOnly: true },
    { key: 'numerator', header: { th: 'ตัวตั้ง', en: 'Numerator' } },
    { key: 'denominator', header: { th: 'ตัวหาร', en: 'Denominator' } },
    { key: 'measure', header: { th: 'รหัส', en: 'Code' }, fileOnly: true },
  ],
  async rows(tx, ctx, params, departmentIds) {
    const k = await computeKpis(tx, ctx.organizationId, { ...periodOf(params), now: ctx.now }, departmentIds)
    const named = (kpi: string, measure: string) => ({ kpi, measure, name: kpiMeasureTh(measure) })
    const ratio = (kpi: string, measure: string, r: Ratio) => ({ ...named(kpi, measure), value: percentText(r), unit: UNIT_TH.percent, numerator: String(r.numerator), denominator: r.denominator === null ? '' : String(r.denominator) })
    const count = (kpi: string, measure: string, n: number) => ({ ...named(kpi, measure), value: String(n), unit: UNIT_TH.count, numerator: '', denominator: '' })
    const time = (kpi: string, measure: string, minutes: number | null) => ({ ...named(kpi, measure), value: hoursText(minutes), unit: UNIT_TH.hours, numerator: '', denominator: '' })
    return [
      ratio('G-1', 'PO_APPROVED_OVER_ACCOUNTING_PURCHASES', k.g1),
      count('G-2', 'DECISIONS_NOT_BY_DOA', k.g2.misrouted),
      ratio('G-2', 'DECISIONS_WITH_DOA_REFERENCE', k.g2.withDoaReference),
      time('G-3', 'MEDIAN_SUBMIT_TO_FIRST_PO_HOURS', k.g3.submitToPoMedianMinutes),
      time('G-3', 'MEDIAN_DECISION_HOURS', k.g3.decisionMedianMinutes),
      ratio('G-3', 'TASKS_PAST_DUE', k.g3.pastDue),
      count('G-4', 'TASKS_ON_FAILED_BUDGET_CHECK', k.g4.tasksOnFailedBudgetCheck),
      ratio('G-5', 'DECISIONS_ON_LINE_ALL', k.g5.total),
      ...Object.entries(k.g5.bySubject).map(([subject, r]) => ratio('G-5', `DECISIONS_ON_LINE_${subject}`, r)),
    ]
  },
}

export const REPORTS: Readonly<Record<string, ReportDefinition<KpiParams>>> = { KPI }

/** Of these members, the ones whose own report.view covers `scope` (null: the whole organization), each counted once */
async function readersAmong(tx: TenantTx, ctx: Ctx, memberIds: readonly string[], scope: readonly string[] | null): Promise<string[]> {
  const readers: string[] = []
  for (const memberId of new Set(memberIds)) {
    const principal = await loadPrincipal(tx, makeCtx({ organizationId: ctx.organizationId, actor: { type: 'USER', memberId }, channel: 'SYSTEM', now: ctx.now }))
    if (scopeCovers(reportScope(principal), scope)) readers.push(memberId)
  }
  return readers
}

export async function runReport(ctx: Ctx, code: string, rawParams: unknown): Promise<Result<{ columns: readonly Column[]; rows: Array<Record<string, string>>; scope: 'ORG' | 'DEPT' }>> {
  const report = REPORTS[code]
  if (!report) return err('NOT_FOUND', 'report not found')
  const params = report.params.safeParse(rawParams)
  if (!params.success) return err('VALIDATION_FAILED', 'invalid report parameters', { field: params.error.issues[0]?.path.join('.') ?? 'params' })
  return forTenant(ctx.organizationId).$transaction(async (tx) => {
    const allowed = await authorize(tx, ctx, 'report.view')
    if (!allowed.ok) return err(allowed.error.code, allowed.error.message, allowed.error.details)
    const scope = reportScope(allowed.data)
    if (scope === 'NONE') return err('FORBIDDEN', 'missing capability report.view', { capability: 'report.view' })
    return ok({ columns: report.columns, rows: await report.rows(tx, ctx, params.data, scope), scope: scope === null ? ('ORG' as const) : ('DEPT' as const) })
  })
}

const MIME = { xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', csv: 'text/csv' } as const

async function reportFile(columns: readonly Column[], rows: ReadonlyArray<Record<string, string>>, format: 'xlsx' | 'csv'): Promise<Uint8Array> {
  const header = columns.map((c) => c.header.th)
  const body = rows.map((r) => columns.map((c) => r[c.key] ?? ''))
  if (format === 'csv') return utf8WithBom(csv([header, ...body]))
  const workbook = new ExcelJS.Workbook()
  const sheet = workbook.addWorksheet('report')
  sheet.addRow(header)
  for (const row of body) sheet.addRow(row)
  return new Uint8Array(await workbook.xlsx.writeBuffer())
}

/** Writes a report file for `requestedById` within `scope` and records it as an ExportJob (BR-EXP-03 like every export) */
async function writeReport(tx: TenantTx, ctx: Ctx, report: ReportDefinition<KpiParams>, params: KpiParams, scope: readonly string[] | null, format: 'xlsx' | 'csv', requestedById: string) {
  const rows = await report.rows(tx, ctx, params, scope)
  const bytes = await reportFile(report.columns, rows, format)
  const checksum = createHash('sha256').update(bytes).digest('hex')
  const exportJobId = newId()
  const fileId = newId()
  const key = `org/${ctx.organizationId}/exports/${exportJobId}.${format}`
  const fileName = `${report.code.toLowerCase()}-${params.from}-${params.to}.${format}`
  await putObject(key, bytes, MIME[format])
  await tx.fileObject.create({ data: { id: fileId, organizationId: ctx.organizationId, storageKey: key, fileName, mimeType: MIME[format], sizeBytes: bytes.length, sha256: checksum, status: 'AVAILABLE', uploadedById: requestedById } })
  await tx.exportJob.create({ data: { id: exportJobId, organizationId: ctx.organizationId, kind: 'REPORT', params: { reportCode: report.code, ...params, format, scope: scope ?? 'ORG' }, status: 'COMPLETED', fileId, rowCount: rows.length, checksum, requestedById, completedAt: ctx.now } })
  await tx.fileLink.create({ data: { organizationId: ctx.organizationId, fileId, subjectType: 'ExportJob', subjectId: exportJobId, kind: 'OTHER' } })
  return { exportJobId, fileId, rowCount: rows.length, checksum, bytes, fileName }
}

const ExportInput = z.strictObject({ reportCode: z.string().min(1), params: z.unknown(), format: z.enum(['xlsx', 'csv']).default('xlsx') })

export const exportReportCommand = defineCommand({
  name: 'report.export',
  capability: 'report.view',
  input: ExportInput,
  async execute(tx, input, ctx): Promise<CommandOutcome<{ exportJobId: string; fileId: string; rowCount: number; checksum: string }>> {
    const allowed = await authorize(tx, ctx, 'report.view')
    if (!allowed.ok) return { ok: false, error: allowed.error }
    const scope = reportScope(allowed.data)
    if (scope === 'NONE' || allowed.data.kind !== 'member') return { ok: false, error: { code: 'FORBIDDEN', message: 'missing capability report.view', details: { capability: 'report.view' } } }
    const report = REPORTS[input.reportCode]
    if (!report) return { ok: false, error: { code: 'NOT_FOUND', message: 'report not found' } }
    const params = report.params.safeParse(input.params)
    if (!params.success) return { ok: false, error: { code: 'VALIDATION_FAILED', message: 'invalid report parameters', details: { field: 'params' } } }
    const file = await writeReport(tx, ctx, report, params.data, scope, input.format, allowed.data.memberId)
    return {
      ok: true,
      result: { exportJobId: file.exportJobId, fileId: file.fileId, rowCount: file.rowCount, checksum: file.checksum },
      events: [{ type: 'export.generated', aggregateType: 'ExportJob', aggregateId: file.exportJobId, data: { kind: 'REPORT', rowCount: file.rowCount, totalSatang: '0', checksum: file.checksum, fileId: file.fileId, invoiceIds: [], excludedInvoiceIds: [], again: false } }],
      notifications: [{ recipientMemberId: allowed.data.memberId, templateKey: 'export.ready', data: { exportJobId: file.exportJobId, fileId: file.fileId, rowCount: file.rowCount, kind: 'REPORT' }, urgency: 'IMMEDIATE', dedupeKey: `export.ready:${file.exportJobId}`, subjectType: 'EXPORT_JOB', subjectId: file.exportJobId }],
    }
  },
})

export function exportReport(ctx: Ctx, input: z.input<typeof ExportInput>, options: RunOptions) {
  return runCommand(ctx, exportReportCommand, input, options)
}

// ---------- schedules (FR-VIS-002 AC1) ----------

const MAX_RECIPIENTS = 50
/** A scheduled report covers the days before its run */
const REPORT_PERIOD_DAYS = 30
const ScheduleInput = z.strictObject({
  reportCode: z.string().min(1),
  /** "TZ=Asia/Bangkok 0 8 * * 1" (core/schedule) */
  cron: z.string().min(1).max(100),
  recipientMemberIds: z.array(z.uuid()).min(1).max(MAX_RECIPIENTS),
  format: z.enum(['xlsx', 'csv']).default('xlsx'),
})

export const createScheduleCommand = defineCommand({
  name: 'report_schedule.create',
  capability: 'report.schedule',
  input: ScheduleInput,
  async execute(tx, input, ctx): Promise<CommandOutcome<{ scheduleId: string }>> {
    const allowed = await authorize(tx, ctx, 'report.schedule')
    if (!allowed.ok) return { ok: false, error: allowed.error }
    if (allowed.data.kind !== 'member') return { ok: false, error: { code: 'FORBIDDEN', message: 'only a member schedules a report' } }
    if (!REPORTS[input.reportCode]) return { ok: false, error: { code: 'VALIDATION_FAILED', message: 'unknown report', details: { field: 'reportCode', reason: 'REPORT' } } }
    if (!parseCron(input.cron)) return { ok: false, error: { code: 'VALIDATION_FAILED', message: 'the schedule is not a cron this system reads', details: { field: 'cron', reason: 'CRON' } } }
    const members = await tx.member.count({ where: { id: { in: input.recipientMemberIds }, status: 'ACTIVE' } })
    if (members !== new Set(input.recipientMemberIds).size) return { ok: false, error: { code: 'VALIDATION_FAILED', message: 'recipients must be active members', details: { field: 'recipientMemberIds', reason: 'RECIPIENT' } } }
    // FR-VIS-002 AC3: the file is made in the creator's scope, so each recipient must be able to read that scope themselves
    const scope = reportScope(allowed.data)
    if (scope === 'NONE') return { ok: false, error: { code: 'FORBIDDEN', message: 'missing capability report.view', details: { capability: 'report.view' } } }
    const readers = await readersAmong(tx, ctx, input.recipientMemberIds, scope)
    const refused = new Set(input.recipientMemberIds).size - readers.length
    if (refused > 0) {
      return { ok: false, error: { code: 'VALIDATION_FAILED', message: 'every recipient must be able to read this report themselves', details: { field: 'recipientMemberIds', reason: 'RECIPIENT_SCOPE', count: refused } } }
    }
    const row = await tx.reportSchedule.create({ data: { organizationId: ctx.organizationId, reportCode: input.reportCode, cron: input.cron, recipients: [...new Set(input.recipientMemberIds)], format: input.format === 'csv' ? 'CSV' : 'XLSX', createdById: allowed.data.memberId, lastRunAt: ctx.now }, select: { id: true } })
    return { ok: true, result: { scheduleId: row.id }, events: [{ type: 'report_schedule.created', aggregateType: 'ReportSchedule', aggregateId: row.id, data: { reportCode: input.reportCode, cron: input.cron, recipientCount: new Set(input.recipientMemberIds).size, format: input.format } }] }
  },
})

export function createReportSchedule(ctx: Ctx, input: z.input<typeof ScheduleInput>, options: RunOptions) {
  return runCommand(ctx, createScheduleCommand, input, options)
}

const ScheduledRunInput = z.strictObject({ scheduleId: z.uuid(), slot: z.iso.datetime() })

/** One due run of a schedule, as the system, within what the schedule's creator may read; the period is the last 30 days */
export const scheduledReportCommand = defineCommand({
  name: 'report_schedule.run',
  capability: 'report.schedule',
  input: ScheduledRunInput,
  async execute(tx, input, ctx): Promise<CommandOutcome<{ exportJobId: string; fileId: string; recipients: string[]; fileName: string; reportCode: string }>> {
    if (ctx.actor.type !== 'SYSTEM') return { ok: false, error: { code: 'FORBIDDEN', message: 'only the schedule job runs a schedule' } }
    const schedule = await tx.reportSchedule.findFirst({ where: { id: input.scheduleId, active: true } })
    if (!schedule) return { ok: false, error: { code: 'NOT_FOUND', message: 'schedule not found' } }
    const report = REPORTS[schedule.reportCode]
    if (!report) return { ok: false, error: { code: 'NOT_FOUND', message: 'report not found' } }
    // the creator's scope, as if they asked for it now (a creator who lost report.view sends nothing)
    const creator = await loadPrincipal(tx, makeCtx({ organizationId: ctx.organizationId, actor: { type: 'USER', memberId: schedule.createdById }, channel: 'SYSTEM', now: ctx.now }))
    const scope = reportScope(creator)
    if (scope === 'NONE') return { ok: false, error: { code: 'FORBIDDEN', message: 'the schedule owner may no longer read this report' } }
    // the 30 Thai days before the slot's day
    const slot = new Date(input.slot)
    const params = { from: taxDateOf(new Date(slot.getTime() - REPORT_PERIOD_DAYS * MS_PER_DAY)), to: taxDateOf(new Date(slot.getTime() - MS_PER_DAY)) }
    const file = await writeReport(tx, ctx, report, params, scope, schedule.format === 'CSV' ? 'csv' : 'xlsx', schedule.createdById)
    await tx.reportSchedule.update({ where: { id: schedule.id }, data: { lastRunAt: slot } })
    // only the recipients who may still read what the file holds (a revoked role or a deactivated member gets nothing)
    const readers = await readersAmong(tx, ctx, schedule.recipients, scope)
    const recipients = await tx.member.findMany({ where: { id: { in: readers }, status: 'ACTIVE' }, select: { email: true } })
    return {
      ok: true,
      result: { exportJobId: file.exportJobId, fileId: file.fileId, recipients: recipients.map((r) => r.email), fileName: file.fileName, reportCode: report.code },
      events: [{ type: 'export.generated', aggregateType: 'ExportJob', aggregateId: file.exportJobId, data: { kind: 'REPORT', rowCount: file.rowCount, totalSatang: '0', checksum: file.checksum, fileId: file.fileId, invoiceIds: [], excludedInvoiceIds: [], again: false } }],
    }
  },
})

/** The job report-schedules: every due schedule runs once per slot, then its file is emailed to its recipients */
export async function runDueReportSchedules(organizationId: string, now: Date): Promise<number> {
  const schedules = await forTenant(organizationId).reportSchedule.findMany({ where: { active: true } })
  let sent = 0
  for (const schedule of schedules) {
    const cron = parseCron(schedule.cron)
    const slot = cron ? latestSlot(cron, now, schedule.lastRunAt) : null
    if (!slot) continue
    const run = await runCommand(systemCtx(organizationId, now, 'report-schedules'), scheduledReportCommand, { scheduleId: schedule.id, slot: slot.toISOString() }, { idempotencyKey: `report-schedule:${schedule.id}:${slot.toISOString()}` })
    if (!run.ok) continue
    const file = await forTenant(organizationId).fileObject.findUniqueOrThrow({ where: { id: run.data.fileId }, select: { storageKey: true, mimeType: true } })
    const content = await readObject(file.storageKey)
    for (const to of run.data.recipients) {
      try {
        await getEmailProvider().send({
          to,
          subject: `รายงาน ${run.data.reportCode} · BCS report ${run.data.reportCode}`,
          text: `แนบรายงาน ${run.data.reportCode} ตามรอบที่ตั้งไว้
The scheduled report ${run.data.reportCode} is attached.`,
          attachments: [{ filename: run.data.fileName, content, contentType: file.mimeType }],
        })
        sent++
      } catch (error) {
        logger.warn({ organizationId, scheduleId: schedule.id, error: error instanceof Error ? error.name : 'unknown' }, 'a scheduled report could not be emailed')
      }
    }
  }
  return sent
}
