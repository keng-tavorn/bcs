import { isLineApiError } from '@/integrations/line'
import { logger } from '@/lib/logger'
import { registerLineFollowHook, type LineFollowRequest } from '@/server/line/webhook'
import { syncLineRichMenu } from './rich-menu'

// A linked member follows the account again (S5-04, FR-LINE-004 AC1). LINE keeps a user's own rich menu only while
// they stay a friend: "If a user blocks and then unblocks a LINE Official Account after linking a per-user rich menu,
// that rich menu will be unlinked from the user" (LINE's FAQ), and someone who is not a friend sees the account's
// default. So a member who blocked the account and came back, or who linked in LIFF before adding the account, would
// see UNLINKED although they are linked. Their follow sets the menu to what their link is now, with the same sync as a
// link (./rich-menu.ts). Unfollow does not unlink (BR-LINE-08: it only stops pushes), so nothing else would.
// A failure LINE may get over is thrown: the webhook still answers the follow, and hands it to the line-webhook job,
// which runs it again (the sync is safe to run twice). One LINE refuses for good is logged, without the LINE user id.
// Registered at module level; src/server/jobs/line-webhook.ts imports this module so the webhook and the job know it.

export const LINE_RICH_MENU_FOLLOW_HOOK = 'line-link:rich-menu'

export async function restoreRichMenuOnFollow(request: LineFollowRequest): Promise<void> {
  try {
    const outcome = await syncLineRichMenu(request.organizationId, request.lineUserId)
    if (outcome.status === 'SKIPPED') logger.info({ organizationId: request.organizationId, eventId: request.eventId, reason: outcome.reason }, 'the rich menu of a member who followed the account was not set')
  } catch (error) {
    if (isLineApiError(error) && error.permanent) {
      logger.warn(
        { organizationId: request.organizationId, eventId: request.eventId, operation: error.operation, reason: error.reason, status: error.status },
        'LINE refused to set the rich menu of a member who followed the account again',
      )
      return
    }
    throw error
  }
}

registerLineFollowHook(LINE_RICH_MENU_FOLLOW_HOOK, restoreRichMenuOnFollow)
