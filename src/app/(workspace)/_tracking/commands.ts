import { z } from 'zod'
import { REASON_MAX_LENGTH } from '@/lib/constants'
import { grantStepUp } from '@/server/auth/step-up'
import type { Principal } from '@/server/authz'
import type { Ctx } from '@/server/context'
import { getRequestAccess } from '@/server/queries/requests'
import { getTaskAccess, POLICY_SUBJECTS, taskDecision } from '@/server/queries/tasks'
import { decideTask, provideInfo, requestInfo } from '@/server/services/approvals/decide'
import { cancelRequest, resubmitRequest } from '@/server/services/requests'
import { toActionFailure, type ActionFailure, type ActionOutcome } from '@/ui/tasks/outcome'
import { taskRight } from './access'
import { memberName, type Locale } from './present'

// The commands behind the buttons of the decision page and the request page (FR-DOA-004, FR-INT-009, BR-DOA-15), apart
// from the session and the page cache so tests run them with a context. Every input is parsed first, so a malformed
// call gets VALIDATION_FAILED and never a crash; then the service decides and checks the permission again (BR-AUTH-05).
// The screens keep two limits of their own on top: questions are asked on request tasks only (a policy change is
// approved or rejected, nothing else), and the request page's cancel belongs to the requester (§2.4: PROCUREMENT
// cancels only an approved request not yet ordered, with a reason — never from this page). A task decided already
// names who decided it in the reader's language (FR-DOA-004 AC2).

const Key = z.uuid()
const Id = z.uuid()
const REASON_MIN = 3
const CODE = /^\d{6}$/

const DecideInput = z.object({ taskId: Id, decision: z.enum(['APPROVE', 'RETURN', 'REJECT']), reason: z.string().max(REASON_MAX_LENGTH).optional() })
const AskInput = z.object({ taskId: Id, question: z.string().max(REASON_MAX_LENGTH) })
const PolicyInput = z.object({ taskId: Id, decision: z.enum(['APPROVE', 'REJECT']), reason: z.string().max(REASON_MAX_LENGTH).optional(), code: z.string().max(20) })
const AnswerInput = z.object({ infoRequestId: Id, answer: z.string().max(REASON_MAX_LENGTH) })
const CancelInput = z.object({ requestId: Id, reason: z.string().max(REASON_MAX_LENGTH) })

const invalid = (field: string, reason?: string): ActionFailure => ({ ok: false, code: 'VALIDATION_FAILED', field, ...(reason ? { reason } : {}) })
const BAD_KEY = invalid('idempotencyKey')
const FORBIDDEN: ActionFailure = { ok: false, code: 'FORBIDDEN' }
const NOT_FOUND: ActionFailure = { ok: false, code: 'NOT_FOUND' }

type ServiceResult = { ok: true; data: unknown } | { ok: false; error: { code: string; details?: Record<string, unknown> } }

function outcomeOf(result: ServiceResult): ActionOutcome {
  if (!result.ok) return toActionFailure(result.error)
  const status = (result.data as { documentStatus?: unknown } | null)?.documentStatus
  return typeof status === 'string' ? { ok: true, documentStatus: status } : { ok: true }
}

/** A task decided or moved already: who decided it, in the reader's language, and when (the service names them in Thai) */
async function decidedOutcome(ctx: Ctx, taskId: string, result: ServiceResult, locale: Locale): Promise<ActionOutcome> {
  const outcome = outcomeOf(result)
  if (outcome.ok || outcome.code !== 'INVALID_STATE_TRANSITION') return outcome
  const decided = await taskDecision(ctx, taskId)
  if (!decided?.decidedBy) return outcome
  return { ...outcome, name: memberName(locale, decided.decidedBy), ...(decided.decidedAt ? { time: decided.decidedAt.toISOString() } : {}) }
}

/** Approve, return or reject a request task (FR-DOA-004 AC1) */
export async function decideRequestTask(ctx: Ctx, input: unknown, idempotencyKey: unknown, locale: Locale): Promise<ActionOutcome> {
  if (!Key.safeParse(idempotencyKey).success) return BAD_KEY
  const parsed = DecideInput.safeParse(input)
  if (!parsed.success) return invalid('decision')
  const { taskId, decision } = parsed.data
  const reason = parsed.data.reason?.trim()
  const result = await decideTask(ctx, { taskId, decision, ...(reason ? { reason } : {}) }, { idempotencyKey: idempotencyKey as string })
  return decidedOutcome(ctx, taskId, result, locale)
}

/** Ask the requester for more information on a request task (FR-INT-009 AC3); a policy task is never asked */
export async function askRequester(ctx: Ctx, input: unknown, idempotencyKey: unknown): Promise<ActionOutcome> {
  if (!Key.safeParse(idempotencyKey).success) return BAD_KEY
  const parsed = AskInput.safeParse(input)
  if (!parsed.success) return invalid('question')
  const question = parsed.data.question.trim()
  if (question.length < REASON_MIN) return invalid('question')
  const access = await getTaskAccess(ctx, parsed.data.taskId)
  if (!access) return NOT_FOUND
  if (access.subjectType !== 'REQUEST') return invalid('taskId', 'SUBJECT')
  return outcomeOf(await requestInfo(ctx, { taskId: parsed.data.taskId, question }, { idempotencyKey: idempotencyKey as string }))
}

/**
 * BR-DOA-15: a DOA version or an authority change is approved or rejected with the authenticator code again. Only a
 * decider of such a task spends a code on it; the code buys a step-up for this one document (5 minutes, used once by
 * the decision) on the security clock `securityNow`; the decision refuses without it.
 */
export async function decidePolicy(ctx: Ctx, principal: Principal, input: unknown, idempotencyKey: unknown, locale: Locale, securityNow: Date): Promise<ActionOutcome> {
  if (!Key.safeParse(idempotencyKey).success) return BAD_KEY
  const parsed = PolicyInput.safeParse(input)
  if (!parsed.success) return invalid('decision')
  const { taskId, decision } = parsed.data
  const code = parsed.data.code.trim()
  const reason = parsed.data.reason?.trim() ?? ''
  if (!CODE.test(code)) return invalid('code')
  if (decision === 'REJECT' && reason.length < REASON_MIN) return invalid('reason')
  if (principal.kind !== 'member' || ctx.actor.type !== 'USER' || ctx.actor.memberId !== principal.memberId) return FORBIDDEN
  const access = await getTaskAccess(ctx, taskId)
  if (!access) return NOT_FOUND
  if (!POLICY_SUBJECTS.includes(access.subjectType) || taskRight(principal, access) !== 'DECIDE') return FORBIDDEN
  const stepUp = await grantStepUp({ organizationId: ctx.organizationId, memberId: principal.memberId, subjectType: access.subjectType, subjectId: access.subjectId, code }, securityNow)
  if (!stepUp.ok) return { ok: false, code: 'STEP_UP', reason: stepUp.reason }
  const result = await decideTask(ctx, { taskId, decision, ...(reason ? { reason } : {}) }, { idempotencyKey: idempotencyKey as string })
  return decidedOutcome(ctx, taskId, result, locale)
}

/** The requester answers the approver's question; the task goes back to the same approver (FR-INT-009 AC3) */
export async function answerQuestion(ctx: Ctx, input: unknown, idempotencyKey: unknown): Promise<ActionOutcome> {
  if (!Key.safeParse(idempotencyKey).success) return BAD_KEY
  const parsed = AnswerInput.safeParse(input)
  if (!parsed.success) return invalid('answer')
  const answer = parsed.data.answer.trim()
  if (!answer) return invalid('answer')
  return outcomeOf(await provideInfo(ctx, { infoRequestId: parsed.data.infoRequestId, answer }, { idempotencyKey: idempotencyKey as string }))
}

/** The requester sends a returned request again: a new route under the DOA in effect (FR-INT-009 AC2, BR-DOA-09) */
export async function resubmitOwnRequest(ctx: Ctx, requestId: unknown, idempotencyKey: unknown): Promise<ActionOutcome> {
  if (!Key.safeParse(idempotencyKey).success) return BAD_KEY
  const parsed = Id.safeParse(requestId)
  if (!parsed.success) return invalid('requestId')
  return outcomeOf(await resubmitRequest(ctx, { requestId: parsed.data }, { idempotencyKey: idempotencyKey as string }))
}

/**
 * The requester cancels their request with a reason; the reserved budget goes back at once (FR-INT-009 AC1). This page
 * offers it to the requester only, so it refuses anybody else before the service runs.
 */
export async function cancelOwnRequest(ctx: Ctx, input: unknown, idempotencyKey: unknown): Promise<ActionOutcome> {
  if (!Key.safeParse(idempotencyKey).success) return BAD_KEY
  const parsed = CancelInput.safeParse(input)
  if (!parsed.success) return invalid('requestId')
  const reason = parsed.data.reason.trim()
  // The screen asks for a reason (the service keeps it optional for other channels)
  if (reason.length < REASON_MIN) return invalid('reason')
  const access = await getRequestAccess(ctx, parsed.data.requestId)
  if (!access) return NOT_FOUND
  if (ctx.actor.type !== 'USER' || ctx.actor.memberId !== access.requesterMemberId) return FORBIDDEN
  return outcomeOf(await cancelRequest(ctx, { requestId: parsed.data.requestId, reason }, { idempotencyKey: idempotencyKey as string }))
}
