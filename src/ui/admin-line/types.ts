// What the page /admin/line and its server actions exchange (FR-ADM-006 AC2 AC3): the saved channel as the screen shows
// it — of the channel secret and the access token only whether each is set (ADR-045 item 2) — and the answers of the
// save, the connection test and the rich-menu button, with the parts of `details` the page explains in its own words
// (§9.9 rule 7). Never a secret, never the raw message.

export interface SecretStatusView {
  readonly set: boolean
  /** The saved value still opens on the server; false: enter it again */
  readonly readable: boolean
}

export interface LineChannelView {
  readonly configured: boolean
  /** What LINE must call (APP_URL/api/webhooks/line/<channelKey>); null before the first save */
  readonly webhookUrl: string | null
  readonly providerId: string
  readonly messagingChannelId: string
  readonly channelSecret: SecretStatusView
  readonly channelAccessToken: SecretStatusView
  readonly liffId: string
  readonly liffChannelId: string
  readonly active: boolean
  /** Both rich menus are stored */
  readonly richMenus: boolean
  /** Sent back as expectedVersion with the next save; null before the first */
  readonly version: number | null
}

export interface LineChannelInputView {
  readonly providerId: string
  readonly messagingChannelId: string
  /** Empty: keep the saved value */
  readonly channelSecret: string
  /** Empty: keep the saved value */
  readonly channelAccessToken: string
  /** Empty: remove */
  readonly liffId: string
  /** Empty: remove */
  readonly liffChannelId: string
  readonly active: boolean
  readonly expectedVersion: number | null
}

export interface LineAdminFailure {
  readonly ok: false
  readonly code: string
  readonly field?: string
  readonly reason?: string
  /** PROVIDER_IN_USE: members still linked */
  readonly linked?: number
  /** LINE's HTTP status when LINE refused */
  readonly status?: string
  readonly requestId?: string
  /** CONFLICT_VERSION: the channel as it is saved now, for the page to show */
  readonly view?: LineChannelView
}

export type SaveLineChannelOutcome = { readonly ok: true; readonly view: LineChannelView } | LineAdminFailure

export interface ConnectionCheckView {
  readonly id: string
  readonly passed: boolean
  readonly title: string
  /** What the check found and, when it failed, how to fix it — in the reader's language */
  readonly message: string
}

export type ConnectionTestOutcome = { readonly ok: true; readonly passed: boolean; readonly checks: readonly ConnectionCheckView[] } | LineAdminFailure

export interface RichMenusResultView {
  readonly relinked: number
  readonly relinkRefused: number
  readonly relinkFailed: number
  readonly defaultSet: boolean
}

export type RichMenusOutcome = ({ readonly ok: true; readonly view: LineChannelView } & RichMenusResultView) | LineAdminFailure

export type SaveLineChannelAction = (input: LineChannelInputView, idempotencyKey: string) => Promise<SaveLineChannelOutcome>
export type TestLineConnectionAction = () => Promise<ConnectionTestOutcome>
export type ReplaceRichMenusAction = (idempotencyKey: string) => Promise<RichMenusOutcome>

/** The form's fields, in the order the page shows them */
export const LINE_CHANNEL_FIELDS = ['providerId', 'messagingChannelId', 'channelSecret', 'channelAccessToken', 'liffId', 'liffChannelId', 'active'] as const
export type LineChannelField = (typeof LINE_CHANNEL_FIELDS)[number]

export function isLineChannelField(value: unknown): value is LineChannelField {
  return typeof value === 'string' && (LINE_CHANNEL_FIELDS as readonly string[]).includes(value)
}

type CommonKey = 'UNAUTHENTICATED' | 'FORBIDDEN' | 'NOT_FOUND' | 'BUSY' | 'CONFLICT' | 'INPUT' | 'INTERNAL' | 'FAILED'

/** Message key under adminSettings.errors for a failure no part of the page explains in its own words */
export function commonLineErrorKey(failure: LineAdminFailure): CommonKey {
  switch (failure.code) {
    case 'UNAUTHENTICATED':
    case 'FORBIDDEN':
    case 'NOT_FOUND':
    case 'INTERNAL':
      return failure.code
    case 'RATE_LIMITED':
      return 'BUSY'
    case 'IDEMPOTENCY_CONFLICT':
      return 'CONFLICT'
    case 'VALIDATION_FAILED':
      return 'INPUT'
    default:
      return 'FAILED'
  }
}

export type RichMenuErrorKey = 'NOT_CONFIGURED' | 'LIFF_REQUIRED' | 'TOKEN_UNREADABLE' | 'IMAGES' | 'LINE' | 'CONFLICT'

/** Message key under lineSettings.richMenus.errors for a refused rich-menu run, or null for a common failure */
export function richMenuErrorKey(failure: LineAdminFailure): RichMenuErrorKey | null {
  if (failure.code === 'CONFLICT_VERSION') return 'CONFLICT'
  if (failure.code === 'EXTERNAL_SERVICE_ERROR') return 'LINE'
  if (failure.code !== 'VALIDATION_FAILED') return null
  if (failure.field === 'channel') return 'NOT_CONFIGURED'
  if (failure.field === 'liffId') return 'LIFF_REQUIRED'
  if (failure.field === 'channelAccessToken') return 'TOKEN_UNREADABLE'
  if (failure.field === 'images' || failure.field?.startsWith('images.')) return 'IMAGES'
  return null
}
