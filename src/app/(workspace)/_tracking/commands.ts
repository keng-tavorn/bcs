import { z } from 'zod'
import { REASON_MAX_LENGTH } from '@/lib/constants'
import { grantStepUp, stepUpRefusalError, type StepUpChannel, type StepUpOptions } from '@/server/auth/step-up'
import { memberPrincipal, type Principal } from '@/server/authz'
import type { Ctx } from '@/server/context'
import { getRequestAccess } from '@/server/queries/requests'
import { getTaskAccess, PIN_DECISION_SUBJECTS, taskDecision, type TaskAccessDto } from '@/server/queries/tasks'
import { decideTask, provideInfo, requestInfo } from '@/server/services/approvals/decide'
import { cancelRequest, resubmitRequest } from '@/server/services/requests'
import { followRequest, manageFollowers } from '@/server/services/requests/followers'
import { renewRequestLine, reorderRequest } from '@/server/services/requests/repeat'
import type { RepeatOutcome } from '@/ui/request-view/repeat-rules'
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
//
// The PIN (FR-AUTH-005 AC2, NFR-SEC-04): deciding a policy task, or a task whose amount is at or above its DOA version's
// stepUpThreshold, takes the member's transaction PIN in the same call. Only the task's decider, while it waits, spends
// a try on it; the PIN buys a step-up for this one document on the security clock (grantStepUp: five wrong in a row
// lock it), then the session id changes and the decision runs and uses the step-up — in that order. A refused PIN
// decides nothing: wrong (VALIDATION_FAILED {field: pin, reason: WRONG, attemptsLeft}), locked (STEP_UP_LOCKED {time})
// or not set (STEP_UP_REQUIRED {reason: PIN_NOT_SET}). The PIN never goes into a log, an error or the decision's input.

const Key = z.uuid()
const Id = z.uuid()
const REASON_MIN = 3
/** FR-AUTH-005 AC1: six digits (PIN_LENGTH of src/core/pin, which the pages' layer does not import); the step-up checks it again */
const PIN = /^[0-9]{6}$/
/** Longer than any PIN, short enough that nothing large is parsed */
const PIN_INPUT_MAX = 32

const DecideInput = z.object({
  taskId: Id,
  decision: z.enum(['APPROVE', 'RETURN', 'REJECT']),
  reason: z.string().max(REASON_MAX_LENGTH).optional(),
  /** Sent when the task needs a step-up (TaskAccessDto.stepUp); left unread otherwise */
  pin: z.string().max(PIN_INPUT_MAX).optional(),
})
const AskInput = z.object({ taskId: Id, question: z.string().max(REASON_MAX_LENGTH) })
/**
 * boundaryTableConfirmed: the approver's tick of the boundary table the page showed, or null when it showed none;
 * boundaryBaselineId: the version that table compared this one with (null: the version's own table) (FR-DOA-009 AC3)
 */
const PolicyInput = z.object({
  taskId: Id,
  decision: z.enum(['APPROVE', 'REJECT']),
  reason: z.string().max(REASON_MAX_LENGTH).optional(),
  pin: z.string().max(PIN_INPUT_MAX),
  boundaryTableConfirmed: z.boolean().nullable().optional(),
  boundaryBaselineId: Id.nullable().optional(),
})

/** What a decision with the PIN takes from the server action around it */
export interface StepUpSession {
  /** Real time: the step-up's 5 minutes and the PIN lock are security timers, never the business clock tests move */
  readonly securityNow: Date
  /** NFR-SEC-04: gives the browser a new session id once the PIN was right; false when the request holds no live session */
  readonly rotateSession: () => Promise<boolean>
  /** Where the PIN lock's event and e-mail go after commit (grantStepUp); the app's outbox sender when left out */
  readonly sender?: StepUpOptions['sender']
}
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

const stepUpChannelOf = (ctx: Ctx): StepUpChannel => (ctx.channel === 'LIFF' || ctx.channel === 'PWA' ? ctx.channel : 'WEB')

/**
 * The PIN for this task's document (FR-AUTH-005 AC2), then a new session id (NFR-SEC-04): null when both went through,
 * otherwise what to tell the member — nothing is decided then. The member is the signed-in one, never from the input.
 */
async function stepUpFor(ctx: Ctx, access: TaskAccessDto, pin: string, session: StepUpSession): Promise<ActionFailure | null> {
  if (ctx.actor.type !== 'USER') return FORBIDDEN
  const granted = await grantStepUp(
    { organizationId: ctx.organizationId, memberId: ctx.actor.memberId, subjectType: access.subjectType, subjectId: access.subjectId, method: 'PIN', pin, channel: stepUpChannelOf(ctx) },
    session.securityNow,
    { requestId: ctx.requestId, correlationId: ctx.correlationId, ...(session.sender !== undefined ? { sender: session.sender } : {}) },
  )
  if (!granted.ok) return toActionFailure(stepUpRefusalError(granted))
  if (!(await session.rotateSession())) return { ok: false, code: 'UNAUTHENTICATED' }
  return null
}

/**
 * Approve, return or reject a request, purchase-order or variance task (FR-DOA-004 AC1). A task that needs a step-up
 * (FR-AUTH-005 AC2) takes the PIN with the decision and `stepUp` from the server action; a PIN sent for one that needs
 * none is not read. A task its member may not decide now, or that waits for no decision, spends no PIN: the service says
 * why (decided already by whom and when, not theirs).
 */
export async function decideRequestTask(ctx: Ctx, input: unknown, idempotencyKey: unknown, locale: Locale, stepUp?: StepUpSession): Promise<ActionOutcome> {
  if (!Key.safeParse(idempotencyKey).success) return BAD_KEY
  const parsed = DecideInput.safeParse(input)
  if (!parsed.success) return invalid('decision')
  const { taskId, decision, pin } = parsed.data
  const reason = parsed.data.reason?.trim()
  const access = await getTaskAccess(ctx, taskId)
  if (!access) return NOT_FOUND
  if (access.stepUp && stepUp && ctx.actor.type === 'USER' && access.status === 'OPEN' && taskRight(memberPrincipal(ctx.actor.memberId, []), access) === 'DECIDE') {
    // Told before a try is spent: a PIN that is not six digits, and a return or rejection without its reason
    if (pin === undefined || !PIN.test(pin)) return invalid('pin')
    if (decision !== 'APPROVE' && (reason ?? '').length < REASON_MIN) return invalid('reason')
    const refused = await stepUpFor(ctx, access, pin, stepUp)
    if (refused) return refused
  }
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
 * BR-DOA-15, FR-AUTH-005 AC2: a DOA version or an authority change is approved or rejected with the member's PIN. Only
 * a decider of such a task spends a try on it; the PIN buys a step-up for this one document (5 minutes, used once by
 * the decision) on the security clock, then the session id changes (NFR-SEC-04); the decision refuses without it.
 * Approving a DOA version passes the approver's tick of its boundary table with the version the table compared it with
 * (FR-DOA-009 AC3): a page that showed the table unticked spends no PIN, and the service asks for the tick whenever the
 * version has a table — and refuses a tick of a table that is no longer the one compared — before it uses the step-up.
 */
export async function decidePolicy(ctx: Ctx, principal: Principal, input: unknown, idempotencyKey: unknown, locale: Locale, stepUp: StepUpSession): Promise<ActionOutcome> {
  if (!Key.safeParse(idempotencyKey).success) return BAD_KEY
  const parsed = PolicyInput.safeParse(input)
  if (!parsed.success) return invalid('decision')
  const { taskId, decision, pin } = parsed.data
  const reason = parsed.data.reason?.trim() ?? ''
  // Rejecting needs no tick
  const tick = decision === 'APPROVE' ? parsed.data.boundaryTableConfirmed : null
  if (!PIN.test(pin)) return invalid('pin')
  if (decision === 'REJECT' && reason.length < REASON_MIN) return invalid('reason')
  if (tick === false) return invalid('boundaryTableConfirmed', 'BOUNDARY_NOT_CONFIRMED')
  if (principal.kind !== 'member' || ctx.actor.type !== 'USER' || ctx.actor.memberId !== principal.memberId) return FORBIDDEN
  const access = await getTaskAccess(ctx, taskId)
  if (!access) return NOT_FOUND
  if (!PIN_DECISION_SUBJECTS.includes(access.subjectType) || taskRight(principal, access) !== 'DECIDE') return FORBIDDEN
  const refused = await stepUpFor(ctx, access, pin, stepUp)
  if (refused) return refused
  // The tick goes with the version its table compared with, so the service approves only the table that was ticked
  const baselineId = parsed.data.boundaryBaselineId
  const boundary = tick === true ? { boundaryTableConfirmed: true, ...(baselineId !== undefined ? { boundaryBaselineId: baselineId } : {}) } : {}
  const result = await decideTask(ctx, { taskId, decision, ...(reason ? { reason } : {}), ...boundary }, { idempotencyKey: idempotencyKey as string })
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

/**
 * The requester sends a returned request again: a new route under the DOA in effect (FR-INT-009 AC2, BR-DOA-09). A
 * request like one they sent within the window needs their reason for asking again (S6-13 · BR-DUP-05), which the
 * service checks: without it, DUPLICATE_UNACKNOWLEDGED.
 */
export async function resubmitOwnRequest(ctx: Ctx, requestId: unknown, idempotencyKey: unknown, duplicateReason?: unknown): Promise<ActionOutcome> {
  if (!Key.safeParse(idempotencyKey).success) return BAD_KEY
  const parsed = Id.safeParse(requestId)
  if (!parsed.success) return invalid('requestId')
  if (duplicateReason !== undefined && typeof duplicateReason !== 'string') return invalid('duplicateReason')
  const reason = typeof duplicateReason === 'string' ? { duplicateReason } : {}
  return outcomeOf(await resubmitRequest(ctx, { requestId: parsed.data, ...reason }, { idempotencyKey: idempotencyKey as string }))
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

const FollowInput = z.object({ requestId: Id, follow: z.boolean() })
const ManageFollowerInput = z.object({ requestId: Id, memberId: Id, follow: z.boolean() })
/** The field the first parse problem names (the whole input when it is not an object) */
const firstField = (error: z.ZodError) => String(error.issues[0]?.path[0] ?? 'input')

/** The viewer follows the request or stops following it (FR-INT-013 AC1); the service checks request.follow */
export async function followOrUnfollow(ctx: Ctx, input: unknown, idempotencyKey: unknown): Promise<ActionOutcome> {
  if (!Key.safeParse(idempotencyKey).success) return BAD_KEY
  const parsed = FollowInput.safeParse(input)
  if (!parsed.success) return invalid(firstField(parsed.error))
  return outcomeOf(await followRequest(ctx, parsed.data, { idempotencyKey: idempotencyKey as string }))
}

/** The requester adds or removes a follower (FR-INT-013 AC1, OQ-39); the service checks request.followers.manage */
export async function addOrRemoveFollower(ctx: Ctx, input: unknown, idempotencyKey: unknown): Promise<ActionOutcome> {
  if (!Key.safeParse(idempotencyKey).success) return BAD_KEY
  const parsed = ManageFollowerInput.safeParse(input)
  if (!parsed.success) return invalid(firstField(parsed.error))
  return outcomeOf(await manageFollowers(ctx, parsed.data, { idempotencyKey: idempotencyKey as string }))
}

type DraftResult = { ok: true; data: { requestId: string } } | { ok: false; error: { code: string; details?: Record<string, unknown> } }
const draftOutcome = (result: DraftResult): RepeatOutcome => (result.ok ? { ok: true, requestId: result.data.requestId } : toActionFailure(result.error))

/**
 * "ขอซ้ำ" (FR-INT-101 AC1, BR-FORM-07): a new draft of the requester's from their request, with what the current form
 * still asks; the answer names the draft, whose edit page the screen opens. The service keeps it to the requester.
 */
export async function reorderOwnRequest(ctx: Ctx, requestId: unknown, idempotencyKey: unknown): Promise<RepeatOutcome> {
  if (!Key.safeParse(idempotencyKey).success) return BAD_KEY
  const parsed = Id.safeParse(requestId)
  if (!parsed.success) return invalid('requestId')
  return draftOutcome(await reorderRequest(ctx, { requestId: parsed.data }, { idempotencyKey: idempotencyKey as string }))
}

/** "สร้างคำขอต่ออายุ" (FR-INT-101 AC2, BR-FORM-08): a new draft from one service line of the requester's request */
export async function renewOwnLine(ctx: Ctx, requestLineId: unknown, idempotencyKey: unknown): Promise<RepeatOutcome> {
  if (!Key.safeParse(idempotencyKey).success) return BAD_KEY
  const parsed = Id.safeParse(requestLineId)
  if (!parsed.success) return invalid('requestLineId')
  return draftOutcome(await renewRequestLine(ctx, { requestLineId: parsed.data }, { idempotencyKey: idempotencyKey as string }))
}
