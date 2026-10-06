import { isLineApiError, LINE_REPLY_TOKEN_TTL_MS, type LineMessage } from '@/integrations/line'
import { logger } from '@/lib/logger'
import { applyLineReachability, findLinkedMemberId } from './identity'
import { linkPromptMessages, liffLink, welcomeBackMessages } from './messages'
import type { LineEventContext, LineEventOutcome, LineWebhookChannel, RecordedLineEvent } from './types'

// follow and unfollow (FR-LINE-005, BR-LINE-08). LINE sends `follow` when a user adds the account or unblocks it and
// `unfollow` when they block it — the only sure sign that a push will not reach them (§4.7 rule 2: lineReachable). The
// last of them LINE sent decides, whatever order they are processed in (applyLineReachability). A follow is answered
// with the reply token, never a push (BR-LINE-07, push counts against the quota): a linked member is welcomed back,
// anyone else is shown how to link.
// A linked member's follow also runs the follow hooks other parts of BCS register (registerLineFollowHook), for what
// LINE keeps only while a user is a friend: S5-04 sets the LINKED rich menu again, which LINE drops when a user blocks
// and unblocks the account and does not show to someone who linked before adding it (src/server/services/line-link).
// A module that registers one is imported by src/server/jobs/line-webhook.ts, as postback handlers are.

/** Replies when the reply token still works now; what LINE refused is logged without the token or the user id */
async function reply(channel: LineWebhookChannel, event: RecordedLineEvent, messages: LineMessage[], context: LineEventContext): Promise<'SENT' | 'EXPIRED' | 'FAILED'> {
  const token = event.payload.replyToken
  if (!token || context.clock.now().getTime() - event.receivedAt.getTime() >= LINE_REPLY_TOKEN_TTL_MS) return 'EXPIRED'
  try {
    await channel.api.replyMessage(token, messages)
    return 'SENT'
  } catch (error) {
    logger.warn(
      { organizationId: channel.organizationId, eventId: event.id, ...(isLineApiError(error) ? { reason: error.reason, status: error.status } : { reason: 'UNEXPECTED' }) },
      'LINE did not take the reply to a webhook event',
    )
    return 'FAILED'
  }
}

/** Outcome note when LINE sent a later follow or unfollow of the user: that one decides, this one changes nothing */
const SUPERSEDED = { status: 'PROCESSED', reason: 'SUPERSEDED' } as const

/** A follow of a LINE user linked to an ACTIVE member, from the signed webhook (never from a browser, BR-LINE-01) */
export interface LineFollowRequest {
  readonly organizationId: string
  /** LineWebhookEvent.id */
  readonly eventId: string
  readonly lineUserId: string
  readonly memberId: string
}

/**
 * Sets right what LINE keeps for a user only while they are a friend. It must be safe to run twice (a failed follow is
 * run again by the line-webhook job) and throws only when another try may fix it: the follow is then answered as usual
 * and handed to the job, which runs every hook again.
 */
export type LineFollowHook = (request: LineFollowRequest, context: LineEventContext) => Promise<void>

const followHooks = new Map<string, LineFollowHook>()

/**
 * Registers a hook under a name, from the module that owns it (one name per module); registering the name again
 * replaces its hook, as registerLinePostbackHandler does. Returns the removal of this hook, which leaves a later one.
 */
export function registerLineFollowHook(name: string, hook: LineFollowHook): () => void {
  followHooks.set(name, hook)
  return () => {
    if (followHooks.get(name) === hook) followHooks.delete(name)
  }
}

/** Runs every hook; the first failure is returned (after all of them ran), not thrown */
async function runFollowHooks(request: LineFollowRequest, context: LineEventContext): Promise<{ readonly error: unknown } | null> {
  let failure: { readonly error: unknown } | null = null
  for (const hook of followHooks.values()) {
    try {
      await hook(request, context)
    } catch (error) {
      failure ??= { error }
    }
  }
  return failure
}

export async function handleFollow(channel: LineWebhookChannel, event: RecordedLineEvent, lineUserId: string, context: LineEventContext): Promise<LineEventOutcome> {
  const memberId = await findLinkedMemberId(channel.organizationId, channel.providerId, lineUserId)
  // A later unfollow (or follow) wins: no state change, and no welcome to someone who blocked the account again
  if (memberId && (await applyLineReachability(channel.organizationId, memberId, event, true)) === 'SUPERSEDED') return SUPERSEDED
  // Before the reply, so the member is welcomed back with their menu in place; a failure is thrown after the reply
  const hookFailure = memberId ? await runFollowHooks({ organizationId: channel.organizationId, eventId: event.id, lineUserId, memberId }, context) : null
  const messages = memberId ? welcomeBackMessages() : linkPromptMessages(channel.liffId ? liffLink(channel.liffId, '/link') : null)
  const replied = await reply(channel, event, messages, context)
  if (hookFailure) throw hookFailure.error
  return replied === 'FAILED' ? { status: 'PROCESSED', reason: 'REPLY_FAILED' } : replied === 'EXPIRED' ? { status: 'PROCESSED', reason: 'REPLY_TOKEN_EXPIRED' } : { status: 'PROCESSED' }
}

export async function handleUnfollow(channel: LineWebhookChannel, event: RecordedLineEvent, lineUserId: string): Promise<LineEventOutcome> {
  const memberId = await findLinkedMemberId(channel.organizationId, channel.providerId, lineUserId)
  if (!memberId) return { status: 'SKIPPED', reason: 'NOT_LINKED' }
  if ((await applyLineReachability(channel.organizationId, memberId, event, false)) === 'SUPERSEDED') return SUPERSEDED
  return { status: 'PROCESSED' }
}
