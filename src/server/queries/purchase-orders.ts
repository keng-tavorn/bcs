import { documentTotals, exceedsByMoreThan, parseQuantity, vatFromNet, type Satang } from '@/core/money/math'
import { formatQuantity } from '@/core/receiving'
import type { BusinessCalendar } from '@/core/sla'
import { PO_MACHINE, transition, type PoState } from '@/core/state-machines'
import { rateFor, taxDateOf } from '@/core/vat'
import { OrgSettingsSchema } from '@/lib/org-settings'
import type { Ctx } from '@/server/context'
import { escapeLike } from '@/server/db/like'
import { listTaxRates } from '@/server/db/lookups'
import { forTenant, type TenantDb } from '@/server/db/tenant'
import {
  approverRoles,
  businessCalendarOf,
  businessMinutesWaited,
  doaVersionsById,
  escalatedTaskIdsOf,
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
  type WaitingApproverDto,
} from './requests'

// Read-only views of purchase orders for the screens of S4-04 to S4-06 (spec §9.1 /procurement/pos, FR-P2P-003,
// FR-P2P-004, FR-P2P-005, FR-P2P-010) and for the decision page of PO and variance tasks (FR-DOA-004): the POs by
// status with whom each waits for; one PO with its lines and their source requests (BR-CONS-04) and their attachments,
// the totals the server computed (FR-P2P-003 AC3), the last three approved prices of each item (AC1), what it reserves
// or holds on each budget line, the route of the DOA rule of PURCHASE_ORDER, the sending to the supplier with a bounce
// (FR-P2P-005), what may happen next by the state machine of §6.4, and a timeline built from its Events; a variance with
// its PO line, its budget line and the photos of its receipt (§9.9 principle 5). An escalated step waits for its first
// assignee and its co-assignee alike — "waiting for" and the timeline name every open task of the step, oldest first —
// and its decision is stamped with the escalated flag beside the route's own DOA reference (BR-SLA-04, FR-INT-008 AC1,
// as a request's page, NEW-46). Queries never check permissions (they cannot import authz): pages ask getPoAccess() and
// check po.view (or the task's deciders) with src/server/authz before they read anything else, and request.view
// (canViewRequest) before they link a source request or list its files.

export const PO_STATUSES = ['DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'SENT', 'PARTIALLY_RECEIVED', 'RECEIVED', 'CLOSED', 'CANCELLED', 'REJECTED'] as const
export type PoStatusDto = (typeof PO_STATUSES)[number]
export const isPoStatus = (value: string | undefined | null): value is PoStatusDto => typeof value === 'string' && (PO_STATUSES as readonly string[]).includes(value)

/** POs whose sources still order their request lines (the same list as services/procurement/pool.ts ORDERING_PO_STATUSES) */
const ORDERING: readonly PoStatusDto[] = ['DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'SENT', 'PARTIALLY_RECEIVED', 'RECEIVED', 'CLOSED']
/** POs approved at some point: the price history reads their prices (FR-P2P-003 AC1) */
export const APPROVED_STATUSES: readonly PoStatusDto[] = ['APPROVED', 'SENT', 'PARTIALLY_RECEIVED', 'RECEIVED', 'CLOSED']
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

/**
 * Whom a PO waits for. A wait on procurement or on the supplier carries the business minutes it has lasted (§9.9 principle
 * 4, FR-INT-008 AC1: how long the current step has waited, as a request waits for procurement since its approval), from
 * when the PO entered its state — or, once goods came, from its latest posted goods receipt (teamWaitSince); null
 * without a business calendar
 */
export type PoWaitingDto =
  /** DRAFT: procurement checks it and sends it for approval */
  | { readonly kind: 'EDIT'; readonly waitingMinutes: number | null }
  /** PENDING_APPROVAL: the first of `approvers` (assignee null when no open task is found) */
  | {
      readonly kind: 'APPROVER'
      readonly assignee: MemberRefDto | null
      readonly onBehalfOf: MemberRefDto | null
      readonly role: ApproverRoleDto
      readonly waitingMinutes: number | null
      readonly dueAt: Date | null
      readonly overdue: boolean
      /**
       * Everyone who may decide the step now, oldest task first: its approver, and the co-assignee of an escalated
       * step — whoever decides first decides (BR-SLA-04, FR-INT-008 AC1, NEW-46)
       */
      readonly approvers: readonly WaitingApproverDto[]
    }
  /** APPROVED: procurement sends it to the supplier; `bounced` when the last e-mail came back (FR-P2P-005 AC2) */
  | { readonly kind: 'SEND'; readonly bounced: boolean; readonly waitingMinutes: number | null }
  /** SENT: the supplier delivers and the receiver records it */
  | { readonly kind: 'DELIVERY'; readonly waitingMinutes: number | null }
  /** PARTIALLY_RECEIVED: the rest of the goods, since the latest posted goods receipt */
  | { readonly kind: 'REST'; readonly waitingMinutes: number | null }
  /** RECEIVED: the invoice, then closing, since the latest posted goods receipt */
  | { readonly kind: 'CLOSE'; readonly waitingMinutes: number | null }
  /** CLOSED, CANCELLED, REJECTED */
  | { readonly kind: 'NONE' }

interface WaitingContext {
  /**
   * The approvers each route waits for: every open task of its current step (tier 1 routes are sequential: the step of
   * its oldest open task), oldest first, with the business time each has waited
   */
  readonly waitingByRoute: ReadonlyMap<string, readonly WaitingApproverDto[]>
  /** The organization's business calendar (null when its settings cannot be read) and the time of the read */
  readonly calendar: BusinessCalendar | null
  readonly now: Date
}

/** The approvers a route waits for now; empty when it waits for nobody */
const waitingFor = (w: WaitingContext, routeId: string | null): readonly WaitingApproverDto[] => (routeId ? (w.waitingByRoute.get(routeId) ?? []) : [])

/** The Events after which a PO is a draft waiting for procurement: the round drafted it, or its approver returned it */
const DRAFT_WAIT_EVENTS: readonly string[] = ['po.drafted', 'po.returned']

/**
 * When a PO began to wait on procurement or on its supplier: when it entered the state it is in — a draft when it was
 * drafted or returned (`draft`), an approved PO at its approval, a sent PO when it was last sent — and, once goods came,
 * its latest posted goods receipt (`receipt`): a PO partly received waits from then for the rest of its goods, one
 * received in full for its invoice and its closing. null for any other state, or without the time it needs: an
 * approver's wait counts from the task (waitingContext).
 */
function teamWaitSince(po: { status: string; approvedAt: Date | null; sentAt: Date | null }, since: { readonly draft: Date | null; readonly receipt: Date | null }): Date | null {
  switch (po.status) {
    case 'DRAFT':
      return since.draft
    case 'APPROVED':
      return po.approvedAt
    case 'SENT':
      return po.sentAt
    case 'PARTIALLY_RECEIVED':
    case 'RECEIVED':
      return since.receipt
    default:
      return null
  }
}

/** Business minutes since `since` (no pause: nobody is asked a question on these waits); null without it or a calendar */
const businessWaited = (w: WaitingContext, since: Date | null): number | null => (since ? businessMinutesWaited(w.calendar, since, w.now, []) : null)

/**
 * When each of these drafts began to wait for procurement: its last po.drafted or po.returned Event. A draft without
 * either is not in the map (the caller falls back on when the PO was made)
 */
async function draftsSince(db: TenantDb, poIds: readonly string[]): Promise<Map<string, Date>> {
  const since = new Map<string, Date>()
  if (poIds.length === 0) return since
  const events = await db.event.findMany({
    where: { aggregateType: 'PurchaseOrder', aggregateId: { in: [...poIds] }, type: { in: [...DRAFT_WAIT_EVENTS] } },
    select: { aggregateId: true, occurredAt: true },
    orderBy: { seq: 'asc' },
  })
  for (const e of events) since.set(e.aggregateId, e.occurredAt)
  return since
}

/** The latest of these goods receipts that is posted (a reversed one no longer counts), or null when none is */
function latestPosted(receipts: ReadonlyArray<{ readonly status: string; readonly postedAt: Date | null }>): Date | null {
  return receipts.reduce<Date | null>((latest, r) => (r.status === 'POSTED' && r.postedAt && (!latest || r.postedAt > latest) ? r.postedAt : latest), null)
}

/**
 * When each of these POs last had goods received: its latest posted goods receipt. A PO with none is not in the map (its
 * wait is not counted)
 */
async function receiptsSince(db: TenantDb, poIds: readonly string[]): Promise<Map<string, Date>> {
  const since = new Map<string, Date>()
  if (poIds.length === 0) return since
  const latest = await db.goodsReceipt.groupBy({ by: ['poId'], where: { poId: { in: [...poIds] }, status: 'POSTED' }, _max: { postedAt: true } })
  for (const g of latest) if (g._max.postedAt) since.set(g.poId, g._max.postedAt)
  return since
}

/** `teamWaited`: the business minutes of a wait on procurement or the supplier (businessWaited of teamWaitSince) */
function waitingOf(po: { status: string; currentRouteId: string | null; sendBouncedAt: Date | null }, w: WaitingContext, teamWaited: number | null): PoWaitingDto {
  switch (po.status) {
    case 'DRAFT':
      return { kind: 'EDIT', waitingMinutes: teamWaited }
    case 'PENDING_APPROVAL': {
      const approvers = waitingFor(w, po.currentRouteId)
      const lead = approvers[0]
      if (!lead) return { kind: 'APPROVER', assignee: null, onBehalfOf: null, role: { kind: 'UNKNOWN' }, waitingMinutes: null, dueAt: null, overdue: false, approvers: [] }
      return { kind: 'APPROVER', assignee: lead.assignee, onBehalfOf: lead.onBehalfOf, role: lead.role, waitingMinutes: lead.waitingMinutes, dueAt: lead.dueAt, overdue: lead.overdue, approvers }
    }
    case 'APPROVED':
      return { kind: 'SEND', bounced: po.sendBouncedAt !== null, waitingMinutes: teamWaited }
    case 'SENT':
      return { kind: 'DELIVERY', waitingMinutes: teamWaited }
    case 'PARTIALLY_RECEIVED':
      return { kind: 'REST', waitingMinutes: teamWaited }
    case 'RECEIVED':
      return { kind: 'CLOSE', waitingMinutes: teamWaited }
    default:
      return { kind: 'NONE' }
  }
}

/**
 * Whom each route waits for: every open task of its current step, oldest first (FR-INT-008 AC1). Tier 1 routes are
 * sequential, so the open tasks of a route are on one step — two when the step was escalated past its time and the
 * approver of the band above joined it (BR-SLA-04), whoever decides first decides.
 */
async function waitingContext(db: TenantDb, ctx: Ctx, routeIds: readonly string[]): Promise<WaitingContext> {
  const tasks = routeIds.length
    ? await db.approvalTask.findMany({
        where: { status: { in: [...OPEN_TASK] }, step: { routeId: { in: [...routeIds] } } },
        select: { id: true, assigneeMemberId: true, principalMemberId: true, resolvedFrom: true, assignedAt: true, dueAt: true, step: { select: { routeId: true, stepNo: true } } },
        orderBy: [{ assignedAt: 'asc' }, { id: 'asc' }],
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
  const waitingByRoute = new Map<string, WaitingApproverDto[]>()
  const stepOf = new Map<string, number>()
  for (const t of tasks) {
    // The step of the route's oldest open task is the one it waits on
    const stepNo = stepOf.get(t.step.routeId) ?? t.step.stepNo
    stepOf.set(t.step.routeId, stepNo)
    const assignee = members.get(t.assigneeMemberId)
    if (t.step.stepNo !== stepNo || !assignee) continue
    waitingByRoute.set(t.step.routeId, [
      ...(waitingByRoute.get(t.step.routeId) ?? []),
      {
        taskId: t.id,
        assignee,
        onBehalfOf: t.principalMemberId ? (members.get(t.principalMemberId) ?? null) : null,
        role: roleOf(t.resolvedFrom),
        since: t.assignedAt,
        waitingMinutes: businessMinutesWaited(calendar, t.assignedAt, ctx.now, pauses.get(t.id) ?? []),
        dueAt: t.dueAt,
        overdue: t.dueAt !== null && t.dueAt.getTime() < ctx.now.getTime(),
      },
    ])
  }
  return { waitingByRoute, calendar, now: ctx.now }
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

/** The states in which a PO waits on procurement: a draft to check and send for approval, an approved PO to send out */
export const PROCUREMENT_WAITS = ['DRAFT', 'APPROVED'] as const satisfies readonly PoStatusDto[]

/**
 * How many POs of the organization wait on procurement now, by state (§9.9 principle 1: the home's work of PROCUREMENT,
 * beside the pool): the same counts the PO list leads to with its status filter. The caller shows them only to whoever
 * the PO list is for (po.create, as the menu's entry).
 */
export async function procurementPoCounts(ctx: Ctx): Promise<Readonly<Record<(typeof PROCUREMENT_WAITS)[number], number>>> {
  const db = forTenant(ctx.organizationId)
  const grouped = await db.purchaseOrder.groupBy({ by: ['status'], where: { status: { in: [...PROCUREMENT_WAITS] } }, _count: { _all: true } })
  const counts = { DRAFT: 0, APPROVED: 0 }
  for (const g of grouped) if (g.status === 'DRAFT' || g.status === 'APPROVED') counts[g.status] = g._count._all
  return counts
}

/** POs of the organization, the ones changed last first, by status (spec §9.1 /procurement/pos) */
export async function listPurchaseOrders(ctx: Ctx, filter: PoListFilter = {}): Promise<PoListDto> {
  const db = forTenant(ctx.organizationId)
  const status = isPoStatus(filter.status) ? filter.status : undefined
  const q = (filter.q ?? '').trim().slice(0, SEARCH_MAX)
  const search = q
    ? {
        OR: [
          { number: { contains: escapeLike(q), mode: 'insensitive' as const } },
          { supplier: { is: { nameTh: { contains: escapeLike(q), mode: 'insensitive' as const } } } },
          { supplier: { is: { code: { contains: escapeLike(q), mode: 'insensitive' as const } } } },
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
        approvedAt: true,
        sentAt: true,
        currentRouteId: true,
        sendBouncedAt: true,
        supplier: { select: { code: true, nameTh: true } },
        deliverySite: { select: { code: true, nameTh: true } },
        lines: { select: { quantity: true, unitPriceSatang: true, vatable: true, sources: { select: { requestLine: { select: { request: { select: { number: true } } } } } } } },
      },
    }),
  ])
  const [w, todayBp, drafted, received] = await Promise.all([
    waitingContext(
      db,
      ctx,
      pos.flatMap((p) => (p.status === 'PENDING_APPROVAL' && p.currentRouteId ? [p.currentRouteId] : [])),
    ),
    pos.some((p) => p.status === 'DRAFT') ? rateOfToday(ctx) : Promise.resolve(null),
    draftsSince(
      db,
      pos.filter((p) => p.status === 'DRAFT').map((p) => p.id),
    ),
    receiptsSince(
      db,
      pos.filter((p) => p.status === 'PARTIALLY_RECEIVED' || p.status === 'RECEIVED').map((p) => p.id),
    ),
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
        waiting: waitingOf(p, w, businessWaited(w, teamWaitSince(p, { draft: drafted.get(p.id) ?? p.createdAt, receipt: received.get(p.id) ?? null }))),
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
  /**
   * A decision on a step escalated past its time with a co-assignee (BR-SLA-04: the route's own DOA reference with the
   * escalated flag), whoever of the two decided it; as on a request's timeline (TrackEntryDto.escalated)
   */
  readonly escalated?: boolean
  /** WAIT_DELIVERY: the supplier the PO waits for, so the current step names whom it waits for (§9.9 principle 4) */
  readonly supplierName?: string
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

/**
 * Done steps of a document from its events and the events of its approval tasks, in the order they happened.
 * `escalatedTaskIds`: the tasks of steps escalated with a co-assignee (escalatedTaskIdsOf): their decisions carry the flag
 */
async function historyFrom(db: TenantDb, events: readonly EventRow[], roleOfTask: (taskId: string) => ApproverRoleDto, escalatedTaskIds: ReadonlySet<string>): Promise<DocTrackEntryDto[]> {
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
          ...(escalatedTaskIds.has(e.aggregateId) ? { escalated: true } : {}),
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

/** The tasks of a document's routes, with their steps (for their roles and the escalated flag of their decisions) */
async function routeTasksOf(db: TenantDb, subjectType: 'PURCHASE_ORDER' | 'VARIANCE', subjectId: string) {
  const tasks = await db.approvalTask.findMany({
    where: { step: { route: { subjectType, subjectId } } },
    select: { id: true, stepId: true, status: true, assigneeMemberId: true, principalMemberId: true, resolvedFrom: true, assignedAt: true, dueAt: true },
  })
  return tasks
}

/**
 * Where a document waits on its route now and what comes after it (FR-INT-008 AC1, the same as a request's): one
 * current entry for every approver who may decide the active step — an escalated step shows its first assignee and its
 * co-assignee, oldest first, as its route does (BR-SLA-04, NEW-46)
 */
function liveRouteSteps(route: RouteDto | null, waiting: readonly WaitingApproverDto[]): DocTrackEntryDto[] {
  if (!route || route.status !== 'ACTIVE') return []
  const out: DocTrackEntryDto[] = []
  for (const step of route.steps) {
    if (step.status === 'ACTIVE') {
      for (const a of waiting) {
        out.push({
          ...blank,
          key: `wait-${a.taskId}`,
          state: 'current',
          what: 'WAIT_APPROVAL',
          at: a.since,
          channel: null,
          actor: a.assignee,
          onBehalfOf: a.onBehalfOf,
          role: a.role,
          waitingMinutes: a.waitingMinutes,
          dueAt: a.dueAt,
          overdue: a.overdue,
        })
      }
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
    db.goodsReceipt.findMany({ where: { poId: po.id }, select: { id: true, status: true, postedAt: true } }),
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
  const history = await historyFrom(db, events, (taskId) => roleOf(resolvedFrom.get(taskId)), escalatedTaskIdsOf(events, taskRows))
  // A wait on procurement or the supplier, from when the PO entered its state: a draft since the round drafted it or its
  // approver returned it (a returned PO is a draft again), else since it was made; once goods came, since the latest
  // posted goods receipt
  const draftSince = events.filter((e) => e.aggregateType === 'PurchaseOrder' && DRAFT_WAIT_EVENTS.includes(e.type)).at(-1)?.occurredAt ?? po.createdAt
  const since = teamWaitSince(po, { draft: draftSince, receipt: latestPosted(postedGrs) })
  const waited = businessWaited(w, since)
  const nowWhat: DocTrackWhat = po.status === 'DRAFT' ? 'WAIT_EDIT' : po.status === 'APPROVED' ? 'WAIT_SEND' : po.status === 'RECEIVED' ? 'WAIT_CLOSE' : 'WAIT_DELIVERY'
  const live: DocTrackEntryDto[] =
    po.status === 'PENDING_APPROVAL'
      ? liveRouteSteps(route, waitingFor(w, po.currentRouteId))
      : po.status === 'DRAFT' || po.status === 'APPROVED' || po.status === 'SENT' || po.status === 'PARTIALLY_RECEIVED' || po.status === 'RECEIVED'
        ? [
            {
              ...blank,
              key: `now-${po.status}`,
              state: 'current',
              what: nowWhat,
              at: since,
              channel: null,
              actor: null,
              waitingMinutes: waited,
              ...(nowWhat === 'WAIT_DELIVERY' ? { supplierName: po.supplier.nameTh } : {}),
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
    waiting: waitingOf(po, w, waited),
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
  const history = await historyFrom(db, events, (taskId) => roleOf(resolvedFrom.get(taskId)), escalatedTaskIdsOf(events, taskRows))
  // The reason the variance was recorded with is its own note
  const recorded = history.map((h) => (h.what === 'VARIANCE_RECORDED' ? { ...h, note: v.reason } : h))
  const live = v.status === 'PENDING_APPROVAL' ? liveRouteSteps(route, waitingFor(w, v.currentRouteId)) : []
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
