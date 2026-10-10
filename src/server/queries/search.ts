import { SEARCH_GROUP_LIMIT, SEARCH_MIN_LENGTH } from '@/lib/constants'
import type { Ctx } from '@/server/context'
import { escapeLike } from '@/server/db/like'
import { recentDocumentsOf } from '@/server/db/sql/recent-documents'
import { forTenant, type TenantDb } from '@/server/db/tenant'
import { findSupplierRows, type SupplierStatusDto, type TaxIdMatch } from './suppliers'

// The ⌘K search (spec FR-PLT-014, §9.10 "ค้นหาและคำสั่ง ⌘K"): document numbers of PRs, POs and GRs (any part) and
// request titles, suppliers by name or code (and tax id for readers who see it), and the documents the member acted on
// last. Queries cannot import authz, so src/server/services/search builds a SearchScope from the member's grants
// (§2.4 request.view, po.view, supplier.view) and every query here turns it into the WHERE clause of the read itself:
// nothing outside the scope is read and filtered afterwards, so no number, title or supplier leaves the database for
// a member who may not see it (BR-AUTH-05). Read only: no Event, no write (FR-PLT-014 AC5).

/** Longest text taken */
export const SEARCH_MAX_LENGTH = 60
/** How many of the member's latest documents are read before the scope check keeps at most SEARCH_GROUP_LIMIT */
const RECENT_CANDIDATES = 50

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

/**
 * The rows of one kind whose number is `text`, then the latest that hold it: read apart, so that newer documents holding
 * the typed number in a longer one cannot crowd the exact one out of the group before it is ranked first. Prisma reads
 * an insensitive `equals` with ILIKE, so the exact read escapes % and _ too (NEW-61), and its rows are checked here.
 */
async function exactThenPartial<T extends { readonly id: string; readonly number: string | null }>(text: string, read: (match: 'exact' | 'part') => Promise<T[]>): Promise<T[]> {
  const [read1, part] = await Promise.all([read('exact'), read('part')])
  const exact = read1.filter((r) => r.number?.toLowerCase() === text.toLowerCase())
  return [...exact, ...part.filter((r) => !exact.some((e) => e.id === r.id))]
}

/** Documents whose number holds `text` (any part), and requests whose title does; at most SEARCH_GROUP_LIMIT */
async function findDocuments(db: TenantDb, scope: SearchScope, text: string): Promise<SearchDocumentDto[]> {
  const [requestScope, poScope] = await Promise.all([requestsWhere(db, scope), purchaseOrdersWhere(db, scope)])
  const take = SEARCH_GROUP_LIMIT
  const number = (match: 'exact' | 'part') => (match === 'exact' ? { equals: escapeLike(text), mode: 'insensitive' as const } : contains(text))
  const [requests, pos, grs] = await Promise.all([
    requestScope
      ? exactThenPartial(text, (match) =>
          db.request.findMany({
            where: { AND: [requestScope, match === 'exact' ? { number: number(match) } : { OR: [{ number: number(match) }, { title: contains(text) }] }] },
            select: { id: true, number: true, title: true, status: true, updatedAt: true },
            orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
            take,
          }),
        )
      : [],
    poScope
      ? exactThenPartial(text, (match) =>
          db.purchaseOrder.findMany({
            where: { AND: [poScope, { number: number(match) }] },
            select: { id: true, number: true, status: true, updatedAt: true },
            orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
            take,
          }),
        )
      : [],
    // A receipt is seen with its PO (§9.1: a GR opens on its PO's page)
    poScope
      ? exactThenPartial(text, (match) =>
          db.goodsReceipt.findMany({
            where: { number: number(match), status: { not: 'DRAFT' }, po: { is: poScope } },
            select: { id: true, number: true, status: true, poId: true, updatedAt: true },
            orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
            take,
          }),
        )
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
  const rows = await findSupplierRows(ctx, { q: text, taxIdMatch: scope.suppliers.taxIdMatch, limit: SEARCH_GROUP_LIMIT })
  return rows.map((s) => ({ id: s.id, code: s.code, nameTh: s.nameTh, nameEn: s.nameEn, status: s.status, href: `/suppliers/${s.id}` }))
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
  // Distinct documents, newest first; more than shown, as some may be out of scope now
  const order = await recentDocumentsOf(ctx.organizationId, scope.memberId, RECENT_CANDIDATES)
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
