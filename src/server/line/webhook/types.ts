import type { LineChannelApi } from '@/integrations/line'
import type { Clock } from '@/lib/clock'
import type { StoredLineEvent } from './body'

// Shapes shared by the parts of the webhook. The channel comes opened from src/server/services/line-channel
// (openLineChannel): src/server/line may not import services (eslint.config.mjs), so the composition in
// src/server/jobs/line-webhook.ts passes the opener in.

/** What processing needs of the organization's LINE channel; openLineChannel's channel has all of it */
export interface LineWebhookChannel {
  readonly organizationId: string
  readonly channelKey: string
  /** LineChannelConfig.active: LINE is in use in this organization */
  readonly active: boolean
  /** ChannelIdentity.providerKey of every live link: LINE user ids differ per provider (§9.2) */
  readonly providerId: string
  readonly liffId: string | null
  /** For x-line-signature only (BR-LINE-03): never logged, stored or sent anywhere */
  readonly channelSecret: string
  readonly api: LineChannelApi
}

export type OpenLineWebhookChannelResult =
  | { readonly ok: true; readonly channel: LineWebhookChannel }
  | { readonly ok: false; readonly reason: 'NOT_CONFIGURED' | 'SECRET_UNREADABLE' }

/** openLineChannel of src/server/services/line-channel */
export type OpenLineWebhookChannel = (organizationId: string) => Promise<OpenLineWebhookChannelResult>

/** A LineWebhookEvent row as processing reads it */
export interface RecordedLineEvent {
  readonly id: string
  readonly organizationId: string
  readonly webhookEventId: string
  readonly type: string
  readonly payload: StoredLineEvent
  /** When BCS received the webhook: a reply token works for LINE_REPLY_TOKEN_TTL_MS after this */
  readonly receivedAt: Date
}

/**
 * INLINE: while the webhook waits for its answer (BR-LINE-05), so a reply token is fresh. QUEUED: in the line-webhook
 * job, maybe after the reply token expired, so a handler that must tell the user something pushes instead.
 */
export type LineEventPath = 'INLINE' | 'QUEUED'

export interface LineEventContext {
  /** When processing of this event started (real time; tests give their own): the time its outcome is recorded with */
  readonly now: Date
  /**
   * The time as it goes on: read it again where the moment matters — a reply token works for LINE_REPLY_TOKEN_TTL_MS
   * after receivedAt, and a handler that ran a command first may be past it by the time it answers (then it pushes)
   */
  readonly clock: Clock
  readonly path: LineEventPath
}

/**
 * How processing of one event ended; written to LineWebhookEvent.status. `reason` is a short code for the row's error
 * column (never personal data): why it was skipped or failed, or what went wrong around a processed event (a reply LINE
 * did not take).
 */
export type LineEventOutcome =
  | { readonly status: 'PROCESSED'; readonly reason?: string }
  | { readonly status: 'SKIPPED'; readonly reason: string }
  | { readonly status: 'FAILED'; readonly reason: string }
