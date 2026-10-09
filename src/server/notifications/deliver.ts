import { textNotice, type OutgoingLineMessage } from '@/channels/line/flex'
import { EmailSendError, getEmailProvider, type EmailMessage } from '@/integrations/email-provider'
import { isLineApiError, type LineApiError, type LineChannelApi } from '@/integrations/line'
import { MS_PER_MINUTE, MS_PER_SECOND } from '@/lib/constants'
import { getEnv } from '@/lib/env'
import { logger } from '@/lib/logger'
import { forTenant } from '@/server/db/tenant'
import { approvalCardMessage, cardContextOf, documentLink } from '@/server/line/postback-cards'
import { setLineReachable } from '@/server/line/webhook/identity'
import { readLineChannelPublic } from '@/server/queries/line-channel'
import { emailLinkPath } from '@/server/tokens/action-tokens'
import { renderNotification } from './templates'

// Delivering an IMMEDIATE notification (spec §4.7 rule 2, §10.1, FR-NOTI-002 AC1, FR-LINE-007 AC3):
//  - first, at every try, a notice about an approval task (task.assigned, task.reminder, task.overdue, task.escalated)
//    is checked against the task as it is now: once the task is decided, cancelled, moved or waiting for the requester's
//    answer — or, for a notice to its assignee, no longer theirs — nothing is sent (FR-NOTI-003 AC3 "งานที่ปิดแล้วไม่ถูก
//    เตือน เพราะ job ตรวจสถานะล่าสุดก่อนส่ง"). The notice stays in the bell (§4.7 rule 1): there is no status for "not
//    sent", so the row is settled SENT on IN_APP with error TASK_CLOSED;
//  - by LINE when the notification is one §10.1 sends by LINE, the organization's channel is switched on
//    (LineChannelConfig.active — the switch the webhook and LIFF obey), the recipient is linked to it (a live
//    ChannelIdentity under the channel's provider) and LINE still reaches them (Member.lineReachable). An approval task
//    goes as its Flex card (task.assigned, and task.escalated to the co-assignee), anything else as a short text with a
//    link back to the document (BR-NOTI-01, BR-NOTI-02), in the organization's language (BR-NOTI-03);
//  - by e-mail otherwise, and whenever LINE cannot take it (FR-LINE-007 AC3: quota used up, blocked, LINE down):
//      · at once when LINE refuses for good. Only a refusal that names this recipient — today a 400 whose details name
//        the property `to` — marks them lineReachable = false (a second signal besides the unfollow event of a block,
//        BR-LINE-08). Any other refusal is the channel's, not the member's: a refused access token (401), a 403 (LINE
//        documents it as a call the channel may not make; whether a push to a user who blocked the account answers 403
//        is NOT CONFIRMED until D-03) and the month's push quota used up (429 "You have reached your monthly limit.")
//        raise an alert, and the member stays reachable;
//      · after LINE_DELIVERY_GIVE_UP_MS of tries with backoff when LINE cannot answer for now (5xx, a rate limit, no
//        connection), so the e-mail goes out within LINE_FALLBACK_WITHIN_MS of the first try.
//    An approval task's e-mail carries its action link (/a/<token>, BR-TOK-03) beside the link into the workspace.
// One call is one try; the job notification-deliver makes the next try at the time a RETRY answer gives (it carries the
// time of the first try from one to the next). A push carries the notification's id as LINE's retry key, so however
// often it is tried LINE shows it once; an e-mail is claimed first (Notification.sentChannel while PENDING), so a run that
// goes twice sends it once. A provider that refused the e-mail for good marks it FAILED; one that could not be reached
// frees the claim and throws for the job's retry. The channel is opened by the caller's openChannel (openLineChannel of
// src/server/services/line-channel, which this layer may not import); without it nothing goes by LINE.
// Logs carry codes and ids of BCS only: never a LINE user id, a message, an address or a secret (NFR-SEC-09).

/** FR-LINE-007 AC3: an approval task LINE cannot deliver reaches its recipient by e-mail within this of the first try */
export const LINE_FALLBACK_WITHIN_MS = 5 * MS_PER_MINUTE
/**
 * LINE is tried for this long after the first try; then e-mail replaces it. The minute left of LINE_FALLBACK_WITHIN_MS
 * covers a late wake-up of the job, the time limit of the last LINE call and the e-mail itself.
 */
export const LINE_DELIVERY_GIVE_UP_MS = 4 * MS_PER_MINUTE
/** The wait after the first failed try; it doubles after each one (15 s, 30 s, 1 min, 2 min), never past the give-up */
export const LINE_DELIVERY_RETRY_BASE_MS = 15 * MS_PER_SECOND
/** Tries by LINE at most, whatever the clock says: the job's bound */
export const LINE_DELIVERY_MAX_TRIES = 6

/**
 * §10.1 rows whose channel is "LINE → อีเมล" (or LINE beside in-app): only these go to LINE. The rest — security notices,
 * administrators' notices that name members, reports — go by e-mail only.
 */
export const LINE_TEMPLATES: ReadonlySet<string> = new Set([
  'task.assigned',
  'task.reminder',
  'task.overdue',
  'task.escalated',
  'request.approved',
  'request.decided',
  'request.info_requested',
  'request.info_provided',
  'request.follower_added',
  'po.approved',
  'po.send_bounced',
  'delegation.window',
  'doa.authority_changed',
  'digest.daily',
])

type Data = Readonly<Record<string, unknown>>

/** task.escalated to ORG_ADMIN (nobody to escalate to) is an administrator's notice, like admin.*: e-mail only */
const goesByLine = (templateKey: string, data: Data) => LINE_TEMPLATES.has(templateKey) && !(templateKey === 'task.escalated' && data.role === 'ADMIN')

/** The notice that gives the recipient an approval task: task.assigned, and task.escalated to the co-assignee (BR-SLA-04) */
const assignedTaskOf = (templateKey: string, data: Data): string | null =>
  typeof data.taskId === 'string' && (templateKey === 'task.assigned' || (templateKey === 'task.escalated' && data.role === 'CO_ASSIGNEE')) ? data.taskId : null

/** Notification.error of a notice that was not sent because its task no longer waits (FR-NOTI-003 AC3) */
export const TASK_CLOSED = 'TASK_CLOSED'

/**
 * The approval task a notice is about (§10.1 rows of approval_task.*), and whether it is addressed to that task's
 * assignee: task.assigned, task.reminder, task.overdue to the assignee and task.escalated to the co-assignee or the
 * assignee are; the next band's acknowledgement (task.overdue ACK) and the requester's and administrators' escalation
 * notices are about the task without being its assignee's.
 */
function taskNoticeOf(templateKey: string, data: Data): { readonly taskId: string; readonly toAssignee: boolean } | null {
  if (typeof data.taskId !== 'string') return null
  switch (templateKey) {
    case 'task.assigned':
    case 'task.reminder':
      return { taskId: data.taskId, toAssignee: true }
    case 'task.overdue':
      return { taskId: data.taskId, toAssignee: data.role === 'ASSIGNEE' }
    case 'task.escalated':
      return { taskId: data.taskId, toAssignee: data.role === 'CO_ASSIGNEE' || data.role === 'ASSIGNEE' }
    default:
      return null
  }
}

/**
 * FR-NOTI-003 AC3: the task still waits — OPEN on a running route — and, for a notice to its assignee, is still theirs.
 * A task waiting for the requester's answer (INFO_REQUESTED) does not: its SLA is paused, and its assignee asked the
 * question. Read again at every try, LINE's and the e-mail's.
 */
async function taskStillWaits(organizationId: string, about: { readonly taskId: string; readonly toAssignee: boolean }, recipientMemberId: string): Promise<boolean> {
  const task = await forTenant(organizationId).approvalTask.findFirst({
    where: { id: about.taskId },
    select: { status: true, assigneeMemberId: true, step: { select: { route: { select: { status: true } } } } },
  })
  return task !== null && task.status === 'OPEN' && task.step.route.status === 'ACTIVE' && (!about.toAssignee || task.assigneeMemberId === recipientMemberId)
}

/** Nothing goes out: the notice stays in the bell (§4.7 rule 1), settled SENT on IN_APP with the reason */
async function settleTaskClosed(organizationId: string, notificationId: string, now: Date): Promise<DeliveryOutcome> {
  await forTenant(organizationId).notification.updateMany({ where: { id: notificationId, status: 'PENDING', sentChannel: null }, data: { status: 'SENT', sentChannel: 'IN_APP', sentAt: now, error: TASK_CLOSED } })
  return { status: 'SKIPPED', why: TASK_CLOSED }
}

/** openLineChannel of src/server/services/line-channel, as delivery uses it */
export type OpenLineChannelForDelivery = (
  organizationId: string,
) => Promise<{ readonly ok: true; readonly channel: { readonly active: boolean; readonly liffId: string | null; readonly api: LineChannelApi } } | { readonly ok: false; readonly reason: string }>

export interface DeliveryOptions {
  /** Opens the organization's LINE channel; without it nothing goes by LINE */
  readonly openChannel?: OpenLineChannelForDelivery
  /** When the first try by LINE was: the job carries it from one try to the next (absent before the first) */
  readonly firstLineTryAt?: Date
  /** Which try by LINE this is: 1 for the first */
  readonly lineTry?: number
  /** Why the last try by LINE failed (the job carries it): reported when the e-mail replaces LINE once time is up */
  readonly lastLineFailure?: string
}

export type DeliveryOutcome =
  | { readonly status: 'SENT'; readonly channel: 'LINE' }
  /** lineFailed: why LINE did not take it when it was tried first (LineApiError.reason) */
  | { readonly status: 'SENT'; readonly channel: 'EMAIL'; readonly lineFailed?: string }
  | { readonly status: 'FAILED'; readonly channel: 'EMAIL'; readonly code: string }
  /** LINE could not answer for now: try again at retryAt (ISO), carrying firstTryAt; the e-mail follows by the give-up */
  | { readonly status: 'RETRY'; readonly channel: 'LINE'; readonly reason: string; readonly tries: number; readonly firstTryAt: string; readonly retryAt: string }
  /** Nothing sent: NOT_FOUND, settled already (its status), CLAIMED by another run, or TASK_CLOSED (FR-NOTI-003 AC3) */
  | { readonly status: 'SKIPPED'; readonly why: string }

interface LineTarget {
  readonly api: LineChannelApi
  /** The recipient's LINE user id under the channel's provider */
  readonly lineUserId: string
  readonly liffId: string | null
}

/** Where the recipient is on LINE, or null when this notification does not go by LINE */
async function lineTargetOf(organizationId: string, memberId: string, openChannel: OpenLineChannelForDelivery): Promise<LineTarget | null> {
  const channel = await readLineChannelPublic(organizationId)
  if (!channel?.active) return null
  const identity = await forTenant(organizationId).channelIdentity.findFirst({
    where: { memberId, channel: 'LINE', providerKey: channel.providerId, unlinkedAt: null },
    select: { externalUserId: true },
  })
  if (!identity) return null
  const opened = await openChannel(organizationId)
  if (!opened.ok) {
    if (opened.reason === 'SECRET_UNREADABLE') logger.error({ alert: true, organizationId }, 'LINE channel secrets do not open (ENCRYPTION_KEY changed?): notifications go by e-mail until the LINE settings are saved again')
    return null
  }
  return opened.channel.active ? { api: opened.channel.api, lineUserId: identity.externalUserId, liffId: opened.channel.liffId } : null
}

/**
 * LINE refused this recipient, and only this recipient: a 400 whose details name the property `to` (a user id LINE does
 * not take for this channel). A 403 is not counted: LINE documents it as a call the channel may not make, so it would
 * switch LINE off for every member who gets a notice while the channel is refused. Add LINE's own answer for a user who
 * blocked the account, or never added it, here once the real channel of D-03 shows it; until then the unfollow event
 * marks a block (BR-LINE-08).
 */
function recipientRefused(error: LineApiError): boolean {
  return error.reason === 'BAD_REQUEST' && error.details.some((d) => d.property === 'to')
}

/**
 * LINE's answer (429) once the month's push messages are used up, "You have reached your monthly limit.": no try
 * succeeds before next month, so the e-mail goes at once (FR-LINE-007 AC3 "โควตาหมด"). The text is the one LINE
 * documents, still to be checked on the real channel of D-03; a 429 without it is a rate limit, tried again with backoff,
 * so a different text only delays the e-mail to the give-up.
 */
const MONTHLY_LIMIT_MESSAGE = /monthly limit/i
/** LineTry.reason of a push refused because the month's quota is used up */
export const LINE_QUOTA_EXHAUSTED = 'QUOTA_EXHAUSTED'

type LineTry = { readonly ok: true } | { readonly ok: false; readonly permanent: boolean; readonly reason: string; readonly recipientRefused: boolean }

async function pushByLine(target: LineTarget, messages: readonly OutgoingLineMessage[], notificationId: string): Promise<LineTry> {
  try {
    // The retry key: LINE sends a push with this key once, however often it is tried (a 409 duplicate counts as sent)
    await target.api.pushMessage(target.lineUserId, messages, { retryKey: notificationId })
    return { ok: true }
  } catch (error) {
    if (!isLineApiError(error)) return { ok: false, permanent: true, reason: 'UNEXPECTED', recipientRefused: false }
    if (error.status === 429 && error.lineMessage !== null && MONTHLY_LIMIT_MESSAGE.test(error.lineMessage)) return { ok: false, permanent: true, reason: LINE_QUOTA_EXHAUSTED, recipientRefused: false }
    return { ok: false, permanent: error.permanent, reason: error.reason, recipientRefused: recipientRefused(error) }
  }
}

/** What a refusal for good says to whoever runs BCS: the channel's own trouble is an alert, a recipient's is not */
function logLineRefusal(log: typeof logger, pushed: { readonly reason: string; readonly recipientRefused: boolean }) {
  if (pushed.reason === 'UNAUTHORIZED') log.error({ alert: true, reason: pushed.reason }, 'LINE refused the channel access token: notifications go by e-mail until the LINE settings are fixed')
  else if (pushed.reason === 'FORBIDDEN') log.error({ alert: true, reason: pushed.reason }, 'LINE refused the push (403: a call the channel may not make): notifications go by e-mail; check the channel in LINE Developers Console')
  else if (pushed.reason === LINE_QUOTA_EXHAUSTED) log.error({ alert: true, reason: pushed.reason }, "LINE's push quota of the month is used up: notifications go by e-mail until next month or a bigger plan")
  else log.warn({ reason: pushed.reason, recipientRefused: pushed.recipientRefused }, 'LINE refused a notification; it goes by e-mail')
}

const escape = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)

/** The e-mail of a notification, in Thai and English, with an approval task's action link (FR-NOTI-002 AC1) */
async function emailOf(organizationId: string, n: { templateKey: string; data: unknown; subjectType: string | null; subjectId: string | null; recipientMemberId: string; email: string }, now: Date): Promise<EmailMessage> {
  const appUrl = getEnv().APP_URL.replace(/\/$/, '')
  const th = renderNotification(n, 'th')
  const en = renderNotification(n, 'en')
  const taskId = assignedTaskOf(n.templateKey, (n.data ?? {}) as Data)
  // FR-NOTI-002 AC1: an approval task's e-mail decides with its link (one use, 72 hours, BR-TOK-01)
  const token = taskId
    ? await forTenant(organizationId).actionToken.findFirst({ where: { taskId, memberId: n.recipientMemberId, channel: 'EMAIL', usedAt: null, revokedAt: null, expiresAt: { gt: now } }, select: { id: true } })
    : null
  const workspace = th.href ? `${appUrl}${th.href}` : appUrl
  const action = token ? `${appUrl}${emailLinkPath(token.id)}` : null
  const text = [
    th.title,
    ...(th.body ? [th.body] : []),
    '',
    ...(action ? [`พิจารณาจากลิงก์นี้ (ใช้ได้ครั้งเดียว): ${action}`] : []),
    `เปิดในระบบ: ${workspace}`,
    '',
    en.title,
    ...(en.body ? [en.body] : []),
    ...(action ? [`Decide with this link (one use): ${action}`] : []),
    `Open in BCS: ${workspace}`,
    '',
  ].join('\n')
  const link = (href: string, label: string) => `<a href="${escape(href)}">${escape(label)}</a>`
  const html = [
    '<div style="font-family: sans-serif; font-size: 15px; line-height: 1.6">',
    `<p><strong>${escape(th.title)}</strong></p>`,
    ...(th.body ? [`<p>${escape(th.body)}</p>`] : []),
    ...(action ? [`<p>${link(action, 'พิจารณาจากลิงก์นี้')} (ใช้ได้ครั้งเดียว)</p>`] : []),
    `<p>${link(workspace, 'เปิดในระบบ')}</p>`,
    '<hr style="border: none; border-top: 1px solid #ddd">',
    `<p style="color: #555">${escape(en.title)}${en.body ? ` — ${escape(en.body)}` : ''}</p>`,
    ...(action ? [`<p style="color: #555">${link(action, 'Decide with this link')} (one use)</p>`] : []),
    `<p style="color: #555">${link(workspace, 'Open in BCS')}</p>`,
    '</div>',
  ].join('\n')
  return { to: n.email, subject: th.title, text, html }
}

/**
 * The LINE message of a notification: an approval task's card, or the short text with its link. Null when the task of a
 * card closed after this try checked it: then nothing is sent (no text stands in for the card).
 */
async function lineMessageOf(organizationId: string, n: { templateKey: string; data: unknown; subjectType: string | null; subjectId: string | null; recipientMemberId: string }, target: LineTarget, now: Date): Promise<OutgoingLineMessage | null> {
  const data = (n.data ?? {}) as Data
  const cards = await cardContextOf(organizationId, target.liffId)
  const taskId = assignedTaskOf(n.templateKey, data)
  if (taskId) return approvalCardMessage(organizationId, { taskId, memberId: n.recipientMemberId, fallbackLabel: typeof data.label === 'string' ? data.label : '' }, now, cards)
  const rendered = renderNotification(n, cards.locale)
  return textNotice({ title: rendered.title, body: rendered.body, url: documentLink(cards, rendered.href) })
}

export async function deliverNotification(organizationId: string, notificationId: string, now: Date, options: DeliveryOptions = {}): Promise<DeliveryOutcome> {
  const db = forTenant(organizationId)
  const log = logger.child({ organizationId, notificationId })
  const n = await db.notification.findFirst({
    where: { id: notificationId },
    select: {
      id: true,
      templateKey: true,
      data: true,
      urgency: true,
      status: true,
      subjectType: true,
      subjectId: true,
      recipientMemberId: true,
      recipient: { select: { email: true, status: true, lineReachable: true } },
    },
  })
  if (!n) return { status: 'SKIPPED', why: 'NOT_FOUND' }
  if (n.urgency !== 'IMMEDIATE' || n.status !== 'PENDING') return { status: 'SKIPPED', why: n.status }
  const data = (n.data ?? {}) as Data
  // FR-NOTI-003 AC3: a notice about an approval task goes out only while the task still waits, checked at every try
  const about = taskNoticeOf(n.templateKey, data)
  if (about && !(await taskStillWaits(organizationId, about, n.recipientMemberId))) return settleTaskClosed(organizationId, n.id, now)
  const active = n.recipient.status === 'ACTIVE'

  // ---- LINE first, while it is still worth a try ----
  let lineFailed: string | undefined
  const tries = Math.max(1, options.lineTry ?? 1)
  const firstTryAt = options.firstLineTryAt ?? now
  const giveUpAt = firstTryAt.getTime() + LINE_DELIVERY_GIVE_UP_MS
  const lineDue = now.getTime() < giveUpAt && tries <= LINE_DELIVERY_MAX_TRIES
  const target =
    active && n.recipient.lineReachable && options.openChannel && goesByLine(n.templateKey, data) && lineDue ? await lineTargetOf(organizationId, n.recipientMemberId, options.openChannel) : null
  if (target) {
    // Everything is read before anything is sent: a failure here throws with nothing claimed, and the job tries again
    const message = await lineMessageOf(organizationId, n, target, now)
    // The card's task closed since the check above: no text stands in for it
    if (!message) return settleTaskClosed(organizationId, n.id, now)
    const pushed = await pushByLine(target, [message], n.id)
    if (pushed.ok) {
      await db.notification.updateMany({ where: { id: n.id, status: 'PENDING' }, data: { status: 'SENT', sentChannel: 'LINE', sentAt: now, error: null } })
      return { status: 'SENT', channel: 'LINE' }
    }
    if (!pushed.permanent) {
      const retryAt = Math.min(now.getTime() + LINE_DELIVERY_RETRY_BASE_MS * 2 ** (tries - 1), giveUpAt)
      if (tries < LINE_DELIVERY_MAX_TRIES && retryAt > now.getTime()) {
        log.warn({ reason: pushed.reason, tries }, 'LINE could not take a notification for now; it is tried again, and sent by e-mail if LINE stays unavailable')
        await db.notification.updateMany({ where: { id: n.id, status: 'PENDING', sentChannel: null }, data: { error: `LINE_${pushed.reason}` } })
        return { status: 'RETRY', channel: 'LINE', reason: pushed.reason, tries, firstTryAt: firstTryAt.toISOString(), retryAt: new Date(retryAt).toISOString() }
      }
    } else {
      logLineRefusal(log, pushed)
    }
    // A recipient LINE refuses by name is not tried again until they follow the account again (BR-LINE-08); a refusal of
    // the channel (401, 403, the month's quota) leaves every member reachable
    if (pushed.recipientRefused) await setLineReachable(organizationId, n.recipientMemberId, false)
    lineFailed = pushed.reason
  } else if (!lineDue && options.lastLineFailure) {
    // LINE's time is up (FR-LINE-007 AC3): the e-mail replaces it
    lineFailed = options.lastLineFailure
  }

  // ---- e-mail ----
  const email = active ? await emailOf(organizationId, { ...n, email: n.recipient.email }, now) : null
  // Claim: one run sends it
  const claimed = await db.notification.updateMany({ where: { id: n.id, status: 'PENDING', sentChannel: null }, data: { sentChannel: 'EMAIL' } })
  if (claimed.count !== 1) return { status: 'SKIPPED', why: 'CLAIMED' }
  if (!email) {
    await db.notification.update({ where: { id: n.id }, data: { status: 'FAILED', error: 'MEMBER_INACTIVE' } })
    return { status: 'FAILED', channel: 'EMAIL', code: 'MEMBER_INACTIVE' }
  }
  try {
    await getEmailProvider().send(email)
  } catch (error) {
    if (error instanceof EmailSendError && error.permanent) {
      await db.notification.update({ where: { id: n.id }, data: { status: 'FAILED', error: error.code } })
      return { status: 'FAILED', channel: 'EMAIL', code: error.code }
    }
    // Not reached: free the claim so the job's retry sends it
    await db.notification.update({ where: { id: n.id }, data: { sentChannel: null } })
    throw error
  }
  await db.notification.update({ where: { id: n.id }, data: { status: 'SENT', sentAt: now, ...(lineFailed ? { error: `LINE_${lineFailed}` } : {}) } })
  return lineFailed ? { status: 'SENT', channel: 'EMAIL', lineFailed } : { status: 'SENT', channel: 'EMAIL' }
}
