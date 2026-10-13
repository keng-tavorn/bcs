import { z } from 'zod'
import { agentActionTransition } from '@/core/ai-checks'
import { err, ok, type Result } from '@/core/result'
import type { Ctx } from '@/server/context'
import { lockRowsForUpdate } from '@/server/db/sql/locks'
import type { TenantTx } from '@/server/db/tenant'
import type { EventDraft } from '@/server/events/append'

// The contract between the documents and the AI that fills them (P1-07, docs/sub-specs/P1.md "สัญญากลางอื่น", BR-AI-17
// of S13, ADR-148). A document's own command takes `aiAssist` and calls applyAiAssist in its transaction, with a person
// as the actor, after it wrote the document; a command that sends a document on calls assertNoPendingAiReview. This file
// never calls the AI and never imports the adapter or the agents: it reads AgentAction and the document only.
//
// What the AI put into a form is the action's review.proposed: { "<form path>": "<value as text>" }. A proposed field
// counts as confirmed when the person named it in confirmedPaths, changed it (the document holds another value now) or
// removed it (the document no longer has that path). While any field waits, the action stays DRAFT (applied) and the
// document cannot be sent; when none waits it is ACCEPTED, or EDITED when the person changed something (with the diff).

/** What the person confirmed of the values an AI action put into the form (BR-AI-17) */
export const AiAssistInput = z.strictObject({
  agentActionId: z.uuid(),
  /** The form paths the person looked at and kept, e.g. "lines.0.unitPrice" */
  confirmedPaths: z.array(z.string().min(1).max(200)).max(500),
})
export type AiAssist = z.infer<typeof AiAssistInput>

/** The document the AI helped with, e.g. { type: 'GOODS_RECEIPT', id } or an invoice of S8 */
export interface AssistSubject {
  readonly type: string
  readonly id: string
}

/** The values of a document by form path, as text, read inside the command's transaction */
export type AssistReader = (tx: TenantTx, id: string) => Promise<Readonly<Record<string, string>> | null>

interface SubjectKind {
  /** The purposes whose results this document takes in */
  readonly purposes: readonly string[]
  /** For an action read for another document first (a delivery note for its PO): that document must be this one's */
  readonly belongsTo?: (tx: TenantTx, id: string, other: AssistSubject) => Promise<boolean>
  /** true: the command that takes the values in also sends the document on (gr.post, doa.import_draft), so every field
   *  must be confirmed in that call; false: a draft may keep fields waiting until it is sent */
  readonly final: boolean
  readonly read: AssistReader
}

const kinds = new Map<string, SubjectKind>()

/**
 * Each document type registers how its values are read by path (the request in S13-03, receiving in S13-07, the DOA in
 * S13-11, the invoice of S8 in S13-12). A document type with no registration refuses aiAssist.
 */
export function registerAssistSubject(type: string, kind: SubjectKind): void {
  kinds.set(type, kind)
}

interface Review {
  readonly requiredPaths: readonly string[]
  readonly confirmedPaths: readonly string[]
  readonly proposed: Readonly<Record<string, string>>
}

function reviewOf(value: unknown): Review {
  const v = (value && typeof value === 'object' ? value : {}) as Partial<Record<keyof Review, unknown>>
  const list = (x: unknown) => (Array.isArray(x) ? x.filter((p): p is string => typeof p === 'string') : [])
  const proposed = v.proposed && typeof v.proposed === 'object' ? Object.fromEntries(Object.entries(v.proposed).filter(([, x]) => typeof x === 'string')) : {}
  return { requiredPaths: list(v.requiredPaths), confirmedPaths: list(v.confirmedPaths), proposed: proposed as Record<string, string> }
}

/** The proposed fields still waiting, and the ones the person changed or removed (BR-AI-17) */
function pendingOf(review: Review, confirmed: ReadonlySet<string>, current: Readonly<Record<string, string>>) {
  const changed: string[] = []
  const pending: string[] = []
  for (const [path, value] of Object.entries(review.proposed)) {
    if (!Object.hasOwn(current, path) || current[path] !== value) changed.push(path)
    else if (!confirmed.has(path)) pending.push(path)
  }
  return { pending: pending.sort(), changed: changed.sort() }
}

const pendingError = (count: number, agentActionIds: readonly string[]) => err('AI_REVIEW_PENDING', `${count} fields filled by AI wait for a person`, { count, agentActionIds })

/**
 * AI_REVIEW_PENDING while values an AI action put into this document wait for the person (BR-AI-17): every action
 * applied to it that is still DRAFT is checked against the document as it is now.
 */
export async function assertNoPendingAiReview(tx: TenantTx, _ctx: Ctx, subject: AssistSubject): Promise<Result<true>> {
  const actions = await tx.agentAction.findMany({
    where: { subjectType: subject.type, subjectId: subject.id, status: 'DRAFT', appliedAt: { not: null } },
    select: { id: true, review: true },
    orderBy: { id: 'asc' },
  })
  if (actions.length === 0) return ok(true)
  const kind = kinds.get(subject.type)
  const current = kind ? ((await kind.read(tx, subject.id)) ?? {}) : {}
  let count = 0
  const waiting: string[] = []
  for (const a of actions) {
    const review = reviewOf(a.review)
    const { pending } = pendingOf(review, new Set(review.confirmedPaths), current)
    if (pending.length) {
      count += pending.length
      waiting.push(a.id)
    }
  }
  return count ? pendingError(count, waiting) : ok(true)
}

/**
 * Records what the person confirmed of an AI action, in the command's transaction, after the command wrote the
 * document; the events go with the command's. No input → nothing happens (a form filled by hand is unchanged, EG-1).
 */
export async function applyAiAssist(tx: TenantTx, ctx: Ctx, subject: AssistSubject, input?: AiAssist): Promise<Result<readonly EventDraft[]>> {
  if (!input) return ok([])
  // A person takes the values in (BR-AI-01): the AI and the system never write a document through this
  if (ctx.actor.type !== 'USER') return err('FORBIDDEN', 'only a person confirms what the AI filled in')
  const kind = kinds.get(subject.type)
  // A document whose AI part is not built yet (the invoice until S13-12) keeps P1-07's answer: the AI is not there for it
  if (!kind) return err('MODULE_DISABLED', `AI values do not reach a ${subject.type} yet`, { module: 'AI', field: 'aiAssist' })
  const [locked] = await lockRowsForUpdate(tx, 'AgentAction', ctx.organizationId, [input.agentActionId])
  // Another organization's action is not found through this tenant (§4.8)
  if (!locked) return err('NOT_FOUND', 'no such AI action', { field: 'aiAssist.agentActionId' })
  const action = await tx.agentAction.findUniqueOrThrow({
    where: { id: input.agentActionId },
    select: { id: true, status: true, level: true, purpose: true, subjectType: true, subjectId: true, review: true, appliedAt: true },
  })
  if (action.status !== 'DRAFT' || action.level !== 'L1') {
    return err('INVALID_STATE_TRANSITION', `the AI action is ${action.status} ${action.level}`, { from: action.status, command: 'agent_action.apply' })
  }
  if (!kind.purposes.includes(action.purpose)) {
    return err('VALIDATION_FAILED', `a ${action.purpose} result does not fill a ${subject.type}`, { field: 'aiAssist.agentActionId', reason: 'PURPOSE_MISMATCH' })
  }
  // An action that waits for its document, or was read for the purchase order a receipt belongs to, moves to the
  // document that takes the values; one already taken into another document stays there
  const movable = action.subjectType === null || action.subjectType === 'CHAT_INTAKE' || (action.appliedAt === null && action.subjectType !== subject.type)
  const elsewhere =
    action.subjectType !== null && action.subjectType !== 'CHAT_INTAKE' && action.subjectType !== subject.type && action.subjectId !== null
      ? !(kind.belongsTo && (await kind.belongsTo(tx, subject.id, { type: action.subjectType, id: action.subjectId })))
      : false
  if ((!movable && (action.subjectType !== subject.type || action.subjectId !== subject.id)) || elsewhere) {
    return err('VALIDATION_FAILED', 'the AI action belongs to another document', { field: 'aiAssist.agentActionId', reason: 'SUBJECT_MISMATCH' })
  }

  const review = reviewOf(action.review)
  const confirmed = new Set([...review.confirmedPaths, ...input.confirmedPaths.filter((p) => Object.hasOwn(review.proposed, p))])
  const current = (await kind.read(tx, subject.id)) ?? {}
  const { pending, changed } = pendingOf(review, confirmed, current)
  if (pending.length && kind.final) return pendingError(pending.length, [action.id])

  const memberId = ctx.actor.memberId
  const nextReview = { ...review, confirmedPaths: [...confirmed].sort() }
  const event = { subjectType: subject.type, subjectId: subject.id }
  if (pending.length) {
    if (!agentActionTransition('DRAFT', 'agent_action.apply').ok) return err('INVALID_STATE_TRANSITION', 'cannot apply')
    await tx.agentAction.update({
      where: { id: action.id },
      data: { subjectType: subject.type, subjectId: subject.id, review: nextReview, appliedAt: action.appliedAt ?? ctx.now, appliedById: memberId, version: { increment: 1 } },
    })
    return ok([{ type: 'agent_action.applied', aggregateType: 'AgentAction', aggregateId: action.id, data: { ...event, pending: pending.length } }])
  }
  const edited = changed.length > 0
  const to = agentActionTransition('DRAFT', edited ? 'agent_action.edit' : 'agent_action.accept')
  if (!to.ok) return err('INVALID_STATE_TRANSITION', 'cannot close the AI action')
  const diff = edited ? Object.fromEntries(changed.map((p) => [p, { ai: review.proposed[p] ?? null, final: Object.hasOwn(current, p) ? current[p]! : null }])) : null
  await tx.agentAction.update({
    where: { id: action.id },
    data: {
      status: to.to,
      subjectType: subject.type,
      subjectId: subject.id,
      review: nextReview,
      ...(diff ? { diff } : {}),
      appliedAt: action.appliedAt ?? ctx.now,
      appliedById: memberId,
      decidedById: memberId,
      decidedAt: ctx.now,
      version: { increment: 1 },
    },
  })
  return ok([
    edited
      ? { type: 'agent_action.edited', aggregateType: 'AgentAction', aggregateId: action.id, data: { ...event, changedPaths: changed } }
      : { type: 'agent_action.accepted', aggregateType: 'AgentAction', aggregateId: action.id, data: event },
  ])
}

/** A decimal as a form path holds it: no sign, no trailing zeros after the point ("18.0000" → "18", "2.50" → "2.5") */
export function decimalText(value: { toString(): string } | string): string {
  const s = String(value).trim().replace(/^\+/, '')
  return s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s
}
