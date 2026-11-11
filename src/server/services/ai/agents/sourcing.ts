import { z } from 'zod'
import { checkAiText } from '@/core/ai-checks'
import { err, ok, type Result } from '@/core/result'
import { getAiClient } from '@/integrations/ai'
import { DECISION_ADVICE_WORDS, modelForPurpose, SOURCING_PROFILE } from '@/lib/ai-config'
import { BriefText, RfxDraftText, rfxDraftInputText } from '@/lib/ai-schemas/agents'
import { RFX_LONG_TEXT_MAX } from '@/lib/constants'
import { getEnv } from '@/lib/env'
import { sourcingSettingsOf } from '@/lib/org-settings'
import { systemCtx, type Ctx } from '@/server/context'
import { forTenant, type TenantTx } from '@/server/db/tenant'
import type { RunOptions } from '../../_pipeline'
import { isRfxRequiredPath, RFX_ASSIST_TYPE, rfxBidFacts, rfxDraftSource, rfxSummarizable, type RfxBidFacts } from '../../sourcing'
import { completeAgentAction, expireAgentAction, requestAgentAction } from '../actions'
import { openAssists, type OpenAssist } from '../assist-contract'
import { aiRuntime, checkCallGates } from '../gate'
import { sourcingFacts, sourcingFactsDigest, sourcingFactsText, type SourcingFacts } from './sourcing-facts'

// The Sourcing and Negotiation Agent (S10-16 · FR-AI-305 · ADR-209 · BR-AI-31 BR-AI-32), on a member's press, through
// every gate of BR-AI-11 and with settings.sourcing.aiAssist on (OQ-209), on the organization's credits (BR-AI-23):
//  - RFX_DRAFT (L1): the words of a draft RFx from its lines — title, description, each line's English — with the kind
//    code decided (rfxDraftFromLines); a DRAFT whose values procurement takes in with rfx.update + aiAssist.
//  - BID_SUMMARY NEGOTIATION_POINTS (L0): after the close, sentences whose every value is a placeholder of a fact code
//    built (sourcingFacts); a text that fails BR-AI-27 (profile SOURCING) is thrown away whole. The job rfx-ai-summary
//    writes the summary ahead after the close and after the reveal, so the button opens it at once.
// The agent never scores, awards, opens a round or writes to a supplier (BR-AI-01 · INV-AI-05): it reads the RFx through
// the sourcing services and writes AgentAction only. With AI off — the system, module AI, the agent, or aiAssist — no
// button and nothing written before is shown (EG-1 · AC6).

const AGENT = 'SOURCING' as const
export const SUMMARY_PURPOSES = ['BID_SUMMARY', 'NEGOTIATION_POINTS'] as const
export type SummaryPurpose = (typeof SUMMARY_PURPOSES)[number]

export const DraftRfxInput = z.strictObject({ rfxEventId: z.uuid() })
export const SummarizeRfxInput = z.strictObject({ rfxEventId: z.uuid(), purpose: z.enum(SUMMARY_PURPOSES) })

const aiAssistOn = async (tx: TenantTx, organizationId: string): Promise<boolean> =>
  sourcingSettingsOf((await tx.organization.findUniqueOrThrow({ where: { id: organizationId }, select: { settings: true } })).settings).aiAssist

/** Every gate of BR-AI-11 for the purpose, and the organization's switch (no call) */
async function mayCall(tx: TenantTx, ctx: Ctx, purpose: 'RFX_DRAFT' | SummaryPurpose): Promise<boolean> {
  if (!(await aiAssistOn(tx, ctx.organizationId))) return false
  return (await checkCallGates(tx, ctx, purpose, ctx.actor.type === 'USER' ? ctx.actor.memberId : null)).ok
}

const finishAs = (organizationId: string, now: Date, promptVersion: string, agentActionId: string, model: string) => (input: Omit<Parameters<typeof completeAgentAction>[3], 'agentActionId' | 'requestedModel'>) =>
  completeAgentAction(organizationId, now, promptVersion, { agentActionId, requestedModel: model, ...input })

// ---------- RFX_DRAFT (L1 · AC1) ----------

export interface RfxDraftDto {
  readonly agentActionId: string
  readonly status: 'READY' | 'FAILED'
  /** What the AI put in, by path (rfx.update takes these with aiAssist) */
  readonly proposed: Readonly<Record<string, string>>
  readonly requiredPaths: readonly string[]
}

const fits = (value: string | null, max: number): value is string => value !== null && value.trim() !== '' && [...value.trim()].length <= max

/** "ร่างด้วย AI" on a draft RFx: the words of the AI, the kind of code, a DRAFT procurement confirms field by field */
export async function draftRfx(ctx: Ctx, rawInput: z.input<typeof DraftRfxInput>, options: RunOptions): Promise<Result<RfxDraftDto>> {
  if (ctx.actor.type !== 'USER') return err('FORBIDDEN', 'only a member drafts an RFx with AI')
  const parsed = DraftRfxInput.safeParse(rawInput)
  if (!parsed.success) return err('VALIDATION_FAILED', 'the RFx', { field: 'rfxEventId' })
  const db = forTenant(ctx.organizationId)
  const read = await db.$transaction(async (tx) => {
    const source = await rfxDraftSource(tx, ctx, parsed.data.rfxEventId)
    if (!source.ok) return source
    if (!(await aiAssistOn(tx, ctx.organizationId))) return err('AI_AGENT_DISABLED', 'the organization switched AI off for sourcing', { agent: AGENT, reason: 'AI_ASSIST_OFF' })
    return source
  })
  if (!read.ok) return read
  const source = read.data
  const started = await requestAgentAction(ctx, { purpose: 'RFX_DRAFT', subjectType: RFX_ASSIST_TYPE, subjectId: source.rfxEventId, inputRefs: { rfxEventId: source.rfxEventId, lineNos: source.lines.map((l) => l.lineNo) } }, options)
  if (!started.ok) return started
  const agentActionId = started.data.agentActionId
  const row = await db.agentAction.findFirst({ where: { id: agentActionId }, select: { status: true } })
  if (row?.status !== 'PENDING') return err('IDEMPOTENCY_CONFLICT', 'this draft was asked with this key already', { field: 'idempotencyKey' })
  // an earlier draft nobody took in is replaced by this one (the form shows one at a time)
  const earlier = await db.agentAction.findMany({ where: { purpose: 'RFX_DRAFT', subjectType: RFX_ASSIST_TYPE, subjectId: source.rfxEventId, status: 'DRAFT', appliedAt: null, id: { not: agentActionId } }, select: { id: true } })
  for (const e of earlier) await expireAgentAction(ctx.organizationId, ctx.now, e.id, 'SUPERSEDED')

  const model = modelForPurpose('RFX_DRAFT', aiRuntime().modelEnv)
  const finish = finishAs(ctx.organizationId, ctx.now, started.data.promptVersion, agentActionId, model)
  const failed = async (done: Awaited<ReturnType<typeof finish>>): Promise<Result<RfxDraftDto>> => (done.ok ? ok({ agentActionId, status: 'FAILED', proposed: {}, requiredPaths: [] }) : done)
  const answer = await getAiClient(getEnv()).write({ purpose: 'RFX_DRAFT', model, schema: RfxDraftText, text: rfxDraftInputText(source) })
  if (!answer.ok) return failed(await finish({ outcome: 'FAILED', model: answer.model ?? null, errorCode: answer.errorCode, usage: answer.usage, latencyMs: answer.latencyMs }))

  // the values the form takes, each within its field's limit; a line only by a number the RFx has
  const proposed: Record<string, string> = {}
  if (source.kind !== 'RFI' && source.plan) proposed.kind = source.plan.kind
  const o = answer.output
  if (fits(o.title, 200)) proposed.title = o.title.trim()
  if (fits(o.titleEn, 200)) proposed.titleEn = o.titleEn.trim()
  if (fits(o.description, RFX_LONG_TEXT_MAX)) proposed.description = o.description.trim()
  if (fits(o.descriptionEn, RFX_LONG_TEXT_MAX)) proposed.descriptionEn = o.descriptionEn.trim()
  const lineNos = new Set(source.lines.map((l) => l.lineNo))
  for (const l of o.lines) {
    if (!lineNos.has(l.lineNo)) continue
    if (fits(l.descriptionEn, 200)) proposed[`lines.${l.lineNo}.descriptionEn`] = l.descriptionEn.trim()
    if (fits(l.uomEn, 40)) proposed[`lines.${l.lineNo}.uomEn`] = l.uomEn.trim()
  }
  const requiredPaths = Object.keys(proposed).filter(isRfxRequiredPath).sort()
  const done = await finish({
    outcome: 'DRAFT',
    model: answer.model,
    output: { kind: proposed.kind ?? null, plan: source.plan ? { kind: source.plan.kind, minInvites: source.plan.minInvites } : null, text: o },
    review: { requiredPaths, confirmedPaths: [], proposed },
    usage: answer.usage,
    latencyMs: answer.latencyMs,
  })
  if (!done.ok) return done
  return ok({ agentActionId, status: 'READY', proposed, requiredPaths })
}

export interface RfxDraftAiDto {
  /** The button shows (every gate passes and the organization lets it) */
  readonly available: boolean
  /** The latest draft still open on the RFx: proposed, waiting, confirmed */
  readonly open: OpenAssist | null
  /** Taken into the RFx already (its values are the RFx's now); not yet, the form starts from what the AI proposed */
  readonly applied: boolean
}

/** The draft step of an RFx (/sourcing/[id]/edit): the button, and the AI's draft still open (shown only while AI is on) */
export async function rfxDraftAiOf(ctx: Ctx, rfxEventId: string): Promise<RfxDraftAiDto> {
  if (ctx.actor.type !== 'USER') return { available: false, open: null, applied: false }
  return forTenant(ctx.organizationId).$transaction(async (tx) => {
    const available = await mayCall(tx, ctx, 'RFX_DRAFT')
    const open = (await openAssists(tx, { type: RFX_ASSIST_TYPE, id: rfxEventId })).filter((a) => a.purpose === 'RFX_DRAFT')
    // what the AI filled in still holds the RFx back while AI is off (rfx.open counts it), so it stays on the form
    // a draft taken in with fields still waiting holds the RFx back first; else the latest one
    const last = open.find((a) => a.pendingPaths.length > 0) ?? open[open.length - 1] ?? null
    const applied = last ? (await tx.agentAction.findFirst({ where: { id: last.agentActionId }, select: { appliedAt: true } }))?.appliedAt != null : false
    return { available, open: last, applied }
  })
}

// ---------- BID_SUMMARY NEGOTIATION_POINTS (L0 · AC2 AC3) ----------

export interface RfxSummaryDto {
  readonly agentActionId: string
  readonly purpose: SummaryPurpose
  readonly status: 'READY' | 'FAILED'
  readonly sentences: readonly string[]
  readonly feedback: 'HELPFUL' | 'NOT_HELPFUL' | null
}

interface SummaryOutput {
  readonly sentences?: string[]
  readonly factKeys?: string[]
  readonly factsDigest?: string
}

/** The latest text of a purpose on the RFx that fits today's facts: filled in again and checked again (BR-AI-27) */
async function latestSummary(tx: TenantTx, rfxEventId: string, purpose: SummaryPurpose, facts: SourcingFacts, sameFactsOnly: boolean) {
  const digest = sourcingFactsDigest(facts)
  const rows = await tx.agentAction.findMany({ where: { purpose, subjectType: RFX_ASSIST_TYPE, subjectId: rfxEventId, status: 'DRAFT', contentPurgedAt: null }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 20, select: { id: true, output: true } })
  for (const r of rows) {
    const o = (r.output ?? {}) as SummaryOutput
    if (!o.sentences || !o.factKeys || !o.factKeys.every((k) => Object.hasOwn(facts, k))) continue
    if (sameFactsOnly && o.factsDigest !== digest) continue
    const checked = checkAiText(o.sentences, facts, SOURCING_PROFILE, DECISION_ADVICE_WORDS)
    if (checked.ok) return { agentActionId: r.id, sentences: checked.rendered }
  }
  return null
}

/** Calls the AI for one text of the RFx's bids and records it (the member's press, or the job's system call) */
async function writeSummary(ctx: Ctx, facts: SourcingFacts, purpose: SummaryPurpose, agentActionId: string, promptVersion: string): Promise<Result<{ status: 'READY' | 'FAILED'; sentences: readonly string[] }>> {
  const model = modelForPurpose(purpose, aiRuntime().modelEnv)
  const finish = finishAs(ctx.organizationId, ctx.now, promptVersion, agentActionId, model)
  const failed = async (done: Awaited<ReturnType<typeof finish>>) => (done.ok ? ok({ status: 'FAILED' as const, sentences: [] }) : done)
  const answer = await getAiClient(getEnv()).write({ purpose, model, schema: BriefText, text: sourcingFactsText(facts) })
  if (!answer.ok) return failed(await finish({ outcome: 'FAILED', model: answer.model ?? null, errorCode: answer.errorCode, usage: answer.usage, latencyMs: answer.latencyMs }))
  // a text that fails BR-AI-27 is thrown away whole: the reader keeps the table, the flags and the scores
  const checked = checkAiText(answer.output.sentences, facts, SOURCING_PROFILE, DECISION_ADVICE_WORDS)
  if (!checked.ok) return failed(await finish({ outcome: 'FAILED', model: answer.model, errorCode: `AI_TEXT_${checked.reason}`, usage: answer.usage, latencyMs: answer.latencyMs }))
  const done = await finish({ outcome: 'DRAFT', model: answer.model, output: { sentences: answer.output.sentences, factKeys: Object.keys(facts).sort(), factsDigest: sourcingFactsDigest(facts) }, usage: answer.usage, latencyMs: answer.latencyMs })
  if (!done.ok) return done
  return ok({ status: 'READY', sentences: checked.rendered })
}

/**
 * "สรุปข้อเสนอ" or "ประเด็นเจรจา" on a closed RFx, by a reader of its prices: the summary written ahead for the same facts
 * when there is one (no new call, no credits), else an L0 call through every gate
 */
export async function summarizeRfx(ctx: Ctx, rawInput: z.input<typeof SummarizeRfxInput>, options: RunOptions): Promise<Result<RfxSummaryDto>> {
  if (ctx.actor.type !== 'USER') return err('FORBIDDEN', 'only a member asks for a summary')
  const parsed = SummarizeRfxInput.safeParse(rawInput)
  if (!parsed.success) return err('VALIDATION_FAILED', 'the RFx and what to write', { field: 'purpose' })
  const { rfxEventId, purpose } = parsed.data
  const read = await forTenant(ctx.organizationId).$transaction(async (tx) => {
    const f = await rfxBidFacts(tx, ctx, rfxEventId)
    if (!f.ok) return f
    if (!(await aiAssistOn(tx, ctx.organizationId))) return err('AI_AGENT_DISABLED', 'the organization switched AI off for sourcing', { agent: AGENT, reason: 'AI_ASSIST_OFF' })
    const facts = sourcingFacts(f.data)
    return ok({ facts, ahead: await latestSummary(tx, rfxEventId, purpose, facts, true) })
  })
  if (!read.ok) return read
  if (read.data.ahead) return ok({ agentActionId: read.data.ahead.agentActionId, purpose, status: 'READY', sentences: read.data.ahead.sentences, feedback: null })
  const started = await requestAgentAction(ctx, { purpose, subjectType: RFX_ASSIST_TYPE, subjectId: rfxEventId, inputRefs: { rfxEventId } }, options)
  if (!started.ok) return started
  const row = await forTenant(ctx.organizationId).agentAction.findFirst({ where: { id: started.data.agentActionId }, select: { status: true } })
  if (row?.status !== 'PENDING') return err('IDEMPOTENCY_CONFLICT', 'this summary was asked with this key already', { field: 'idempotencyKey' })
  const written = await writeSummary(ctx, read.data.facts, purpose, started.data.agentActionId, started.data.promptVersion)
  if (!written.ok) return written
  return ok({ agentActionId: started.data.agentActionId, purpose, ...written.data, feedback: null })
}

export interface RfxSummariesDto {
  /** The two buttons show (after the close, for a reader of the prices, every gate and the organization's switch) */
  readonly available: boolean
  readonly summary: RfxSummaryDto | null
  readonly negotiation: RfxSummaryDto | null
}

const NONE: RfxSummariesDto = { available: false, summary: null, negotiation: null }

/**
 * The box "สรุปโดย AI" of an RFx for a reader of its prices: the latest summary and points that fit today's facts, with
 * what this member said of them; nothing before the close, and nothing while AI is off (EG-1)
 */
export async function rfxSummariesOf(ctx: Ctx, rfx: { readonly id: string; readonly kind: string; readonly status: string }): Promise<RfxSummariesDto> {
  if (ctx.actor.type !== 'USER' || !rfxSummarizable(rfx)) return NONE
  const memberId = ctx.actor.memberId
  return forTenant(ctx.organizationId).$transaction(async (tx) => {
    if (!(await aiAssistOn(tx, ctx.organizationId))) return NONE
    const on = await checkCallGates(tx, ctx, 'BID_SUMMARY', memberId)
    // shown while the agent is switched on; a call also needs credits and the rate, which only hide the buttons
    const switchedOn = on.ok || !['AI_AGENT_DISABLED', 'MODULE_DISABLED'].includes(on.error.code)
    if (!switchedOn) return NONE
    const f = await rfxBidFacts(tx, ctx, rfx.id)
    if (!f.ok) return NONE
    const facts = sourcingFacts(f.data)
    const summary = await latestSummary(tx, rfx.id, 'BID_SUMMARY', facts, false)
    const negotiation = await latestSummary(tx, rfx.id, 'NEGOTIATION_POINTS', facts, false)
    const ids = [summary, negotiation].filter((x) => x !== null).map((x) => x.agentActionId)
    const given = ids.length
      ? await tx.event.findMany({ where: { type: 'agent_action.feedback_given', aggregateType: 'AgentAction', aggregateId: { in: ids }, actorMemberId: memberId }, orderBy: { seq: 'asc' }, select: { aggregateId: true, data: true } })
      : []
    const last = new Map(given.map((e) => [e.aggregateId, (e.data as { feedback?: 'HELPFUL' | 'NOT_HELPFUL' } | null)?.feedback ?? null]))
    const dto = (x: { agentActionId: string; sentences: readonly string[] } | null, purpose: SummaryPurpose): RfxSummaryDto | null =>
      x ? { agentActionId: x.agentActionId, purpose, status: 'READY', sentences: x.sentences, feedback: last.get(x.agentActionId) ?? null } : null
    return { available: on.ok, summary: dto(summary, 'BID_SUMMARY'), negotiation: dto(negotiation, 'NEGOTIATION_POINTS') }
  })
}

// ---------- job rfx-ai-summary: the summary written ahead (BR-AI-32) ----------

export type SummaryAhead = 'WRITTEN' | 'FAILED' | `SKIPPED_${string}`

/**
 * After rfx.closed or scorecard.revealed: the system writes BID_SUMMARY ahead when every gate and aiAssist let it, so
 * the button opens it at once. A refusal anywhere is a skip; nothing is shown until a reader presses the button.
 */
export async function writeSummaryAhead(organizationId: string, rfxEventId: string, trigger: string, now: Date): Promise<SummaryAhead> {
  const ctx = systemCtx(organizationId, now, 'rfx-ai-summary')
  const read = await forTenant(organizationId).$transaction(async (tx) => {
    if (!(await aiAssistOn(tx, organizationId))) return 'SKIPPED_AI_ASSIST_OFF' as const
    const f = await rfxBidFacts(tx, ctx, rfxEventId, { system: true })
    if (!f.ok) return `SKIPPED_${f.error.code}` as const
    if (f.data.table.bids.length === 0) return 'SKIPPED_NO_BIDS' as const
    const facts = sourcingFacts(f.data)
    return (await latestSummary(tx, rfxEventId, 'BID_SUMMARY', facts, true)) ? ('SKIPPED_WRITTEN' as const) : { facts }
  })
  if (typeof read === 'string') return read
  const started = await requestAgentAction(ctx, { purpose: 'BID_SUMMARY', subjectType: RFX_ASSIST_TYPE, subjectId: rfxEventId, inputRefs: { rfxEventId, trigger } }, { idempotencyKey: `rfx_summary:${rfxEventId}:${trigger}` })
  if (!started.ok) return `SKIPPED_${started.error.code}`
  if (started.data.existing) return 'SKIPPED_WRITTEN'
  const written = await writeSummary(ctx, read.facts, 'BID_SUMMARY', started.data.agentActionId, started.data.promptVersion)
  return written.ok ? (written.data.status === 'READY' ? 'WRITTEN' : 'FAILED') : `SKIPPED_${written.error.code}`
}

export type { RfxBidFacts }
