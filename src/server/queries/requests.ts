import { z } from 'zod'
import { bandOf } from '@/core/doa'
import { FieldDefSchema, type FieldDef } from '@/core/forms/fields'
import { amountToSatang } from '@/core/money/dto'
import { businessMinutesBetween, type BusinessCalendar, type Weekday } from '@/core/sla'
import { REQUEST_MACHINE, SUPPLIER_REQUEST_MACHINE, transition, type RequestCommand, type RequestState, type SupplierRequestState } from '@/core/state-machines'
import { stepOutcome, type SlotDecision } from '@/core/workflow'
import { OrgSettingsSchema } from '@/lib/org-settings'
import type { Ctx } from '@/server/context'
import { escapeLike } from '@/server/db/like'
import { forTenant, type TenantDb, type TenantTx } from '@/server/db/tenant'
import { REQUEST_STATUSES } from './statuses'

// Read-only views of purchase requests for the screens of S2-12 (spec FR-INT-008, FR-DOA-003 AC2, FR-DOA-005 AC2,
// FR-PLT-003 AC3, FR-INT-009): "my requests" with where each one is now, and one request with its lines, totals, budget,
// the route the DOA engine chose and why, and a tracking timeline built from its Events (who, what, which channel, when
// and the DOA version and rule of every decision). Queries never check permissions (they cannot import authz): the page
// asks getRequestAccess() first and checks request.view with src/server/authz before it reads anything else.

const Uuid = z.uuid()
/** Page parameters arrive as any text; Postgres refuses a malformed uuid, so it is checked first */
export const isUuid = (value: string): boolean => Uuid.safeParse(value).success

// ---------- shared shapes ----------

/** A name as the organization keeps it: Thai always, English when it was given */
export interface NameDto {
  readonly th: string
  readonly en: string | null
}

export interface MemberRefDto {
  readonly id: string
  readonly name: NameDto
}

export interface DepartmentRefDto {
  readonly id: string
  readonly code: string
  readonly name: NameDto
  /** The root department (the company): organization-wide positions belong to it */
  readonly isRoot: boolean
}

/** Where an approver came from (ApprovalTask.resolvedFrom): a position of a department, a named member, or the signatory */
export type ApproverRoleDto =
  | { readonly kind: 'POSITION'; readonly positionCode: string; readonly position: NameDto | null; readonly department: NameDto | null; readonly orgWide: boolean }
  | { readonly kind: 'NAMED' }
  | { readonly kind: 'SIGNATORY' }
  | { readonly kind: 'UNKNOWN' }

/** Who a later step of a route will go to, from the DOA rule (the engine names the person when the step starts) */
export type ExpectedApproverDto = { readonly kind: 'POSITION'; readonly positionCode: string; readonly position: NameDto | null } | { readonly kind: 'MEMBER'; readonly member: MemberRefDto | null }

export interface DoaRefDto {
  readonly versionId: string
  readonly code: string
  readonly versionNo: number
  readonly ruleCode: string
}

type MemberRow = { readonly id: string; readonly displayNameTh: string; readonly displayNameEn: string | null }
export const memberRef = (m: MemberRow): MemberRefDto => ({ id: m.id, name: { th: m.displayNameTh, en: m.displayNameEn } })
const present = <T>(v: T | null | undefined): v is T => v !== null && v !== undefined

/** Names of the members with these ids (actors, assignees, delegators) */
export async function membersById(db: TenantDb, ids: Iterable<string | null | undefined>): Promise<Map<string, MemberRefDto>> {
  const wanted = [...new Set([...ids].filter(present))]
  if (wanted.length === 0) return new Map()
  const rows = await db.member.findMany({ where: { id: { in: wanted } }, select: { id: true, displayNameTh: true, displayNameEn: true } })
  return new Map(rows.map((m) => [m.id, memberRef(m)]))
}

/** Every department of the organization, by id and by code (a tree of a few dozen rows) */
export async function departmentsOf(db: TenantDb): Promise<{ byId: Map<string, DepartmentRefDto>; byCode: Map<string, DepartmentRefDto> }> {
  const rows = await db.department.findMany({ select: { id: true, code: true, nameTh: true, nameEn: true, parentId: true } })
  const refs = rows.map((d) => ({ id: d.id, code: d.code, name: { th: d.nameTh, en: d.nameEn }, isRoot: d.parentId === null }))
  return { byId: new Map(refs.map((d) => [d.id, d])), byCode: new Map(refs.map((d) => [d.code, d])) }
}

/** Turns "POSITION:VP@OPS", "MEMBER:<id>" or "CONTRACT_SIGNATORY:<id>" into what a screen shows */
export async function approverRoles(db: TenantDb, departments?: Map<string, DepartmentRefDto>): Promise<(resolvedFrom: string | null | undefined) => ApproverRoleDto> {
  const [positions, byCode] = await Promise.all([
    db.position.findMany({ select: { code: true, nameTh: true, nameEn: true, scope: true } }),
    departments ? Promise.resolve(departments) : departmentsOf(db).then((d) => d.byCode),
  ])
  const position = new Map(positions.map((p) => [p.code, p]))
  return (resolvedFrom) => {
    if (!resolvedFrom) return { kind: 'UNKNOWN' }
    const match = /^POSITION:([^@]+)@(.+)$/.exec(resolvedFrom)
    if (match) {
      const p = position.get(match[1]!)
      const d = byCode.get(match[2]!)
      return {
        kind: 'POSITION',
        positionCode: match[1]!,
        position: p ? { th: p.nameTh, en: p.nameEn } : null,
        department: d ? d.name : null,
        orgWide: p?.scope === 'ORG' || d?.isRoot === true,
      }
    }
    if (resolvedFrom.startsWith('MEMBER:')) return { kind: 'NAMED' }
    if (resolvedFrom.startsWith('CONTRACT_SIGNATORY:')) return { kind: 'SIGNATORY' }
    return { kind: 'UNKNOWN' }
  }
}

/** settings.businessCalendar with the time zone and holidays (BR-SLA-01); null when the settings cannot be read */
export async function businessCalendarOf(db: TenantDb, organizationId: string): Promise<BusinessCalendar | null> {
  const org = await db.organization.findUnique({ where: { id: organizationId }, select: { settings: true, timezone: true } })
  if (!org) return null
  const parsed = OrgSettingsSchema.shape.businessCalendar.safeParse((org.settings as { businessCalendar?: unknown } | null)?.businessCalendar)
  if (!parsed.success) return null
  const holidays = await db.holiday.findMany({ select: { date: true } })
  return { timezone: org.timezone, workdays: parsed.data.workdays as Weekday[], start: parsed.data.start, end: parsed.data.end, holidays: holidays.map((h) => h.date.toISOString().slice(0, 10)) }
}

/** Business minutes from `since` until now (GC-SLA-05); null without a calendar */
export function businessMinutesSince(calendar: BusinessCalendar | null, since: Date, now: Date): number | null {
  return calendar ? businessMinutesBetween(since, now, calendar) : null
}

/** A pause of a task's SLA: from the approver's question until the requester's answer, or until now (BR-SLA-03) */
export interface SlaPause {
  readonly askedAt: Date
  readonly answeredAt: Date | null
}

/**
 * Business minutes a task has waited for its approver (FR-INT-008 AC1): from when it arrived until now, without the time
 * it waited for the requester's answers, because the SLA stops counting then (BR-SLA-03, GC-SLA-06). A task waiting for
 * an answer keeps the time it had used before the question. null without a business calendar.
 */
export function businessMinutesWaited(calendar: BusinessCalendar | null, assignedAt: Date, now: Date, pauses: readonly SlaPause[] = []): number | null {
  if (!calendar) return null
  const paused = pauses.reduce((sum, p) => {
    const from = Math.max(p.askedAt.getTime(), assignedAt.getTime())
    const to = Math.min((p.answeredAt ?? now).getTime(), now.getTime())
    return to > from ? sum + businessMinutesBetween(new Date(from), new Date(to), calendar) : sum
  }, 0)
  return Math.max(0, businessMinutesBetween(assignedAt, now, calendar) - paused)
}

/** The SLA pauses of these tasks (their questions to the requester), by task */
export async function slaPausesOf(db: TenantDb, taskIds: readonly string[]): Promise<Map<string, SlaPause[]>> {
  const byTask = new Map<string, SlaPause[]>()
  if (taskIds.length === 0) return byTask
  const rows = await db.infoRequest.findMany({ where: { taskId: { in: [...taskIds] } }, select: { taskId: true, askedAt: true, answeredAt: true } })
  for (const r of rows) byTask.set(r.taskId, [...(byTask.get(r.taskId) ?? []), { askedAt: r.askedAt, answeredAt: r.answeredAt }])
  return byTask
}

/** DOA versions by id, for "DOA-DEMO ฉบับ 1 ข้อ PR-02" */
export async function doaVersionsById(db: TenantDb, ids: Iterable<string | null | undefined>): Promise<Map<string, { id: string; code: string; versionNo: number }>> {
  const wanted = [...new Set([...ids].filter(present))]
  if (wanted.length === 0) return new Map()
  const rows = await db.doaVersion.findMany({ where: { id: { in: wanted } }, select: { id: true, code: true, versionNo: true } })
  return new Map(rows.map((v) => [v.id, v]))
}

// ---------- access (the page checks request.view with these facts before reading) ----------

export interface RequestAccessDto {
  readonly requestId: string
  /** The document number once submitted (the page title) */
  readonly number: string | null
  /** OWN: the requester */
  readonly requesterMemberId: string
  /** OWN: followers see what the requester sees (FR-INT-008 AC2) */
  readonly followerMemberIds: readonly string[]
  /**
   * ASSIGNED: everyone who has or had an approval task on the request or on its over-budget approvals, and the
   * delegator a delegate held it for
   */
  readonly taskMemberIds: readonly string[]
  readonly chargedDepartmentId: string
}

/**
 * The approval tasks that make a member ASSIGNED on a request (request.view): the tasks of its own routes, and of the
 * routes of its over-budget approvals — their approvers read the source request (S6-16 · FR-BUD-101)
 */
export async function requestTaskMemberIds(db: TenantDb | TenantTx, requestId: string): Promise<string[]> {
  const overruns = await db.budgetOverrun.findMany({ where: { requestId }, select: { id: true } })
  const tasks = await db.approvalTask.findMany({
    where: { step: { route: { OR: [{ subjectType: 'REQUEST', subjectId: requestId }, ...(overruns.length ? [{ subjectType: 'BUDGET_OVERRUN' as const, subjectId: { in: overruns.map((o) => o.id) } }] : [])] } } },
    select: { assigneeMemberId: true, principalMemberId: true },
  })
  return [...new Set(tasks.flatMap((t) => [t.assigneeMemberId, t.principalMemberId]).filter(present))]
}

export async function getRequestAccess(ctx: Ctx, requestId: string): Promise<RequestAccessDto | null> {
  if (!isUuid(requestId)) return null
  const db = forTenant(ctx.organizationId)
  const request = await db.request.findUnique({ where: { id: requestId }, select: { id: true, number: true, requesterMemberId: true, chargedDepartmentId: true, followers: { select: { memberId: true } } } })
  if (!request) return null
  return {
    requestId: request.id,
    number: request.number,
    requesterMemberId: request.requesterMemberId,
    followerMemberIds: request.followers.map((f) => f.memberId),
    taskMemberIds: await requestTaskMemberIds(db, requestId),
    chargedDepartmentId: request.chargedDepartmentId,
  }
}

// ---------- where a request is now ----------

export { REQUEST_STATUSES }
export type RequestStatusDto = (typeof REQUEST_STATUSES)[number]
const isRequestStatus = (value: string | undefined): value is RequestStatusDto => value !== undefined && (REQUEST_STATUSES as readonly string[]).includes(value)

/**
 * An approver the current step waits for: one open task of the step. An escalated step has two — the first assignee and
 * the approver of the next band added as co-assignee — and whoever decides first decides the step (BR-SLA-04, NEW-46).
 */
export interface WaitingApproverDto {
  readonly taskId: string
  readonly assignee: MemberRefDto
  /** The delegator when a delegate holds the task (BR-DLG-04) */
  readonly onBehalfOf: MemberRefDto | null
  readonly role: ApproverRoleDto
  readonly since: Date
  readonly waitingMinutes: number | null
  readonly dueAt: Date | null
  readonly overdue: boolean
}

/** Where the request waits now and on whom (FR-INT-008 AC1) */
export type StageDto =
  | { readonly kind: 'DRAFT'; readonly since: Date }
  | {
      readonly kind: 'APPROVER'
      readonly taskId: string
      readonly assignee: MemberRefDto
      /** The delegator when a delegate holds the task (BR-DLG-04) */
      readonly onBehalfOf: MemberRefDto | null
      readonly role: ApproverRoleDto
      readonly since: Date
      readonly waitingMinutes: number | null
      readonly dueAt: Date | null
      readonly overdue: boolean
      readonly stepNo: number
      readonly stepCount: number
      /**
       * Everyone who may decide the step now, oldest task first: the approver above, and the co-assignee of an escalated
       * step. Always set by the queries; a stage made elsewhere without it waits for the approver above alone
       */
      readonly approvers?: readonly WaitingApproverDto[]
      /**
       * The step waits for every one of them, each for their own slot — the reviewers' step or a committee (S6 ·
       * BR-WF-01) — not for whoever decides first. Absent: the first to decide decides
       */
      readonly together?: 'REVIEW' | 'COMMITTEE'
    }
  /**
   * The approver asked a question; the task's SLA has stopped until the requester answers (BR-SLA-03). `approvers`: the
   * other approvers of an escalated step, who may still decide it meanwhile (BR-SLA-04; always set by the queries)
   */
  | {
      readonly kind: 'ANSWER'
      readonly taskId: string
      readonly infoRequestId: string | null
      readonly question: string | null
      readonly askedBy: MemberRefDto | null
      readonly since: Date
      readonly approvers?: readonly WaitingApproverDto[]
      /** Business minutes the question has waited for the requester's answer (§9.9 principle 4; always set by the queries) */
      readonly waitingMinutes?: number | null
    }
  /** Returned: waits for the requester to edit and send it again, for `waitingMinutes` (always set by the queries) */
  | { readonly kind: 'REQUESTER_EDIT'; readonly since: Date | null; readonly waitingMinutes?: number | null }
  | { readonly kind: 'PROCUREMENT'; readonly since: Date | null; readonly waitingMinutes: number | null }
  /** A new-supplier request waits in the procurement queue without a DOA route (OQ-23) */
  | { readonly kind: 'QUEUE'; readonly since: Date | null; readonly waitingMinutes: number | null }
  /**
   * Ordered: its lines are on approved POs. `suppliers`: whom it waits for — the suppliers of its POs that went out and
   * still wait for goods (SENT, PARTIALLY_RECEIVED), in the order they began to wait; empty when none does (a PO not
   * sent yet, or all goods in). `since`: the earliest of their waits, as the PO page counts each (teamWaitSince: a sent
   * PO from its sending, one partly received from its latest goods receipt). Always set by the queries
   */
  | { readonly kind: 'DELIVERY'; readonly since?: Date | null; readonly waitingMinutes?: number | null; readonly suppliers?: readonly NameDto[] }
  | { readonly kind: 'CLOSED' }
  | { readonly kind: 'UNKNOWN' }

const OPEN_TASK = ['OPEN', 'INFO_REQUESTED'] as const

interface StageInput {
  readonly id: string
  readonly status: string
  readonly createdAt: Date
  readonly approvedAt: Date | null
  readonly submittedAt: Date | null
  readonly currentRouteId: string | null
}

type TaskRow = {
  readonly id: string
  readonly status: string
  readonly assigneeMemberId: string
  readonly principalMemberId: string | null
  readonly resolvedFrom: string
  readonly assignedAt: Date
  readonly dueAt: Date | null
  readonly decidedAt: Date | null
  readonly decision: string | null
  readonly step: { readonly routeId: string; readonly stepNo: number; readonly kind: string; readonly mode: string }
}

interface StageContext {
  readonly now: Date
  readonly calendar: BusinessCalendar | null
  readonly members: Map<string, MemberRefDto>
  readonly roleOf: (resolvedFrom: string | null | undefined) => ApproverRoleDto
  /** Tasks of the current routes, any status */
  readonly tasksByRoute: Map<string, TaskRow[]>
  readonly stepCountByRoute: Map<string, number>
  readonly openQuestionByTask: Map<string, { id: string; question: string; askedById: string; askedAt: Date }>
  /** The questions of the open tasks: the time they waited for the requester is not counted (BR-SLA-03) */
  readonly pausesByTask: Map<string, SlaPause[]>
  /** Ordered requests: the suppliers their goods wait for, and since when (DELIVERY) */
  readonly deliveryByRequest: Map<string, { readonly since: Date | null; readonly suppliers: readonly NameDto[] }>
}

const isOpenTask = (status: string): boolean => (OPEN_TASK as readonly string[]).includes(status)

/** One open task as the approver it waits for, with the business time it has waited (FR-INT-008 AC1, BR-SLA-03) */
function waitingApprover(t: TaskRow, s: StageContext): WaitingApproverDto | null {
  const assignee = s.members.get(t.assigneeMemberId)
  if (!assignee) return null
  return {
    taskId: t.id,
    assignee,
    onBehalfOf: t.principalMemberId ? (s.members.get(t.principalMemberId) ?? null) : null,
    role: s.roleOf(t.resolvedFrom),
    since: t.assignedAt,
    waitingMinutes: businessMinutesWaited(s.calendar, t.assignedAt, s.now, s.pausesByTask.get(t.id) ?? []),
    dueAt: t.dueAt,
    overdue: t.dueAt !== null && t.dueAt.getTime() < s.now.getTime(),
  }
}

function stageOf(r: StageInput, s: StageContext): StageDto {
  const tasks = r.currentRouteId ? (s.tasksByRoute.get(r.currentRouteId) ?? []) : []
  switch (r.status) {
    case 'DRAFT':
      return { kind: 'DRAFT', since: r.createdAt }
    case 'PENDING_APPROVAL': {
      // Every open task of the current step, oldest first: an escalated step waits for its first assignee and for the
      // co-assignee alike, and whoever decides first decides (BR-SLA-04, NEW-46). A question one of them asked waits for
      // the requester's answer first — the page shows the requester the question to answer — while the others may
      // still decide.
      const open = tasks.filter((t) => isOpenTask(t.status))
      const first = open[0]
      if (!first) return { kind: 'UNKNOWN' }
      const step = open.filter((t) => t.step.routeId === first.step.routeId && t.step.stepNo === first.step.stepNo)
      const approvers = step.filter((t) => t.status === 'OPEN').flatMap((t) => waitingApprover(t, s) ?? [])
      const asking = step.find((t) => t.status === 'INFO_REQUESTED')
      if (asking) {
        const q = s.openQuestionByTask.get(asking.id)
        const askedBy = q ? (s.members.get(q.askedById) ?? null) : (s.members.get(asking.assigneeMemberId) ?? null)
        const since = q?.askedAt ?? asking.assignedAt
        return {
          kind: 'ANSWER',
          taskId: asking.id,
          infoRequestId: q?.id ?? null,
          question: q?.question ?? null,
          askedBy,
          since,
          approvers,
          // How long the question has waited for the requester's answer (§9.9 principle 4)
          waitingMinutes: businessMinutesSince(s.calendar, since, s.now),
        }
      }
      const lead = approvers[0]
      if (!lead) return { kind: 'UNKNOWN' }
      return {
        kind: 'APPROVER',
        ...lead,
        stepNo: first.step.stepNo,
        stepCount: s.stepCountByRoute.get(first.step.routeId) ?? first.step.stepNo,
        approvers,
        ...(first.step.kind === 'REVIEW' ? { together: 'REVIEW' as const } : first.step.mode === 'PARALLEL' ? { together: 'COMMITTEE' as const } : {}),
      }
    }
    case 'RETURNED': {
      const returned = tasks.filter((t) => t.decision === 'RETURN' && t.decidedAt).sort((a, b) => b.decidedAt!.getTime() - a.decidedAt!.getTime())[0]
      const since = returned?.decidedAt ?? null
      return { kind: 'REQUESTER_EDIT', since, waitingMinutes: since ? businessMinutesSince(s.calendar, since, s.now) : null }
    }
    case 'APPROVED':
    case 'PARTIALLY_ORDERED':
      return { kind: 'PROCUREMENT', since: r.approvedAt, waitingMinutes: r.approvedAt ? businessMinutesSince(s.calendar, r.approvedAt, s.now) : null }
    // A new-supplier request waits in the procurement queue (OQ-23)
    case 'SUBMITTED':
      return { kind: 'QUEUE', since: r.submittedAt, waitingMinutes: r.submittedAt ? businessMinutesSince(s.calendar, r.submittedAt, s.now) : null }
    case 'ORDERED': {
      const delivery = s.deliveryByRequest.get(r.id)
      const since = delivery?.since ?? null
      return { kind: 'DELIVERY', since, waitingMinutes: since ? businessMinutesSince(s.calendar, since, s.now) : null, suppliers: delivery?.suppliers ?? [] }
    }
    default:
      return { kind: 'CLOSED' }
  }
}

/** POs that went to their supplier and still wait for goods: what an ordered request waits for (DELIVERY) */
const DELIVERY_WAIT: readonly ('SENT' | 'PARTIALLY_RECEIVED')[] = ['SENT', 'PARTIALLY_RECEIVED']

/**
 * For each ordered request, the suppliers its goods wait for and since when (StageDto DELIVERY): its POs that went out
 * and still wait for goods, each waiting as the PO page counts it — a sent PO from its sending, a PO partly received from
 * its latest posted goods receipt — the earliest wait first, each supplier once
 */
async function deliveriesOf(db: TenantDb, requestIds: readonly string[]): Promise<Map<string, { readonly since: Date | null; readonly suppliers: readonly NameDto[] }>> {
  const byRequest = new Map<string, { since: Date | null; suppliers: NameDto[] }>()
  if (requestIds.length === 0) return byRequest
  const pos = await db.purchaseOrder.findMany({
    where: { status: { in: [...DELIVERY_WAIT] }, lines: { some: { sources: { some: { requestLine: { requestId: { in: [...requestIds] } } } } } } },
    select: {
      id: true,
      status: true,
      sentAt: true,
      supplierId: true,
      supplier: { select: { nameTh: true, nameEn: true } },
      lines: { select: { sources: { select: { requestLine: { select: { requestId: true } } } } } },
      goodsReceipts: { where: { status: 'POSTED' }, select: { postedAt: true } },
    },
  })
  const waits = pos
    .map((po) => {
      const receipt = po.goodsReceipts.reduce<Date | null>((latest, g) => (g.postedAt && (!latest || g.postedAt > latest) ? g.postedAt : latest), null)
      const since = po.status === 'SENT' ? po.sentAt : (receipt ?? po.sentAt)
      const requests = new Set(po.lines.flatMap((l) => l.sources.map((src) => src.requestLine.requestId)))
      return { since, supplierId: po.supplierId, supplier: { th: po.supplier.nameTh, en: po.supplier.nameEn }, requests }
    })
    .sort((a, b) => (a.since?.getTime() ?? Number.MAX_SAFE_INTEGER) - (b.since?.getTime() ?? Number.MAX_SAFE_INTEGER))
  for (const requestId of requestIds) {
    const mine = waits.filter((w) => w.requests.has(requestId))
    if (mine.length === 0) continue
    const suppliers: NameDto[] = []
    const seen = new Set<string>()
    for (const w of mine) {
      if (seen.has(w.supplierId)) continue
      seen.add(w.supplierId)
      suppliers.push(w.supplier)
    }
    // Sorted earliest first, a wait without a time last: the first with one is the earliest
    byRequest.set(requestId, { since: mine.find((w) => w.since)?.since ?? null, suppliers })
  }
  return byRequest
}

/** What stageOf needs for these requests, read in a few queries */
async function stageContext(
  db: TenantDb,
  ctx: Ctx,
  requests: ReadonlyArray<{ readonly id: string; readonly status: string; readonly currentRouteId: string | null }>,
  extraMemberIds: ReadonlyArray<string | null> = [],
): Promise<StageContext> {
  const routeIds = [...new Set(requests.map((r) => r.currentRouteId).filter(present))]
  const [tasks, steps, calendar, roleOf, deliveryByRequest] = await Promise.all([
    routeIds.length
      ? db.approvalTask.findMany({
          where: { step: { routeId: { in: routeIds } } },
          select: { id: true, status: true, assigneeMemberId: true, principalMemberId: true, resolvedFrom: true, assignedAt: true, dueAt: true, decidedAt: true, decision: true, step: { select: { routeId: true, stepNo: true, kind: true, mode: true } } },
          orderBy: { assignedAt: 'asc' },
        })
      : Promise.resolve([]),
    routeIds.length ? db.approvalStep.groupBy({ by: ['routeId'], where: { routeId: { in: routeIds } }, _count: { _all: true } }) : Promise.resolve([]),
    businessCalendarOf(db, ctx.organizationId),
    approverRoles(db),
    deliveriesOf(
      db,
      requests.filter((r) => r.status === 'ORDERED').map((r) => r.id),
    ),
  ])
  // Every question of the open tasks: the unanswered one waits for the requester, and all of them paused the SLA
  const openIds = tasks.filter((t) => (OPEN_TASK as readonly string[]).includes(t.status)).map((t) => t.id)
  const infos = openIds.length
    ? await db.infoRequest.findMany({ where: { taskId: { in: openIds } }, select: { id: true, taskId: true, question: true, askedById: true, askedAt: true, answeredAt: true }, orderBy: { askedAt: 'desc' } })
    : []
  const asking = new Set(tasks.filter((t) => t.status === 'INFO_REQUESTED').map((t) => t.id))
  const questions = infos.filter((q) => q.answeredAt === null && asking.has(q.taskId))
  const members = await membersById(db, [...tasks.flatMap((t) => [t.assigneeMemberId, t.principalMemberId]), ...questions.map((q) => q.askedById), ...extraMemberIds])
  const tasksByRoute = new Map<string, TaskRow[]>()
  for (const t of tasks) tasksByRoute.set(t.step.routeId, [...(tasksByRoute.get(t.step.routeId) ?? []), t])
  const openQuestionByTask = new Map<string, { id: string; question: string; askedById: string; askedAt: Date }>()
  for (const q of questions) if (!openQuestionByTask.has(q.taskId)) openQuestionByTask.set(q.taskId, q)
  const pausesByTask = new Map<string, SlaPause[]>()
  for (const q of infos) pausesByTask.set(q.taskId, [...(pausesByTask.get(q.taskId) ?? []), { askedAt: q.askedAt, answeredAt: q.answeredAt }])
  return {
    now: ctx.now,
    calendar,
    members,
    roleOf,
    tasksByRoute,
    stepCountByRoute: new Map(steps.map((s) => [s.routeId, s._count._all])),
    openQuestionByTask,
    pausesByTask,
    deliveryByRequest,
  }
}

// ---------- my requests (FR-INT-008 AC3) ----------

export interface MyRequestsFilter {
  /** One status of REQUEST_STATUSES; anything else means all */
  readonly status?: string | undefined
  /** Any of these statuses (with `status`, both apply) */
  readonly statuses?: readonly RequestStatusDto[]
  /** Only these requests (still only the member's own and followed) */
  readonly ids?: readonly string[]
  /** Part of the document number or of the title */
  readonly q?: string | undefined
  /**
   * Whose: ALL (default) — the member's own and the ones they follow · MINE — the member is the requester (the home's
   * to-do rows: what waits for the requester) · FOLLOWING — own or followed and not a draft (the home's card "ที่ฉันติดตาม")
   */
  readonly scope?: MyRequestsScope
  /** Only requests with an approver's question that waits for its answer (the home's row "คำถามจากผู้อนุมัติรอคำตอบ") */
  readonly openQuestion?: boolean
  readonly limit?: number
}

export const MY_REQUESTS_SCOPES = ['ALL', 'MINE', 'FOLLOWING'] as const
export type MyRequestsScope = (typeof MY_REQUESTS_SCOPES)[number]

/** Open, as the home's card "ที่ฉันติดตาม" counts it (§11.5): still on its way, a new-supplier request in the queue too */
export const FOLLOWING_OPEN_STATUSES = ['PENDING_APPROVAL', 'RETURNED', 'APPROVED', 'PARTIALLY_ORDERED', 'ORDERED', 'SUBMITTED'] as const

export interface MyRequestRowDto {
  readonly id: string
  readonly number: string | null
  readonly title: string
  readonly status: RequestStatusDto
  readonly documentType: 'PURCHASE_REQUEST' | 'SUPPLIER_REQUEST'
  /** FOLLOWER: a request someone else made that this member follows (FR-INT-008 AC2) */
  readonly relation: 'REQUESTER' | 'FOLLOWER'
  /** null until the request is submitted (totals come from core/money at submit) and for supplier requests */
  readonly grossSatang: bigint | null
  readonly createdAt: Date
  readonly submittedAt: Date | null
  readonly stage: StageDto
}

export interface MyRequestsDto {
  readonly rows: readonly MyRequestRowDto[]
  /** All of the member's requests, so the screen can tell "none yet" from "none match" */
  readonly total: number
  readonly matched: number
}

const LIST_LIMIT = 100
const SEARCH_MAX = 60

/** The requests of a filter, for one member: the list and every count of it read the same condition */
export function myRequestsWhere(me: string, filter: MyRequestsFilter) {
  const ownOrFollowed = { OR: [{ requesterMemberId: me }, { followers: { some: { memberId: me } } }] }
  const scope = filter.scope ?? 'ALL'
  const q = (filter.q ?? '').trim().slice(0, SEARCH_MAX)
  return {
    AND: [
      scope === 'MINE' ? { requesterMemberId: me } : ownOrFollowed,
      ...(scope === 'FOLLOWING' ? [{ status: { not: 'DRAFT' as const } }] : []),
      ...(isRequestStatus(filter.status) ? [{ status: filter.status }] : []),
      ...(filter.statuses ? [{ status: { in: [...filter.statuses] } }] : []),
      ...(filter.ids ? [{ id: { in: [...filter.ids] } }] : []),
      // a question waits while its task does (INFO_REQUESTED) and nobody has answered it, as the inbox counts it
      ...(filter.openQuestion ? [{ infoRequests: { some: { answeredAt: null, task: { status: 'INFO_REQUESTED' as const } } } }] : []),
      ...(q ? [{ OR: [{ number: { contains: escapeLike(q), mode: 'insensitive' as const } }, { title: { contains: escapeLike(q), mode: 'insensitive' as const } }] }] : []),
    ],
  }
}

/** How many of the member's requests a filter keeps: the number the home shows for the list it links to */
export async function countMyRequests(ctx: Ctx, filter: MyRequestsFilter): Promise<number> {
  if (ctx.actor.type !== 'USER') return 0
  return forTenant(ctx.organizationId).request.count({ where: myRequestsWhere(ctx.actor.memberId, filter) })
}

export async function listMyRequests(ctx: Ctx, filter: MyRequestsFilter = {}): Promise<MyRequestsDto> {
  if (ctx.actor.type !== 'USER') return { rows: [], total: 0, matched: 0 }
  const me = ctx.actor.memberId
  const db = forTenant(ctx.organizationId)
  const where = myRequestsWhere(me, filter)
  const [total, matched, rows] = await Promise.all([
    db.request.count({ where: myRequestsWhere(me, {}) }),
    db.request.count({ where }),
    db.request.findMany({
      where,
      select: { id: true, number: true, title: true, status: true, documentType: true, requesterMemberId: true, grossSatang: true, createdAt: true, submittedAt: true, approvedAt: true, currentRouteId: true },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: Math.min(filter.limit ?? LIST_LIMIT, LIST_LIMIT),
    }),
  ])
  const stages = await stageContext(db, ctx, rows)
  return {
    total,
    matched,
    rows: rows.map((r) => ({
      id: r.id,
      number: r.number,
      title: r.title,
      status: r.status as RequestStatusDto,
      documentType: r.documentType,
      relation: r.requesterMemberId === me ? 'REQUESTER' : 'FOLLOWER',
      grossSatang: r.documentType === 'PURCHASE_REQUEST' && r.submittedAt ? r.grossSatang : null,
      createdAt: r.createdAt,
      submittedAt: r.submittedAt,
      stage: stageOf(r, stages),
    })),
  }
}

// ---------- one request ----------

export interface LineDto {
  readonly lineNo: number
  readonly description: string
  readonly quantity: string
  readonly uom: string
  readonly unitPriceSatang: bigint
  readonly netSatang: bigint
  readonly vatable: boolean
  readonly serviceEndDate: string | null
}

export interface TotalsDto {
  readonly netSatang: bigint
  readonly vatSatang: bigint
  readonly grossSatang: bigint
  /** 700 = 7% */
  readonly vatRateBp: number | null
  readonly priceIncludesVat: boolean
}

export interface BudgetDto {
  readonly lineId: string
  readonly code: string
  readonly name: string
  readonly status: 'OPEN' | 'FROZEN' | 'CLOSED'
  /** What the request's lines hold on the line now (BudgetAllocation, INV-BUD-03) */
  readonly reservedSatang: bigint
  readonly committedSatang: bigint
  readonly actualSatang: bigint
}

export type FieldValueDto =
  | { readonly kind: 'TEXT'; readonly text: string }
  /** The name of the member, department, cost center or budget line the field points at */
  | { readonly kind: 'NAME'; readonly name: NameDto }
  | { readonly kind: 'OPTIONS'; readonly options: ReadonlyArray<{ readonly value: string; readonly label: NameDto | null }> }
  | { readonly kind: 'BOOLEAN'; readonly value: boolean }
  | { readonly kind: 'DATE'; readonly date: string }
  | { readonly kind: 'MONEY'; readonly satang: bigint }
  | { readonly kind: 'COUNT'; readonly count: number }

export interface FieldDto {
  readonly id: string
  /** FieldDef.label in both languages (FR-ADM-005: forms are data, not messages) */
  readonly label: NameDto | null
  readonly value: FieldValueDto
}

export interface AttachmentDto {
  readonly fileId: string
  readonly fileName: string
  readonly kind: string
  readonly sizeBytes: number
}

export interface QuotationDto {
  readonly supplierName: string
  readonly amountSatang: bigint
  readonly includesVat: boolean
  readonly netSatang: bigint
  readonly isSelected: boolean
}

export interface InfoRequestDto {
  readonly id: string
  readonly taskId: string
  readonly question: string
  readonly askedBy: MemberRefDto | null
  readonly askedAt: Date
  readonly answer: string | null
  readonly answeredBy: MemberRefDto | null
  readonly answeredAt: Date | null
  /**
   * Unanswered, and no answer is needed any more because the task that asked was closed: the other approver of its step
   * decided first (STEP_DECIDED, BR-SLA-04), or the route ended without it (CLOSED: the request cancelled or sent
   * again). null while the question still waits, or once answered. Always set by getRequestView
   */
  readonly noLongerNeeded?: 'STEP_DECIDED' | 'CLOSED' | null
}

/** A task still open on a route step: someone who may decide the step now */
export interface StepTaskDto {
  readonly taskId: string
  readonly approver: MemberRefDto | null
  /** The delegator when a delegate holds the task (BR-DLG-04) */
  readonly onBehalfOf: MemberRefDto | null
  readonly role: ApproverRoleDto
  /** INFO_REQUESTED: this approver waits for the requester's answer (BR-SLA-03) */
  readonly status: 'OPEN' | 'INFO_REQUESTED'
}

export interface RouteStepDto {
  readonly stepNo: number
  readonly status: 'WAITING' | 'ACTIVE' | 'DONE' | 'CANCELLED'
  /**
   * Who decided the step; while it waits, the first of its open tasks; otherwise (closed with nothing decided) its
   * latest task. null while the step waits for its turn
   */
  readonly approver: MemberRefDto | null
  readonly onBehalfOf: MemberRefDto | null
  readonly role: ApproverRoleDto | null
  readonly expected: ExpectedApproverDto | null
  readonly taskStatus: string | null
  readonly decision: 'APPROVE' | 'RETURN' | 'REJECT' | null
  readonly decidedAt: Date | null
  /**
   * Every task still open on the step, oldest first (`approver` is the first): an escalated step waits for its
   * co-assignee too, and whoever decides first decides (BR-SLA-04, NEW-46). Empty once the step is decided. Always set
   * by routeOf; a step made elsewhere without it has `approver` alone.
   */
  readonly open?: readonly StepTaskDto[]
  /**
   * The step went past its escalation time (BR-SLA-04, approval_task.escalated): CO_ASSIGNED when the approver of the
   * band above joined it — its decision keeps the route's own DOA reference, with this flag — NO_NEXT_BAND when nobody
   * could be added (ORG_ADMIN and the requester were told); null otherwise. Always set by routeOf
   */
  readonly escalation?: 'CO_ASSIGNED' | 'NO_NEXT_BAND' | null
  /**
   * Whom the route's rule gave the step, as the route's Thai explanation names them (BR-DOA-10): the step's first task —
   * not the co-assignee an escalation added (who may have decided it: `approver`), nor a task moved to someone later.
   * null while the step waits for its turn (`expected` names the approver then). Always set by routeOf; a step made
   * elsewhere without it (a preview of the engine's route) has its rule's approver in `approver`
   */
  readonly ruleApprover?: { readonly approver: MemberRefDto | null; readonly onBehalfOf: MemberRefDto | null; readonly role: ApproverRoleDto } | null
  /**
   * S6 (getRouteView): APPROVAL — a DOA step of one approver · REVIEW — the reviewers' step (BR-WF-06) · COMMITTEE — a
   * DOA step of several slots (BR-WF-01). Always set by routeOf, with the step's mode, its slots and, for REVIEW, its
   * groups; a step made elsewhere (a preview) has none of them
   */
  readonly stepType?: 'APPROVAL' | 'REVIEW' | 'COMMITTEE'
  /** S6-08 (BR-WF-14): the holder of the step's position changed after the submit; the step went to the holder of then */
  readonly holderChanged?: boolean
  /** The step number of resolveRoute; null for the REVIEW step */
  readonly doaStepNo?: number | null
  readonly quorum?: 'ALL' | 'ANY' | 'COUNT'
  readonly quorumCount?: number | null
  /** REVIEW: the groups that decide the step (one per ALL or COUNT rule, one for the ANY rules) */
  readonly groups?: ReadonlyArray<{ readonly ruleCodes: readonly string[]; readonly quorum: 'ALL' | 'ANY' | 'COUNT'; readonly quorumCount: number | null; readonly slotNos: readonly number[] }>
  readonly slots?: readonly RouteSlotDto[]
}

/** A slot of a step (BR-WF-01): who holds it, and what its first decision was */
export interface RouteSlotDto {
  readonly slotNo: number
  /** The rules the slot answers for: a reviewer's workflow rules, or the route's DOA rule */
  readonly ruleCodes: readonly string[]
  readonly status: 'OPEN' | 'QUESTION' | 'APPROVE' | 'RETURN' | 'REJECT' | 'CLOSED'
  /** Every task of the slot in the order they were made: a reviewer of the ANY rules each, a co-assignee, a moved task */
  readonly holders: ReadonlyArray<{ readonly taskId: string; readonly approver: MemberRefDto | null; readonly onBehalfOf: MemberRefDto | null; readonly role: ApproverRoleDto; readonly status: string }>
  /** Who decided the slot, and whom a delegate acted for */
  readonly decidedBy: MemberRefDto | null
  readonly decidedOnBehalfOf: MemberRefDto | null
  readonly decision: 'APPROVE' | 'RETURN' | 'REJECT' | null
  readonly decidedAt: Date | null
  /** The task that decided the slot (its reason is read with the reader's scope, BR-WF-09) */
  readonly decidedTaskId: string | null
}

/** The route the DOA engine chose, and why (FR-DOA-003 AC2, BR-DOA-10) */
export interface RouteDto {
  readonly id: string
  readonly routeNo: number
  readonly status: 'ACTIVE' | 'COMPLETED' | 'CANCELLED'
  readonly doa: DoaRefDto
  /** The rule the amount fell into when its approver was part of the request (BR-DOA-06) */
  readonly escalatedFromRuleCode: string | null
  readonly amountBasis: 'GROSS' | 'NET'
  readonly basisSatang: bigint | null
  /** The record kept with the route (Thai); English screens build their sentence from the fields here */
  readonly explanationTh: string
  /** The amount band of the rule the amount fell into: (lower, upper] in satang */
  readonly band: { readonly lowerSatang: bigint | null; readonly upperSatang: bigint | null } | null
  readonly steps: readonly RouteStepDto[]
  readonly createdAt: Date
}

export type TrackWhat =
  | 'CREATED'
  /** The requester's saves after a return, until the request goes again (one entry for consecutive saves) */
  | 'EDITED'
  | 'SUBMITTED'
  | 'RESUBMITTED'
  | 'APPROVED'
  | 'RETURNED'
  | 'REJECTED'
  | 'INFO_REQUESTED'
  | 'INFO_PROVIDED'
  | 'CANCELLED'
  | 'REASSIGNED'
  | 'DRAFT_OPEN'
  | 'WAIT_APPROVAL'
  | 'WAIT_ANSWER'
  | 'WAIT_REQUESTER_EDIT'
  | 'WAIT_PROCUREMENT'
  | 'WAIT_QUEUE'
  | 'WAIT_DELIVERY'
  | 'NEXT_APPROVAL'
  | 'NEXT_PROCUREMENT'

/** One step of the tracking timeline (FR-INT-008 AC1, FR-PLT-003 AC3): done steps come from Events, the rest from the state */
export interface TrackEntryDto {
  readonly key: string
  readonly state: 'done' | 'current' | 'upcoming'
  readonly what: TrackWhat
  readonly at: Date | null
  readonly channel: string | null
  /** null: the system, or a team such as procurement */
  readonly actor: MemberRefDto | null
  readonly onBehalfOf: MemberRefDto | null
  readonly role: ApproverRoleDto | null
  readonly expected: ExpectedApproverDto | null
  readonly doa: DoaRefDto | null
  /** A reason, a question or an answer, quoted as written */
  readonly note: string | null
  /** REASSIGNED: who has the task now */
  readonly other: MemberRefDto | null
  readonly number: string | null
  readonly stepNo: number | null
  readonly waitingMinutes: number | null
  readonly dueAt: Date | null
  readonly overdue: boolean
  /**
   * A decision on a step escalated past its time with a co-assignee (BR-SLA-04: the route's own DOA reference with the
   * escalated flag), whoever of the two decided it. Set by historyOf when the caller names the escalated tasks
   */
  readonly escalated?: boolean
  /** WAIT_DELIVERY: the suppliers the goods wait for (StageDto DELIVERY); none: the step names procurement */
  readonly suppliers?: readonly NameDto[]
}

export interface RequesterActionsDto {
  /** DRAFT or RETURNED: /requests/<id>/edit */
  readonly canEdit: boolean
  readonly canResubmit: boolean
  readonly canCancel: boolean
}

export interface RequestViewDto {
  readonly id: string
  readonly number: string | null
  readonly title: string
  readonly status: RequestStatusDto
  readonly documentType: 'PURCHASE_REQUEST' | 'SUPPLIER_REQUEST'
  readonly requestType: { readonly code: string; readonly name: NameDto }
  readonly requester: MemberRefDto
  readonly requesterDepartment: DepartmentRefDto | null
  readonly chargedDepartment: DepartmentRefDto | null
  readonly urgency: 'NORMAL' | 'URGENT'
  readonly neededBy: string | null
  readonly createdAt: Date
  readonly submittedAt: Date | null
  readonly approvedAt: Date | null
  readonly cancelledAt: Date | null
  /** null until submitted: totals come from core/money at submit, never from the client */
  readonly totals: TotalsDto | null
  readonly lines: readonly LineDto[]
  readonly budget: BudgetDto | null
  readonly fields: readonly FieldDto[]
  readonly attachments: readonly AttachmentDto[]
  readonly quotations: readonly QuotationDto[]
  readonly nonLowestQuoteReason: string | null
  readonly infoRequests: readonly InfoRequestDto[]
  readonly openInfoRequest: InfoRequestDto | null
  readonly route: RouteDto | null
  /** "อนุมัติภายใต้ DOA-DEMO ฉบับ 1 ข้อ PR-02" (FR-DOA-005 AC2) */
  readonly approvedUnder: DoaRefDto | null
  /** The reason of the last return, while the request waits for the requester */
  readonly returnReason: string | null
  readonly cancelReason: string | null
  /** Where the goods go (S4-02, BR-CONS-01); null: not chosen */
  readonly deliverySite: { readonly code: string; readonly name: string; readonly address: string | null } | null
  /** The supplier the requester suggested, with the basic details every member may see (§2.4 supplier.view) */
  readonly suggestedSupplier: { readonly code: string; readonly name: NameDto } | null
  readonly stage: StageDto
  readonly track: readonly TrackEntryDto[]
  readonly actions: RequesterActionsDto
}

const DONE_STATUSES = ['APPROVED', 'PARTIALLY_ORDERED', 'ORDERED', 'COMPLETED'] as const

/** What the requester may do now, by the state machines of §6.4 (the services check again) */
function requesterActions(status: string, documentType: string): RequesterActionsDto {
  const allows = (command: RequestCommand) => {
    // A new-supplier request follows its own machine (§6.4), as the cancel command does; it is never resubmitted
    if (documentType === 'SUPPLIER_REQUEST') return command === 'request.cancel' && transition(SUPPLIER_REQUEST_MACHINE, status as SupplierRequestState, 'request.cancel').ok
    return transition(REQUEST_MACHINE, status as RequestState, command).ok
  }
  return { canEdit: status === 'DRAFT' || status === 'RETURNED', canResubmit: allows('request.resubmit'), canCancel: allows('request.cancel') }
}

const SatangText = z.string().regex(/^\d{1,18}$/).transform((v) => BigInt(v))
const RuleWhen = z.object({ amount: z.object({ gt: SatangText.optional(), gte: SatangText.optional(), lte: SatangText.optional() }).optional() })
const RuleSteps = z.array(
  z.object({
    approver: z.union([
      z.object({ kind: z.enum(['POSITION_OF_DEPARTMENT', 'POSITION_OF_ORG']), position: z.string() }),
      z.object({ kind: z.literal('MEMBER'), memberId: z.string() }),
    ]),
  }),
)

/** The band of a stored rule (BR-DOA-02), or null when it has no amount condition */
function bandOfRule(when: unknown): RouteDto['band'] {
  const parsed = RuleWhen.safeParse(when)
  if (!parsed.success || !parsed.data.amount) return null
  const band = bandOf(parsed.data.amount)
  return { lowerSatang: band.lower, upperSatang: band.upper }
}

const FormFields = z.object({ fields: z.array(FieldDefSchema) })

/** Form fields with a value, in the order of the form, with their labels (FieldDef.label, both languages) */
function fieldsOf(schema: unknown, data: unknown, refs: Map<string, NameDto>): FieldDto[] {
  const parsed = FormFields.safeParse(schema)
  const values = (data && typeof data === 'object' ? data : {}) as Record<string, unknown>
  if (!parsed.success) return []
  const out: FieldDto[] = []
  for (const def of parsed.data.fields as FieldDef[]) {
    const value = fieldValue(def, values[def.id], refs)
    if (value) out.push({ id: def.id, label: def.label ?? null, value })
  }
  return out
}

/** Fields that hold the id of a row of the organization, shown by its name */
const REFERENCE_FIELDS: ReadonlySet<string> = new Set(['member', 'department', 'costCenter', 'budgetLine', 'supplier', 'deliverySite'])

function fieldValue(def: FieldDef, raw: unknown, refs: Map<string, NameDto>): FieldValueDto | null {
  if (raw === undefined || raw === null || raw === '' || (Array.isArray(raw) && raw.length === 0)) return null
  const option = (value: string) => ({ value, label: def.optionLabels?.[value] ?? null })
  if (REFERENCE_FIELDS.has(def.type)) {
    // An id that names no row of the organization is not shown
    const name = typeof raw === 'string' ? refs.get(raw) : undefined
    return name ? { kind: 'NAME', name } : null
  }
  switch (def.type) {
    case 'select':
      return typeof raw === 'string' ? { kind: 'OPTIONS', options: [option(raw)] } : null
    case 'multiselect':
      return Array.isArray(raw) ? { kind: 'OPTIONS', options: raw.filter((v): v is string => typeof v === 'string').map(option) } : null
    case 'checkbox':
      return typeof raw === 'boolean' ? { kind: 'BOOLEAN', value: raw } : null
    case 'date':
      return typeof raw === 'string' ? { kind: 'DATE', date: raw } : null
    case 'money':
      return typeof raw === 'string' && /^\d{1,13}(\.\d{1,2})?$/.test(raw) ? { kind: 'MONEY', satang: amountToSatang(raw) } : null
    case 'attachment':
    case 'lineItems':
      return Array.isArray(raw) ? { kind: 'COUNT', count: raw.length } : null
    default:
      return typeof raw === 'string' || typeof raw === 'number' ? { kind: 'TEXT', text: String(raw) } : null
  }
}

/**
 * Names of the rows the form's reference fields point at (members, departments, cost centers, budget lines, suppliers
 * by their basic details, delivery sites)
 */
async function referenceNames(db: TenantDb, data: unknown, members: Map<string, MemberRefDto>, departments: Map<string, DepartmentRefDto>): Promise<Map<string, NameDto>> {
  const ids = Object.values((data && typeof data === 'object' ? data : {}) as Record<string, unknown>).filter((v): v is string => typeof v === 'string' && isUuid(v))
  const refs = new Map<string, NameDto>()
  if (ids.length === 0) return refs
  const [costCenters, budgetLines, suppliers, sites] = await Promise.all([
    db.costCenter.findMany({ where: { id: { in: ids } }, select: { id: true, code: true, nameTh: true } }),
    db.budgetLine.findMany({ where: { id: { in: ids } }, select: { id: true, code: true, nameTh: true } }),
    db.supplier.findMany({ where: { id: { in: ids } }, select: { id: true, code: true, nameTh: true, nameEn: true } }),
    db.deliverySite.findMany({ where: { id: { in: ids } }, select: { id: true, code: true, nameTh: true } }),
  ])
  for (const id of ids) {
    const name = members.get(id)?.name ?? departments.get(id)?.name
    if (name) refs.set(id, name)
  }
  for (const row of [...costCenters, ...budgetLines, ...sites]) refs.set(row.id, { th: `${row.code} · ${row.nameTh}`, en: null })
  for (const s of suppliers) refs.set(s.id, { th: `${s.code} · ${s.nameTh}`, en: s.nameEn ? `${s.code} · ${s.nameEn}` : null })
  return refs
}

type EventRow = {
  readonly id: string
  readonly type: string
  readonly aggregateType: string
  readonly aggregateId: string
  readonly occurredAt: Date
  readonly actorType: string
  readonly actorMemberId: string | null
  readonly onBehalfOfMemberId: string | null
  readonly channel: string
  readonly doaVersionId: string | null
  readonly doaRuleCode: string | null
  readonly data: unknown
}

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null)

/**
 * The documented history of a document as timeline steps (FR-PLT-003 AC3): one step per meaningful Event.
 * `escalatedTaskIds`: the tasks of steps escalated with a co-assignee (escalatedTaskIdsOf): their decisions carry the flag
 */
export async function historyOf(
  db: TenantDb,
  events: readonly EventRow[],
  taskRoleById: Map<string, string>,
  roleOf: (resolvedFrom: string | null | undefined) => ApproverRoleDto,
  escalatedTaskIds: ReadonlySet<string> = new Set(),
  hiddenReasonTaskIds: ReadonlySet<string> = new Set(),
): Promise<TrackEntryDto[]> {
  const dataOf = (e: EventRow) => (e.data && typeof e.data === 'object' ? (e.data as Record<string, unknown>) : {})
  const commentIds = events.flatMap((e) => [str(dataOf(e).reasonCommentId)]).filter(present)
  const infoIds = events.flatMap((e) => [str(dataOf(e).infoRequestId)]).filter(present)
  const versionIds = events.flatMap((e) => [e.doaVersionId, str(dataOf(e).doaVersionId)]).filter(present)
  const [comments, infos, versions] = await Promise.all([
    commentIds.length ? db.comment.findMany({ where: { id: { in: commentIds } }, select: { id: true, body: true, retractedAt: true } }) : Promise.resolve([]),
    infoIds.length ? db.infoRequest.findMany({ where: { id: { in: infoIds } }, select: { id: true, question: true, answer: true } }) : Promise.resolve([]),
    doaVersionsById(db, versionIds),
  ])
  const members = await membersById(db, events.flatMap((e) => [e.actorMemberId, e.onBehalfOfMemberId, str(dataOf(e).onBehalfOfMemberId), str(dataOf(e).toMemberId)]))
  const comment = new Map(comments.map((c) => [c.id, c.retractedAt ? null : c.body]))
  const info = new Map(infos.map((i) => [i.id, i]))

  const entries: TrackEntryDto[] = []
  let created = false
  // Between a return and the next sending, every save of the requester is part of one edit
  let editing = false
  for (const e of events) {
    const data = dataOf(e)
    const base = {
      key: e.id,
      state: 'done' as const,
      at: e.occurredAt,
      channel: e.channel,
      actor: e.actorType === 'USER' && e.actorMemberId ? (members.get(e.actorMemberId) ?? null) : null,
      onBehalfOf: null as MemberRefDto | null,
      role: null as ApproverRoleDto | null,
      expected: null,
      doa: null as DoaRefDto | null,
      note: null as string | null,
      other: null as MemberRefDto | null,
      number: null as string | null,
      stepNo: null,
      waitingMinutes: null,
      dueAt: null,
      overdue: false,
    }
    switch (e.type) {
      case 'request.drafted': {
        // Every save is an Event: the first one started the request; saves before the first sending are part of making
        // it; saves after a return are the requester's edit (FR-PLT-003 AC3), consecutive ones shown as one at the last
        if (!created) {
          entries.push({ ...base, what: 'CREATED' })
          created = true
          break
        }
        if (!editing) break
        const last = entries.at(-1)
        if (last?.what === 'EDITED') entries[entries.length - 1] = { ...base, key: last.key, what: 'EDITED' }
        else entries.push({ ...base, what: 'EDITED' })
        break
      }
      case 'request.submitted':
      case 'doa_version.submitted':
      case 'org_authority_change.submitted':
        entries.push({ ...base, what: 'SUBMITTED', number: str(data.number) })
        break
      case 'request.resubmitted':
        editing = false
        entries.push({ ...base, what: 'RESUBMITTED' })
        break
      case 'approval_task.decided': {
        // The Event columns carry the DOA reference (INV-DOA-01); events written before they did keep it in data
        const versionId = e.doaVersionId ?? str(data.doaVersionId)
        const ruleCode = e.doaRuleCode ?? str(data.doaRuleCode)
        const version = versionId ? versions.get(versionId) : undefined
        const behalf = e.onBehalfOfMemberId ?? str(data.onBehalfOfMemberId)
        const reasonId = str(data.reasonCommentId)
        if (data.decision === 'RETURN') editing = true
        entries.push({
          ...base,
          what: data.decision === 'APPROVE' ? 'APPROVED' : data.decision === 'RETURN' ? 'RETURNED' : 'REJECTED',
          onBehalfOf: behalf ? (members.get(behalf) ?? null) : null,
          role: roleOf(taskRoleById.get(e.aggregateId)),
          doa: version && ruleCode ? { versionId: version.id, code: version.code, versionNo: version.versionNo, ruleCode } : null,
          note: reasonId && !hiddenReasonTaskIds.has(e.aggregateId) ? (comment.get(reasonId) ?? null) : null,
          ...(escalatedTaskIds.has(e.aggregateId) ? { escalated: true } : {}),
        })
        break
      }
      case 'request.info_requested': {
        const id = str(data.infoRequestId)
        entries.push({ ...base, what: 'INFO_REQUESTED', note: id ? (info.get(id)?.question ?? null) : null })
        break
      }
      case 'request.info_provided': {
        const id = str(data.infoRequestId)
        entries.push({ ...base, what: 'INFO_PROVIDED', note: id ? (info.get(id)?.answer ?? null) : null })
        break
      }
      case 'request.cancelled': {
        const reasonId = str(data.reasonCommentId)
        entries.push({ ...base, what: 'CANCELLED', note: reasonId ? (comment.get(reasonId) ?? null) : null })
        break
      }
      case 'approval_task.reassigned': {
        const to = str(data.toMemberId)
        entries.push({ ...base, what: 'REASSIGNED', other: to ? (members.get(to) ?? null) : null })
        break
      }
      default:
        // Budget, notification and bookkeeping events (assigned, cancelled tasks) are not steps of the document
        break
    }
  }
  return entries
}

type EscalationOutcome = NonNullable<RouteStepDto['escalation']>
const isEscalationOutcome = (v: unknown): v is EscalationOutcome => v === 'CO_ASSIGNED' || v === 'NO_NEXT_BAND'

/** How each escalated step was escalated, by step id, from its approval_task.escalated events (once per step, BR-SLA-04) */
function escalationsOf(events: ReadonlyArray<{ readonly type: string; readonly data: unknown }>): Map<string, EscalationOutcome> {
  const byStep = new Map<string, EscalationOutcome>()
  for (const e of events) {
    if (e.type !== 'approval_task.escalated' || !e.data || typeof e.data !== 'object') continue
    const data = e.data as Record<string, unknown>
    const stepId = str(data.stepId)
    if (stepId && isEscalationOutcome(data.outcome) && !byStep.has(stepId)) byStep.set(stepId, data.outcome)
  }
  return byStep
}

/**
 * The tasks whose decision carries the escalated flag (BR-SLA-04): every task of a step the approver of the band above
 * joined as co-assignee — the first assignee's, the co-assignee's, and a task moved from either
 */
export function escalatedTaskIdsOf(events: ReadonlyArray<{ readonly type: string; readonly data: unknown }>, tasks: ReadonlyArray<{ readonly id: string; readonly stepId: string }>): Set<string> {
  const escalations = escalationsOf(events)
  return new Set(tasks.filter((t) => escalations.get(t.stepId) === 'CO_ASSIGNED').map((t) => t.id))
}

/** The events of a document and of every approval task on it, in the order they happened */
export async function documentEvents(db: TenantDb, aggregateType: string, aggregateId: string, taskIds: readonly string[]): Promise<EventRow[]> {
  return db.event.findMany({
    where: { OR: [{ aggregateType, aggregateId }, ...(taskIds.length ? [{ aggregateType: 'ApprovalTask', aggregateId: { in: [...taskIds] } }] : [])] },
    select: { id: true, type: true, aggregateType: true, aggregateId: true, occurredAt: true, actorType: true, actorMemberId: true, onBehalfOfMemberId: true, channel: true, doaVersionId: true, doaRuleCode: true, data: true },
    orderBy: { seq: 'asc' },
  })
}

/** The route of a document as stored, with the person on each step and the approver the rule names for later steps */
export async function routeOf(
  db: TenantDb,
  routeId: string,
  members: Map<string, MemberRefDto>,
  roleOf: (resolvedFrom: string | null | undefined) => ApproverRoleDto,
): Promise<RouteDto | null> {
  const route = await db.approvalRoute.findUnique({
    where: { id: routeId },
    include: {
      doaVersion: { select: { id: true, code: true, versionNo: true } },
      // A step's tasks in the order they were made: by assignedAt, and by id (uuid v7, made in time order) when two share
      // the business time a fixed clock gave them
      steps: {
        orderBy: { stepNo: 'asc' },
        include: {
          tasks: {
            orderBy: [{ assignedAt: 'asc' }, { id: 'asc' }],
            select: { id: true, status: true, slotNo: true, workflowRuleCodes: true, assigneeMemberId: true, principalMemberId: true, decidedByMemberId: true, resolvedFrom: true, decision: true, decidedAt: true },
          },
        },
      },
    },
  })
  if (!route) return null
  const rules = await db.doaRule.findMany({ where: { doaVersionId: route.doaVersionId, code: { in: [route.ruleCode, ...(route.escalatedFromRuleCode ? [route.escalatedFromRuleCode] : [])] } }, select: { code: true, when: true, steps: true } })
  const rule = rules.find((r) => r.code === route.ruleCode)
  const amountRule = rules.find((r) => r.code === (route.escalatedFromRuleCode ?? route.ruleCode))
  const specs = RuleSteps.safeParse(rule?.steps)
  const positions = specs.success ? await db.position.findMany({ where: { code: { in: specs.data.flatMap((s) => ('position' in s.approver ? [s.approver.position] : [])) } }, select: { code: true, nameTh: true, nameEn: true } }) : []
  const named = specs.success ? await membersById(db, specs.data.flatMap((s) => ('memberId' in s.approver ? [s.approver.memberId] : []))) : new Map<string, MemberRefDto>()
  const missing = route.steps.flatMap((s) => s.tasks.flatMap((t) => [t.assigneeMemberId, t.principalMemberId, t.decidedByMemberId])).filter((id): id is string => Boolean(id) && !members.has(id!))
  const taskIds = route.steps.flatMap((s) => s.tasks.map((t) => t.id))
  const [more, escalatedEvents, assignedEvents] = await Promise.all([
    membersById(db, missing),
    taskIds.length ? db.event.findMany({ where: { type: 'approval_task.escalated', aggregateType: 'ApprovalTask', aggregateId: { in: taskIds } }, select: { type: true, data: true }, orderBy: { seq: 'asc' } }) : Promise.resolve([]),
    taskIds.length ? db.event.findMany({ where: { type: 'approval_task.assigned', aggregateType: 'ApprovalTask', aggregateId: { in: taskIds } }, select: { aggregateId: true, data: true } }) : Promise.resolve([]),
  ])
  const escalations = escalationsOf(escalatedEvents)
  // S6-08 (BR-WF-14): the tasks that went to the holder of the time their step started, not to the one of the submit
  const holderChanged = new Set(assignedEvents.filter((e) => typeof (e.data as { holderChangedFrom?: unknown } | null)?.holderChangedFrom === 'string').map((e) => e.aggregateId))
  const who = (id: string | null) => (id ? (members.get(id) ?? more.get(id) ?? null) : null)
  const expectedOf = (stepNo: number): ExpectedApproverDto | null => {
    const spec = specs.success ? specs.data[stepNo - 1] : undefined
    if (!spec) return null
    if ('memberId' in spec.approver) return { kind: 'MEMBER', member: named.get(spec.approver.memberId) ?? null }
    const code = spec.approver.position
    const p = positions.find((x) => x.code === code)
    return { kind: 'POSITION', positionCode: code, position: p ? { th: p.nameTh, en: p.nameEn } : null }
  }
  return {
    id: route.id,
    routeNo: route.routeNo,
    status: route.status,
    doa: { versionId: route.doaVersion.id, code: route.doaVersion.code, versionNo: route.doaVersion.versionNo, ruleCode: route.ruleCode },
    escalatedFromRuleCode: route.escalatedFromRuleCode,
    amountBasis: route.amountBasis,
    basisSatang: route.amountSatang,
    explanationTh: route.explanationTh,
    band: amountRule ? bandOfRule(amountRule.when) : null,
    createdAt: route.createdAt,
    steps: route.steps.map((s) => {
      const slotted = s.kind === 'REVIEW' || s.mode === 'PARALLEL'
      const slots = slotsOfStep(s, route.ruleCode, who, roleOf)
      const groups = s.kind === 'REVIEW' ? ReviewGroups.safeParse(s.reviewGroups) : null
      // A step of several slots comes to what its slots come to (BR-WF-01), not to its first decision
      const outcome =
        slotted && s.tasks.length
          ? stepOutcome({ kind: s.kind, quorum: s.quorum, quorumCount: s.quorumCount, ...(groups?.success ? { groups: groups.data.map((g) => ({ quorum: g.quorum, quorumCount: g.quorumCount ?? null, slots: g.slotNos })) } : {}), slots: slotDecisions(slots) })
          : null
      const slottedDecision = outcome?.ok ? DECISION_OF[outcome.data.outcome] : null
      // The task that decided the step names it — not the co-assignee's task its decision cancelled (BR-SLA-04,
      // NEW-46); while nobody has decided, the open ones; a step closed with nothing decided shows its latest task
      const decided = slotted ? (slottedDecision ? s.tasks.find((t) => t.decision === slottedDecision) : undefined) : s.tasks.find((t) => t.decision !== null)
      const open = decided ? [] : s.tasks.filter((t) => isOpenTask(t.status))
      const task = decided ?? open[0] ?? s.tasks.at(-1) ?? null
      // The rule's own approver of the step: its first task, assigned when the step started (a co-assignee or a moved
      // task is made later, even at the same business time)
      const first = s.tasks[0] ?? null
      return {
        stepNo: s.stepNo,
        status: s.status,
        approver: task ? who(task.assigneeMemberId) : null,
        onBehalfOf: task ? who(task.principalMemberId) : null,
        role: task ? roleOf(task.resolvedFrom) : null,
        // The DOA rule's approver of a later step, by its DOA step number (a REVIEW step has none, BR-WF-06)
        expected: task || s.doaStepNo === null ? null : expectedOf(s.doaStepNo),
        taskStatus: task?.status ?? null,
        decision: task?.decision ?? null,
        decidedAt: task?.decidedAt ?? null,
        open: open.map((t) => ({ taskId: t.id, approver: who(t.assigneeMemberId), onBehalfOf: who(t.principalMemberId), role: roleOf(t.resolvedFrom), status: t.status as StepTaskDto['status'] })),
        escalation: escalations.get(s.id) ?? null,
        ruleApprover: first ? { approver: who(first.assigneeMemberId), onBehalfOf: who(first.principalMemberId), role: roleOf(first.resolvedFrom) } : null,
        stepType: s.kind === 'REVIEW' ? 'REVIEW' : s.mode === 'PARALLEL' ? 'COMMITTEE' : 'APPROVAL',
        ...(s.tasks.some((t) => holderChanged.has(t.id)) ? { holderChanged: true } : {}),
        doaStepNo: s.doaStepNo,
        quorum: s.quorum,
        quorumCount: s.quorumCount,
        ...(groups?.success ? { groups: groups.data.map((g) => ({ ruleCodes: g.ruleCodes, quorum: g.quorum, quorumCount: g.quorumCount ?? null, slotNos: g.slotNos })) } : {}),
        slots,
      } satisfies RouteStepDto
    }),
  }
}

const ReviewGroups = z.array(
  z.object({ ruleCodes: z.array(z.string()).default([]), quorum: z.enum(['ALL', 'ANY', 'COUNT']), quorumCount: z.number().int().positive().nullable().optional(), slotNos: z.array(z.number().int().positive()).min(1) }),
)
const DECISION_OF = { OPEN: null, APPROVED: 'APPROVE', RETURNED: 'RETURN', REJECTED: 'REJECT' } as const

type SlotTask = {
  id: string
  status: string
  slotNo: number
  workflowRuleCodes: string[]
  assigneeMemberId: string
  principalMemberId: string | null
  decidedByMemberId: string | null
  resolvedFrom: string | null
  decision: string | null
  decidedAt: Date | null
}

/** The slots of a stored step from its tasks: the first decision of a slot is its result (§6.4, BR-WF-01) */
function slotsOfStep(
  step: { readonly kind: string; readonly tasks: readonly SlotTask[] },
  routeRuleCode: string,
  who: (id: string | null) => MemberRefDto | null,
  roleOf: (resolvedFrom: string | null | undefined) => ApproverRoleDto,
): RouteSlotDto[] {
  const numbers = [...new Set(step.tasks.map((t) => t.slotNo))].sort((a, b) => a - b)
  return numbers.map((slotNo) => {
    const tasks = step.tasks.filter((t) => t.slotNo === slotNo)
    const decided = tasks.filter((t) => t.decision !== null && t.decidedAt !== null).sort((a, b) => a.decidedAt!.getTime() - b.decidedAt!.getTime())[0]
    const decision = (decided?.decision ?? null) as RouteSlotDto['decision']
    const status: RouteSlotDto['status'] = decision ?? (tasks.some((t) => t.status === 'OPEN') ? 'OPEN' : tasks.some((t) => t.status === 'INFO_REQUESTED') ? 'QUESTION' : 'CLOSED')
    const decider = decided?.decidedByMemberId ?? null
    const onBehalf = decided && decider && decided.principalMemberId && decided.principalMemberId !== decider ? decided.principalMemberId : null
    return {
      slotNo,
      ruleCodes: step.kind === 'REVIEW' ? [...new Set(tasks.flatMap((t) => t.workflowRuleCodes))] : [routeRuleCode],
      status,
      holders: tasks.map((t) => ({ taskId: t.id, approver: who(t.assigneeMemberId), onBehalfOf: who(t.principalMemberId), role: roleOf(t.resolvedFrom), status: t.status })),
      decidedBy: who(decider),
      decidedOnBehalfOf: who(onBehalf),
      decision,
      decidedAt: decided?.decidedAt ?? null,
      decidedTaskId: decided?.id ?? null,
    }
  })
}

/** What each slot came to, slot 1 first, for stepOutcome (a slot number with no task counts as not decided) */
function slotDecisions(slots: readonly RouteSlotDto[]): (SlotDecision | null)[] {
  const last = Math.max(0, ...slots.map((s) => s.slotNo))
  return Array.from({ length: last }, (_, i) => slots.find((s) => s.slotNo === i + 1)?.decision ?? null)
}

/** The live part of the timeline: where the request waits now and what comes after (FR-INT-008 AC1) */
function liveSteps(request: { status: string; requester: MemberRefDto }, stage: StageDto, route: RouteDto | null, requesterQuestion: string | null): TrackEntryDto[] {
  const entry = (key: string, state: 'current' | 'upcoming', what: TrackWhat, more: Partial<TrackEntryDto> = {}): TrackEntryDto => ({
    key,
    state,
    what,
    at: null,
    channel: null,
    actor: null,
    onBehalfOf: null,
    role: null,
    expected: null,
    doa: null,
    note: null,
    other: null,
    number: null,
    stepNo: null,
    waitingMinutes: null,
    dueAt: null,
    overdue: false,
    ...more,
  })
  const later = (route?.status === 'ACTIVE' ? route.steps : []).filter((s) => s.status === 'WAITING').map((s) => entry(`next-${s.stepNo}`, 'upcoming', 'NEXT_APPROVAL', { stepNo: s.stepNo, expected: s.expected }))
  // One current entry for every approver who may decide the step now: an escalated step shows its first assignee and
  // its co-assignee, as its route does (BR-SLA-04, NEW-46)
  const waiting = (approvers: readonly WaitingApproverDto[], stepNo: number | null, first: string | null) =>
    approvers.map((a) =>
      entry(a.taskId === first ? 'waiting' : `waiting-${a.taskId}`, 'current', 'WAIT_APPROVAL', {
        actor: a.assignee,
        onBehalfOf: a.onBehalfOf,
        role: a.role,
        at: a.since,
        waitingMinutes: a.waitingMinutes,
        dueAt: a.dueAt,
        overdue: a.overdue,
        stepNo,
      }),
    )
  const stepOfTask = (taskId: string) => route?.steps.find((s) => (s.open ?? []).some((o) => o.taskId === taskId))?.stepNo ?? null
  switch (stage.kind) {
    case 'DRAFT':
      return [entry('draft', 'current', 'DRAFT_OPEN', { actor: request.requester, at: stage.since })]
    case 'APPROVER':
      return [...waiting(stage.approvers ?? [stage], stage.stepNo, stage.taskId), ...later, entry('procurement', 'upcoming', 'NEXT_PROCUREMENT')]
    case 'ANSWER':
      return [
        entry('answer', 'current', 'WAIT_ANSWER', { actor: request.requester, other: stage.askedBy, at: stage.since, note: requesterQuestion ?? stage.question, waitingMinutes: stage.waitingMinutes ?? null }),
        ...waiting(stage.approvers ?? [], stepOfTask(stage.taskId), null),
        ...later,
        entry('procurement', 'upcoming', 'NEXT_PROCUREMENT'),
      ]
    case 'REQUESTER_EDIT':
      return [entry('edit', 'current', 'WAIT_REQUESTER_EDIT', { actor: request.requester, at: stage.since, waitingMinutes: stage.waitingMinutes ?? null })]
    case 'PROCUREMENT':
      return [entry('procurement', 'current', 'WAIT_PROCUREMENT', { at: stage.since, waitingMinutes: stage.waitingMinutes })]
    case 'QUEUE':
      return [entry('queue', 'current', 'WAIT_QUEUE', { at: stage.since, waitingMinutes: stage.waitingMinutes })]
    case 'DELIVERY':
      // Whom the goods wait for — the suppliers of the POs that went out — and for how long (§9.9 principle 4)
      return [entry('delivery', 'current', 'WAIT_DELIVERY', { at: stage.since ?? null, waitingMinutes: stage.waitingMinutes ?? null, suppliers: stage.suppliers ?? [] })]
    default:
      return []
  }
}

/**
 * BR-WF-09 (S6): the tasks of a REVIEW step whose reasons the reader may not read. A reviewer's reason is read by the
 * requester, the approvers of the request's DOA steps, AUDITOR and the reviewers of that slot (with whoever acts for
 * them); everyone else — a reviewer of another slot among them — sees the decision and not its reason.
 */
export async function hiddenReviewReasons(
  db: TenantDb,
  ctx: Ctx,
  requesterMemberId: string,
  tasks: ReadonlyArray<{ readonly id: string; readonly stepId: string; readonly slotNo: number; readonly assigneeMemberId: string; readonly principalMemberId: string | null; readonly step: { readonly kind: string } }>,
): Promise<Set<string>> {
  const reviews = tasks.filter((t) => t.step.kind === 'REVIEW')
  if (reviews.length === 0) return new Set()
  const reader = ctx.actor.type === 'USER' ? ctx.actor.memberId : null
  if (reader === requesterMemberId) return new Set()
  const holds = (t: (typeof tasks)[number]) => reader !== null && (t.assigneeMemberId === reader || t.principalMemberId === reader)
  if (tasks.some((t) => t.step.kind !== 'REVIEW' && holds(t))) return new Set()
  if (reader && (await db.roleAssignment.count({ where: { memberId: reader, role: 'AUDITOR', revokedAt: null } })) > 0) return new Set()
  const ownSlots = new Set(reviews.filter(holds).map((t) => `${t.stepId}:${t.slotNo}`))
  return new Set(reviews.filter((t) => !ownSlots.has(`${t.stepId}:${t.slotNo}`)).map((t) => t.id))
}

/** A line of a request that has a service end date: what its renew button names and sends (S6-12 · FR-INT-101 AC2) */
export interface ServiceLineDto {
  readonly id: string
  readonly lineNo: number
  readonly description: string
  /** YYYY-MM-DD */
  readonly serviceEndDate: string
}

/** The service lines of a request in line order (the page checks request.view first; the renewal checks the requester) */
export async function getServiceLines(ctx: Ctx, requestId: string): Promise<ServiceLineDto[]> {
  if (!isUuid(requestId)) return []
  const lines = await forTenant(ctx.organizationId).requestLine.findMany({
    where: { requestId, serviceEndDate: { not: null } },
    orderBy: { lineNo: 'asc' },
    select: { id: true, lineNo: true, description: true, serviceEndDate: true },
  })
  return lines.map((l) => ({ id: l.id, lineNo: l.lineNo, description: l.description, serviceEndDate: l.serviceEndDate!.toISOString().slice(0, 10) }))
}

export async function getRequestView(ctx: Ctx, requestId: string): Promise<RequestViewDto | null> {
  if (!isUuid(requestId)) return null
  const db = forTenant(ctx.organizationId)
  const request = await db.request.findUnique({
    where: { id: requestId },
    include: {
      lines: { orderBy: { lineNo: 'asc' } },
      requestType: { select: { code: true, nameTh: true, nameEn: true } },
      formVersion: { select: { schema: true } },
      requester: { select: { id: true, displayNameTh: true, displayNameEn: true } },
      budgetLine: { select: { id: true, code: true, nameTh: true, status: true } },
      quotations: { orderBy: { createdAt: 'asc' }, select: { supplierName: true, amountSatang: true, includesVat: true, netSatang: true, isSelected: true } },
      infoRequests: { orderBy: { askedAt: 'asc' } },
      deliverySite: { select: { code: true, nameTh: true, address: true } },
      suggestedSupplier: { select: { code: true, nameTh: true, nameEn: true } },
    },
  })
  if (!request) return null

  const departments = await departmentsOf(db)
  const roleOf = await approverRoles(db, departments.byCode)
  const [allTasks, allocations, links] = await Promise.all([
    db.approvalTask.findMany({
      where: { step: { route: { subjectType: 'REQUEST', subjectId: request.id } } },
      select: { id: true, stepId: true, slotNo: true, status: true, resolvedFrom: true, reason: true, decision: true, decidedAt: true, assigneeMemberId: true, principalMemberId: true, step: { select: { kind: true } } },
    }),
    request.lines.length
      ? db.budgetAllocation.findMany({ where: { sourceType: 'REQUEST_LINE', sourceId: { in: request.lines.map((l) => l.id) } }, select: { budgetLineId: true, reservedSatang: true, committedSatang: true, actualSatang: true } })
      : Promise.resolve([]),
    db.fileLink.findMany({ where: { subjectType: 'Request', subjectId: request.id }, orderBy: { createdAt: 'asc' }, include: { file: { select: { id: true, fileName: true, sizeBytes: true, status: true } } } }),
  ])
  const formMemberIds = Object.values((request.formData ?? {}) as Record<string, unknown>).filter((v): v is string => typeof v === 'string' && isUuid(v))
  const stages = await stageContext(db, ctx, [request], [...request.infoRequests.flatMap((i) => [i.askedById, i.answeredById]), ...formMemberIds])
  const members = stages.members
  members.set(request.requester.id, memberRef(request.requester))
  const route = request.currentRouteId ? await routeOf(db, request.currentRouteId, members, roleOf) : null
  const stage = stageOf(request, stages)

  // A question whose task closed unanswered needs no answer any more (its task is cancelled with its step's decision,
  // BR-SLA-04, or with the route); a question that moved with its task (a delegation) still waits
  const taskById = new Map(allTasks.map((t) => [t.id, t]))
  const decidedSteps = new Set(allTasks.filter((t) => t.decision !== null).map((t) => t.stepId))
  const noLongerNeeded = (i: { taskId: string; answeredAt: Date | null }): InfoRequestDto['noLongerNeeded'] => {
    const task = taskById.get(i.taskId)
    if (i.answeredAt || !task || isOpenTask(task.status)) return null
    return decidedSteps.has(task.stepId) ? 'STEP_DECIDED' : 'CLOSED'
  }
  const infoRequests: InfoRequestDto[] = request.infoRequests.map((i) => ({
    id: i.id,
    taskId: i.taskId,
    question: i.question,
    askedBy: members.get(i.askedById) ?? null,
    askedAt: i.askedAt,
    answer: i.answer,
    answeredBy: i.answeredById ? (members.get(i.answeredById) ?? null) : null,
    answeredAt: i.answeredAt,
    noLongerNeeded: noLongerNeeded(i),
  }))
  const openInfoRequest = stage.kind === 'ANSWER' ? (infoRequests.find((i) => i.id === stage.infoRequestId) ?? infoRequests.filter((i) => !i.answeredAt && !i.noLongerNeeded).at(-1) ?? null) : null

  const events = await documentEvents(db, 'Request', request.id, allTasks.map((t) => t.id))
  const hidden = await hiddenReviewReasons(db, ctx, request.requesterMemberId, allTasks)
  const history = await historyOf(db, events, new Map(allTasks.map((t) => [t.id, t.resolvedFrom])), roleOf, escalatedTaskIdsOf(events, allTasks), hidden)

  const held = allocations.filter((a) => a.budgetLineId === request.budgetLineId)
  const sum = (pick: (a: (typeof held)[number]) => bigint) => held.reduce((total, a) => total + pick(a), 0n)
  const lastReturn = allTasks.filter((t) => t.decision === 'RETURN' && t.decidedAt && !hidden.has(t.id)).sort((a, b) => b.decidedAt!.getTime() - a.decidedAt!.getTime())[0]
  const approvedUnder = (DONE_STATUSES as readonly string[]).includes(request.status) && route?.status === 'COMPLETED' ? route.doa : null

  return {
    id: request.id,
    number: request.number,
    title: request.title,
    status: request.status as RequestStatusDto,
    documentType: request.documentType,
    requestType: { code: request.requestType.code, name: { th: request.requestType.nameTh, en: request.requestType.nameEn } },
    requester: memberRef(request.requester),
    requesterDepartment: departments.byId.get(request.requesterDepartmentId) ?? null,
    chargedDepartment: departments.byId.get(request.chargedDepartmentId) ?? null,
    urgency: request.urgency,
    neededBy: request.neededBy ? request.neededBy.toISOString().slice(0, 10) : null,
    createdAt: request.createdAt,
    submittedAt: request.submittedAt,
    approvedAt: request.approvedAt,
    cancelledAt: request.cancelledAt,
    totals:
      request.submittedAt && request.documentType === 'PURCHASE_REQUEST'
        ? { netSatang: request.netSatang, vatSatang: request.vatSatang, grossSatang: request.grossSatang, vatRateBp: request.vatRateBp, priceIncludesVat: request.priceIncludesVat }
        : null,
    lines: request.lines.map((l) => ({
      lineNo: l.lineNo,
      description: l.description,
      quantity: l.quantity.toString(),
      uom: l.uom,
      unitPriceSatang: l.unitPriceSatang,
      netSatang: l.netSatang,
      vatable: l.vatable,
      serviceEndDate: l.serviceEndDate ? l.serviceEndDate.toISOString().slice(0, 10) : null,
    })),
    budget: request.budgetLine
      ? {
          lineId: request.budgetLine.id,
          code: request.budgetLine.code,
          name: request.budgetLine.nameTh,
          status: request.budgetLine.status,
          reservedSatang: sum((a) => a.reservedSatang),
          committedSatang: sum((a) => a.committedSatang),
          actualSatang: sum((a) => a.actualSatang),
        }
      : null,
    fields: fieldsOf(request.formVersion.schema, request.formData, await referenceNames(db, request.formData, members, departments.byId)),
    attachments: links.filter((l) => l.file.status === 'AVAILABLE').map((l) => ({ fileId: l.file.id, fileName: l.file.fileName, kind: l.kind, sizeBytes: l.file.sizeBytes })),
    quotations: request.quotations,
    nonLowestQuoteReason: request.nonLowestQuoteReason,
    infoRequests,
    openInfoRequest,
    route,
    approvedUnder,
    returnReason: request.status === 'RETURNED' ? (lastReturn?.reason ?? null) : null,
    cancelReason: request.status === 'CANCELLED' ? request.cancelReason : null,
    deliverySite: request.deliverySite ? { code: request.deliverySite.code, name: request.deliverySite.nameTh, address: request.deliverySite.address } : null,
    suggestedSupplier: request.suggestedSupplier ? { code: request.suggestedSupplier.code, name: { th: request.suggestedSupplier.nameTh, en: request.suggestedSupplier.nameEn } } : null,
    stage,
    track: [...history, ...liveSteps({ status: request.status, requester: memberRef(request.requester) }, stage, route, openInfoRequest?.question ?? null)],
    actions: requesterActions(request.status, request.documentType),
  }
}
