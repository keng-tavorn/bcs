// Which channels an IMMEDIATE notification goes by, in order, and what a push says (spec §4.7 rule 2, §10.1,
// BR-NOTI-05 to BR-NOTI-08, golden notification-route, S17-10). Pure: the caller reads the recipient and the
// organization, looks the push title up in the message files, and sends.
//
// The in-app bell always gets the notification (§4.7 rule 1), so IN_APP is never in the plan. A notification of a
// template that goes by LINE goes by push first when the organization has the BCS Go app on, the recipient turned
// "notifications in the app" on and has a device in use (OQ-165: push instead of LINE, LINE and e-mail after it);
// anything else goes as before: LINE when linked and reachable, then e-mail. A DIGEST notification waits for the daily
// summary, which never goes by push (BR-NOTI-08).

export type DeliveryChannel = 'PUSH' | 'LINE' | 'EMAIL'

export interface NotificationFacts {
  readonly templateKey: string
  readonly data: Readonly<Record<string, unknown>>
  readonly urgency: 'IMMEDIATE' | 'DIGEST'
}

export interface RecipientFacts {
  /** A live LINE link of the recipient under the organization's channel */
  readonly lineLinked: boolean
  /** The organization's LINE channel is on (LineChannelConfig.active) and the organization may send by LINE */
  readonly lineActive: boolean
  /** LINE still reaches the recipient (Member.lineReachable, BR-LINE-08) */
  readonly lineReachable: boolean
  /** The recipient turned "notifications in the app" on (Member.notificationPrefs.appPush, OQ-165) */
  readonly appPush: boolean
  /** Devices of the recipient in use (PushDevice with revokedAt null) */
  readonly activeDevices: number
  /** The organization may send push: module BCS_GO on, not a UAT sandbox (BR-APP-13, BR-UAT-01), a push provider set */
  readonly bcsGo: boolean
}

export interface DeliveryPlan {
  /** In the order they are tried; empty for a DIGEST notification */
  readonly channels: readonly DeliveryChannel[]
  /** The notification waits for the daily summary */
  readonly digest: boolean
}

/** The daily summary: a LINE template that never goes by push (BR-NOTI-05, BR-NOTI-08) */
export const DIGEST_TEMPLATE = 'digest.daily'

/**
 * The template goes by LINE: one of the §10.1 rows whose channel is LINE (lineTemplates), except task.escalated to
 * ORG_ADMIN when nobody is left to escalate to, which is an administrator's notice and goes by e-mail only
 */
export function goesByLine(templateKey: string, data: Readonly<Record<string, unknown>>, lineTemplates: ReadonlySet<string>): boolean {
  return lineTemplates.has(templateKey) && !(templateKey === 'task.escalated' && data.role === 'ADMIN')
}

/** BR-NOTI-05: push goes with the templates LINE takes, never with the daily summary */
export function goesByPush(templateKey: string, data: Readonly<Record<string, unknown>>, lineTemplates: ReadonlySet<string>): boolean {
  return templateKey !== DIGEST_TEMPLATE && goesByLine(templateKey, data, lineTemplates)
}

export function planDelivery(n: NotificationFacts, r: RecipientFacts, lineTemplates: ReadonlySet<string>): DeliveryPlan {
  if (n.urgency === 'DIGEST') return { channels: [], digest: true }
  const channels: DeliveryChannel[] = []
  if (goesByPush(n.templateKey, n.data, lineTemplates) && r.bcsGo && r.appPush && r.activeDevices > 0) channels.push('PUSH')
  if (goesByLine(n.templateKey, n.data, lineTemplates) && r.lineActive && r.lineLinked && r.lineReachable) channels.push('LINE')
  channels.push('EMAIL')
  return { channels, digest: false }
}

export interface PushMessage {
  readonly title: string
  /** The document's number only, or nothing (BR-NOTI-06) */
  readonly body: string | null
  /** What the app reads when the push is tapped: the notification and the page inside the app */
  readonly data: { readonly notificationId?: string; readonly path: string | null }
}

const DOCUMENT_NUMBER = /^[\p{L}\p{N}][\p{L}\p{N}/._-]{0,63}$/u

/**
 * BR-NOTI-06: what a push shows on a locked screen. The title is the template's own words (the caller's lookup of
 * push.<templateKey>.title, or the general words when the template has none); the body is the document's number from
 * data.number and nothing else — never its title, an amount, a person, a supplier, an item or an account. A value
 * that does not look like a document number (spaces, digits grouped like money) is left out rather than shown.
 */
export function pushMessage(input: { readonly title: string; readonly data: Readonly<Record<string, unknown>>; readonly path: string | null; readonly notificationId?: string }): PushMessage {
  const number = typeof input.data.number === 'string' && DOCUMENT_NUMBER.test(input.data.number) ? input.data.number : null
  return { title: input.title, body: number, data: { ...(input.notificationId ? { notificationId: input.notificationId } : {}), path: input.path } }
}

/** What one device's answer to a push means (BR-NOTI-07) */
export type PushAnswer = 'SENT' | 'UNREGISTERED' | 'INVALID_TOKEN' | 'AUTH_401' | 'AUTH_403' | 'QUOTA_429' | 'SERVER_503' | 'NETWORK'

export type PushAction = 'DONE' | 'REVOKE_DEVICE_TRY_NEXT' | 'ALERT_NEXT_CHANNEL' | 'RETRY'

/**
 * BR-NOTI-07: a device FCM no longer knows, or a token it cannot read, is revoked and the next device is tried; a
 * refusal of BCS's own credentials (401, 403) is BCS's trouble, not the recipient's: an alert, and the next channel at
 * once; a quota, a server error or no connection is tried again until the push's time is up.
 */
export function pushAnswerAction(answer: PushAnswer): PushAction {
  switch (answer) {
    case 'SENT':
      return 'DONE'
    case 'UNREGISTERED':
    case 'INVALID_TOKEN':
      return 'REVOKE_DEVICE_TRY_NEXT'
    case 'AUTH_401':
    case 'AUTH_403':
      return 'ALERT_NEXT_CHANNEL'
    case 'QUOTA_429':
    case 'SERVER_503':
    case 'NETWORK':
      return 'RETRY'
  }
}
