import { createHash } from 'node:crypto'
import { agreementDay } from '@/core/pricing/agreement'
import { err, ok, type Result } from '@/core/result'
import type { PaymentFlag } from '@/core/payment'
import { taxDateOf } from '@/core/vat'
import { ASSISTANT_DUE_SOON_MS, kindOfKey, rankSuggestions, SUGGESTION_KEY_MAX, SUGGESTION_SHOWN, SUGGESTION_TONE, type SuggestionKind, type SuggestionTone } from '@/lib/assistant-suggestions'
import { MS_PER_DAY } from '@/lib/constants'
import { paymentSettingsOf } from '@/lib/org-settings'
import { authorize, isAllowed, loadPrincipal, scopesFor, type Principal } from '@/server/authz'
import type { Ctx } from '@/server/context'
import { forTenant } from '@/server/db/tenant'
import { itemFlagsNow, supplierFacts } from '@/server/queries/payment-runs'
import { riskOverridesForPayment } from '@/server/queries/risk-overrides'
import { myRequestsWhere } from '@/server/queries/requests'
import { listMyTasks } from '@/server/queries/tasks'
import { defineCommand, runCommand, type CommandOutcome, type RunOptions } from '../_pipeline'
import { budgetDashboard } from '../budget/dashboard'
import { getPriceReference } from '../price-reference'
import { z } from 'zod'

// The home card "ผู้ช่วยเจอให้คุณ" (NEW-121 · ADR-078): what the rules the system already has found for this member, in
// one place, each with one way to the page where it is dealt with. Nothing here decides or adds a rule, and no AI is
// called: every kind is read through the query or service that already answers it, with that source's own permission —
//  · FOLLOW_OVERDUE · FOLLOW_DUE_SOON: the member's own and followed requests (the card "ที่ฉันติดตาม") waiting on
//    somebody else's task past its due time, or due within a day; the member's own tasks are in "รอฉันอนุมัติ";
//  · REQUEST_FLAG: the member's open tasks on a request flagged as a duplicate or a split (BR-DUP-05 shows the approver);
//  · PRICE_HIGH: a line of a request of the member's open tasks above its price reference (getPriceReference checks
//    priceReference.view itself);
//  · AGREEMENT_EXPIRING: agreed prices in effect that end within 30 days, for catalog.manage;
//  · BUDGET_LOW: the lines the budget dashboard marks low (budgetDashboard checks budget.view and its scope);
//  · SUPPLIER_FLAGS: suppliers of invoices ready for payment that a payment run would flag today (BR-PAY-06), for
//    paymentRun.view of the whole organization; flag codes only, never an account number (BR-AUTH-04).
// A member sets one aside by its key (AssistantDismissal); a key names the situation, so a new state shows again.

/** Agreed prices ending within this many days */
export const AGREEMENT_DAYS = 30
/** At most this many of the member's tasks have their price reference read, the earliest due first */
const PRICE_TASKS = 10
/** At most this many suppliers with invoices ready for payment are checked, the earliest due first */
const SUPPLIERS_CHECKED = 20

interface Base {
  readonly key: string
  readonly tone: SuggestionTone
  readonly href: string
  /** What orders suggestions of one tone: the earlier first */
  readonly at: Date | null
}

type Name = { readonly th: string; readonly en: string | null }

export type SuggestionDto = Base &
  (
    | { readonly kind: 'FOLLOW_OVERDUE' | 'FOLLOW_DUE_SOON'; readonly number: string | null; readonly title: string; readonly waitingFor: Name; readonly dueAt: Date }
    | { readonly kind: 'REQUEST_FLAG'; readonly number: string | null; readonly title: string; readonly flags: ReadonlyArray<'DUPLICATE' | 'SPLIT'> }
    | { readonly kind: 'PRICE_HIGH'; readonly number: string | null; readonly lineNo: number; readonly description: string; readonly deviationBp: number; readonly samples: number; readonly windowDays: number }
    | { readonly kind: 'AGREEMENT_EXPIRING'; readonly count: number; readonly days: number; readonly first: { readonly item: Name; readonly supplier: Name; readonly validTo: string } }
    | { readonly kind: 'BUDGET_LOW'; readonly count: number; readonly lowPct: number; readonly first: { readonly code: string; readonly availableBp: number } }
    | { readonly kind: 'SUPPLIER_FLAGS'; readonly supplier: Name; readonly flags: readonly PaymentFlag[]; readonly invoices: number }
  )

export interface SuggestionsDto {
  /** The first SUGGESTION_SHOWN of them, the most pressing first */
  readonly items: readonly SuggestionDto[]
  /** All the member has not set aside */
  readonly total: number
}

const nameOf = (r: { displayNameTh: string; displayNameEn: string | null }): Name => ({ th: r.displayNameTh, en: r.displayNameEn })

/**
 * What names a suggestion about a set (the low budget lines, the agreed prices ending): its members, whichever order they
 * came in, in a few characters — so another line becoming low as one is topped up is a new situation, not the one set aside
 */
export const setKey = (ids: readonly string[]) => `${ids.length}:${createHash('sha256').update([...ids].sort().join(',')).digest('hex').slice(0, 16)}`
const tone = (kind: SuggestionKind) => SUGGESTION_TONE[kind]

async function followed(ctx: Ctx, me: string): Promise<SuggestionDto[]> {
  const db = forTenant(ctx.organizationId)
  const requests = await db.request.findMany({ where: { AND: [myRequestsWhere(me, { scope: 'FOLLOWING' }), { status: 'PENDING_APPROVAL' }] }, select: { id: true, number: true, title: true } })
  if (requests.length === 0) return []
  const soon = new Date(ctx.now.getTime() + ASSISTANT_DUE_SOON_MS)
  const tasks = await db.approvalTask.findMany({
    where: {
      status: 'OPEN',
      dueAt: { not: null, lt: soon },
      // not mine, nor held for me (a task without a delegator has no principal: NULL must not drop it)
      assigneeMemberId: { not: me },
      OR: [{ principalMemberId: null }, { principalMemberId: { not: me } }],
      step: { route: { status: 'ACTIVE', subjectType: 'REQUEST', subjectId: { in: requests.map((r) => r.id) } } },
    },
    orderBy: [{ dueAt: 'asc' }, { id: 'asc' }],
    select: { id: true, dueAt: true, assignee: { select: { displayNameTh: true, displayNameEn: true } }, step: { select: { route: { select: { subjectId: true } } } } },
  })
  const byId = new Map(requests.map((r) => [r.id, r]))
  const seen = new Set<string>()
  return tasks.flatMap((t) => {
    const request = byId.get(t.step.route.subjectId)
    // one per request: the task due first
    if (!request || seen.has(request.id)) return []
    seen.add(request.id)
    const kind = t.dueAt! <= ctx.now ? 'FOLLOW_OVERDUE' : 'FOLLOW_DUE_SOON'
    return [{ kind, key: `${kind}:${t.id}`, tone: tone(kind), href: `/requests/${request.id}`, at: t.dueAt, number: request.number, title: request.title, waitingFor: nameOf(t.assignee), dueAt: t.dueAt! }]
  })
}

async function onMyTasks(ctx: Ctx): Promise<SuggestionDto[]> {
  const inbox = await listMyTasks(ctx)
  const tasks = inbox.items
    .filter((t) => t.status === 'OPEN' && t.subject.kind === 'REQUEST')
    .sort((a, b) => (a.dueAt?.getTime() ?? Number.MAX_SAFE_INTEGER) - (b.dueAt?.getTime() ?? Number.MAX_SAFE_INTEGER) || (a.id < b.id ? -1 : 1))
  if (tasks.length === 0) return []
  const requestOf = (t: (typeof tasks)[number]) => (t.subject.kind === 'REQUEST' ? t.subject : null)!
  const out: SuggestionDto[] = []

  // BR-DUP-05: the flags of the request's latest route, which the approver's card shows
  const flags = await forTenant(ctx.organizationId).requestFlag.findMany({ where: { requestId: { in: tasks.map((t) => requestOf(t).requestId) } }, select: { requestId: true, routeNo: true, kind: true } })
  for (const t of tasks) {
    const own = flags.filter((f) => f.requestId === requestOf(t).requestId)
    const latest = Math.max(...own.map((f) => f.routeNo))
    const kinds = [...new Set(own.filter((f) => f.routeNo === latest).map((f) => f.kind))].sort()
    if (kinds.length === 0) continue
    out.push({ kind: 'REQUEST_FLAG', key: `REQUEST_FLAG:${t.id}:${kinds.join('+')}`, tone: tone('REQUEST_FLAG'), href: `/tasks/${t.id}`, at: t.dueAt, number: requestOf(t).number, title: requestOf(t).title, flags: kinds })
  }

  // the line furthest above its reference, read as the approver's own panel reads it
  for (const t of tasks.slice(0, PRICE_TASKS)) {
    const reference = await getPriceReference(ctx, { requestId: requestOf(t).requestId })
    if (!reference.ok) continue
    const high = reference.data.lines.filter((l) => l.alert === 'HIGH' && l.deviationBp !== null).sort((a, b) => b.deviationBp! - a.deviationBp! || a.lineNo - b.lineNo)[0]
    if (!high) continue
    out.push({
      kind: 'PRICE_HIGH',
      key: `PRICE_HIGH:${t.id}:${high.lineNo}`,
      tone: tone('PRICE_HIGH'),
      href: `/tasks/${t.id}`,
      at: t.dueAt,
      number: requestOf(t).number,
      lineNo: high.lineNo,
      description: high.description,
      deviationBp: high.deviationBp!,
      samples: high.count,
      windowDays: reference.data.windowDays,
    })
  }
  return out
}

async function agreementsEnding(ctx: Ctx): Promise<SuggestionDto[]> {
  const today = agreementDay(ctx.now)
  const from = new Date(`${today}T00:00:00Z`)
  const until = new Date(from.getTime() + AGREEMENT_DAYS * MS_PER_DAY)
  const where = { endedAt: null, validFrom: { lte: from }, validTo: { gt: from, lte: until } }
  const db = forTenant(ctx.organizationId)
  const [ending, first] = await Promise.all([
    db.priceAgreement.findMany({ where, select: { id: true } }),
    db.priceAgreement.findFirst({
      where,
      orderBy: [{ validTo: 'asc' }, { id: 'asc' }],
      select: { id: true, validTo: true, catalogItem: { select: { nameTh: true, nameEn: true } }, supplier: { select: { nameTh: true, nameEn: true } } },
    }),
  ])
  if (!first) return []
  const count = ending.length
  const validTo = first.validTo.toISOString().slice(0, 10)
  return [
    {
      kind: 'AGREEMENT_EXPIRING',
      key: `AGREEMENT_EXPIRING:${setKey(ending.map((a) => a.id))}`,
      tone: tone('AGREEMENT_EXPIRING'),
      href: '/catalog/manage',
      at: first.validTo,
      count,
      days: AGREEMENT_DAYS,
      first: { item: { th: first.catalogItem.nameTh, en: first.catalogItem.nameEn }, supplier: { th: first.supplier.nameTh, en: first.supplier.nameEn }, validTo },
    },
  ]
}

async function budgetLow(ctx: Ctx): Promise<SuggestionDto[]> {
  const dashboard = await budgetDashboard(ctx)
  // FORBIDDEN: a member the dashboard does not answer has no budget suggestion either
  if (!dashboard.ok || !dashboard.data.fiscalYear) return []
  const low = dashboard.data.lines.filter((l) => l.low && l.status !== 'CLOSED').sort((a, b) => (a.availableBp ?? 0) - (b.availableBp ?? 0) || a.code.localeCompare(b.code))
  const first = low[0]
  if (!first) return []
  return [
    {
      kind: 'BUDGET_LOW',
      key: `BUDGET_LOW:${dashboard.data.fiscalYear.id}:${setKey(low.map((l) => l.id))}`,
      tone: tone('BUDGET_LOW'),
      href: low.length === 1 ? `/budgets/${first.id}` : '/budgets',
      at: null,
      count: low.length,
      lowPct: dashboard.data.lowPct,
      first: { code: first.code, availableBp: first.availableBp ?? 0 },
    },
  ]
}

async function suppliersFlagged(ctx: Ctx): Promise<SuggestionDto[]> {
  return forTenant(ctx.organizationId).$transaction(async (tx) => {
    const invoices = await tx.invoice.findMany({ where: { status: 'READY_FOR_PAYMENT' }, orderBy: [{ dueDate: 'asc' }, { id: 'asc' }], select: { id: true, supplierId: true, dueDate: true } })
    if (invoices.length === 0) return []
    const supplierIds = [...new Set(invoices.map((i) => i.supplierId))].slice(0, SUPPLIERS_CHECKED)
    const org = await tx.organization.findUniqueOrThrow({ where: { id: ctx.organizationId }, select: { settings: true } })
    const { recentBankChangeDays } = paymentSettingsOf(org.settings)
    const facts = await supplierFacts(tx, supplierIds)
    // FR-PAY-101 AC13 (S11-08): the risk overrides on today's pay date, as a run would weigh them
    const overrides = await riskOverridesForPayment(tx, supplierIds, taxDateOf(ctx.now))
    const names = new Map((await tx.supplier.findMany({ where: { id: { in: supplierIds } }, select: { id: true, nameTh: true, nameEn: true } })).map((s) => [s.id, { th: s.nameTh, en: s.nameEn }]))
    const out: SuggestionDto[] = []
    // one query at a time: they share the transaction's connection
    for (const supplierId of supplierIds) {
      const own = invoices.filter((i) => i.supplierId === supplierId)
      const { flags } = await itemFlagsNow(tx, { payDate: taxDateOf(ctx.now), recentBankChangeDays, supplier: facts.get(supplierId)!, docIds: own.map((i) => i.id), riskOverrides: overrides.get(supplierId) ?? [] })
      if (flags.length === 0) continue
      const sorted = [...flags].sort()
      out.push({ kind: 'SUPPLIER_FLAGS', key: `SUPPLIER_FLAGS:${supplierId}:${sorted.join('+')}`, tone: tone('SUPPLIER_FLAGS'), href: `/finance/invoices/${own[0]!.id}`, at: own[0]!.dueDate, supplier: names.get(supplierId)!, flags: sorted, invoices: own.length })
    }
    return out
  })
}

/** What each source gives this member, by the source's own permission; none is read for a member it would refuse */
async function gather(ctx: Ctx, principal: Extract<Principal, { kind: 'member' }>): Promise<SuggestionDto[]> {
  const me = principal.memberId
  const parts = await Promise.all([
    followed(ctx, me),
    onMyTasks(ctx),
    isAllowed(principal, 'catalog.manage') ? agreementsEnding(ctx) : [],
    budgetLow(ctx),
    scopesFor(principal, 'paymentRun.view').has('ORG') ? suppliersFlagged(ctx) : [],
  ])
  return parts.flat()
}

/** Every suggestion of the member that they have not set aside, the most pressing first */
export async function allSuggestions(ctx: Ctx): Promise<Result<SuggestionDto[]>> {
  if (ctx.actor.type !== 'USER') return err('FORBIDDEN', 'the home page is a member’s')
  const db = forTenant(ctx.organizationId)
  const principal = await db.$transaction((tx) => loadPrincipal(tx, ctx))
  if (principal.kind !== 'member') return err('FORBIDDEN', 'the home page is a member’s')
  const found = await gather(ctx, principal)
  const dismissed = found.length ? await db.assistantDismissal.findMany({ where: { memberId: principal.memberId, key: { in: found.map((s) => s.key) } }, select: { key: true } }) : []
  const aside = new Set(dismissed.map((d) => d.key))
  return ok(rankSuggestions(found.filter((s) => !aside.has(s.key))))
}

/** The card: the first five, and how many there are */
export async function homeSuggestions(ctx: Ctx): Promise<Result<SuggestionsDto>> {
  const all = await allSuggestions(ctx)
  if (!all.ok) return all
  return ok({ items: all.data.slice(0, SUGGESTION_SHOWN), total: all.data.length })
}

// ---------- setting one aside ----------

const DismissInput = z.strictObject({
  key: z
    .string()
    .min(1)
    .max(SUGGESTION_KEY_MAX)
    .refine((k) => kindOfKey(k) !== null, { message: 'not a suggestion key' }),
})

/** Setting a suggestion aside, like marking a notification read: the member's own, nobody else's (self.notificationPrefs) */
export const dismissSuggestionCommand = defineCommand({
  name: 'assistant.dismiss',
  capability: 'self.notificationPrefs',
  input: DismissInput,
  async execute(tx, input, ctx): Promise<CommandOutcome<{ key: string }>> {
    const memberId = ctx.actor.type === 'USER' ? ctx.actor.memberId : null
    if (!memberId) return { ok: false, error: { code: 'FORBIDDEN', message: 'members only' } }
    const allowed = await authorize(tx, ctx, 'self.notificationPrefs', { ownerMemberIds: [memberId] })
    if (!allowed.ok) return { ok: false, error: allowed.error }
    // set aside once: a second press of the same key changes nothing and records nothing more
    const { count } = await tx.assistantDismissal.createMany({ data: [{ organizationId: ctx.organizationId, memberId, key: input.key, dismissedAt: ctx.now }], skipDuplicates: true })
    if (count === 0) return { ok: false, error: { code: 'INVALID_STATE_TRANSITION', message: 'already set aside' } }
    return {
      ok: true,
      result: { key: input.key },
      events: [{ type: 'assistant.suggestion_dismissed', aggregateType: 'Assistant', aggregateId: memberId, data: { kind: kindOfKey(input.key)!, key: input.key } }],
    }
  },
})

/**
 * Only a suggestion the member has now can be set aside (NOT_FOUND otherwise, nothing written): a key made up, another
 * member's, or one already set aside writes no row and no event. The command's own check covers two presses at once.
 */
export async function dismissSuggestion(ctx: Ctx, input: z.input<typeof DismissInput>, options: RunOptions) {
  const parsed = DismissInput.safeParse(input)
  if (parsed.success) {
    const current = await allSuggestions(ctx)
    if (!current.ok) return current
    if (!current.data.some((s) => s.key === parsed.data.key)) return err('NOT_FOUND', 'no such suggestion of yours')
  }
  // an input the schema refuses is answered VALIDATION_FAILED by the command's own pipeline
  return runCommand(ctx, dismissSuggestionCommand, input, options)
}
