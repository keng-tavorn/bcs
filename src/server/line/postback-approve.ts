import type { OutgoingLineMessage } from '@/channels/line/flex'
import type { Result } from '@/core/result'
import { isLineApiError, LINE_REPLY_TOKEN_TTL_MS } from '@/integrations/line'
import { logger } from '@/lib/logger'
import { makeCtx, type Ctx } from '@/server/context'
import { cardContextOf, decisionConfirmationMessage, postbackRefusalFor } from './postback-cards'
import type { LineEventContext, LineEventOutcome, LinePostbackContext, LinePostbackHandler, LinePostbackRequest, LineWebhookChannel } from './webhook'

// The `approve` postback of the approval card (spec §9.3, BR-TOK-02, BR-TOK-04, BR-TOK-05, BR-LINE-07, FR-LINE-002 AC2
// AC3, FR-LINE-007 AC2), plugged into the webhook's dispatcher by src/server/services/approvals/line-postback.ts, which
// passes the command that decides (src/server/line may not import services). For one tap:
//  1. the data must be exactly v=1&a=approve&k=<tokenId>; anything else is skipped;
//  2. the actor is the member linked to the LINE user of the signed webhook (the dispatcher found them), or nobody;
//  3. the command checks that this member is the one the token was issued to (else FORBIDDEN and security.token_misuse),
//     refuses a step-up again on the server (STEP_UP_REQUIRED), uses the token by one conditional update and decides
//     through the command the workspace uses, on channel LINE_CHAT. Its idempotency key is LINE's webhookEventId: a run
//     of the same event again (the line-webhook job) replays the stored answer, while a second tap is a new event and is
//     refused TOKEN_USED with who decided and when (INV-TOK-01);
//  4. the answer — the confirmation card, or the reason it decided nothing with where to go on — goes by the reply
//     token while it is fresh (a reply is free, BR-LINE-07), otherwise, or when LINE refused the reply, by a push to the
//     member with the event's id as retry key, so trying the event again never pushes twice. Someone not linked gets
//     the reply only. A busy database or LINE being unreachable throws, and the job tries the event again.
// Logs name the organization, the event and codes only: never the LINE user id, the reply token or the token id.

/** The command of src/server/services/approvals/line-postback.ts: decideByLinePostback */
export type DecideByLinePostback = (ctx: Ctx, input: { readonly tokenId: string }, options: { readonly idempotencyKey: string }) => Promise<Result<{ readonly taskId: string; readonly documentStatus: string }>>

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
/** Codes another try may fix (§4.3 step 6): the event goes to the line-webhook job */
const TRANSIENT: ReadonlySet<string> = new Set(['RATE_LIMITED', 'INTERNAL'])
/** The job that stands in for the actor when the LINE user is linked to nobody: the refusal is still audited */
export const LINE_POSTBACK_JOB = 'line-postback'

/** The token id of `v=1&a=approve&k=<tokenId>` and nothing more (BR-TOK-02), or null */
export function approveTokenOf(params: ReadonlyMap<string, string>): string | null {
  const k = params.get('k')
  return params.size === 3 && params.get('a') === 'approve' && k !== undefined && UUID.test(k) ? k.toLowerCase() : null
}

export type LineAnswer = 'REPLIED' | 'PUSHED' | 'NOT_ANSWERED'

/**
 * BR-LINE-07, FR-LINE-007 AC2: the reply token while it works — read the clock now, after the command ran — then a push
 * to a linked member. A push LINE could not take for now throws (the event is tried again; the retry key keeps it one
 * message); one LINE refuses for good is left unanswered and logged.
 */
export async function answerPostback(channel: LineWebhookChannel, request: LinePostbackRequest, messages: readonly OutgoingLineMessage[], context: LineEventContext): Promise<LineAnswer> {
  const log = logger.child({ organizationId: request.organizationId, eventId: request.eventId })
  const fresh = request.replyToken !== null && context.clock.now().getTime() - request.receivedAt.getTime() < LINE_REPLY_TOKEN_TTL_MS
  if (fresh) {
    try {
      await channel.api.replyMessage(request.replyToken!, messages)
      return 'REPLIED'
    } catch (error) {
      log.warn({ ...(isLineApiError(error) ? { reason: error.reason, status: error.status } : { reason: 'UNEXPECTED' }) }, 'LINE did not take the reply to a postback; pushing the answer instead')
    }
  }
  // A push counts against the quota: only to the member linked to this LINE user, never to a stranger
  if (request.memberId === null) return 'NOT_ANSWERED'
  try {
    await channel.api.pushMessage(request.lineUserId, messages, { retryKey: request.eventId })
    return 'PUSHED'
  } catch (error) {
    if (isLineApiError(error) && !error.permanent) throw error
    log.warn({ ...(isLineApiError(error) ? { reason: error.reason, status: error.status } : { reason: 'UNEXPECTED' }) }, 'LINE refused the answer to a postback')
    return 'NOT_ANSWERED'
  }
}

function outcomeOf(refused: string | null, answered: LineAnswer): LineEventOutcome {
  const notes = [...(refused ? [refused] : []), ...(answered === 'REPLIED' ? [] : [answered])]
  return notes.length > 0 ? { status: 'PROCESSED', reason: notes.join(',') } : { status: 'PROCESSED' }
}

export function approvePostbackHandler(decide: DecideByLinePostback): LinePostbackHandler {
  return async (request: LinePostbackRequest, context: LinePostbackContext): Promise<LineEventOutcome> => {
    const tokenId = approveTokenOf(request.params)
    if (!tokenId) return { status: 'SKIPPED', reason: 'POSTBACK_INVALID' }
    const ctx = makeCtx({
      organizationId: request.organizationId,
      actor: request.memberId ? { type: 'USER', memberId: request.memberId } : { type: 'SYSTEM', job: LINE_POSTBACK_JOB },
      channel: 'LINE_CHAT',
      now: context.clock.now(),
      requestId: request.eventId,
    })
    const result = await decide(ctx, { tokenId }, { idempotencyKey: `line-postback:${request.webhookEventId}` })
    if (!result.ok && TRANSIENT.has(result.error.code)) throw new Error(`deciding from a LINE button did not finish (${result.error.code}); the line-webhook job tries the event again`)

    const cards = await cardContextOf(request.organizationId, context.channel.liffId)
    const confirmation = result.ok ? await decisionConfirmationMessage(request.organizationId, result.data.taskId, cards) : null
    const message = confirmation ?? (result.ok ? null : await postbackRefusalFor(request.organizationId, result.error, { tokenId, memberId: request.memberId }, cards))
    if (!message) return { status: 'PROCESSED', reason: 'NO_ANSWER' }
    const answered = await answerPostback(context.channel, request, [message], context)
    return outcomeOf(result.ok ? null : result.error.code, answered)
  }
}
