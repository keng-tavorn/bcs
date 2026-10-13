import { checkAiText, renderValue, type TextValue } from '@/core/ai-checks'
import { satangToAmount } from '@/core/money/dto'
import { err, ok, type Result } from '@/core/result'
import { getAiClient } from '@/integrations/ai'
import { DECISION_ADVICE_WORDS, modelFor } from '@/lib/ai-config'
import { BriefText, briefInputText } from '@/lib/ai-schemas/agents'
import { MS_PER_DAY, MS_PER_HOUR } from '@/lib/constants'
import { getEnv } from '@/lib/env'
import { isAllowed, loadPrincipal } from '@/server/authz'
import { makeCtx, systemCtx, type Ctx } from '@/server/context'
import { forTenant } from '@/server/db/tenant'
import { poViewFacts } from '@/server/queries/receiving'
import { budgetLineAvailable } from '../../budget/line-available'
import { completeAgentAction, expireAgentAction, requestAgentAction } from '../actions'
import { aiRuntime } from '../gate'

// Approval Brief (FR-AI-301 AC1–AC6, BR-AI-20, BR-AI-27, ADR-144 ADR-145). Facts are built by code every time they are
// read, under the rights of the one who reads — the assignee of the task or the member they act for (BR-DLG-04): the
// amount on the DOA's basis and its rule, the budget line's balance (budget.view only), the quotations, the reference
// price (none before S6's getPriceReference is in main: "no reference", never a guess), the supplier's POs of the last
// 12 months the reader may view (po.view), and the time left of the SLA. Once per task the AI writes sentences whose
// every value is a placeholder of a fact (job ai-approval-brief); only the sentences and the keys of every fact it was
// given are kept. A reader sees the sentences only when their own facts hold every one of those keys, filled with their
// own values; otherwise the facts alone. The Brief never decides and is never on a LINE card or a push.

/** Brief profile of BR-AI-27: at most 4 sentences of 120 characters */
export const BRIEF_PROFILE = { maxSentences: 4, maxChars: 120 } as const
const SUPPLIER_HISTORY_DAYS = 365
/** Steps a Brief is written for; REVIEW and COMMITTEE steps come with S6 (getRouteView) and get none (BR-AI-20) */
const BRIEF_SUBJECTS = ['REQUEST', 'PURCHASE_ORDER'] as const

export type BriefFacts = Readonly<Record<string, TextValue>>

interface TaskOfBrief {
  readonly id: string
  readonly status: string
  readonly assigneeMemberId: string
  readonly principalMemberId: string | null
  readonly dueAt: Date | null
  readonly route: { readonly subjectType: string; readonly subjectId: string; readonly amountBasis: string; readonly amountSatang: bigint | null; readonly ruleCode: string }
}

async function loadTask(organizationId: string, taskId: string): Promise<TaskOfBrief | null> {
  const t = await forTenant(organizationId).approvalTask.findFirst({
    where: { id: taskId },
    select: { id: true, status: true, assigneeMemberId: true, principalMemberId: true, dueAt: true, step: { select: { route: { select: { subjectType: true, subjectId: true, amountBasis: true, amountSatang: true, ruleCode: true } } } } },
  })
  return t ? { id: t.id, status: t.status, assigneeMemberId: t.assigneeMemberId, principalMemberId: t.principalMemberId, dueAt: t.dueAt, route: t.step.route } : null
}

/** The facts of a task under the rights of `ctx`'s member (BR-AI-20); a fact the reader may not see is left out */
export async function briefFacts(ctx: Ctx, task: TaskOfBrief): Promise<BriefFacts> {
  const db = forTenant(ctx.organizationId)
  const facts: Record<string, TextValue> = {}
  const r = task.route
  if (r.amountSatang !== null) facts.amount = { kind: 'money', value: satangToAmount(r.amountSatang) }
  facts.amountBasis = { kind: 'enum', value: r.amountBasis }
  facts.doaRule = { kind: 'text', value: r.ruleCode }
  // The request the facts come from: the task's, or the one request behind every line of a PO
  let requestId: string | null = r.subjectType === 'REQUEST' ? r.subjectId : null
  let supplierId: string | null = null
  let budgetLineId: string | null = null
  if (r.subjectType === 'PURCHASE_ORDER') {
    const po = await db.purchaseOrder.findFirst({ where: { id: r.subjectId }, select: { supplierId: true, lines: { select: { budgetLineId: true, sources: { select: { requestLine: { select: { requestId: true } } } } } } } })
    supplierId = po?.supplierId ?? null
    const requests = [...new Set((po?.lines ?? []).flatMap((l) => l.sources.map((s) => s.requestLine.requestId)))]
    const lines = [...new Set((po?.lines ?? []).map((l) => l.budgetLineId))]
    requestId = requests.length === 1 ? requests[0]! : null
    budgetLineId = lines.length === 1 ? lines[0]! : null
  }
  if (requestId) {
    const request = await db.request.findFirst({
      where: { id: requestId },
      select: { budgetLineId: true, suggestedSupplierId: true, nonLowestQuoteReason: true, quotations: { select: { netSatang: true, isSelected: true } } },
    })
    if (request) {
      budgetLineId ??= request.budgetLineId
      supplierId ??= request.suggestedSupplierId
      facts.quoteCount = { kind: 'integer', value: request.quotations.length }
      const chosen = request.quotations.find((q) => q.isSelected)
      if (chosen) facts.quoteChosenLowest = { kind: 'enum', value: request.quotations.every((q) => chosen.netSatang <= q.netSatang) ? 'YES' : 'NO' }
      if (request.nonLowestQuoteReason) facts.nonLowestReason = { kind: 'text', value: request.nonLowestQuoteReason }
    }
  }
  // budget.view of the line only (the same reader as the decision page's balance)
  if (budgetLineId) {
    const balance = await budgetLineAvailable(ctx, budgetLineId)
    if (balance.ok) facts.budgetRemaining = { kind: 'money', value: balance.data.available.amount }
  }
  // TODO(S6): getPriceReference and listRequestFlags of S6 once in main (FR-AI-301 AC6); until then no reference
  facts.priceReference = { kind: 'enum', value: 'NONE' }
  if (supplierId) {
    const since = new Date(ctx.now.getTime() - SUPPLIER_HISTORY_DAYS * MS_PER_DAY)
    const pos = await db.purchaseOrder.findMany({
      where: { supplierId, createdAt: { gte: since }, status: { notIn: ['DRAFT', 'CANCELLED'] }, ...(r.subjectType === 'PURCHASE_ORDER' ? { id: { not: r.subjectId } } : {}) },
      select: { id: true, grossSatang: true, createdAt: true },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    })
    const principal = await db.$transaction((tx) => loadPrincipal(tx, ctx))
    const seen: typeof pos = []
    for (const po of pos) {
      const f = await poViewFacts(db, po.id)
      if (isAllowed(principal, 'po.view', { ownerMemberIds: f.ownerMemberIds, assigneeMemberIds: f.assigneeMemberIds })) seen.push(po)
    }
    if (seen.length) {
      facts.supplierPoCount = { kind: 'integer', value: seen.length }
      facts.supplierLastPoAmount = { kind: 'money', value: satangToAmount(seen[0]!.grossSatang) }
    }
  }
  if (task.dueAt) {
    // The same keys whenever they are read, overdue or not: a Brief written before stays readable after (BR-AI-20)
    const hours = Math.floor((task.dueAt.getTime() - ctx.now.getTime()) / MS_PER_HOUR)
    facts.slaHoursLeft = { kind: 'integer', value: Math.max(hours, 0) }
    facts.slaOverdue = { kind: 'enum', value: hours < 0 ? 'YES' : 'NO' }
  }
  return facts
}

/** The facts as the AI reads them: each key with its value as the text shows it */
const plainFacts = (facts: BriefFacts) => Object.fromEntries(Object.entries(facts).map(([k, v]) => [k, renderValue(v)]))

/**
 * Job ai-approval-brief (ADR-145): writes the Brief of one task once, for its assignee's facts, when the Brief agent
 * may run (BR-AI-11; no action and no credits otherwise). A reassignment expires the Brief of the task it replaced.
 */
export async function runBrief(organizationId: string, taskId: string, now: Date, replacedTaskId?: string): Promise<'DRAFT' | 'FAILED' | 'SKIPPED'> {
  const db = forTenant(organizationId)
  if (replacedTaskId) {
    const old = await db.agentAction.findMany({ where: { purpose: 'BRIEF', subjectType: 'APPROVAL_TASK', subjectId: replacedTaskId, status: { in: ['PENDING', 'DRAFT'] } }, select: { id: true } })
    for (const a of old) await expireAgentAction(organizationId, now, a.id, 'SUPERSEDED')
  }
  const task = await loadTask(organizationId, taskId)
  if (!task || task.status !== 'OPEN' || !(BRIEF_SUBJECTS as readonly string[]).includes(task.route.subjectType)) return 'SKIPPED'
  const earlier = await db.agentAction.findMany({ where: { purpose: 'BRIEF', subjectType: 'APPROVAL_TASK', subjectId: taskId }, select: { status: true } })
  if (earlier.some((a) => a.status !== 'EXPIRED')) return 'SKIPPED'
  // One key per Brief of the task: a retry repeats nothing, a Brief after an expired one is a call of its own
  const started = await requestAgentAction(systemCtx(organizationId, now, 'ai-approval-brief'), { purpose: 'BRIEF', subjectType: 'APPROVAL_TASK', subjectId: taskId, inputRefs: { taskId } }, { idempotencyKey: `ai-approval-brief:${taskId}:${earlier.length}` })
  // A gate that is closed (agent off, credits, module) writes nothing and costs nothing (BR-AI-11)
  if (!started.ok || started.data.existing) return 'SKIPPED'
  const model = modelFor('APPROVAL_BRIEF', aiRuntime().modelEnv)
  const assignee = makeCtx({ organizationId, actor: { type: 'USER', memberId: task.assigneeMemberId }, channel: 'SYSTEM', now })
  const facts = await briefFacts(assignee, task)
  const answer = await getAiClient(getEnv()).write({ purpose: 'BRIEF', model, schema: BriefText, text: briefInputText(plainFacts(facts)) })
  const finish = async (input: Omit<Parameters<typeof completeAgentAction>[3], 'agentActionId' | 'requestedModel'>) => {
    const r = await completeAgentAction(organizationId, now, started.data.promptVersion, { agentActionId: started.data.agentActionId, requestedModel: model, ...input })
    return r.ok ? (r.data.status === 'DRAFT' ? ('DRAFT' as const) : ('FAILED' as const)) : ('SKIPPED' as const)
  }
  if (!answer.ok) return finish({ outcome: 'FAILED', model: answer.model ?? null, errorCode: answer.errorCode, usage: answer.usage, latencyMs: answer.latencyMs })
  // A text that fails BR-AI-27 is thrown away whole: the reader gets the facts alone
  const checked = checkAiText(answer.output.sentences, facts, BRIEF_PROFILE, DECISION_ADVICE_WORDS)
  if (!checked.ok) return finish({ outcome: 'FAILED', model: answer.model, errorCode: `AI_TEXT_${checked.reason}`, usage: answer.usage, latencyMs: answer.latencyMs })
  return finish({ outcome: 'DRAFT', model: answer.model, output: { sentences: answer.output.sentences, factKeys: Object.keys(facts).sort() }, usage: answer.usage, latencyMs: answer.latencyMs })
}

export interface ApprovalBriefDto {
  /** NONE: no Brief for this task (agent off, not an approval step); PENDING: being written; READY; FAILED: facts only */
  readonly status: 'NONE' | 'PENDING' | 'READY' | 'FAILED'
  /** The reader's own facts, as the text shows each value */
  readonly facts: ReadonlyArray<{ readonly key: string; readonly text: string }>
  /** The AI's sentences with the reader's values, only when the reader's facts hold every key the AI was given */
  readonly sentences: readonly string[] | null
}

/**
 * The Brief of a task for the one who decides it now (docs/sub-specs/S13.md "interface"): the assignee or the member
 * they act for (BR-DLG-04); anyone else FORBIDDEN. Read only: the facts are built for this reader every time.
 */
export async function approvalBriefOf(ctx: Ctx, taskId: string): Promise<Result<ApprovalBriefDto>> {
  if (ctx.actor.type !== 'USER') return err('FORBIDDEN', 'only the one who decides the task reads its Brief')
  const task = await loadTask(ctx.organizationId, taskId)
  if (!task) return err('NOT_FOUND', 'task not found')
  if (task.assigneeMemberId !== ctx.actor.memberId && task.principalMemberId !== ctx.actor.memberId) return err('FORBIDDEN', 'only the one who decides the task reads its Brief')
  const facts = await briefFacts(ctx, task)
  const shown = Object.entries(facts).map(([key, v]) => ({ key, text: renderValue(v) }))
  const action = await forTenant(ctx.organizationId).agentAction.findFirst({
    where: { purpose: 'BRIEF', subjectType: 'APPROVAL_TASK', subjectId: taskId, status: { not: 'EXPIRED' }, contentPurgedAt: null },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    select: { status: true, output: true },
  })
  if (!action) return ok({ status: 'NONE', facts: shown, sentences: null })
  if (action.status === 'PENDING') return ok({ status: 'PENDING', facts: shown, sentences: null })
  const out = (action.output ?? {}) as { sentences?: string[]; factKeys?: string[] }
  if (action.status !== 'DRAFT' || !out.sentences || !out.factKeys) return ok({ status: 'FAILED', facts: shown, sentences: null })
  // Every key the AI was given must be the reader's too: a sentence may sum a value up in words (BR-AI-20)
  if (!out.factKeys.every((k) => Object.hasOwn(facts, k))) return ok({ status: 'READY', facts: shown, sentences: null })
  const checked = checkAiText(out.sentences, facts, BRIEF_PROFILE, DECISION_ADVICE_WORDS)
  return ok({ status: 'READY', facts: shown, sentences: checked.ok ? checked.rendered : null })
}
