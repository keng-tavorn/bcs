import { BYTES_PER_MIB, MS_PER_DAY, MS_PER_MINUTE, MS_PER_SECOND } from '@/lib/constants'

// Time and size limits of the LINE webhook (BR-LINE-05, FR-LINE-005 AC3, S5 sub-spec "webhook").

/** LINE counts a slower answer as a failed delivery: the route answers 200 within this, whatever processing needs */
export const LINE_WEBHOOK_ANSWER_WITHIN_MS = 2 * MS_PER_SECOND
/**
 * Counted from the request's arrival: events are processed inline (a postback decision answered with its reply token)
 * until this much time has passed. What is not done by then goes to the line-webhook job, the event still running
 * included. What is left of the 2 s covers handing them over and answering.
 */
export const LINE_WEBHOOK_INLINE_BUDGET_MS = 1.5 * MS_PER_SECOND
/** Larger bodies are refused before they are read: LINE's bodies are a few kilobytes */
export const LINE_WEBHOOK_BODY_MAX_BYTES = BYTES_PER_MIB
/** The Inngest event that hands recorded events to the line-webhook job (§4.6: Inngest names start with bcs/) */
export const LINE_WEBHOOK_QUEUE_EVENT = 'bcs/line.webhook_received' as const
/** Event ids in one job run; a hand-over of more is split into several runs */
export const LINE_WEBHOOK_JOB_MAX_EVENTS = 500
/**
 * The route's maxDuration (src/app/api/webhooks/line/[channelKey]/route.ts, where Next.js needs it as a literal; a test
 * keeps the two equal): work the request keeps alive after its answer is cut at this.
 */
export const LINE_WEBHOOK_ROUTE_MAX_DURATION_MS = 30 * MS_PER_SECOND
/**
 * Counted from an event's arrival: by then the request that recorded it has ended, however it ended (the route's
 * maxDuration and as much again). The job waits this long before it touches an event that was still running inline when
 * the webhook answered, and an event still RECEIVED after this long was dropped by its request (the platform cut it, the
 * server stopped, or the hand-over failed): a redelivery or the sweep hands it to the job.
 */
export const LINE_WEBHOOK_REQUEST_ENDED_MS = 2 * LINE_WEBHOOK_ROUTE_MAX_DURATION_MS
/** Inngest's retries of one run of the line-webhook job (each retry takes up the events still QUEUED) */
export const LINE_WEBHOOK_JOB_RETRIES = 3 as const
/**
 * Runs of the line-webhook job an event gets. When Inngest gives up a run, its failure handler starts the next one for
 * the events still waiting; after the last, they are given up (FAILED, GAVE_UP) with an alert, never left waiting.
 */
export const LINE_WEBHOOK_JOB_ROUNDS = 3
/** The next run starts this long after a run failed, times the number of the next run (5, then 10 minutes) */
export const LINE_WEBHOOK_ROUND_DELAY_MS = 5 * MS_PER_MINUTE
/**
 * The sweep's last resort: an event still QUEUED this long after its arrival was never finished by any run of the job
 * (its outbox message died, or the failure handler could not run). It is given up with an alert. Far beyond every run
 * and retry above, so it never cuts a run short.
 */
export const LINE_WEBHOOK_QUEUED_GIVE_UP_MS = MS_PER_DAY
