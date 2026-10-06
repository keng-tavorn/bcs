import { z } from 'zod'
import { err, ok, type Result } from '@/core/result'
import { authorize, scopesFor } from '@/server/authz'
import { PERMISSIONS, type StoredRole } from '@/server/authz/permissions'
import type { Ctx } from '@/server/context'
import { forTenant, type TenantTx } from '@/server/db/tenant'
import type { RunOptions } from '../_pipeline'
import { REPORTS, createReportSchedule, periodOf, reportScope, type Column, type KpiParams, type ReportParamField } from './index'
import { collectKpis, isMobileChannel, kpiDocumentKind, type KpiDecisionItem, type KpiResult, type KpiTaskItem } from './kpi'

// What the report and KPI screens read (spec §11.3, §11.4, FR-VIS-002 AC1 AC3, FR-VIS-003 AC2): the reports the
// framework offers with their filters and columns, the schedules, the KPI page (organization-wide figures for
// executives: report.view with the ORG scope), and the documents behind every KPI figure — §9.9 asks that every number
// on a dashboard opens the list it counts. Nothing here changes state; exports and schedules stay in ./index.

const DAY = z.iso.date()
const KpiPeriod = z.strictObject({ from: DAY, to: DAY }).refine((p) => p.from <= p.to, { message: 'the period ends before it starts', path: ['to'] })

// ---------- the catalogue (FR-VIS-002 AC1) ----------

/** How often a schedule runs, as the screen offers it; the cron is written in the organization's time zone */
export const SCHEDULE_CADENCES = { WEEKLY: '0 8 * * 1', MONTHLY: '0 8 1 * *' } as const
export type ScheduleCadence = keyof typeof SCHEDULE_CADENCES

export function cadenceCron(cadence: ScheduleCadence, timezone: string): string {
  return `TZ=${timezone} ${SCHEDULE_CADENCES[cadence]}`
}

/** The cadence a schedule's cron is, or null when it was written some other way */
export function cadenceOf(cron: string): ScheduleCadence | null {
  const body = cron.replace(/^TZ=\S+\s+/, '').trim()
  return (Object.keys(SCHEDULE_CADENCES) as ScheduleCadence[]).find((c) => SCHEDULE_CADENCES[c] === body) ?? null
}

export interface ReportScheduleDto {
  readonly id: string
  readonly reportCode: string
  readonly cron: string
  readonly cadence: ScheduleCadence | null
  readonly format: 'XLSX' | 'CSV'
  readonly recipientCount: number
  readonly createdBy: { readonly nameTh: string; readonly nameEn: string | null }
  readonly createdAt: string
  /** The last slot sent (the slot it was created in, before the first) */
  readonly lastRunAt: string | null
}

export interface ReportCatalogDto {
  /** What every report reads for this viewer: the organization, or the departments they head (AC3) */
  readonly scope: 'ORG' | 'DEPT'
  readonly reports: ReadonlyArray<{ readonly code: string; readonly params: readonly ReportParamField[]; readonly columns: readonly Column[] }>
  /** report.schedule (FINANCE, EXECUTIVE) */
  readonly canSchedule: boolean
  readonly timezone: string
  readonly schedules: readonly ReportScheduleDto[]
  /**
   * Whom a schedule may send to on this screen: members who may read the whole organization's reports themselves, so
   * a scheduled file never reaches someone the report would refuse
   */
  readonly recipients: ReadonlyArray<{ readonly id: string; readonly nameTh: string; readonly nameEn: string | null }>
}

/** The roles whose report.view covers the whole organization (§2.4), read from the permission table */
const ORG_REPORT_ROLES: readonly StoredRole[] = PERMISSIONS['report.view'].flatMap((g) => (g.scope === 'ORG' && g.grantee.kind === 'ROLE' ? [g.grantee.role] : []))

export async function reportCatalog(ctx: Ctx): Promise<Result<ReportCatalogDto>> {
  return forTenant(ctx.organizationId).$transaction(async (tx) => {
    const allowed = await authorize(tx, ctx, 'report.view')
    if (!allowed.ok) return err(allowed.error.code, allowed.error.message, allowed.error.details)
    const scope = reportScope(allowed.data)
    if (scope === 'NONE' || allowed.data.kind !== 'member') return err('FORBIDDEN', 'missing capability report.view', { capability: 'report.view' })
    const canSchedule = scopesFor(allowed.data, 'report.schedule').size > 0
    const org = await tx.organization.findUniqueOrThrow({ where: { id: ctx.organizationId }, select: { timezone: true } })
    const schedules = canSchedule
      ? await tx.reportSchedule.findMany({ where: { active: true }, orderBy: { createdAt: 'desc' }, include: { createdBy: { select: { displayNameTh: true, displayNameEn: true } } } })
      : []
    const recipients = canSchedule
      ? await tx.member.findMany({
          where: { status: 'ACTIVE', roleAssignments: { some: { role: { in: [...ORG_REPORT_ROLES] }, revokedAt: null } } },
          select: { id: true, displayNameTh: true, displayNameEn: true },
          orderBy: { displayNameTh: 'asc' },
        })
      : []
    return ok({
      scope: scope === null ? ('ORG' as const) : ('DEPT' as const),
      reports: Object.values(REPORTS).map((r) => ({ code: r.code, params: r.paramFields, columns: r.columns })),
      canSchedule,
      timezone: org.timezone,
      schedules: schedules.map((s) => ({
        id: s.id,
        reportCode: s.reportCode,
        cron: s.cron,
        cadence: cadenceOf(s.cron),
        format: s.format,
        recipientCount: s.recipients.length,
        createdBy: { nameTh: s.createdBy.displayNameTh, nameEn: s.createdBy.displayNameEn },
        createdAt: s.createdAt.toISOString(),
        lastRunAt: s.lastRunAt?.toISOString() ?? null,
      })),
      recipients: recipients.map((m) => ({ id: m.id, nameTh: m.displayNameTh, nameEn: m.displayNameEn })),
    })
  })
}

const ScheduleScreenInput = z.strictObject({
  reportCode: z.string().min(1).max(40),
  cadence: z.enum(Object.keys(SCHEDULE_CADENCES) as [ScheduleCadence, ...ScheduleCadence[]]),
  format: z.enum(['xlsx', 'csv']),
  recipientMemberIds: z.array(z.uuid()).min(1).max(50),
})

/**
 * The schedule form of /reports: a cadence the screen offers, written as a cron in the organization's time zone, then
 * createReportSchedule — which checks report.schedule, the report, the cron and the recipients and records the event.
 */
export async function scheduleReport(ctx: Ctx, input: unknown, options: RunOptions): Promise<Result<{ scheduleId: string }>> {
  const parsed = ScheduleScreenInput.safeParse(input)
  if (!parsed.success) return err('VALIDATION_FAILED', 'invalid schedule', { field: parsed.error.issues[0]?.path[0]?.toString() ?? 'schedule' })
  const org = await forTenant(ctx.organizationId).organization.findUniqueOrThrow({ where: { id: ctx.organizationId }, select: { timezone: true } })
  const { reportCode, cadence, format, recipientMemberIds } = parsed.data
  return createReportSchedule(ctx, { reportCode, cron: cadenceCron(cadence, org.timezone), format, recipientMemberIds }, options)
}

// ---------- the Phase 0 baseline (FR-VIS-003 AC2) ----------

/** A measure of the KPI page; a list of documents stands behind each (kpiDetail) */
export const KPI_MEASURES = ['g1', 'g2a', 'g2b', 'g3a', 'g3b', 'g3c', 'g4', 'g5'] as const
export type KpiMeasure = (typeof KPI_MEASURES)[number]

export type KpiBaselineValue = { readonly kind: 'ratio'; readonly numerator: number; readonly denominator: number } | { readonly kind: 'minutes'; readonly minutes: number } | { readonly kind: 'count'; readonly count: number }

export interface KpiBaseline {
  /** The day the baseline was measured (P0-09) */
  readonly measuredOn: string
  readonly values: Partial<Readonly<Record<KpiMeasure, KpiBaselineValue>>>
  /** G-5 of one kind of document (PURCHASE_REQUEST …), when it was measured on its own */
  readonly g5ByKind?: Partial<Readonly<Record<string, KpiBaselineValue>>>
}

/**
 * The KPI baseline people measure in Phase 0 (P0-09). The single place the system reads it from: nothing records a
 * baseline in the system yet — the spec names no place for it, and where it is kept and who records it wait for the
 * user (NEW-36) — so every organization has none, and the KPI page says so rather than show an invented one. The values
 * belong in the organization's own data (never in code: they are one customer's numbers); once NEW-36 settles where,
 * only this function changes, and the page shows each one as "{value} (วัดเมื่อ {date})" (kpi/_present.ts).
 */
export async function kpiBaseline(_tx: TenantTx, _organizationId: string): Promise<KpiBaseline | null> {
  return null
}

// ---------- the KPI page (FR-VIS-003 AC2) ----------

export interface KpiViewDto {
  readonly period: { readonly from: string; readonly to: string }
  readonly kpi: KpiResult
  readonly baseline: KpiBaseline | null
  readonly asOf: string
}

/** report.view over the whole organization: the KPI figures are the organization's (G-1 to G-5); a head reads /reports */
async function orgReader(tx: TenantTx, ctx: Ctx) {
  const allowed = await authorize(tx, ctx, 'report.view')
  if (!allowed.ok) return allowed
  if (reportScope(allowed.data) !== null) return err('FORBIDDEN', 'the KPI page reads the whole organization', { capability: 'report.view', reason: 'ORG_SCOPE' })
  return allowed
}

export async function kpiView(ctx: Ctx, params: KpiParams): Promise<Result<KpiViewDto>> {
  const period = KpiPeriod.safeParse(params)
  if (!period.success) return err('VALIDATION_FAILED', 'invalid period', { field: period.error.issues[0]?.path.join('.') || 'from', reason: 'PERIOD' })
  return forTenant(ctx.organizationId).$transaction(async (tx) => {
    const allowed = await orgReader(tx, ctx)
    if (!allowed.ok) return err(allowed.error.code, allowed.error.message, allowed.error.details)
    const { result } = await collectKpis(tx, ctx.organizationId, { ...periodOf(period.data), now: ctx.now }, null)
    return ok({ period: period.data, kpi: result, baseline: await kpiBaseline(tx, ctx.organizationId), asOf: ctx.now.toISOString() })
  })
}

// ---------- the documents behind a figure ----------

export type KpiDocumentType = 'REQUEST' | 'PURCHASE_ORDER' | 'VARIANCE' | 'DOA_VERSION' | 'ORG_AUTHORITY_CHANGE'

export interface KpiItemDto {
  readonly key: string
  readonly document: { readonly type: KpiDocumentType; readonly id: string; readonly label: string; readonly poId: string | null } | null
  /** Who decided, or who holds the task */
  readonly person: { readonly nameTh: string; readonly nameEn: string | null } | null
  readonly onBehalfOf: { readonly nameTh: string; readonly nameEn: string | null } | null
  readonly channel: string | null
  readonly decision: string | null
  /** When it was decided, approved or (for an open task) assigned */
  readonly at: string
  readonly dueAt: string | null
  /** Business minutes it took (decision time, submit to PO) */
  readonly minutes: number | null
  readonly doaRef: { readonly versionId: string; readonly code: string; readonly versionNo: number; readonly ruleCode: string } | null
  /** Why the item is in the list, in a word the screen translates */
  readonly mark: 'MOBILE' | 'NOT_MOBILE' | 'WITH_DOA' | 'WITHOUT_DOA' | 'MISROUTED' | 'DOA_MATCHED' | 'PAST_DUE_DECIDED' | 'PAST_DUE_OPEN' | null
}

export interface KpiDetailDto {
  readonly measure: KpiMeasure
  /** G-5 of one kind of document (PURCHASE_REQUEST …), or null for all */
  readonly kind: string | null
  readonly period: { readonly from: string; readonly to: string }
  /** At most KPI_DETAIL_MAX items, newest first; G-2 (a) puts the misrouted decisions it counts first */
  readonly items: readonly KpiItemDto[]
  /** How many items stand behind the figure in all */
  readonly total: number
  /** How many of them the figure counts (the numerator, or the count) */
  readonly counted: number
}

/** A list behind a figure shows at most this many items, the newest */
export const KPI_DETAIL_MAX = 200

const name = (m: { displayNameTh: string; displayNameEn: string | null } | undefined) => (m ? { nameTh: m.displayNameTh, nameEn: m.displayNameEn } : null)

async function resolveDocuments(tx: TenantTx, refs: ReadonlyArray<{ subjectType: string; subjectId: string }>): Promise<Map<string, NonNullable<KpiItemDto['document']>>> {
  const ids = (type: string) => [...new Set(refs.filter((r) => r.subjectType === type).map((r) => r.subjectId))]
  const [requests, pos, variances, versions, changes] = await Promise.all([
    tx.request.findMany({ where: { id: { in: ids('REQUEST') } }, select: { id: true, number: true, title: true } }),
    tx.purchaseOrder.findMany({ where: { id: { in: ids('PURCHASE_ORDER') } }, select: { id: true, number: true } }),
    tx.variance.findMany({ where: { id: { in: ids('VARIANCE') } }, select: { id: true, poId: true, po: { select: { number: true } } } }),
    tx.doaVersion.findMany({ where: { id: { in: ids('DOA_VERSION') } }, select: { id: true, code: true, versionNo: true } }),
    tx.orgAuthorityChange.findMany({ where: { id: { in: ids('ORG_AUTHORITY_CHANGE') } }, select: { id: true, kind: true } }),
  ])
  const doc = (type: KpiDocumentType, id: string, label: string, poId: string | null = null) => [id, { type, id, label, poId }] as const
  return new Map([
    ...requests.map((r) => doc('REQUEST', r.id, r.number ? `${r.number} ${r.title}` : r.title)),
    ...pos.map((p) => doc('PURCHASE_ORDER', p.id, p.number ?? '', p.id)),
    ...variances.map((v) => doc('VARIANCE', v.id, v.po.number ?? '', v.poId)),
    ...versions.map((v) => doc('DOA_VERSION', v.id, `${v.code} #${v.versionNo}`)),
    ...changes.map((c) => doc('ORG_AUTHORITY_CHANGE', c.id, c.kind)),
  ])
}

const MeasureInput = z.enum(KPI_MEASURES)

/** The documents behind one KPI figure for the period, newest first (the KPI page's lists) */
export async function kpiDetail(ctx: Ctx, params: KpiParams, measure: string, kind: string | null = null): Promise<Result<KpiDetailDto>> {
  const period = KpiPeriod.safeParse(params)
  if (!period.success) return err('VALIDATION_FAILED', 'invalid period', { field: period.error.issues[0]?.path.join('.') || 'from', reason: 'PERIOD' })
  const which = MeasureInput.safeParse(measure)
  if (!which.success) return err('NOT_FOUND', 'no such KPI figure')
  return forTenant(ctx.organizationId).$transaction(async (tx) => {
    const allowed = await orgReader(tx, ctx)
    if (!allowed.ok) return err(allowed.error.code, allowed.error.message, allowed.error.details)
    const { items } = await collectKpis(tx, ctx.organizationId, { ...periodOf(period.data), now: ctx.now }, null)
    const m = which.data

    let decisions: readonly KpiDecisionItem[] = []
    let tasks: readonly KpiTaskItem[] = []
    let counted = 0
    let decisionMark: (d: KpiDecisionItem) => KpiItemDto['mark'] = () => null
    if (m === 'g2a') {
      // every decision the DOA engine checked again, the misrouted ones counted: "0 รายการ (ตรวจแล้ว 33 การตัดสิน)"
      // opens the 33 decisions it checked, as G-2 (b) and G-5 open every decision they count or not (§9.9)
      decisions = items.decisions.filter((d) => d.misrouted !== null)
      counted = decisions.filter((d) => d.misrouted === true).length
      decisionMark = (d) => (d.misrouted ? 'MISROUTED' : 'DOA_MATCHED')
    } else if (m === 'g2b') {
      decisions = items.decisions
      counted = decisions.filter((d) => d.doaVersionId && d.doaRuleCode).length
      decisionMark = (d) => (d.doaVersionId && d.doaRuleCode ? 'WITH_DOA' : 'WITHOUT_DOA')
    } else if (m === 'g5') {
      decisions = kind ? items.decisions.filter((d) => kpiDocumentKind(d.subjectType) === kind) : items.decisions
      counted = decisions.filter((d) => isMobileChannel(d.channel)).length
      decisionMark = (d) => (isMobileChannel(d.channel) ? 'MOBILE' : 'NOT_MOBILE')
    } else if (m === 'g3b') {
      tasks = items.g3Decisions
      counted = tasks.length
    } else if (m === 'g3c') {
      tasks = items.g3PastDue
      counted = tasks.length
    } else if (m === 'g4') {
      tasks = items.g4
      counted = tasks.length
    }

    const refs = [
      ...decisions.map((d) => ({ subjectType: d.subjectType, subjectId: d.subjectId })),
      ...tasks.map((t) => ({ subjectType: t.subjectType, subjectId: t.subjectId })),
      ...(m === 'g1' ? items.g1.map((p) => ({ subjectType: 'PURCHASE_ORDER', subjectId: p.poId })) : []),
      ...(m === 'g3a' ? items.g3SubmitToPo.map((r) => ({ subjectType: 'REQUEST', subjectId: r.requestId })) : []),
    ]
    const [documents, people, versions] = await Promise.all([
      resolveDocuments(tx, refs),
      tx.member.findMany({
        where: { id: { in: [...new Set([...decisions.flatMap((d) => [d.actorMemberId, d.onBehalfOfMemberId]), ...tasks.map((t) => t.assigneeMemberId)].filter((x): x is string => Boolean(x)))] } },
        select: { id: true, displayNameTh: true, displayNameEn: true },
      }),
      tx.doaVersion.findMany({ where: { id: { in: [...new Set(decisions.map((d) => d.doaVersionId).filter((x): x is string => Boolean(x)))] } }, select: { id: true, code: true, versionNo: true } }),
    ])
    const person = new Map(people.map((p) => [p.id, p]))
    const version = new Map(versions.map((v) => [v.id, v]))
    const blank = { person: null, onBehalfOf: null, channel: null, decision: null, dueAt: null, minutes: null, doaRef: null, mark: null } as const

    const list: KpiItemDto[] = [
      ...decisions.map((d): KpiItemDto => {
        const v = d.doaVersionId ? version.get(d.doaVersionId) : undefined
        return {
          ...blank,
          key: d.taskId,
          document: documents.get(d.subjectId) ?? null,
          person: name(person.get(d.actorMemberId)),
          onBehalfOf: d.onBehalfOfMemberId ? name(person.get(d.onBehalfOfMemberId)) : null,
          channel: d.channel,
          decision: d.decision,
          at: d.decidedAt,
          doaRef: v && d.doaRuleCode ? { versionId: v.id, code: v.code, versionNo: v.versionNo, ruleCode: d.doaRuleCode } : null,
          mark: decisionMark(d),
        }
      }),
      ...tasks.map(
        (t): KpiItemDto => ({
          ...blank,
          key: t.taskId,
          document: documents.get(t.subjectId) ?? null,
          person: name(person.get(t.assigneeMemberId)),
          at: t.decidedAt ?? t.assignedAt,
          dueAt: t.dueAt,
          minutes: t.minutes,
          mark: m === 'g3c' ? (t.decidedAt ? 'PAST_DUE_DECIDED' : 'PAST_DUE_OPEN') : null,
        }),
      ),
      ...(m === 'g1' ? items.g1.map((p): KpiItemDto => ({ ...blank, key: p.poId, document: documents.get(p.poId) ?? null, at: p.approvedAt })) : []),
      ...(m === 'g3a'
        ? items.g3SubmitToPo.map((r): KpiItemDto => ({ ...blank, key: r.requestId, document: documents.get(r.requestId) ?? null, at: r.firstPoApprovedAt, minutes: r.minutes }))
        : []),
    ]
    if (m === 'g1' || m === 'g3a') counted = list.length
    list.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
    // G-2 (a) counts the misrouted decisions among all it checked: they come first, so the cut at KPI_DETAIL_MAX never
    // hides one behind newer decisions made by the right person
    const shown = m === 'g2a' ? [...list.filter((i) => i.mark === 'MISROUTED'), ...list.filter((i) => i.mark !== 'MISROUTED')] : list
    return ok({ measure: m, kind, period: period.data, items: shown.slice(0, KPI_DETAIL_MAX), total: list.length, counted })
  })
}
