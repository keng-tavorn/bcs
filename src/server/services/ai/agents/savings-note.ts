import { z } from 'zod'
import { checkAiText, renderValue, type TextValue } from '@/core/ai-checks'
import { satangToAmount } from '@/core/money/dto'
import { err, ok, type Result } from '@/core/result'
import { getAiClient } from '@/integrations/ai'
import { DECISION_ADVICE_WORDS, modelForPurpose } from '@/lib/ai-config'
import { BriefText, savingsNoteInputText } from '@/lib/ai-schemas/agents'
import { MS_PER_DAY } from '@/lib/constants'
import { getEnv } from '@/lib/env'
import type { Ctx } from '@/server/context'
import { forTenant } from '@/server/db/tenant'
import type { RunOptions } from '../../_pipeline'
import { savingsOpportunities, type SavingsItemDto } from '../../assistants/savings'
import { completeAgentAction, requestAgentAction } from '../actions'
import { asDataValues } from '../data'
import { agentSwitchedOn, aiRuntime, checkCallGates } from '../gate'
import { BRIEF_PROFILE } from './brief'

// The savings assistant's words (NEW-123 · FR-VIS-008 AC3 · ADR-081): on a member's press, the AI explains one saving
// the code found, from facts code builds out of that saving as the member's own list shows it — the amount, what it is
// compared with, the evidence's counts. Every value is a placeholder of a fact and the sentences pass BR-AI-27 (Brief
// profile, DECISION_ADVICE included) before anyone sees them; a text that fails is thrown away whole and the row keeps
// its figures and evidence. An L0 call of the Insight agent with its credits; it reads the savings through the same
// service and permission as the page, so a member who may not see a saving cannot have it explained either. With AI off
// — the system's switch, the module or the Insight agent — no button and no explanation written before (ADR-079).

const PURPOSE = 'SAVINGS_NOTE' as const
/** The member's latest explanations read for the page at most */
const NOTES_READ = 200
const AGENT = 'INSIGHT' as const

export type SavingsFacts = Readonly<Record<string, TextValue>>

const money = (satang: string): TextValue => ({ kind: 'money', value: satangToAmount(BigInt(satang)) })
const text = (value: string): TextValue => ({ kind: 'text', value })
const integer = (value: number): TextValue => ({ kind: 'integer', value })

/** The facts of one saving, by code (BR-AI-03): the AI writes placeholders of these keys only, in Thai */
export function savingsFacts(item: SavingsItemDto): SavingsFacts {
  switch (item.kind) {
    case 'PRICE_ABOVE_HISTORY':
      return {
        kind: { kind: 'enum', value: item.kind },
        stage: { kind: 'enum', value: item.line.request.stage },
        request: { kind: 'ref', value: item.line.request.number },
        line: integer(item.line.lineNo),
        description: text(item.line.description),
        quantity: text(`${item.line.quantity} ${item.line.uom}`),
        price: money(item.line.unitPriceSatang),
        reference: money(item.referenceSatang),
        lowest: money(item.minSatang),
        highest: money(item.maxSatang),
        deviation: { kind: 'bp', value: item.deviationBp },
        samples: integer(item.count),
        saving: money(item.savingSatang),
      }
    case 'OFF_AGREEMENT':
      return {
        kind: { kind: 'enum', value: item.kind },
        stage: { kind: 'enum', value: item.line.request.stage },
        request: { kind: 'ref', value: item.line.request.number },
        line: integer(item.line.lineNo),
        item: text(item.item.th),
        quantity: text(`${item.line.quantity} ${item.line.uom}`),
        price: money(item.line.unitPriceSatang),
        supplier: item.line.supplier ? text(item.line.supplier.th) : { kind: 'enum', value: 'NONE' },
        agreed: money(item.agreedSatang),
        agreedSupplier: text(item.agreements.find((a) => a.id === item.agreementId)?.supplier.th ?? ''),
        agreements: integer(item.agreements.length),
        ...(item.offAgreementReason ? { reason: text(item.offAgreementReason) } : {}),
        saving: money(item.savingSatang),
      }
    case 'SAME_ITEM_DEPARTMENTS':
      return {
        kind: { kind: 'enum', value: item.kind },
        description: text(item.description),
        departments: integer(item.departments),
        lines: integer(item.lines.length),
        lowest: money(item.lowestSatang),
        ...(item.site ? { site: text(item.site.th) } : {}),
        saving: money(item.savingSatang),
      }
    case 'AGREEMENT_EXPIRING':
      return {
        kind: { kind: 'enum', value: item.kind },
        item: text(item.item.th),
        supplier: text(item.agreement.supplier.th),
        price: money(item.agreement.unitPriceSatang),
        // the last day the price holds (validTo is not included, BR-PRC-06)
        lastDay: { kind: 'date', value: new Date(Date.parse(`${item.agreement.validTo}T00:00:00Z`) - MS_PER_DAY).toISOString().slice(0, 10) },
        daysLeft: integer(item.daysLeft),
        purchases: integer(item.count),
        spent: money(item.spentSatang),
      }
  }
}

/** The facts as the AI reads them: each key with its value as the text shows it */
const plainFacts = (facts: SavingsFacts) => Object.fromEntries(Object.entries(facts).map(([k, v]) => [k, renderValue(v)]))

export const ExplainSavingInput = z.strictObject({ key: z.string().min(1).max(200) })

export interface SavingsNoteDto {
  readonly agentActionId: string
  /** READY: the sentences passed BR-AI-27 · FAILED: nothing to show but the row's own figures */
  readonly status: 'READY' | 'FAILED'
  readonly sentences: readonly string[]
  /** What this member said of it last, from their own Event (agent_action.feedback_given) */
  readonly feedback: 'HELPFUL' | 'NOT_HELPFUL' | null
}

/** Whether the member may have a saving explained now: every gate of BR-AI-11 for this purpose (no call) */
export async function savingsNoteAvailable(ctx: Ctx): Promise<boolean> {
  if (ctx.actor.type !== 'USER') return false
  const memberId = ctx.actor.memberId
  return forTenant(ctx.organizationId).$transaction(async (tx) => (await checkCallGates(tx, ctx, PURPOSE, memberId)).ok)
}

/**
 * "ให้ผู้ช่วยอธิบาย" on one saving: the saving as the member's list shows it now (FORBIDDEN or NOT_FOUND before any call
 * or credits), an L0 AgentAction through every gate, then the AI's sentences checked against the facts
 */
export async function explainSaving(ctx: Ctx, rawInput: z.input<typeof ExplainSavingInput>, options: RunOptions): Promise<Result<SavingsNoteDto>> {
  if (ctx.actor.type !== 'USER') return err('FORBIDDEN', 'only a member asks for an explanation')
  const parsed = ExplainSavingInput.safeParse(rawInput)
  if (!parsed.success) return err('VALIDATION_FAILED', 'the key of a saving', { field: 'key' })
  const list = await savingsOpportunities(ctx)
  if (!list.ok) return list
  const item = list.data.items.find((i) => i.key === parsed.data.key)
  if (!item) return err('NOT_FOUND', 'no such saving in your list now')

  const started = await requestAgentAction(ctx, { purpose: PURPOSE, inputRefs: { key: item.key } }, options)
  if (!started.ok) return started
  const agentActionId = started.data.agentActionId
  // A key used before replays its action, already answered: the AI is never asked again without credits (BR-AI-11)
  const row = await forTenant(ctx.organizationId).agentAction.findFirst({ where: { id: agentActionId }, select: { status: true } })
  if (row?.status !== 'PENDING') return err('IDEMPOTENCY_CONFLICT', 'this explanation was asked with this key already', { field: 'idempotencyKey' })

  const facts = savingsFacts(item)
  const model = modelForPurpose(PURPOSE, aiRuntime().modelEnv)
  const answer = await getAiClient(getEnv()).write({ purpose: PURPOSE, model, schema: BriefText, text: savingsNoteInputText(asDataValues(plainFacts(facts))) })
  const finish = (input: Omit<Parameters<typeof completeAgentAction>[3], 'agentActionId' | 'requestedModel'>) =>
    completeAgentAction(ctx.organizationId, ctx.now, started.data.promptVersion, { agentActionId, requestedModel: model, ...input })
  const failed = async (done: Awaited<ReturnType<typeof finish>>) => (done.ok ? ok({ agentActionId, status: 'FAILED' as const, sentences: [], feedback: null }) : done)
  if (!answer.ok) return failed(await finish({ outcome: 'FAILED', model: answer.model ?? null, errorCode: answer.errorCode, usage: answer.usage, latencyMs: answer.latencyMs }))
  // A text that fails BR-AI-27 is thrown away whole: the reader keeps the row's figures and evidence
  const checked = checkAiText(answer.output.sentences, facts, BRIEF_PROFILE, DECISION_ADVICE_WORDS)
  if (!checked.ok) return failed(await finish({ outcome: 'FAILED', model: answer.model, errorCode: `AI_TEXT_${checked.reason}`, usage: answer.usage, latencyMs: answer.latencyMs }))
  const done = await finish({ outcome: 'DRAFT', model: answer.model, output: { key: item.key, sentences: answer.output.sentences, factKeys: Object.keys(facts).sort() }, usage: answer.usage, latencyMs: answer.latencyMs })
  if (!done.ok) return done
  return ok({ agentActionId, status: 'READY', sentences: checked.rendered, feedback: null })
}

/**
 * The explanations this member asked for, of the savings in their list now: the latest one of each saving, its
 * sentences filled with today's facts while every key it was written with is still a fact and the text still passes
 * BR-AI-27. None while the Insight agent is off (ADR-079 item 6).
 */
export async function savingsNotesOf(ctx: Ctx, items: readonly SavingsItemDto[]): Promise<ReadonlyMap<string, SavingsNoteDto>> {
  const out = new Map<string, SavingsNoteDto>()
  if (ctx.actor.type !== 'USER' || items.length === 0) return out
  if (!(await agentSwitchedOn(ctx, AGENT)).ok) return out
  const memberId = ctx.actor.memberId
  const db = forTenant(ctx.organizationId)
  const byKey = new Map(items.map((i) => [i.key, i]))
  const actions = await db.agentAction.findMany({
    where: { purpose: PURPOSE, requestedById: memberId, status: 'DRAFT', contentPurgedAt: null },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: NOTES_READ,
    select: { id: true, output: true },
  })
  for (const action of actions) {
    const output = (action.output ?? {}) as { key?: string; sentences?: string[]; factKeys?: string[] }
    const item = output.key ? byKey.get(output.key) : undefined
    if (!item || out.has(item.key) || !output.sentences || !output.factKeys) continue
    const facts = savingsFacts(item)
    if (!output.factKeys.every((k) => Object.hasOwn(facts, k))) continue
    const checked = checkAiText(output.sentences, facts, BRIEF_PROFILE, DECISION_ADVICE_WORDS)
    if (!checked.ok) continue
    out.set(item.key, { agentActionId: action.id, status: 'READY', sentences: checked.rendered, feedback: null })
  }
  if (out.size === 0) return out
  const given = await db.event.findMany({
    where: { type: 'agent_action.feedback_given', aggregateType: 'AgentAction', aggregateId: { in: [...out.values()].map((n) => n.agentActionId) }, actorMemberId: memberId },
    orderBy: { seq: 'asc' },
    select: { aggregateId: true, data: true },
  })
  const last = new Map(given.map((e) => [e.aggregateId, (e.data as { feedback?: 'HELPFUL' | 'NOT_HELPFUL' } | null)?.feedback ?? null]))
  return new Map([...out].map(([k, n]) => [k, { ...n, feedback: last.get(n.agentActionId) ?? null }]))
}
