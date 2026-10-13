import type { TextValue } from '@/core/ai-checks'
import { satangToAmount } from '@/core/money/dto'
import type { InsightTool } from '@/lib/ai-schemas/agents'
import { isAllowed, loadPrincipal } from '@/server/authz'
import type { Ctx } from '@/server/context'
import { escapeLike } from '@/server/db/like'
import { forTenant } from '@/server/db/tenant'
import { poViewFacts } from '@/server/queries/receiving'
import { listMyRequests } from '@/server/queries/requests'
import { listMyTasks } from '@/server/queries/tasks'
import { boardView } from '../../board'
import { budgetDashboard } from '../../budget/dashboard'
import { insightsView } from '../../reports/insights'
import { kpiView } from '../../reports/screens'
import { requestViewScope } from '../../requests/view-scope'
import { searchForMember } from '../../search'
import { isIndividualTaxId, supplierAccess } from '../../suppliers/access'

// The tools of the Insight Agent (BR-AI-07 BR-AI-21, ADR-147, docs/sub-specs/S13.md "เครื่องมือของ Insight"): read only,
// each under the asking member's ctx and checking rights and scope itself — the services of the screens, which check
// already, or a query of their own that filters by the member's scope (purchase orders, suppliers). The AI picks tools
// by name only; the arguments come from the question, by code. Every row carries the link of what it shows; nothing
// personal leaves a tool (no e-mails, phones, addresses or an individual's tax id: BR-AI-18).

export interface ToolRow {
  readonly href: string | null
  readonly values: Readonly<Record<string, TextValue>>
}

export interface ToolResult {
  readonly tool: InsightTool
  readonly rows: readonly ToolRow[]
  /** Figures of the whole result (a threshold, a total) */
  readonly values: Readonly<Record<string, TextValue>>
}

/** Rows a tool returns at most */
export const TOOL_ROWS = 10
const PO_CANDIDATES = 50
const DOC_NUMBER = /\b[A-Z]{2,4}-\d{4}-\d{5}\b/
const BP_PER_PERCENT = 100

const money = (satang: bigint | null | undefined): TextValue | null => (satang === null || satang === undefined ? null : { kind: 'money', value: satangToAmount(satang) })
const text = (value: string | null | undefined): TextValue | null => (value ? { kind: 'text', value } : null)
const ref = (value: string | null | undefined): TextValue | null => (value ? { kind: 'ref', value } : null)
const row = (href: string | null, values: Record<string, TextValue | null>): ToolRow => ({ href, values: Object.fromEntries(Object.entries(values).filter((e): e is [string, TextValue] => e[1] !== null)) })
const empty = (tool: InsightTool): ToolResult => ({ tool, rows: [], values: {} })

async function searchDocuments(ctx: Ctx, question: string): Promise<ToolResult> {
  const found = await searchForMember(ctx, question)
  if (!found.ok) return empty('search_documents')
  const docs = found.data.documents.map((d) => row(d.href, { number: ref(d.number), title: text(d.title), status: { kind: 'enum', value: d.status } }))
  const suppliers = found.data.suppliers.map((s) => row(s.href, { code: ref(s.code), name: text(s.nameTh) }))
  return { tool: 'search_documents', rows: [...docs, ...suppliers].slice(0, TOOL_ROWS), values: {} }
}

async function getRequest(ctx: Ctx, question: string): Promise<ToolResult> {
  const number = DOC_NUMBER.exec(question)?.[0]
  if (!number) return empty('get_request')
  const db = forTenant(ctx.organizationId)
  const r = await db.request.findFirst({ where: { number }, select: { id: true, number: true, title: true, status: true, grossSatang: true } })
  if (!r) return empty('get_request')
  // request.view of this request, as its page decides (§2.4)
  const allowed = await db.$transaction(async (tx) => {
    const scope = await requestViewScope(tx, r.id)
    return scope !== null && isAllowed(await loadPrincipal(tx, ctx), 'request.view', scope)
  })
  return allowed ? { tool: 'get_request', rows: [row(`/requests/${r.id}`, { number: ref(r.number), title: text(r.title), status: { kind: 'enum', value: r.status }, gross: money(r.grossSatang) })], values: {} } : empty('get_request')
}

async function myRequests(ctx: Ctx): Promise<ToolResult> {
  const mine = await listMyRequests(ctx)
  return {
    tool: 'my_requests',
    rows: mine.rows.slice(0, TOOL_ROWS).map((r) => row(`/requests/${r.id}`, { number: ref(r.number), title: text(r.title), status: { kind: 'enum', value: r.status }, gross: money(r.grossSatang) })),
    // Nothing of their own: no figure either, so the answer says nothing was found (FR-AI-307 AC4)
    values: mine.rows.length ? { total: { kind: 'integer', value: mine.total } } : {},
  }
}

async function myTasks(ctx: Ctx): Promise<ToolResult> {
  const inbox = await listMyTasks(ctx, { limit: TOOL_ROWS })
  return {
    tool: 'my_tasks',
    rows: inbox.items.map((t) =>
      row(`/tasks/${t.id}`, {
        number: ref('number' in t.subject ? t.subject.number : null),
        title: text('title' in t.subject ? t.subject.title : null),
        amount: money(t.amountSatang),
        overdue: { kind: 'enum', value: t.overdue ? 'YES' : 'NO' },
      }),
    ),
    values: inbox.items.length ? { total: { kind: 'integer', value: inbox.total } } : {},
  }
}

async function pendingApprovals(ctx: Ctx): Promise<ToolResult> {
  const board = await boardView(ctx)
  if (!board.ok) return empty('pending_approvals')
  return {
    tool: 'pending_approvals',
    rows: board.data.rows.slice(0, TOOL_ROWS).map((b) => row('/board', { name: text(b.name), open: { kind: 'integer', value: b.open }, overdue: { kind: 'integer', value: b.overdue } })),
    values: {},
  }
}

async function budgetStatus(ctx: Ctx): Promise<ToolResult> {
  const dash = await budgetDashboard(ctx)
  if (!dash.ok) return empty('budget_status')
  const lines = [...dash.data.lines].filter((l) => l.availableBp !== null).sort((a, b) => a.availableBp! - b.availableBp!)
  return {
    tool: 'budget_status',
    rows: lines.slice(0, TOOL_ROWS).map((l) => row(`/budgets/${l.id}`, { code: ref(l.code), name: text(l.nameTh), remainingBp: { kind: 'bp', value: l.availableBp! }, available: money(BigInt(l.available.amount.replace('.', ''))), low: { kind: 'enum', value: l.low ? 'YES' : 'NO' } })),
    values: { lowThresholdBp: { kind: 'bp', value: dash.data.lowPct * BP_PER_PERCENT } },
  }
}

async function spendSummary(ctx: Ctx): Promise<ToolResult> {
  const view = await insightsView(ctx, {})
  if (!view.ok || !view.data.spend) return empty('spend_summary')
  const spend = view.data.spend
  return {
    tool: 'spend_summary',
    rows: spend.byDepartment.slice(0, TOOL_ROWS).map((d) => row('/insights', { department: text(d.nameTh), net: money(BigInt(d.netSatang)) })),
    values: { total: money(BigInt(spend.total.amount.replace('.', '')))!, poCount: { kind: 'integer', value: spend.poCount } },
  }
}

async function kpiSummary(ctx: Ctx): Promise<ToolResult> {
  const view = await kpiView(ctx, {} as never)
  if (!view.ok) return empty('kpi_summary')
  const k = view.data.kpi
  return {
    tool: 'kpi_summary',
    rows: [],
    values: {
      from: { kind: 'date', value: view.data.period.from },
      to: { kind: 'date', value: view.data.period.to },
      misrouted: { kind: 'integer', value: k.g2.misrouted },
      failedBudgetChecks: { kind: 'integer', value: k.g4.tasksOnFailedBudgetCheck },
    },
  }
}

/**
 * The POs the asking member may view (po.view, §2.4): the latest ones, each checked with the facts the PO's own page
 * uses — created by them or for their request, or on a route they were assigned (ADR-147). Never listPurchaseOrders,
 * which leaves scope to its screen.
 */
export async function listPurchaseOrdersForAsker(ctx: Ctx, limit = TOOL_ROWS) {
  const db = forTenant(ctx.organizationId)
  const principal = await db.$transaction((tx) => loadPrincipal(tx, ctx))
  if (principal.kind !== 'member') return []
  const candidates = await db.purchaseOrder.findMany({
    where: { status: { not: 'DRAFT' } },
    select: { id: true, number: true, status: true, grossSatang: true, supplier: { select: { nameTh: true } } },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: PO_CANDIDATES,
  })
  const out: typeof candidates = []
  for (const po of candidates) {
    if (out.length >= limit) break
    const f = await poViewFacts(db, po.id)
    if (isAllowed(principal, 'po.view', { ownerMemberIds: f.ownerMemberIds, assigneeMemberIds: f.assigneeMemberIds })) out.push(po)
  }
  return out
}

async function purchaseOrders(ctx: Ctx): Promise<ToolResult> {
  const pos = await listPurchaseOrdersForAsker(ctx)
  return { tool: 'purchase_orders', rows: pos.map((p) => row(`/procurement/pos/${p.id}`, { number: ref(p.number), supplier: text(p.supplier.nameTh), status: { kind: 'enum', value: p.status }, gross: money(p.grossSatang) })), values: {} }
}

/**
 * Suppliers the asking member may see (supplierAccess): code, name, status and category for BASIC; the tax id of a
 * juristic person too for FULL. Never an e-mail, a phone, an address or an individual's tax id (BR-AI-18).
 */
export async function findSuppliersForAsker(ctx: Ctx, question: string) {
  const db = forTenant(ctx.organizationId)
  const access = supplierAccess(await db.$transaction((tx) => loadPrincipal(tx, ctx)))
  if (!access) return []
  const words = question.split(/\s+/).map((w) => w.trim()).filter((w) => w.length >= 2).slice(0, 8)
  if (words.length === 0) return []
  const found = await db.supplier.findMany({
    where: { OR: words.flatMap((w) => [{ code: w }, { nameTh: { contains: escapeLike(w), mode: 'insensitive' as const } }]) },
    select: { id: true, code: true, nameTh: true, status: true, category: true, taxId: true, isForeign: true },
    orderBy: { code: 'asc' },
    take: TOOL_ROWS,
  })
  return found.map((s) => ({ id: s.id, code: s.code, nameTh: s.nameTh, status: s.status, category: s.category, taxId: access.level === 'FULL' && !isIndividualTaxId(s.taxId, s.isForeign) ? s.taxId : null }))
}

async function findSupplier(ctx: Ctx, question: string): Promise<ToolResult> {
  const found = await findSuppliersForAsker(ctx, question)
  return {
    tool: 'find_supplier',
    rows: found.map((s) => row(`/suppliers/${s.id}`, { code: ref(s.code), name: text(s.nameTh), status: { kind: 'enum', value: s.status }, category: text(s.category), taxId: ref(s.taxId) })),
    values: {},
  }
}

/** Runs one tool for the asking member; the question is the only source of its arguments */
export function runTool(ctx: Ctx, tool: InsightTool, question: string): Promise<ToolResult> {
  switch (tool) {
    case 'search_documents':
      return searchDocuments(ctx, question)
    case 'get_request':
      return getRequest(ctx, question)
    case 'my_requests':
      return myRequests(ctx)
    case 'my_tasks':
      return myTasks(ctx)
    case 'pending_approvals':
      return pendingApprovals(ctx)
    case 'budget_status':
      return budgetStatus(ctx)
    case 'spend_summary':
      return spendSummary(ctx)
    case 'kpi_summary':
      return kpiSummary(ctx)
    case 'purchase_orders':
      return purchaseOrders(ctx)
    case 'find_supplier':
      return findSupplier(ctx, question)
    default:
      return Promise.resolve(empty(tool))
  }
}

/** The values of the tools' results by placeholder key: t<n>.<row>.<field> and t<n>.<field> (golden ai-text) */
export function toolValues(results: readonly ToolResult[]): Record<string, TextValue> {
  const out: Record<string, TextValue> = {}
  results.forEach((r, i) => {
    for (const [k, v] of Object.entries(r.values)) out[`t${i + 1}.${k}`] = v
    r.rows.forEach((rowOf, j) => {
      for (const [k, v] of Object.entries(rowOf.values)) out[`t${i + 1}.${j}.${k}`] = v
    })
  })
  return out
}
