import type { Ctx } from '@/server/context'
import { escapeLike } from '@/server/db/like'
import { forTenant, type TenantDb } from '@/server/db/tenant'
import { searchSuppliers, type SupplierStatusDto, type TaxIdMatch } from './suppliers'

// The ⌘K search (spec FR-PLT-014, §9.10 "ค้นหาและคำสั่ง ⌘K"): document numbers of PRs, POs and GRs (any part) and
// request titles, suppliers by name or code (and tax id for readers who see it), and the documents the member acted on
// last. Queries cannot import authz, so src/server/services/search builds a SearchScope from the member's grants
// (§2.4 request.view, po.view, supplier.view) and every query here turns it into the WHERE clause of the read itself:
// nothing outside the scope is read and filtered afterwards, so no number, title or supplier leaves the database for
// a member who may not see it (BR-AUTH-05). Read only: no Event, no write (FR-PLT-014 AC5).

/** Fewest characters that start a search (FR-PLT-014 AC3) */
export const SEARCH_MIN_LENGTH = 2
/** Longest text taken */
export const SEARCH_MAX_LENGTH = 60
/** Results per group (FR-PLT-014 AC3, §9.10) */
export const SEARCH_GROUP_LIMIT = 5
/** How many of the member's latest events are read to find their recent documents */
const RECENT_EVENTS_READ = 50

/** What the member may find; built from their grants by the service (the query trusts it as given) */
export interface SearchScope {
  readonly memberId: string
  /** request.view: `all` = ORG; otherwise own, followed and assigned requests and those charged to `headedDepartmentIds` */
  readonly requests: { readonly all: boolean; readonly headedDepartmentIds: readonly string[] } | null
  /** po.view: `all` = ORG; otherwise POs they made, POs of their own requests, and POs they have or had a task on */
  readonly purchaseOrders: { readonly all: boolean } | null
  /** supplier.view: everyone with it finds names and codes; tax ids only by `taxIdMatch` (BR-AUTH-04) */
  readonly suppliers: { readonly taxIdMatch: TaxIdMatch | null } | null
}

export type SearchDocumentKind = 'REQUEST' | 'PURCHASE_ORDER' | 'GOODS_RECEIPT'

export interface SearchDocumentDto {
  readonly kind: SearchDocumentKind
  readonly id: string
  /** null for the requester's own draft, which has no number yet (BR-NUM-01) */
  readonly number: string | null
  /** The request's title; a PO or GR has none */
  readonly title: string | null
  readonly status: string
  /** The page that opens it */
  readonly href: string
}

export interface SearchSupplierDto {
  readonly id: string
  readonly code: string
  readonly nameTh: string
  readonly nameEn: string | null
  readonly status: SupplierStatusDto
  readonly href: string
}

export interface SearchResultDto {
  readonly documents: readonly SearchDocumentDto[]
  readonly suppliers: readonly SearchSupplierDto[]
}

/** Trimmed and cut to SEARCH_MAX_LENGTH; null when shorter than SEARCH_MIN_LENGTH */
export function searchText(q: string | null | undefined): string | null {
  const text = (q ?? '').trim().slice(0, SEARCH_MAX_LENGTH)
  return text.length >= SEARCH_MIN_LENGTH ? text : null
}

const contains = (text: string) => ({ contains: escapeLike(text), mode: 'insensitive' as const })

/** The subjects of the approval tasks the member has or had, as assignee or as the person a delegate acts for */
async function assignedSubjects(db: TenantDb, memberId: string, subjectType: 'REQUEST' | 'PURCHASE_ORDER'): Promise<string[]> {
  const tasks = await db.approvalTask.findMany({
    where: { OR: [{ assigneeMemberId: memberId }, { principalMemberId: memberId }], step: { route: { subjectType } } },
    select: { step: { select: { route: { select: { subjectId: true } } } } },
  })
  return [...new Set(tasks.map((t) => t.step.route.subjectId))]
}

/**
 * The requests in scope as a WHERE clause; null when none are. A draft is the requester's alone — nobody else finds it,
 * whatever their scope — until it is sent and numbered.
 */
async function requestsWhere(db: TenantDb, scope: SearchScope) {
  const requests = scope.requests
  if (!requests) return null
  const me = scope.memberId
  const draftsOwnOnly = { OR: [{ status: { not: 'DRAFT' as const } }, { requesterMemberId: me }] }
  if (requests.all) return draftsOwnOnly
  const assigned = await assignedSubjects(db, me, 'REQUEST')
  return {
    AND: [
      draftsOwnOnly,
      {
        OR: [
          { requesterMemberId: me },
          { followers: { some: { memberId: me } } },
          ...(assigned.length ? [{ id: { in: assigned } }] : []),
          ...(requests.headedDepartmentIds.length ? [{ chargedDepartmentId: { in: [...requests.headedDepartmentIds] } }] : []),
        ],
      },
    ],
  }
}

/** The POs in scope as a WHERE clause (the same facts as getPoAccess); null when none are */
async function purchaseOrdersWhere(db: TenantDb, scope: SearchScope) {
  const pos = scope.purchaseOrders
  if (!pos) return null
  if (pos.all) return {}
  const me = scope.memberId
  const assigned = await assignedSubjects(db, me, 'PURCHASE_ORDER')
  return {
    OR: [
      { createdById: me },
      { lines: { some: { sources: { some: { requestLine: { request: { requesterMemberId: me } } } } } } },
      ...(assigned.length ? [{ id: { in: assigned } }] : []),
    ],
  }
}

const requestHref = (id: string) => `/requests/${id}`
const poHref = (id: string) => `/procurement/pos/${id}`

type Ranked = SearchDocumentDto & { readonly at: Date }

/** Documents whose number holds `text` (any part), and requests whose title does; at most SEARCH_GROUP_LIMIT */
async function findDocuments(db: TenantDb, scope: SearchScope, text: string): Promise<SearchDocumentDto[]> {
  const [requestScope, poScope] = await Promise.all([requestsWhere(db, scope), purchaseOrdersWhere(db, scope)])
  const take = SEARCH_GROUP_LIMIT
  const [requests, pos, grs] = await Promise.all([
    requestScope
      ? db.request.findMany({
          where: { AND: [requestScope, { OR: [{ number: contains(text) }, { title: contains(text) }] }] },
          select: { id: true, number: true, title: true, status: true, updatedAt: true },
          orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
          take,
        })
      : [],
    poScope
      ? db.purchaseOrder.findMany({
          where: { AND: [poScope, { number: contains(text) }] },
          select: { id: true, number: true, status: true, updatedAt: true },
          orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
          take,
        })
      : [],
    // A receipt is seen with its PO (§9.1: a GR opens on its PO's page)
    poScope
      ? db.goodsReceipt.findMany({
          where: { number: contains(text), status: { not: 'DRAFT' }, po: { is: poScope } },
          select: { id: true, number: true, status: true, poId: true, updatedAt: true },
          orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
          take,
        })
      : [],
  ])
  const ranked: Ranked[] = [
    ...requests.map((r): Ranked => ({ kind: 'REQUEST', id: r.id, number: r.number, title: r.title, status: r.status, href: requestHref(r.id), at: r.updatedAt })),
    ...pos.map((p): Ranked => ({ kind: 'PURCHASE_ORDER', id: p.id, number: p.number, title: null, status: p.status, href: poHref(p.id), at: p.updatedAt })),
    ...grs.map((g): Ranked => ({ kind: 'GOODS_RECEIPT', id: g.id, number: g.number, title: null, status: g.status, href: poHref(g.poId), at: g.updatedAt })),
  ]
  const exact = (d: Ranked) => (d.number?.toLowerCase() === text.toLowerCase() ? 0 : 1)
  return ranked
    .sort((a, b) => exact(a) - exact(b) || b.at.getTime() - a.at.getTime())
    .slice(0, take)
    .map(({ at: _at, ...d }) => d)
}

/** Suppliers by name or code, and by tax id only as `taxIdMatch` allows; basic fields only leave the query */
async function findSuppliers(ctx: Ctx, scope: SearchScope, text: string): Promise<SearchSupplierDto[]> {
  if (!scope.suppliers) return []
  const found = await searchSuppliers(ctx, { q: text, taxIdMatch: scope.suppliers.taxIdMatch, limit: SEARCH_GROUP_LIMIT })
  return found.rows.map((s) => ({ id: s.id, code: s.code, nameTh: s.nameTh, nameEn: s.nameEn, status: s.status, href: `/suppliers/${s.id}` }))
}

/** FR-PLT-014: documents and suppliers in the member's scope that match `q` (at least SEARCH_MIN_LENGTH characters) */
export async function searchInScope(ctx: Ctx, scope: SearchScope, q: string): Promise<SearchResultDto> {
  const text = searchText(q)
  if (!text) return { documents: [], suppliers: [] }
  const db = forTenant(ctx.organizationId)
  const [documents, suppliers] = await Promise.all([findDocuments(db, scope, text), findSuppliers(ctx, scope, text)])
  return { documents, suppliers }
}

/**
 * §9.10 "ล่าสุด": the documents the member acted on last (Events with them as the actor, newest first; a decision counts
 * for the document it decided), at most SEARCH_GROUP_LIMIT, each still in their scope now.
 */
export async function recentInScope(ctx: Ctx, scope: SearchScope): Promise<SearchDocumentDto[]> {
  const db = forTenant(ctx.organizationId)
  const events = await db.event.findMany({
    where: { actorMemberId: scope.memberId, aggregateType: { in: ['Request', 'PurchaseOrder', 'GoodsReceipt', 'ApprovalTask'] } },
    select: { aggregateType: true, aggregateId: true, data: true },
    orderBy: { seq: 'desc' },
    take: RECENT_EVENTS_READ,
  })
  const order: Array<{ kind: SearchDocumentKind; id: string }> = []
  const seen = new Set<string>()
  const add = (kind: SearchDocumentKind, id: string) => {
    if (seen.has(id)) return
    seen.add(id)
    order.push({ kind, id })
  }
  for (const e of events) {
    if (e.aggregateType === 'Request') add('REQUEST', e.aggregateId)
    else if (e.aggregateType === 'PurchaseOrder') add('PURCHASE_ORDER', e.aggregateId)
    else if (e.aggregateType === 'GoodsReceipt') add('GOODS_RECEIPT', e.aggregateId)
    else {
      const data = e.data as { subjectType?: unknown; subjectId?: unknown } | null
      if (typeof data?.subjectId !== 'string') continue
      if (data.subjectType === 'REQUEST') add('REQUEST', data.subjectId)
      else if (data.subjectType === 'PURCHASE_ORDER') add('PURCHASE_ORDER', data.subjectId)
    }
  }
  const ids = (kind: SearchDocumentKind) => order.filter((o) => o.kind === kind).map((o) => o.id)
  const [requestScope, poScope] = await Promise.all([requestsWhere(db, scope), purchaseOrdersWhere(db, scope)])
  const [requests, pos, grs] = await Promise.all([
    requestScope && ids('REQUEST').length
      ? db.request.findMany({ where: { AND: [requestScope, { id: { in: ids('REQUEST') } }] }, select: { id: true, number: true, title: true, status: true } })
      : [],
    poScope && ids('PURCHASE_ORDER').length
      ? db.purchaseOrder.findMany({ where: { AND: [poScope, { id: { in: ids('PURCHASE_ORDER') } }] }, select: { id: true, number: true, status: true } })
      : [],
    poScope && ids('GOODS_RECEIPT').length
      ? db.goodsReceipt.findMany({ where: { id: { in: ids('GOODS_RECEIPT') }, status: { not: 'DRAFT' }, po: { is: poScope } }, select: { id: true, number: true, status: true, poId: true } })
      : [],
  ])
  const found = new Map<string, SearchDocumentDto>([
    ...requests.map((r) => [r.id, { kind: 'REQUEST', id: r.id, number: r.number, title: r.title, status: r.status, href: requestHref(r.id) }] as const),
    ...pos.map((p) => [p.id, { kind: 'PURCHASE_ORDER', id: p.id, number: p.number, title: null, status: p.status, href: poHref(p.id) }] as const),
    ...grs.map((g) => [g.id, { kind: 'GOODS_RECEIPT', id: g.id, number: g.number, title: null, status: g.status, href: poHref(g.poId) }] as const),
  ])
  return order.flatMap((o) => {
    const d = found.get(o.id)
    return d ? [d] : []
  }).slice(0, SEARCH_GROUP_LIMIT)
}
