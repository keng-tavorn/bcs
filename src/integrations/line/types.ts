// Shapes of the LINE Messaging API that BCS uses (developers.line.biz/en/reference/messaging-api/), as the client
// returns them. Only the fields BCS reads are typed; LINE may add others.

export interface LineCallOptions {
  /** Aborts the call (the webhook's inline budget, BR-LINE-05) */
  readonly signal?: AbortSignal
  /** Overrides the default time limit of this kind of call */
  readonly timeoutMs?: number
}

export interface LineSentMessage {
  readonly id: string
  readonly quoteToken: string | null
}

export interface LineSendResult {
  readonly sentMessages: readonly LineSentMessage[]
  /**
   * The push carried a retry key LINE had already accepted (409 with x-line-accepted-request-id): the messages went out
   * with the earlier request and were not sent again.
   */
  readonly duplicate: boolean
  /** x-line-request-id of the request that sent the messages (the earlier one for a duplicate) */
  readonly requestId: string | null
}

export interface LinePushOptions extends LineCallOptions {
  /** X-Line-Retry-Key: a UUID; LINE sends a push with the same key once, however often it is retried */
  readonly retryKey?: string
  readonly notificationDisabled?: boolean
}

export interface LineReplyOptions extends LineCallOptions {
  readonly notificationDisabled?: boolean
}

export interface LineBotInfo {
  readonly userId: string
  readonly basicId: string
  readonly premiumId: string | null
  readonly displayName: string
  readonly pictureUrl: string | null
  readonly chatMode: string
  readonly markAsReadMode: string
}

export interface LineWebhookEndpoint {
  /** The webhook URL set at LINE; empty when none is set */
  readonly endpoint: string
  /** "Use webhook" is on */
  readonly active: boolean
}

/** LINE's test of a webhook URL: LINE sends a signed webhook with no events and reports the answer */
export interface LineWebhookTestResult {
  readonly success: boolean
  readonly timestamp: string
  /** HTTP status the endpoint answered with (0 when LINE got no answer) */
  readonly statusCode: number
  /** OK · COULD_NOT_CONNECT · REQUEST_TIMEOUT · ERROR_STATUS_CODE · UNCLASSIFIED */
  readonly reason: string
  readonly detail: string
}

export interface LineRichMenuBounds {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

export interface LineRichMenuArea {
  readonly bounds: LineRichMenuBounds
  readonly action: { readonly type: string } & Readonly<Record<string, unknown>>
}

export interface LineRichMenu {
  readonly size: { readonly width: number; readonly height: number }
  readonly selected: boolean
  readonly name: string
  readonly chatBarText: string
  readonly areas: readonly LineRichMenuArea[]
}

export interface LineRichMenuWithId extends LineRichMenu {
  readonly richMenuId: string
}

export type LineRichMenuImageType = 'image/png' | 'image/jpeg'
