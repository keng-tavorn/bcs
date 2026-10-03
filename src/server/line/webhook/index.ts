// The LINE webhook (S5-02, FR-LINE-005): checking, recording and processing what LINE sends to
// /api/webhooks/line/<channelKey>, inline within the time budget or in the line-webhook job, and making sure nothing it
// recorded is left behind (the job's further runs and the line-webhook sweep). The route and the jobs reach it through
// src/server/jobs/line-webhook.ts, which supplies the channel opener of src/server/services/line-channel.
// Postback actions plug in with registerLinePostbackHandler (S5-05: `approve`), and what a linked member's follow sets
// right again with registerLineFollowHook (S5-04: the LINKED rich menu).

export { parseLineWebhook, StoredLineEvent, type ParsedLineEvent, type ParsedLineWebhook } from './body'
export {
  LINE_WEBHOOK_ANSWER_WITHIN_MS,
  LINE_WEBHOOK_BODY_MAX_BYTES,
  LINE_WEBHOOK_INLINE_BUDGET_MS,
  LINE_WEBHOOK_JOB_MAX_EVENTS,
  LINE_WEBHOOK_JOB_RETRIES,
  LINE_WEBHOOK_JOB_ROUNDS,
  LINE_WEBHOOK_QUEUE_EVENT,
  LINE_WEBHOOK_QUEUED_GIVE_UP_MS,
  LINE_WEBHOOK_REQUEST_ENDED_MS,
  LINE_WEBHOOK_ROUND_DELAY_MS,
  LINE_WEBHOOK_ROUTE_MAX_DURATION_MS,
} from './constants'
export { registerLineFollowHook, type LineFollowHook, type LineFollowRequest } from './follow'
export { applyLineReachability, findLinkedMemberId, setLineReachable, type LineReachabilityChange } from './identity'
export { liffLink, linkPromptMessages, welcomeBackMessages } from './messages'
export {
  LINE_POSTBACK_VERSION,
  linePostbackActions,
  parseLinePostbackData,
  registerLinePostbackHandler,
  type LinePostbackContext,
  type LinePostbackHandler,
  type LinePostbackRequest,
  type ParsedLinePostback,
} from './postback'
export { processLineWebhookEvent, runLineWebhookEvent } from './process'
export { LineWebhookQueuePayload, tellLineWebhookJob, webhookClock } from './queue'
export {
  processQueuedLineWebhookEvents,
  receiveLineWebhook,
  type LineWebhookAnswer,
  type LineWebhookDeps,
  type LineWebhookIgnored,
  type LineWebhookJobResult,
  type LineWebhookRequest,
  type ReceiveLineWebhookOptions,
} from './receive'
export { settleFailedLineWebhookRun, sweepLineWebhookEvents, type LineWebhookRunSettlement, type LineWebhookSweepResult } from './recovery'
export {
  finishLineWebhookEvent,
  giveUpLineWebhookEvents,
  handOverLineWebhookEvents,
  LINE_WEBHOOK_GAVE_UP,
  LINE_WEBHOOK_RECOVERED,
  loadQueuedLineWebhookEvents,
  recordLineWebhookEvents,
  recoverStaleLineWebhookEvents,
  requeueLineWebhookEvents,
  type LineWebhookStatus,
  type RecoveredLineWebhookEvents,
} from './store'
export type { LineEventContext, LineEventOutcome, LineEventPath, LineWebhookChannel, OpenLineWebhookChannel, OpenLineWebhookChannelResult, RecordedLineEvent } from './types'
