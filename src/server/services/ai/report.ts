import { z } from 'zod'
import { creditPeriodMonth } from '@/core/ai-checks'
import { err, ok, type Result } from '@/core/result'
import { AI_AGENTS, type AiAgentName } from '@/lib/ai-config'
import { authorize, isAllowed, scopesFor, type Principal } from '@/server/authz'
import type { Ctx } from '@/server/context'
import { forTenant, type TenantTx } from '@/server/db/tenant'
import { creditBalance } from './gate'

// What /admin/ai reads besides the switches (NEW-125 · ADR-083 · BR-AI-04), for ORG_ADMIN and AUDITOR (admin.ai.view):
//  · the history of every call of an assistant from AgentAction — who asked, through which channel, what for, the
//    document, what it read (references and tools, never the document or the question), how many fields it filled and
//    which ones the person changed. The values the AI read and the person typed instead are content (ai.actions.view):
//    AUDITOR and the member who asked see them, ORG_ADMIN does not (AI_METADATA_ONLY);
//  · the history of the settings from the events ai_agent.* (who changed what, and when);
//  · the month's results, every number counted by code from AgentAction and Event and each one a filter of the
//    history; the amount found (OQ-41) and invoice numbers only for a reader of every invoice (readsEveryInvoice),
//    since ORG_ADMIN reads no invoice.

export const ACTIVITY_PAGE = 20
/** Settings changes shown, the newest first */
const SETTING_CHANGES = 50
/** Invoices listed under the amount found */
const FOUND_INVOICES = 20

export const ACTIVITY_FILTERS = ['ALL', 'FILLED', 'EDITED', 'FLAGGED', 'HELPFUL', 'NOT_HELPFUL', 'FAILED'] as const
export type ActivityFilter = (typeof ACTIVITY_FILTERS)[number]

const READ_PURPOSES = ['QUOTATION_READ', 'DELIVERY_NOTE_READ', 'INVOICE_READ'] as const
const DECIDED = ['ACCEPTED', 'EDITED'] as const
// TODO(OQ-41): what the month's "amount found" counts — what an invoice asked above its PO (the price, and the quantity
// over what was ordered) as the latest match of the month raised it; the savings of NEW-123 join when they are recorded
export const FOUND_EXCEPTIONS = ['PRICE_OVER', 'QTY_OVER_ORDERED'] as const

type Name = { readonly th: string; readonly en: string | null }

/** The first moment of a Thai month and of the next one ("YYYY-MM-01", UTC+7 without daylight saving) */
export function thaiMonthWindow(periodMonth: string): { from: Date; to: Date } {
  const [y, m] = periodMonth.split('-').map(Number) as [number, number]
  const next = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`
  return { from: new Date(`${periodMonth}T00:00:00+07:00`), to: new Date(`${next}-01T00:00:00+07:00`) }
}

const MonthInput = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/)

/** What the reader of /admin/ai may do and see beyond reading it */
export interface AiAdminAccess {
  readonly canManage: boolean
  /** AUDITOR: the values the AI read and what the person typed instead, of every member's call */
  readonly content: boolean
  /** A reader of every invoice (readsEveryInvoice): the amount found on invoices */
  readonly moneyFound: boolean
}

/**
 * Who reads every invoice of the organization, as the invoice page lets them (mayReadInvoice, BR-AP-13): FINANCE and
 * PROCUREMENT (invoice.record, invoice.reject) and the readers of every payment run, whose items are invoices (AUDITOR).
 * po.view alone is not enough: EXECUTIVE reads POs but no invoice.
 */
function readsEveryInvoice(principal: Principal): boolean {
  return isAllowed(principal, 'invoice.record') || isAllowed(principal, 'invoice.reject') || scopesFor(principal, 'paymentRun.view').has('ORG')
}

function accessOf(principal: Principal): AiAdminAccess {
  return {
    canManage: isAllowed(principal, 'admin.ai.manage'),
    content: principal.kind === 'member' && principal.roles.has('AUDITOR'),
    moneyFound: readsEveryInvoice(principal),
  }
}

async function viewer(tx: TenantTx, ctx: Ctx): Promise<Result<{ principal: Principal; access: AiAdminAccess }>> {
  const allowed = await authorize(tx, ctx, 'admin.ai.view')
  if (!allowed.ok) return err(allowed.error.code, allowed.error.message, allowed.error.details)
  return ok({ principal: allowed.data, access: accessOf(allowed.data) })
}

async function namesOf(tx: TenantTx, ids: readonly (string | null)[]): Promise<Map<string, Name>> {
  const wanted = [...new Set(ids.filter((i): i is string => Boolean(i)))]
  if (wanted.length === 0) return new Map()
  const rows = await tx.member.findMany({ where: { id: { in: wanted } }, select: { id: true, displayNameTh: true, displayNameEn: true } })
  return new Map(rows.map((r) => [r.id, { th: r.displayNameTh, en: r.displayNameEn }]))
}

// ---------- the history of the assistants' work ----------

export type DataUsed =
  | { readonly kind: 'FILES'; readonly count: number }
  | { readonly kind: 'REQUEST_TYPE'; readonly code: string }
  | { readonly kind: 'APPROVAL_TASK' }
  | { readonly kind: 'TOOL'; readonly name: string }

export interface ActivityRowDto {
  readonly id: string
  readonly createdAt: string
  readonly agent: string
  readonly purpose: string
  /** L0 calls (a question, a summary) are done once answered; L1 drafts wait for a person */
  readonly level: string
  readonly status: string
  readonly channel: string
  /** null: the system asked (the approver's summary is written by a job) */
  readonly requester: Name | null
  readonly subject: { readonly type: string; readonly number: string | null } | null
  readonly dataUsed: readonly DataUsed[]
  /** Fields the AI put into the form */
  readonly filled: number
  /** The fields the person changed (form paths) */
  readonly changedPaths: readonly string[]
  /** What the AI read and what the person kept instead: AUDITOR and the member who asked only */
  readonly changes: ReadonlyArray<{ readonly path: string; readonly ai: string | null; readonly final: string | null }> | null
  /** WARN or FAIL when the system's checks flagged something in what the AI read */
  readonly checks: 'WARN' | 'FAIL' | null
  readonly feedback: 'HELPFUL' | 'NOT_HELPFUL' | null
  readonly costCredits: number
  readonly errorCode: string | null
}

export interface ActivityPageDto {
  readonly access: AiAdminAccess
  readonly filter: { readonly show: ActivityFilter; readonly month: string | null; readonly agent: AiAgentName | null }
  readonly rows: readonly ActivityRowDto[]
  /** The id to read the older page from; null when this is the last */
  readonly before: string | null
}

export const ActivityQuery = z.strictObject({
  show: z.enum(ACTIVITY_FILTERS).default('ALL'),
  /** "YYYY-MM" (Thai month); absent = every month */
  month: MonthInput.nullish(),
  agent: z.enum(AI_AGENTS).nullish(),
  before: z.uuid().nullish(),
})

const flaggedWhere = { OR: [{ verification: { path: ['status'], equals: 'WARN' } }, { verification: { path: ['status'], equals: 'FAIL' } }] }

/** The rows each filter (and each number of the month's results) stands for */
function activityWhere(show: ActivityFilter, window: { from: Date; to: Date } | null, agent: AiAgentName | null) {
  const created = window ? { createdAt: { gte: window.from, lt: window.to } } : {}
  const decided = window ? { decidedAt: { gte: window.from, lt: window.to } } : { decidedAt: { not: null } }
  const byAgent = agent ? { agent } : {}
  switch (show) {
    case 'FILLED':
      return { ...byAgent, level: 'L1' as const, status: { in: [...DECIDED] }, ...decided }
    case 'EDITED':
      return { ...byAgent, level: 'L1' as const, status: 'EDITED' as const, ...decided }
    case 'FLAGGED':
      return { ...byAgent, ...created, purpose: { in: [...READ_PURPOSES] }, ...flaggedWhere }
    case 'HELPFUL':
      return { ...byAgent, ...created, feedback: 'HELPFUL' as const }
    case 'NOT_HELPFUL':
      return { ...byAgent, ...created, feedback: 'NOT_HELPFUL' as const }
    case 'FAILED':
      return { ...byAgent, ...created, status: 'FAILED' as const }
    default:
      return { ...byAgent, ...created }
  }
}

const proposedOf = (review: unknown): Record<string, unknown> => {
  const proposed = review && typeof review === 'object' ? (review as { proposed?: unknown }).proposed : null
  return proposed && typeof proposed === 'object' && !Array.isArray(proposed) ? (proposed as Record<string, unknown>) : {}
}

const diffOf = (diff: unknown): Array<{ path: string; ai: string | null; final: string | null }> => {
  if (!diff || typeof diff !== 'object' || Array.isArray(diff)) return []
  const text = (v: unknown) => (typeof v === 'string' ? v : null)
  return Object.entries(diff as Record<string, { ai?: unknown; final?: unknown } | null>)
    .map(([path, v]) => ({ path, ai: text(v?.ai), final: text(v?.final) }))
    .sort((a, b) => a.path.localeCompare(b.path))
}

/** References and tools only: the file read, the request type asked for, the approval task, the tools of a question */
function dataUsedOf(inputRefs: unknown, output: unknown): DataUsed[] {
  const refs = (inputRefs && typeof inputRefs === 'object' ? inputRefs : {}) as Record<string, unknown>
  const used: DataUsed[] = []
  const files = (typeof refs.fileId === 'string' ? 1 : 0) + (Array.isArray(refs.fileIds) ? refs.fileIds.length : 0)
  if (files > 0) used.push({ kind: 'FILES', count: files })
  if (typeof refs.requestTypeCode === 'string' && refs.requestTypeCode) used.push({ kind: 'REQUEST_TYPE', code: refs.requestTypeCode })
  if (typeof refs.taskId === 'string') used.push({ kind: 'APPROVAL_TASK' })
  // the tools of a question are metadata (§2.4 ai.actions.view): kept after the content is cleared only if output was
  const tools = output && typeof output === 'object' ? (output as { tools?: unknown }).tools : null
  if (Array.isArray(tools)) for (const t of tools) if (typeof t === 'string') used.push({ kind: 'TOOL', name: t })
  return used
}

/**
 * The numbers of the documents the calls were about, read in batches — only of the kinds the reader reads across the
 * organization (a request: request.view ORG; a PO and its receipts: po.view ORG; an invoice: readsEveryInvoice).
 * ORG_ADMIN reads no PO and no invoice, so a call about one shows its kind without its number.
 */
async function subjectNumbers(tx: TenantTx, principal: Principal, rows: ReadonlyArray<{ subjectType: string | null; subjectId: string | null }>): Promise<Map<string, string | null>> {
  const readable = new Set([...(scopesFor(principal, 'request.view').has('ORG') ? ['REQUEST'] : []), ...(scopesFor(principal, 'po.view').has('ORG') ? ['PURCHASE_ORDER', 'GOODS_RECEIPT'] : []), ...(readsEveryInvoice(principal) ? ['INVOICE'] : [])])
  const ids = (type: string) => (readable.has(type) ? [...new Set(rows.filter((r) => r.subjectType === type && r.subjectId).map((r) => r.subjectId!))] : [])
  const out = new Map<string, string | null>()
  const [requests, pos, invoices, receipts] = await Promise.all([
    ids('REQUEST').length ? tx.request.findMany({ where: { id: { in: ids('REQUEST') } }, select: { id: true, number: true } }) : [],
    ids('PURCHASE_ORDER').length ? tx.purchaseOrder.findMany({ where: { id: { in: ids('PURCHASE_ORDER') } }, select: { id: true, number: true } }) : [],
    ids('INVOICE').length ? tx.invoice.findMany({ where: { id: { in: ids('INVOICE') } }, select: { id: true, number: true, supplierInvoiceNo: true } }) : [],
    ids('GOODS_RECEIPT').length ? tx.goodsReceipt.findMany({ where: { id: { in: ids('GOODS_RECEIPT') } }, select: { id: true, number: true } }) : [],
  ])
  for (const r of requests) out.set(r.id, r.number)
  for (const r of pos) out.set(r.id, r.number)
  for (const r of invoices) out.set(r.id, r.number ?? r.supplierInvoiceNo)
  for (const r of receipts) out.set(r.id, r.number)
  return out
}

/** The history of the assistants' work, the newest first, ACTIVITY_PAGE at a time (admin.ai.view) */
export async function listAgentActivity(ctx: Ctx, query: z.input<typeof ActivityQuery> = {}): Promise<Result<ActivityPageDto>> {
  const parsed = ActivityQuery.safeParse(query)
  if (!parsed.success) return err('VALIDATION_FAILED', 'invalid filter', { field: String(parsed.error.issues[0]?.path[0] ?? 'show') })
  const q = parsed.data
  return forTenant(ctx.organizationId).$transaction(async (tx) => {
    const seen = await viewer(tx, ctx)
    if (!seen.ok) return seen
    const { principal, access } = seen.data
    const window = q.month ? thaiMonthWindow(`${q.month}-01`) : null
    // The newest first by when the call was made (a seeded history is written out of order); a page starts after the
    // row it names, ties broken by id
    const from = q.before ? await tx.agentAction.findFirst({ where: { id: q.before }, select: { id: true, createdAt: true } }) : null
    const after = from ? { OR: [{ createdAt: { lt: from.createdAt } }, { createdAt: from.createdAt, id: { lt: from.id } }] } : {}
    const rows = await tx.agentAction.findMany({
      where: { AND: [activityWhere(q.show, window, q.agent ?? null), after] },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: ACTIVITY_PAGE + 1,
      select: {
        id: true, createdAt: true, agent: true, purpose: true, level: true, status: true, channel: true, requestedById: true, subjectType: true, subjectId: true,
        inputRefs: true, output: true, review: true, diff: true, verification: true, feedback: true, costCredits: true, errorCode: true,
      },
    })
    const page = rows.slice(0, ACTIVITY_PAGE)
    const [names, numbers] = await Promise.all([namesOf(tx, page.map((r) => r.requestedById)), subjectNumbers(tx, principal, page)])
    const me = principal.kind === 'member' ? principal.memberId : null
    return ok({
      access,
      filter: { show: q.show, month: q.month ?? null, agent: q.agent ?? null },
      before: rows.length > ACTIVITY_PAGE ? page.at(-1)!.id : null,
      rows: page.map((r) => {
        const changes = diffOf(r.diff)
        const status = (r.verification as { status?: unknown } | null)?.status
        return {
          id: r.id,
          createdAt: r.createdAt.toISOString(),
          agent: r.agent,
          purpose: r.purpose,
          level: r.level,
          status: r.status,
          channel: r.channel,
          requester: r.requestedById ? (names.get(r.requestedById) ?? { th: '-', en: null }) : null,
          subject: r.subjectType ? { type: r.subjectType, number: r.subjectId ? (numbers.get(r.subjectId) ?? null) : null } : null,
          dataUsed: dataUsedOf(r.inputRefs, r.output),
          filled: Object.keys(proposedOf(r.review)).length,
          changedPaths: changes.map((c) => c.path),
          changes: access.content || (me !== null && r.requestedById === me) ? changes : null,
          checks: status === 'WARN' || status === 'FAIL' ? status : null,
          feedback: r.feedback,
          costCredits: r.costCredits,
          errorCode: r.errorCode,
        }
      }),
    })
  })
}

// ---------- the history of the settings ----------

export interface SettingChangeDto {
  readonly type: 'ai_agent.enabled' | 'ai_agent.disabled' | 'ai_agent.updated'
  readonly agent: string
  readonly enabled: boolean
  readonly minConfidenceBp: number
  /** The setting's version this change made (the first save is version 0) */
  readonly version: number
  readonly by: Name | null
  readonly at: string
}

/** Every change of the agents' settings, the newest first, from the events (admin.ai.view) */
export async function listSettingChanges(ctx: Ctx): Promise<Result<readonly SettingChangeDto[]>> {
  return forTenant(ctx.organizationId).$transaction(async (tx) => {
    const seen = await viewer(tx, ctx)
    if (!seen.ok) return seen
    const events = await tx.event.findMany({
      where: { aggregateType: 'AiAgentSetting', type: { in: ['ai_agent.enabled', 'ai_agent.disabled', 'ai_agent.updated'] } },
      orderBy: { seq: 'asc' },
      select: { aggregateId: true, type: true, data: true, actorMemberId: true, occurredAt: true },
    })
    const names = await namesOf(tx, events.map((e) => e.actorMemberId))
    // a setting starts at version 0 and every change adds one (ai_agent.update), so its n-th event made version n-1
    const count = new Map<string, number>()
    const changes = events.map((e) => {
      const version = count.get(e.aggregateId) ?? 0
      count.set(e.aggregateId, version + 1)
      // the seed's ai_agent.enabled of phase 1 carries no 'enabled' (src/server/seed/p1-ai.ts): the type says it
      const d = e.data as { agent: string; enabled?: boolean; minConfidenceBp: number }
      const enabled = typeof d.enabled === 'boolean' ? d.enabled : e.type !== 'ai_agent.disabled'
      return { type: e.type as SettingChangeDto['type'], agent: d.agent, enabled, minConfidenceBp: d.minConfidenceBp, version, by: e.actorMemberId ? (names.get(e.actorMemberId) ?? null) : null, at: e.occurredAt.toISOString() }
    })
    return ok(changes.reverse().slice(0, SETTING_CHANGES))
  })
}

// ---------- the month's results ----------

export interface FoundInvoiceDto {
  readonly invoiceId: string
  readonly number: string | null
  readonly supplier: Name
  readonly satang: bigint
  readonly types: readonly string[]
}

export interface MonthResultsDto {
  readonly access: AiAdminAccess
  /** "YYYY-MM-01" of the Thai month */
  readonly periodMonth: string
  /** "YYYY-MM": the month filter of the history */
  readonly month: string
  readonly calls: { readonly total: number; readonly failed: number }
  readonly agents: ReadonlyArray<{ readonly agent: AiAgentName; readonly calls: number; readonly credits: number }>
  /** Fields the AI filled of the readings and drafts people closed this month: kept as filled, or changed */
  readonly fields: { readonly documents: number; readonly filled: number; readonly kept: number; readonly changed: number; readonly editedDocuments: number }
  /** Readings the system's checks flagged, and how many of them a person has decided (taken in or turned down) */
  readonly checks: { readonly flagged: number; readonly decided: number }
  readonly feedback: { readonly helpful: number; readonly notHelpful: number }
  readonly credits: { readonly used: number; readonly granted: number }
  /** OQ-41; null when the reader does not read every PO */
  readonly found: { readonly satang: bigint; readonly invoices: number; readonly list: readonly FoundInvoiceDto[] } | null
}

/** The latest exception_raised of each invoice in the window, as code counts the amount found (OQ-41) */
async function amountFound(tx: TenantTx, window: { from: Date; to: Date }) {
  const events = await tx.event.findMany({
    where: { type: 'invoice.exception_raised', occurredAt: { gte: window.from, lt: window.to } },
    orderBy: { seq: 'asc' },
    select: { aggregateId: true, data: true },
  })
  const latest = new Map<string, Array<{ type: string; amountSatang: string }>>()
  for (const e of events) latest.set(e.aggregateId, (e.data as { exceptions: Array<{ type: string; amountSatang: string }> }).exceptions)
  const found: Array<{ invoiceId: string; satang: bigint; types: string[] }> = []
  for (const [invoiceId, exceptions] of latest) {
    const counted = exceptions.filter((x) => (FOUND_EXCEPTIONS as readonly string[]).includes(x.type))
    const satang = counted.reduce((sum, x) => sum + BigInt(x.amountSatang), 0n)
    if (satang > 0n) found.push({ invoiceId, satang, types: [...new Set(counted.map((x) => x.type))].sort() })
  }
  found.sort((a, b) => (b.satang > a.satang ? 1 : b.satang < a.satang ? -1 : a.invoiceId.localeCompare(b.invoiceId)))
  const shown = found.slice(0, FOUND_INVOICES)
  const invoices = shown.length
    ? await tx.invoice.findMany({ where: { id: { in: shown.map((f) => f.invoiceId) } }, select: { id: true, number: true, supplierInvoiceNo: true, supplier: { select: { nameTh: true, nameEn: true } } } })
    : []
  const byId = new Map(invoices.map((i) => [i.id, i]))
  return {
    satang: found.reduce((sum, f) => sum + f.satang, 0n),
    invoices: found.length,
    list: shown.flatMap((f) => {
      const i = byId.get(f.invoiceId)
      return i ? [{ invoiceId: f.invoiceId, number: i.number ?? i.supplierInvoiceNo, supplier: { th: i.supplier.nameTh, en: i.supplier.nameEn }, satang: f.satang, types: f.types }] : []
    }),
  }
}

/** This Thai month's results of the assistants, every number from AgentAction and Event (admin.ai.view) */
export async function monthResults(ctx: Ctx): Promise<Result<MonthResultsDto>> {
  return forTenant(ctx.organizationId).$transaction(async (tx) => {
    const seen = await viewer(tx, ctx)
    if (!seen.ok) return seen
    const { access } = seen.data
    const periodMonth = creditPeriodMonth(ctx.now)
    const window = thaiMonthWindow(periodMonth)
    const created = { createdAt: { gte: window.from, lt: window.to } }
    const [byAgent, failed, closed, flagged, flaggedDecided, helpful, notHelpful, balance] = await Promise.all([
      tx.agentAction.groupBy({ by: ['agent'], where: created, _count: { _all: true }, _sum: { costCredits: true } }),
      tx.agentAction.count({ where: activityWhere('FAILED', window, null) }),
      tx.agentAction.findMany({ where: activityWhere('FILLED', window, null), select: { status: true, review: true, diff: true } }),
      tx.agentAction.count({ where: activityWhere('FLAGGED', window, null) }),
      tx.agentAction.count({ where: { ...activityWhere('FLAGGED', window, null), status: { in: [...DECIDED, 'REJECTED'] } } }),
      tx.agentAction.count({ where: activityWhere('HELPFUL', window, null) }),
      tx.agentAction.count({ where: activityWhere('NOT_HELPFUL', window, null) }),
      creditBalance(tx, periodMonth),
    ])
    let filled = 0
    let changed = 0
    let editedDocuments = 0
    for (const a of closed) {
      const proposed = Object.keys(proposedOf(a.review)).length
      // a field the person changed counts once, and never more than the AI filled
      const edits = a.status === 'EDITED' ? Math.min(proposed, diffOf(a.diff).length) : 0
      filled += proposed
      changed += edits
      if (a.status === 'EDITED') editedDocuments += 1
    }
    const counts = new Map(byAgent.map((g) => [g.agent, { calls: g._count._all, credits: g._sum.costCredits ?? 0 }]))
    return ok({
      access,
      periodMonth,
      month: periodMonth.slice(0, 7),
      calls: { total: byAgent.reduce((sum, g) => sum + g._count._all, 0), failed },
      agents: AI_AGENTS.map((agent) => ({ agent, ...(counts.get(agent) ?? { calls: 0, credits: 0 }) })),
      fields: { documents: closed.length, filled, kept: filled - changed, changed, editedDocuments },
      checks: { flagged, decided: flaggedDecided },
      feedback: { helpful, notHelpful },
      credits: { used: balance.used, granted: balance.granted },
      found: access.moneyFound ? await amountFound(tx, window) : null,
    })
  })
}
