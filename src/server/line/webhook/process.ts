import { handleFollow, handleUnfollow } from './follow'
import { dispatchLinePostback } from './postback'
import { finishLineWebhookEvent } from './store'
import type { LineEventContext, LineEventOutcome, LineWebhookChannel, RecordedLineEvent } from './types'

// One recorded webhook event, processed by kind (FR-LINE-005). BCS acts on events of a 1:1 chat in the active mode only:
// follow, unfollow and postbacks. Messages and everything else are recorded (without their text) and skipped. The same
// code runs inline in the webhook and in the line-webhook job; only the path in the context differs.

export async function processLineWebhookEvent(channel: LineWebhookChannel, event: RecordedLineEvent, context: LineEventContext): Promise<LineEventOutcome> {
  // standby: another channel answers this chat (LINE's module mode), so BCS stays silent
  if (event.payload.mode !== 'active') return { status: 'SKIPPED', reason: 'NOT_ACTIVE_MODE' }
  const lineUserId = event.payload.source === 'user' ? event.payload.userId : null
  if (!lineUserId) return { status: 'SKIPPED', reason: 'NOT_A_USER_CHAT' }
  switch (event.type) {
    case 'follow':
      return handleFollow(channel, event, lineUserId, context)
    case 'unfollow':
      return handleUnfollow(channel, event, lineUserId)
    case 'postback':
      return dispatchLinePostback(channel, event, lineUserId, context)
    default:
      return { status: 'SKIPPED', reason: 'NOT_HANDLED' }
  }
}

/**
 * Processes one event and records how it ended, if the row is still in one of the statuses `from` (inline: RECEIVED, or
 * QUEUED once it was handed over while still running; the job: QUEUED). Throws, leaving the row as it was, when
 * processing failed in a way another try may fix (the database, LINE): the job takes it (again).
 */
export async function runLineWebhookEvent(
  channel: LineWebhookChannel,
  event: RecordedLineEvent,
  from: readonly ('RECEIVED' | 'QUEUED')[],
  context: LineEventContext,
): Promise<LineEventOutcome> {
  const outcome = await processLineWebhookEvent(channel, event, context)
  await finishLineWebhookEvent(channel.organizationId, event.id, from, outcome, context.clock.now())
  return outcome
}
