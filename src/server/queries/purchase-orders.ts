import { documentTotals, exceedsByMoreThan, parseQuantity, vatFromNet, type Satang } from '@/core/money/math'
import { formatQuantity } from '@/core/receiving'
import { PO_MACHINE, transition, type PoState } from '@/core/state-machines'
import { rateFor, taxDateOf } from '@/core/vat'
import { OrgSettingsSchema } from '@/lib/org-settings'
import type { Ctx } from '@/server/context'
import { listTaxRates } from '@/server/db/lookups'
import { forTenant, type TenantDb } from '@/server/db/tenant'
import {
  approverRoles,
  businessCalendarOf,
  businessMinutesWaited,
  doaVersionsById,
  isUuid,
  membersById,
  routeOf,
  slaPausesOf,
  type ApproverRoleDto,
  type DoaRefDto,
  type ExpectedApproverDto,
  type MemberRefDto,
  type RequestAccessDto,
  type RouteDto,
} from './requests'

// Read-only views of purchase orders for the screens of S4-04 to S4-06 (spec §9.1 /procurement/pos, FR-P2P-003,
// FR-P2P-004, FR-P2P-005, FR-P2P-010) and for the decision page of PO and variance tasks (FR-DOA-004): the POs by
// status with whom each waits for; one PO with its lines and their source requests (BR-CONS-04) and their attachments,
// the totals the server computed (FR-P2P-003 AC3), the last three approved prices of each item (AC1), what it reserves
// or holds on each budget line, the route of the DOA rule of PURCHASE_ORDER, the sending to the supplier with a bounce
// (FR-P2P-005), what may happen next by the state machine of §6.4, and a timeline built from its Events; a variance with
// its PO line, its budget line and the photos of its receipt (§9.9 principle 5). Queries never check permissions (they
// cannot import authz): pages ask getPoAccess() and check po.view (or the task's deciders) with src/server/authz before
// they read anything else, and request.view (canViewRequest) before they link a source request or list its files.

export const PO_STATUSES = ['DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'SENT', 'PARTIALLY_RECEIVED', 'RECEIVED', 'CLOSED', 'CANCELLED', 'REJECTED'] as const
export type PoStatusDto = (typeof PO_STATUSES)[number]
export const isPoStatus = (value: string | undefined | null): value is PoStatusDto => typeof value === 'string' && (PO_STATUSES as readonly string[]).includes(value)

/** POs whose sources still order their request lines (the same list as services/procurement/pool.ts ORDERING_PO_STATUSES) */
const ORDERING: readonly PoStatusDto[] = ['DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'SENT', 'PARTIALLY_RECEIVED', 'RECEIVED', 'CLOSED']
/** POs approved at some point: the price history reads their prices (FR-P2P-003 AC1) */
const APPROVED_STATUSES: readonly PoStatusDto[] = ['APPROVED', 'SENT', 'PARTIALLY_RECEIVED', 'RECEIVED', 'CLOSED']
const OPEN_TASK = ['OPEN', 'INFO_REQUESTED'] as const
const PRICE_HISTORY_SIZE = 3
const PERCENT_TO_BP = 100
const LIST_LIMIT = 200
const SEARCH_MAX = 60

const scaled = (d: { toString(): string }) => parseQuantity(d.toString())
const quantityText = (d: { toString(): string }) => formatQuantity(scaled(d))
const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null)

/** The VAT rate of today in basis points (§6.4: the rate a draft takes when it is sent), or null when none covers today */
async function rateOfToday(ctx: Ctx): Promise<number | null> {
  const rate = rateFor(taxDateOf(ctx.now), await listTaxRates())
  return rate.ok ? rate.rateBp : null
}

/**
 * A draft's totals at today's rate, from core/money (FR-P2P-003 AC3): what sending it for approval will compute, so the
 * list, the page and the preview of the route show one amount. The stored totals keep the rate of the round that made
 * the draft (or of an earlier sending), which may be another period's.
 */
function draftTotals(lines: ReadonlyArray<{ quantity: { toString(): string }; unitPriceSatang: Satang; vatable: boolean }>, rateBp: number) {
  const t = documentTotals(
    lines.map((l) => ({ quantity: l.quantity.toString(), unitPriceSatang: l.unitPriceSatang, vatable: l.vatable })),
    rateBp,
    false,
  )
  return { netSatang: t.net, vatSatang: t.vat, grossSatang: t.gross, vatRateBp: rateBp }
}

/** A file attached to a document, as the decision page lists it (FR-PLT-004 AC2: downloads check the document again) */
export interface AttachmentDto {
  readonly fileId: string
  readonly fileName: string
  /** FileLink.kind: QUOTATION, PHOTO, DELIVERY_NOTE … */
  readonly kind: string
  readonly sizeBytes: number
}

async function attachmentsOf(db: TenantDb, subjectType: 'Request' | 'GoodsReceipt', subjectIds: readonly string[]): Promise<Map<string, AttachmentDto[]>> {
  const out = new Map<string, AttachmentDto[]>()
  if (subjectIds.length === 0) return out
  const links = await db.fileLink.findMany({
    where: { subjectType, subjectId: { in: [...subjectIds] } },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: { subjectId: true, kind: true, file: { select: { id: true, fileName: true, sizeBytes: true, status: true } } },
  })
  for (const link of links) {
    if (link.file.status !== 'AVAILABLE') continue
    out.set(link.subjectId, [...(out.get(link.subjectId) ?? []), { fileId: link.file.id, fileName: link.file.fileName, kind: link.kind, sizeBytes: link.file.sizeBytes }])
  }
  return out
}

// ---------- whom a PO waits for ----------

export type PoWaitingDto =
  /** DRAFT: procurement checks it and sends it for approval */
  | { readonly kind: 'EDIT' }
  | {
      readonly kind: 'APPROVER'
      readonly assignee: MemberRefDto | null
      readonly onBehalfOf: MemberRefDto | null
      readonly role: ApproverRoleDto
      readonly waitingMinutes: number | null
      readonly dueAt: Date | null
      readonly overdue: boolean
    }
  /** APPROVED: procurement sends it to the supplier; `bounced` when the last e-mail came back (FR-P2P-005 AC2) */
  | { readonly kind: 'SEND'; readonly bounced: boolean }
  /** SENT: the supplier delivers and the receiver records it */
  | { readonly kind: 'DELIVERY' }
  /** PARTIALLY_RECEIVED: the rest of the goods */
  | { readonly kind: 'REST' }
  /** RECEIVED: the invoice, then closing */
  | { readonly kind: 'CLOSE' }
  /** CLOSED, CANCELLED, REJECTED */
  | { readonly kind: 'NONE' }

interface WaitingContext {
  readonly openTasks: Map<string, { assigneeMemberId: string; principalMemberId: string | null; resolvedFrom: string | null; assignedAt: Date; dueAt: Date | null; id: string }>
  readonly members: Map<string, MemberRefDto>
  readonly roleOf: (resolvedFrom: string | null | undefined) => ApproverRoleDto
  readonly minutesOf: (task: { id: string; assignedAt: Date }) => number | null
  readonly now: Date
}

function waitingOf(po: { status: string; currentRouteId: string | null; sendBouncedAt: Date | null }, w: WaitingContext): PoWaitingDto {
  switch (po.status) {
    case 'DRAFT':
      return { kind: 'EDIT' }
    case 'PENDING_APPROVAL': {
      const task = po.currentRouteId ? w.openTasks.get(po.currentRouteId) : undefined
      if (!task) return { kind: 'APPROVER', assignee: null, onBehalfOf: null, role: { kind: 'UNKNOWN' }, waitingMinutes: null, dueAt: null, overdue: false }
      return {
        kind: 'APPROVER',
        assignee: w.members.get(task.assigneeMemberId) ?? null,
        onBehalfOf: task.principalMemberId ? (w.members.get(task.principalMemberId) ?? null) : null,
        role: w.roleOf(task.resolvedFrom),
        waitingMinutes: w.minutesOf(task),
        dueAt: task.dueAt,
        overdue: task.dueAt !== null && task.dueAt.getTime() < w.now.getTime(),
      }
    }
    case 'APPROVED':
      return { kind: 'SEND', bounced: po.sendBouncedAt !== null }
    case 'SENT':
      return { kind: 'DELIVERY' }
    case 'PARTIALLY_RECEIVED':
      return { kind: 'REST' }
    case 'RECEIVED':
      return { kind: 'CLOSE' }
    default:
      return { kind: 'NONE' }
  }
}

/** The open approval task of each route (tier 1 routes are sequential: one task waits at a time) */
async function waitingContext(db: TenantDb, ctx: Ctx, routeIds: readonly string[]): Promise<WaitingContext> {
  const tasks = routeIds.length
    ? await db.approvalTask.findMany({
        where: { status: { in: [...OPEN_TASK] }, step: { routeId: { in: [...routeIds] } } },
        select: { id: true, assigneeMemberId: true, principalMemberId: true, resolvedFrom: true, assignedAt: true, dueAt: true, step: { select: { routeId: true } } },
      })
    : []
  const [members, roleOf, calendar, pauses] = await Promise.all([
    membersById(
      db,
      tasks.flatMap((t) => [t.assigneeMemberId, t.principalMemberId]),
    ),
    approverRoles(db),
    businessCalendarOf(db, ctx.organizationId),
    slaPausesOf(
      db,
      tasks.map((t) => t.id),
    ),
  ])
  return {
    openTasks: new Map(tasks.map((t) => [t.step.routeId, t])),
    members,
    roleOf,
    minutesOf: (task) => businessMinutesWaited(calendar, task.assignedAt, ctx.now, pauses.get(task.id) ?? []),
    now: ctx.now,
  }
}

// ---------- the list (/procurement/pos) ----------

export interface PoRowDto {
  readonly id: string
  /** null while DRAFT (BR-NUM-01) */
  readonly number: string | null
  readonly status: PoStatusDto
  readonly supplier: { readonly code: string; readonly nameTh: string }
  readonly deliverySite: { readonly code: string; readonly nameTh: string } | null
  readonly kind: 'GOODS' | 'SERVICE'
  readonly urgency: 'NORMAL' | 'URGENT'
  readonly lineCount: number
  /** The purchase requests the PO orders, by number */
  readonly requestNumbers: readonly string[]
  readonly netSatang: Satang
  readonly vatSatang: Satang
  readonly grossSatang: Satang
  readonly createdAt: Date
  readonly updatedAt: Date
  readonly waiting: PoWaitingDto
}

export interface PoListDto {
  readonly rows: readonly PoRowDto[]
  /** POs per status, with the search applied (every count leads to its list) */
  readonly counts: Readonly<Record<PoStatusDto, number>>
  /** Every PO of the organization */
  readonly total: number
  /** The POs matching the filter, also when `rows` stops at the limit */
  readonly matched: number
}

export interface PoListFilter {
  readonly status?: string
  /** Part of a PO number, or of a supplier's code or name */
  readonly q?: string
}

/** POs of the organization, the ones changed last first, by status (spec §9.1 /procurement/pos) */
export async function listPurchaseOrders(ctx: Ctx, filter: PoListFilter = {}): Promise<PoListDto> {
  const db = forTenant(ctx.organizationId)
  const status = isPoStatus(filter.status) ? filter.status : undefined
  const q = (filter.q ?? '').trim().slice(0, SEARCH_MAX)
  const search = q
    ? {
        OR: [
          { number: { contains: q, mode: 'insensitive' as const } },
          { supplier: { is: { nameTh: { contains: q, mode: 'insensitive' as const } } } },
          { supplier: { is: { code: { contains: q, mode: 'insensitive' as const } } } },
        ],
      }
    : {}
  const where = { ...search, ...(status ? { status } : {}) }
  const [total, grouped, matched, pos] = await Promise.all([
    db.purchaseOrder.count(),
    db.purchaseOrder.groupBy({ by: ['status'], where: search, _count: { _all: true } }),
    db.purchaseOrder.count({ where }),
    db.purchaseOrder.findMany({
      where,
      orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
      take: LIST_LIMIT,
      select: {
        id: true,
        number: true,
        status: true,
        kind: true,
        urgency: true,
        netSatang: true,
        vatSatang: true,
        grossSatang: true,
        createdAt: true,
        updatedAt: true,
        currentRouteId: true,
        sendBouncedAt: true,
        supplier: { select: { code: true, nameTh: true } },
        deliverySite: { select: { code: true, nameTh: true } },
        lines: { select: { quantity: true, unitPriceSatang: true, vatable: true, sources: { select: { requestLine: { select: { request: { select: { number: true } } } } } } } },
      },
    }),
  ])
  const [w, todayBp] = await Promise.all([
    waitingContext(
      db,
      ctx,
      pos.flatMap((p) => (p.status === 'PENDING_APPROVAL' && p.currentRouteId ? [p.currentRouteId] : [])),
    ),
    pos.some((p) => p.status === 'DRAFT') ? rateOfToday(ctx) : Promise.resolve(null),
  ])
  const counts = Object.fromEntries(PO_STATUSES.map((s) => [s, 0])) as Record<PoStatusDto, number>
  for (const g of grouped) counts[g.status] = g._count._all
  return {
    total,
    matched,
    counts,
    rows: pos.map((p) => {
      // A draft is listed at today's rate, as its page and the sending show it
      const totals = p.status === 'DRAFT' && todayBp !== null ? draftTotals(p.lines, todayBp) : { netSatang: p.netSatang, vatSatang: p.vatSatang, grossSatang: p.grossSatang }
      return {
        id: p.id,
        number: p.number,
        status: p.status,
        supplier: p.supplier,
        deliverySite: p.deliverySite,
        kind: p.kind,
        urgency: p.urgency,
        lineCount: p.lines.length,
        requestNumbers: [...new Set(p.lines.flatMap((l) => l.sources.map((s) => s.requestLine.request.number)).filter((n): n is string => Boolean(n)))].sort((a, b) =>
          a.localeCompare(b, 'en', { numeric: true }),
        ),
        netSatang: totals.netSatang,
        vatSatang: totals.vatSatang,
        grossSatang: totals.grossSatang,
        createdAt: p.createdAt,
        updatedAt: p.updatedAt,
        waiting: waitingOf(p, w),
      }
    }),
  }
}

// ---------- access (the page checks po.view with these facts before reading) ----------

export interface PoAccessDto {
  readonly poId: string
  readonly status: PoStatusDto
  /**
   * Who made it (po.view OWN, and the creator of BR-SOD-03): the member who ran a round by hand or chose the supplier of
   * an urgent request; for a draft of a scheduled round, nobody until a member sends it for approval and becomes it
   */
  readonly createdById: string | null
  /** The requesters of its PRs (po.view OWN) */
  readonly requesterMemberIds: readonly string[]
  /** Everyone who has or had an approval task on it, and whom they acted for (po.view ASSIGNED) */
  readonly approverMemberIds: readonly string[]
}

export async function getPoAccess(ctx: Ctx, poId: string): Promise<PoAccessDto | null> {
  if (!isUuid(poId)) return null
  const db = forTenant(ctx.organizationId)
  const po = await db.purchaseOrder.findUnique({ where: { id: poId }, select: { id: true, status: true, createdById: true } })
  if (!po) return null
  const [requests, tasks] = await Promise.all([
    db.request.findMany({ where: { lines: { some: { poSources: { some: { poLine: { poId: po.id } } } } } }, select: { requesterMemberId: true } }),
    db.approvalTask.findMany({ where: { step: { route: { subjectType: 'PURCHASE_ORDER', subjectId: po.id } } }, select: { assigneeMemberId: true, principalMemberId: true } }),
  ])
  return {
    poId: po.id,
    status: po.status,
    createdById: po.createdById,
    requesterMemberIds: [...new Set(requests.map((r) => r.requesterMemberId))],
    approverMemberIds: [...new Set(tasks.flatMap((t) => [t.assigneeMemberId, ...(t.principalMemberId ? [t.principalMemberId] : [])]))],
  }
}

// ---------- price history (FR-P2P-003 AC1) ----------

/** "the same item": the category and the description with spaces collapsed and case folded */
export const itemKey = (categoryCode: string | null, description: string) => `${categoryCode ?? ''}|${description.trim().replace(/\s+/g, ' ').toLowerCase()}`

export interface EarlierPriceDto {
  readonly poId: string
  readonly poNumber: string
  readonly approvedAt: Date
  readonly unitPriceSatang: Satang
}

export interface LinePriceHistoryDto {
  readonly poLineId: string
  /** The last three unit prices of the same item on approved POs, newest first */
  readonly previous: readonly EarlierPriceDto[]
  /** The line's price is above the last one by more than settings.priceAlertPct */
  readonly alert: boolean
}

export interface PriceHistoryOfDto {
  /** settings.priceAlertPct, as a percent */
  readonly alertPct: number
  readonly lines: readonly LinePriceHistoryDto[]
}

/**
 * The last three approved unit prices of the item of every line of a PO, and whether the line's price is above the
 * last one by more than settings.priceAlertPct (FR-P2P-003 AC1). Read only; the caller has checked who may see it.
 */
export async function priceHistoryOf(db: TenantDb, organizationId: string, poId: string): Promise<PriceHistoryOfDto | null> {
  const po = await db.purchaseOrder.findFirst({ where: { id: poId }, select: { lines: { orderBy: { lineNo: 'asc' }, select: { id: true, categoryCode: true, description: true, unitPriceSatang: true } } } })
  if (!po) return null
  const org = await db.organization.findUniqueOrThrow({ where: { id: organizationId }, select: { settings: true } })
  const alertPct = OrgSettingsSchema.shape.priceAlertPct.parse((org.settings as { priceAlertPct?: unknown } | null)?.priceAlertPct)
  const alertBp = Math.round(alertPct * PERCENT_TO_BP)
  const earlier = po.lines.length
    ? await db.poLine.findMany({
        where: { poId: { not: poId }, po: { status: { in: [...APPROVED_STATUSES] } }, OR: po.lines.map((l) => ({ categoryCode: l.categoryCode })) },
        select: { categoryCode: true, description: true, unitPriceSatang: true, po: { select: { id: true, number: true, approvedAt: true } } },
      })
    : []
  return {
    alertPct,
    lines: po.lines.map((line) => {
      const key = itemKey(line.categoryCode, line.description)
      const previous = earlier
        .filter((e) => itemKey(e.categoryCode, e.description) === key && e.po.approvedAt)
        .sort((a, b) => b.po.approvedAt!.getTime() - a.po.approvedAt!.getTime() || (b.po.number ?? '').localeCompare(a.po.number ?? '', 'en', { numeric: true }))
        .slice(0, PRICE_HISTORY_SIZE)
        .map((e) => ({ poId: e.po.id, poNumber: e.po.number ?? '', approvedAt: e.po.approvedAt!, unitPriceSatang: e.unitPriceSatang }))
      return { poLineId: line.id, previous, alert: previous.length > 0 && exceedsByMoreThan(line.unitPriceSatang, previous[0]!.unitPriceSatang, alertBp) }
    }),
  }
}

// ---------- the timeline of a PO or a variance ----------

export type DocTrackWhat =
  | 'DRAFTED'
  | 'EDITED'
  | 'SUBMITTED'
  | 'APPROVED'
  | 'RETURNED'
  | 'REJECTED'
  | 'REASSIGNED'
  | 'SENT'
  | 'RESENT'
  | 'BOUNCED'
  | 'CANCELLED'
  | 'CLOSED'
  | 'RECEIVED'
  | 'VARIANCE_RECORDED'
  | 'WAIT_APPROVAL'
  | 'NEXT_APPROVAL'
  | 'WAIT_EDIT'
  | 'WAIT_SEND'
  | 'WAIT_DELIVERY'
  | 'WAIT_CLOSE'

/** One step of a PO's or a variance's timeline: done steps come from Events, the rest from the state (FR-PLT-003 AC3) */
export interface DocTrackEntryDto {
  readonly key: string
  readonly state: 'done' | 'current' | 'upcoming'
  readonly what: DocTrackWhat
  readonly at: Date | null
  readonly channel: string | null
  /** null: the system (the consolidation round) or a team such as procurement */
  readonly actor: MemberRefDto | null
  readonly onBehalfOf: MemberRefDto | null
  readonly role: ApproverRoleDto | null
  readonly expected: ExpectedApproverDto | null
  readonly doa: DoaRefDto | null
  /** A reason, quoted as written */
  readonly note: string | null
  /** SUBMITTED: the PO number · RECEIVED: the GR number · BOUNCED: the refusal's code */
  readonly detail: string | null
  readonly other: MemberRefDto | null
  readonly waitingMinutes: number | null
  readonly dueAt: Date | null
  readonly overdue: boolean
}

interface EventRow {
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

const EVENT_SELECT = {
  id: true,
  type: true,
  aggregateType: true,
  aggregateId: true,
  occurredAt: true,
  actorType: true,
  actorMemberId: true,
  onBehalfOfMemberId: true,
  channel: true,
  doaVersionId: true,
  doaRuleCode: true,
  data: true,
} as const

const blank = {
  onBehalfOf: null,
  role: null,
  expected: null,
  doa: null,
  note: null,
  detail: null,
  other: null,
  waitingMinutes: null,
  dueAt: null,
  overdue: false,
} as const

/** Done steps of a document from its events and the events of its approval tasks, in the order they happened */
async function historyFrom(db: TenantDb, events: readonly EventRow[], roleOfTask: (taskId: string) => ApproverRoleDto): Promise<DocTrackEntryDto[]> {
  const dataOf = (e: EventRow) => (e.data && typeof e.data === 'object' ? (e.data as Record<string, unknown>) : {})
  const commentIds = events.map((e) => str(dataOf(e).reasonCommentId)).filter((id): id is string => Boolean(id))
  const [comments, versions, members] = await Promise.all([
    commentIds.length ? db.comment.findMany({ where: { id: { in: commentIds } }, select: { id: true, body: true, retractedAt: true } }) : Promise.resolve([]),
    doaVersionsById(
      db,
      events.flatMap((e) => [e.doaVersionId, str(dataOf(e).doaVersionId)]),
    ),
    membersById(
      db,
      events.flatMap((e) => [e.actorMemberId, e.onBehalfOfMemberId, str(dataOf(e).onBehalfOfMemberId), str(dataOf(e).toMemberId)]),
    ),
  ])
  const comment = new Map(comments.map((c) => [c.id, c.retractedAt ? null : c.body]))
  const out: DocTrackEntryDto[] = []
  for (const e of events) {
    const data = dataOf(e)
    const base = {
      ...blank,
      key: e.id,
      state: 'done' as const,
      at: e.occurredAt,
      channel: e.channel,
      actor: e.actorType === 'USER' && e.actorMemberId ? (members.get(e.actorMemberId) ?? null) : null,
    }
    const reason = str(data.reasonCommentId) ? (comment.get(str(data.reasonCommentId)!) ?? null) : null
    switch (e.type) {
      case 'po.drafted':
        out.push({ ...base, what: 'DRAFTED' })
        break
      case 'po.updated': {
        // Saves one after another are one edit, shown at the last save
        const last = out.at(-1)
        if (last?.what === 'EDITED') out[out.length - 1] = { ...base, key: last.key, what: 'EDITED' }
        else out.push({ ...base, what: 'EDITED' })
        break
      }
      case 'po.submitted':
        out.push({ ...base, what: 'SUBMITTED', detail: str(data.number) })
        break
      case 'approval_task.decided': {
        // The Event columns carry the DOA reference (INV-DOA-01); older events keep it in data
        const versionId = e.doaVersionId ?? str(data.doaVersionId)
        const ruleCode = e.doaRuleCode ?? str(data.doaRuleCode)
        const version = versionId ? versions.get(versionId) : undefined
        const behalf = e.onBehalfOfMemberId ?? str(data.onBehalfOfMemberId)
        out.push({
          ...base,
          what: data.decision === 'APPROVE' ? 'APPROVED' : data.decision === 'RETURN' ? 'RETURNED' : 'REJECTED',
          onBehalfOf: behalf ? (members.get(behalf) ?? null) : null,
          role: roleOfTask(e.aggregateId),
          doa: version && ruleCode ? { versionId: version.id, code: version.code, versionNo: version.versionNo, ruleCode } : null,
          note: reason,
        })
        break
      }
      case 'approval_task.reassigned': {
        const to = str(data.toMemberId)
        out.push({ ...base, what: 'REASSIGNED', other: to ? (members.get(to) ?? null) : null })
        break
      }
      case 'po.sent':
        out.push({ ...base, what: data.resend === true ? 'RESENT' : 'SENT', note: reason })
        break
      case 'po.send_bounced':
        out.push({ ...base, what: 'BOUNCED', detail: str(data.code), note: reason })
        break
      case 'po.cancelled':
        out.push({ ...base, what: 'CANCELLED', detail: str(data.disposition), note: reason })
        break
      case 'po.closed':
        out.push({ ...base, what: 'CLOSED' })
        break
      case 'gr.posted':
        out.push({ ...base, what: 'RECEIVED', detail: str(data.number) })
        break
      case 'variance.recorded':
        out.push({ ...base, what: 'VARIANCE_RECORDED' })
        break
      default:
        // Budget, notification and bookkeeping events (assigned or cancelled tasks, po.approved …) are not steps
        break
    }
  }
  return out
}

/** The tasks of a document's routes, their roles, and the live steps of the route that waits now */
async function routeTasksOf(db: TenantDb, subjectType: 'PURCHASE_ORDER' | 'VARIANCE', subjectId: string) {
  const tasks = await db.approvalTask.findMany({
    where: { step: { route: { subjectType, subjectId } } },
    select: { id: true, status: true, assigneeMemberId: true, principalMemberId: true, resolvedFrom: true, assignedAt: true, dueAt: true },
  })
  return tasks
}

/** Where a document waits on its route now and what comes after it (FR-INT-008 AC1, the same as a request's) */
function liveRouteSteps(route: RouteDto | null, task: { id: string; assignedAt: Date; dueAt: Date | null } | null, waited: number | null, now: Date): DocTrackEntryDto[] {
  if (!route || route.status !== 'ACTIVE') return []
  const out: DocTrackEntryDto[] = []
  for (const step of route.steps) {
    if (step.status === 'ACTIVE' && task) {
      out.push({
        ...blank,
        key: `wait-${task.id}`,
        state: 'current',
        what: 'WAIT_APPROVAL',
        at: task.assignedAt,
        channel: null,
        actor: step.approver,
        onBehalfOf: step.onBehalfOf,
        role: step.role,
        waitingMinutes: waited,
        dueAt: task.dueAt,
        overdue: task.dueAt !== null && task.dueAt.getTime() < now.getTime(),
      })
    } else if (step.status === 'WAITING') {
      out.push({ ...blank, key: `next-${route.id}-${step.stepNo}`, state: 'upcoming', what: 'NEXT_APPROVAL', at: null, channel: null, actor: step.approver ?? null, role: step.role, expected: step.expected })
    }
  }
  return out
}

// ---------- one PO (/procurement/pos/[id] and the decision page) ----------

export interface PoSourceDto {
  readonly requestId: string
  readonly requestNumber: string | null
  readonly requestTitle: string
  readonly requestLineNo: number
  /** What this PO line orders of the request line */
  readonly quantity: string
  readonly requester: MemberRefDto | null
}

export interface PoLineDto {
  readonly id: string
  readonly lineNo: number
  readonly description: string
  readonly categoryCode: string | null
  readonly quantity: string
  readonly uom: string
  readonly unitPriceSatang: Satang
  readonly netSatang: Satang
  readonly vatable: boolean
  readonly receivedQuantity: string
  readonly cancelledQuantity: string
  readonly sources: readonly PoSourceDto[]
  /**
   * DRAFT: the most this line may order — what is left of its request line beside other POs (FR-P2P-003 AC2) — or
   * null when the line orders several request lines (its quantity changes by splitting it, BR-CONS-04)
   */
  readonly maxQuantity: string | null
}

/** What may happen to the PO next by §6.4 and its guards; the viewer's permissions are checked by the page and the service */
export interface PoNextDto {
  readonly edit: boolean
  readonly submit: boolean
  /** The first sending of an approved PO */
  readonly send: boolean
  /** Sending again, with a reason (after a bounce, or while goods are still to come) */
  readonly resend: boolean
  readonly cancel: boolean
  readonly close: boolean
  /** SENT or PARTIALLY_RECEIVED with lines still to come: closing needs them received or closed short first */
  readonly closeNeedsShortfall: boolean
}

/** A source request of the PO (BR-CONS-04): who asked, the facts request.view is checked with, and its files */
export interface PoRequestDto {
  readonly id: string
  readonly number: string | null
  readonly title: string
  readonly requester: MemberRefDto | null
  /** The page asks request.view with these (canViewRequest) before it links the request or lists its files */
  readonly access: RequestAccessDto
  /** Its attachments and the files of its quotations that are available (FileLink "Request"; a download asks request.view) */
  readonly attachments: readonly AttachmentDto[]
}

/**
 * What the PO stands for on one budget line it charges (BudgetAllocation, INV-BUD-03, BR-BUD-05): the document's own
 * amounts, never the balance of the line, which only budget.view reads (§2.4)
 */
export interface PoBudgetDto {
  readonly lineId: string
  readonly code: string
  readonly name: string
  readonly status: 'OPEN' | 'FROZEN' | 'CLOSED'
  /** What the PO lines on this budget line cost before VAT (BR-BUD-03) */
  readonly needSatang: Satang
  /** Until the approval: what the source request lines still reserve of what this PO orders (they give it to the PO when it is approved) */
  readonly requestReservedSatang: Satang
  /** Reserved for the PO itself when it was sent: what its lines cost above their share of the requests */
  readonly reservedSatang: Satang
  /** Held for the PO since its approval */
  readonly committedSatang: Satang
  /** Spent on confirmed invoices */
  readonly actualSatang: Satang
}

export interface PoViewDto {
  readonly id: string
  readonly number: string | null
  readonly status: PoStatusDto
  readonly version: number
  readonly kind: 'GOODS' | 'SERVICE'
  readonly urgency: 'NORMAL' | 'URGENT'
  readonly supplier: { readonly id: string; readonly code: string; readonly nameTh: string; readonly email: string | null; readonly active: boolean }
  readonly deliverySite: { readonly code: string; readonly nameTh: string; readonly address: string | null } | null
  /** Who made the draft: the member who ran the round by hand or chose the supplier of an urgent request; null when a scheduled round made it */
  readonly createdBy: MemberRefDto | null
  /** Who sent it for approval the last time (the actor of its latest po.submitted Event); null while nobody has */
  readonly submittedBy: MemberRefDto | null
  readonly createdAt: Date
  readonly submittedAt: Date | null
  readonly approvedAt: Date | null
  readonly sentAt: Date | null
  readonly sentToEmail: string | null
  readonly bounce: { readonly at: Date; readonly code: string | null } | null
  readonly closedAt: Date | null
  readonly cancelledAt: Date | null
  readonly cancelReason: string | null
  readonly cancelDisposition: 'RETURN_TO_POOL' | 'CANCEL_REQUEST_LINES' | null
  readonly paymentTermDays: number | null
  readonly notesToSupplier: string | null
  /**
   * From core/money on the server, never from the client (FR-P2P-003 AC3). TODAY: a draft computed again at the VAT
   * rate of today, the rate it takes when it is sent (§6.4). STORED: what the sending computed — or, for a draft when no
   * rate covers today, what the round stored with the rate of its day (null when there was none)
   */
  readonly totals: { readonly netSatang: Satang; readonly vatSatang: Satang; readonly grossSatang: Satang; readonly vatRateBp: number | null; readonly basis: 'TODAY' | 'STORED' }
  readonly lines: readonly PoLineDto[]
  readonly prices: PriceHistoryOfDto
  /** The budget lines it charges and what it reserves or holds on each (§9.9 principle 5: the state of the budget) */
  readonly budget: readonly PoBudgetDto[]
  /** The requests it orders, by number, with their attachments */
  readonly requests: readonly PoRequestDto[]
  /** The route of the DOA rule of PURCHASE_ORDER (FR-P2P-004 AC1); null before it is sent for approval */
  readonly route: RouteDto | null
  readonly waiting: PoWaitingDto
  readonly next: PoNextDto
  readonly track: readonly DocTrackEntryDto[]
}

export async function getPurchaseOrderView(ctx: Ctx, poId: string): Promise<PoViewDto | null> {
  if (!isUuid(poId)) return null
  const db = forTenant(ctx.organizationId)
  const po = await db.purchaseOrder.findUnique({
    where: { id: poId },
    include: {
      supplier: { select: { id: true, code: true, nameTh: true, email: true, status: true } },
      deliverySite: { select: { code: true, nameTh: true, address: true } },
      lines: {
        orderBy: { lineNo: 'asc' },
        include: {
          sources: {
            orderBy: { id: 'asc' },
            select: {
              id: true,
              quantity: true,
              requestLineId: true,
              releasableSatang: true,
              requestLine: {
                select: {
                  lineNo: true,
                  quantity: true,
                  cancelledQuantity: true,
                  request: { select: { id: true, number: true, title: true, requesterMemberId: true } },
                  poSources: { where: { poLine: { po: { status: { in: [...ORDERING] } } } }, select: { id: true, quantity: true } },
                },
              },
            },
          },
        },
      },
    },
  })
  if (!po) return null
  const requestIds = [...new Set(po.lines.flatMap((l) => l.sources.map((s) => s.requestLine.request.id)))]
  const requestLineIds = [...new Set(po.lines.flatMap((l) => l.sources.map((s) => s.requestLineId)))]
  const taskRows = await routeTasksOf(db, 'PURCHASE_ORDER', po.id)
  const routeIds = po.currentRouteId ? [po.currentRouteId] : []
  const [w, roleOf, prices, postedGrs, todayBp, budgetLines, allocations, requestRows, requestTasks, files] = await Promise.all([
    waitingContext(db, ctx, routeIds),
    approverRoles(db),
    priceHistoryOf(db, ctx.organizationId, po.id),
    db.goodsReceipt.findMany({ where: { poId: po.id }, select: { id: true, status: true } }),
    po.status === 'DRAFT' ? rateOfToday(ctx) : Promise.resolve(null),
    db.budgetLine.findMany({ where: { id: { in: [...new Set(po.lines.map((l) => l.budgetLineId))] } }, select: { id: true, code: true, nameTh: true, status: true }, orderBy: { code: 'asc' } }),
    db.budgetAllocation.findMany({
      where: {
        OR: [
          { sourceType: 'PO_LINE' as const, sourceId: { in: po.lines.map((l) => l.id) } },
          ...(requestLineIds.length ? [{ sourceType: 'REQUEST_LINE' as const, sourceId: { in: requestLineIds } }] : []),
        ],
      },
      select: { sourceType: true, sourceId: true, budgetLineId: true, reservedSatang: true, committedSatang: true, actualSatang: true },
    }),
    db.request.findMany({ where: { id: { in: requestIds } }, select: { id: true, number: true, title: true, requesterMemberId: true, chargedDepartmentId: true, followers: { select: { memberId: true } } } }),
    db.approvalTask.findMany({
      where: { step: { route: { subjectType: 'REQUEST', subjectId: { in: requestIds } } } },
      select: { assigneeMemberId: true, principalMemberId: true, step: { select: { route: { select: { subjectId: true } } } } },
    }),
    attachmentsOf(db, 'Request', requestIds),
  ])

  // The timeline: the PO's events, its approval tasks' and its goods receipts'
  const events = (await db.event.findMany({
    where: {
      OR: [
        { aggregateType: 'PurchaseOrder', aggregateId: po.id },
        ...(taskRows.length ? [{ aggregateType: 'ApprovalTask', aggregateId: { in: taskRows.map((t) => t.id) } }] : []),
        ...(postedGrs.length ? [{ aggregateType: 'GoodsReceipt', aggregateId: { in: postedGrs.map((g) => g.id) } }] : []),
      ],
    },
    select: EVENT_SELECT,
    orderBy: { seq: 'asc' },
  })) as EventRow[]
  // Who made it: the member of its po.drafted Event (a round run by hand, an urgent supplier choice); a scheduled round
  // drafts as the system. Who sent it for approval: the member of its latest sending (a returned PO may be sent again
  // by someone else)
  const drafted = events.find((e) => e.type === 'po.drafted')
  const creatorId = drafted ? (drafted.actorType === 'USER' ? drafted.actorMemberId : null) : po.createdById
  const submittedById = events.filter((e) => e.type === 'po.submitted' && e.actorType === 'USER').at(-1)?.actorMemberId ?? null
  const members = await membersById(db, [creatorId, submittedById, ...requestRows.map((r) => r.requesterMemberId)])
  const route = po.currentRouteId ? await routeOf(db, po.currentRouteId, members, roleOf) : null
  const resolvedFrom = new Map(taskRows.map((t) => [t.id, t.resolvedFrom]))
  const history = await historyFrom(db, events, (taskId) => roleOf(resolvedFrom.get(taskId)))
  const openTask = po.currentRouteId ? (w.openTasks.get(po.currentRouteId) ?? null) : null
  const live: DocTrackEntryDto[] =
    po.status === 'PENDING_APPROVAL'
      ? liveRouteSteps(route, openTask, openTask ? w.minutesOf(openTask) : null, ctx.now)
      : po.status === 'DRAFT' || po.status === 'APPROVED' || po.status === 'SENT' || po.status === 'PARTIALLY_RECEIVED' || po.status === 'RECEIVED'
        ? [
            {
              ...blank,
              key: `now-${po.status}`,
              state: 'current',
              what: po.status === 'DRAFT' ? 'WAIT_EDIT' : po.status === 'APPROVED' ? 'WAIT_SEND' : po.status === 'RECEIVED' ? 'WAIT_CLOSE' : 'WAIT_DELIVERY',
              at: null,
              channel: null,
              actor: null,
            },
          ]
        : []

  const lines: PoLineDto[] = po.lines.map((l) => {
    const single = l.sources.length === 1 ? l.sources[0]! : null
    let maxQuantity: string | null = null
    if (single) {
      const rl = single.requestLine
      const elsewhere = rl.poSources.filter((s) => s.id !== single.id).reduce((sum, s) => sum + scaled(s.quantity), 0n)
      const left = scaled(rl.quantity) - scaled(rl.cancelledQuantity) - elsewhere
      maxQuantity = formatQuantity(left > 0n ? left : 0n)
    }
    return {
      id: l.id,
      lineNo: l.lineNo,
      description: l.description,
      categoryCode: l.categoryCode,
      quantity: quantityText(l.quantity),
      uom: l.uom,
      unitPriceSatang: l.unitPriceSatang,
      netSatang: l.netSatang,
      vatable: l.vatable,
      receivedQuantity: quantityText(l.receivedQuantity),
      cancelledQuantity: quantityText(l.cancelledQuantity),
      maxQuantity,
      sources: l.sources.map((s) => ({
        requestId: s.requestLine.request.id,
        requestNumber: s.requestLine.request.number,
        requestTitle: s.requestLine.request.title,
        requestLineNo: s.requestLine.lineNo,
        quantity: quantityText(s.quantity),
        requester: members.get(s.requestLine.request.requesterMemberId) ?? null,
      })),
    }
  })

  const status = po.status as PoState
  const posted = postedGrs.some((g) => g.status === 'POSTED')
  const unsettled = po.lines.some((l) => scaled(l.receivedQuantity) + scaled(l.cancelledQuantity) < scaled(l.quantity))
  const sentBefore = po.sentAt !== null || po.sendBouncedAt !== null
  const next: PoNextDto = {
    edit: po.status === 'DRAFT',
    submit: transition(PO_MACHINE, status, 'po.submit').ok,
    send: po.status === 'APPROVED' && !sentBefore,
    resend: (po.status === 'APPROVED' && sentBefore) || po.status === 'SENT' || po.status === 'PARTIALLY_RECEIVED',
    cancel: transition(PO_MACHINE, status, 'po.cancel').ok && !posted,
    close: transition(PO_MACHINE, status, 'po.close').ok && !unsettled,
    closeNeedsShortfall: transition(PO_MACHINE, status, 'po.close').ok && unsettled,
  }

  // The budget, per line it charges. Until the approval the request lines still reserve what the PO orders: each gives
  // its releasable, never more than it still reserves — the cap the approval applies (purchase-orders/budget.ts)
  const beforeApproval = po.status === 'DRAFT' || po.status === 'PENDING_APPROVAL'
  const stillReserved = new Map(allocations.filter((a) => a.sourceType === 'REQUEST_LINE').map((a) => [a.sourceId, a.reservedSatang]))
  const requestShare = new Map<string, Satang>()
  for (const l of po.lines) {
    for (const s of l.sources) {
      const reserved = stillReserved.get(s.requestLineId) ?? 0n
      const gives = s.releasableSatang < reserved ? s.releasableSatang : reserved
      stillReserved.set(s.requestLineId, reserved - gives)
      requestShare.set(l.budgetLineId, (requestShare.get(l.budgetLineId) ?? 0n) + gives)
    }
  }
  const ownAllocations = allocations.filter((a) => a.sourceType === 'PO_LINE')
  const budget: PoBudgetDto[] = budgetLines.map((b) => {
    const mine = ownAllocations.filter((a) => a.budgetLineId === b.id)
    const sum = (pick: (a: (typeof mine)[number]) => Satang) => mine.reduce((total, a) => total + pick(a), 0n)
    return {
      lineId: b.id,
      code: b.code,
      name: b.nameTh,
      status: b.status,
      needSatang: po.lines.filter((l) => l.budgetLineId === b.id).reduce((total, l) => total + l.netSatang, 0n),
      requestReservedSatang: beforeApproval ? (requestShare.get(b.id) ?? 0n) : 0n,
      reservedSatang: sum((a) => a.reservedSatang),
      committedSatang: sum((a) => a.committedSatang),
      actualSatang: sum((a) => a.actualSatang),
    }
  })

  // The source requests by number, with the facts of request.view and their files
  const taskMembersOf = new Map<string, string[]>()
  for (const t of requestTasks) {
    const id = t.step.route.subjectId
    taskMembersOf.set(id, [...(taskMembersOf.get(id) ?? []), t.assigneeMemberId, ...(t.principalMemberId ? [t.principalMemberId] : [])])
  }
  const requests: PoRequestDto[] = [...requestRows]
    .sort((a, b) => (a.number ?? '￿').localeCompare(b.number ?? '￿', 'en', { numeric: true }))
    .map((r) => ({
      id: r.id,
      number: r.number,
      title: r.title,
      requester: members.get(r.requesterMemberId) ?? null,
      access: {
        requestId: r.id,
        number: r.number,
        requesterMemberId: r.requesterMemberId,
        followerMemberIds: r.followers.map((f) => f.memberId),
        taskMemberIds: [...new Set(taskMembersOf.get(r.id) ?? [])],
        chargedDepartmentId: r.chargedDepartmentId,
      },
      attachments: files.get(r.id) ?? [],
    }))

  return {
    id: po.id,
    number: po.number,
    status: po.status,
    version: po.version,
    kind: po.kind,
    urgency: po.urgency,
    supplier: { id: po.supplier.id, code: po.supplier.code, nameTh: po.supplier.nameTh, email: po.supplier.email, active: po.supplier.status === 'ACTIVE' },
    deliverySite: po.deliverySite,
    createdBy: creatorId ? (members.get(creatorId) ?? null) : null,
    submittedBy: submittedById ? (members.get(submittedById) ?? null) : null,
    createdAt: po.createdAt,
    submittedAt: po.submittedAt,
    approvedAt: po.approvedAt,
    sentAt: po.sentAt,
    sentToEmail: po.sentToEmail,
    bounce: po.sendBouncedAt ? { at: po.sendBouncedAt, code: po.sendBounceReason } : null,
    closedAt: po.closedAt,
    cancelledAt: po.cancelledAt,
    cancelReason: po.cancelReason,
    cancelDisposition: po.cancelDisposition,
    paymentTermDays: po.paymentTermDays,
    notesToSupplier: po.notesToSupplier,
    totals:
      po.status === 'DRAFT' && todayBp !== null
        ? { ...draftTotals(po.lines, todayBp), basis: 'TODAY' }
        : { netSatang: po.netSatang, vatSatang: po.vatSatang, grossSatang: po.grossSatang, vatRateBp: po.vatRateBp, basis: 'STORED' },
    lines,
    prices: prices ?? { alertPct: 0, lines: [] },
    budget,
    requests,
    route,
    waiting: waitingOf(po, w),
    next,
    track: [...history, ...live],
  }
}

// ---------- a variance (the decision page of a GR_VARIANCE task) ----------

export interface VarianceViewDto {
  readonly id: string
  readonly type: 'SHORT' | 'OVER' | 'DAMAGED'
  readonly disposition: 'ACCEPT_EXCESS' | 'RETURN_EXCESS' | 'ACCEPT_DAMAGED' | 'RETURN_REPLACE' | 'CLOSE_SHORT'
  readonly status: 'RECORDED' | 'PENDING_APPROVAL' | 'APPROVED' | 'REJECTED'
  /** The quantity the variance is about, decimal text */
  readonly quantity: string
  /** quantity × the PO's unit price, before VAT (BR-GR-04) */
  readonly amountSatang: Satang
  /** Its VAT at the PO's rate, and the two together: the amount the DOA route used */
  readonly vatSatang: Satang
  readonly grossSatang: Satang
  readonly vatRateBp: number | null
  readonly reason: string | null
  readonly createdBy: MemberRefDto | null
  readonly createdAt: Date
  readonly po: { readonly id: string; readonly number: string | null; readonly status: PoStatusDto; readonly supplier: { readonly code: string; readonly nameTh: string }; readonly deliverySite: { readonly nameTh: string } | null }
  readonly line: { readonly lineNo: number; readonly description: string; readonly uom: string; readonly ordered: string; readonly received: string; readonly cancelled: string; readonly unitPriceSatang: Satang }
  readonly gr: { readonly number: string | null; readonly receivedAt: Date; readonly deliveryNoteNo: string | null; readonly receiver: MemberRefDto | null } | null
  /**
   * The files of the goods receipt it came from — its photos (BR-GR-05: a damaged-goods variance has at least one) and a
   * scanned delivery note; downloads check the receipt again (its approvers may open them, FR-PLT-004 AC2)
   */
  readonly photos: readonly AttachmentDto[]
  /** The budget line of the PO line and what the PO holds for that line now (BudgetAllocation PO_LINE): the document's own amounts */
  readonly budget: {
    readonly lineId: string
    readonly code: string
    readonly name: string
    readonly status: 'OPEN' | 'FROZEN' | 'CLOSED'
    readonly heldSatang: Satang
    readonly actualSatang: Satang
  } | null
  readonly route: RouteDto | null
  readonly track: readonly DocTrackEntryDto[]
}

export async function getVarianceView(ctx: Ctx, varianceId: string): Promise<VarianceViewDto | null> {
  if (!isUuid(varianceId)) return null
  const db = forTenant(ctx.organizationId)
  const v = await db.variance.findUnique({
    where: { id: varianceId },
    include: {
      po: { select: { id: true, number: true, status: true, vatRateBp: true, supplier: { select: { code: true, nameTh: true } }, deliverySite: { select: { nameTh: true } } } },
      poLine: { select: { id: true, budgetLineId: true, lineNo: true, description: true, uom: true, quantity: true, receivedQuantity: true, cancelledQuantity: true, unitPriceSatang: true } },
      gr: { select: { number: true, receivedAt: true, deliveryNoteNo: true, receiverMemberId: true } },
    },
  })
  if (!v) return null
  const taskRows = await routeTasksOf(db, 'VARIANCE', v.id)
  const [w, roleOf, members, budgetLine, held, files] = await Promise.all([
    waitingContext(db, ctx, v.currentRouteId ? [v.currentRouteId] : []),
    approverRoles(db),
    membersById(db, [v.createdById, v.gr?.receiverMemberId]),
    db.budgetLine.findFirst({ where: { id: v.poLine.budgetLineId }, select: { id: true, code: true, nameTh: true, status: true } }),
    db.budgetAllocation.findFirst({ where: { sourceType: 'PO_LINE', sourceId: v.poLine.id }, select: { committedSatang: true, actualSatang: true } }),
    v.grId ? attachmentsOf(db, 'GoodsReceipt', [v.grId]) : Promise.resolve(new Map<string, AttachmentDto[]>()),
  ])
  const route = v.currentRouteId ? await routeOf(db, v.currentRouteId, members, roleOf) : null
  const events = (await db.event.findMany({
    where: { OR: [{ aggregateType: 'Variance', aggregateId: v.id }, ...(taskRows.length ? [{ aggregateType: 'ApprovalTask', aggregateId: { in: taskRows.map((t) => t.id) } }] : [])] },
    select: EVENT_SELECT,
    orderBy: { seq: 'asc' },
  })) as EventRow[]
  const resolvedFrom = new Map(taskRows.map((t) => [t.id, t.resolvedFrom]))
  const history = await historyFrom(db, events, (taskId) => roleOf(resolvedFrom.get(taskId)))
  // The reason the variance was recorded with is its own note
  const recorded = history.map((h) => (h.what === 'VARIANCE_RECORDED' ? { ...h, note: v.reason } : h))
  const openTask = v.currentRouteId ? (w.openTasks.get(v.currentRouteId) ?? null) : null
  const live = v.status === 'PENDING_APPROVAL' ? liveRouteSteps(route, openTask, openTask ? w.minutesOf(openTask) : null, ctx.now) : []
  const vat = vatFromNet(v.amountSatang, v.po.vatRateBp ?? 0)
  return {
    id: v.id,
    type: v.type,
    disposition: v.disposition,
    status: v.status,
    quantity: quantityText(v.quantity),
    amountSatang: v.amountSatang,
    vatSatang: vat.vat,
    grossSatang: vat.gross,
    vatRateBp: v.po.vatRateBp,
    reason: v.reason,
    createdBy: members.get(v.createdById) ?? null,
    createdAt: v.createdAt,
    po: { id: v.po.id, number: v.po.number, status: v.po.status, supplier: v.po.supplier, deliverySite: v.po.deliverySite },
    line: {
      lineNo: v.poLine.lineNo,
      description: v.poLine.description,
      uom: v.poLine.uom,
      ordered: quantityText(v.poLine.quantity),
      received: quantityText(v.poLine.receivedQuantity),
      cancelled: quantityText(v.poLine.cancelledQuantity),
      unitPriceSatang: v.poLine.unitPriceSatang,
    },
    gr: v.gr ? { number: v.gr.number, receivedAt: v.gr.receivedAt, deliveryNoteNo: v.gr.deliveryNoteNo, receiver: members.get(v.gr.receiverMemberId) ?? null } : null,
    photos: v.grId ? (files.get(v.grId) ?? []) : [],
    budget: budgetLine
      ? { lineId: budgetLine.id, code: budgetLine.code, name: budgetLine.nameTh, status: budgetLine.status, heldSatang: held?.committedSatang ?? 0n, actualSatang: held?.actualSatang ?? 0n }
      : null,
    route,
    track: [...recorded, ...live],
  }
}
