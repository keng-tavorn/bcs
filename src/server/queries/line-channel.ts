import { getEnv } from '@/lib/env'
import { forTenant } from '@/server/db/tenant'

// The organization's LINE channel (LineChannelConfig, §6.2, FR-ADM-006 AC2). Read-only. The channel secret and the
// access token stay sealed here: a query cannot open them (src/server/crypto is not a layer queries may use, §4.10). The
// service that has checked admin.channels passes the function that opens them (src/server/services/line-channel), only
// to learn whether each still opens: the settings screen gets whether each one is set — never a character of either
// (ADR-045 item 2: even the last 4 characters of the secret give away 16 of its 128 bits).

/** LineChannelConfig.channelKey: 24 base64url characters (src/server/crypto/random-key.ts) */
export const LINE_CHANNEL_KEY_PATTERN = /^[A-Za-z0-9_-]{24}$/
/** The webhook route of a channel: /api/webhooks/line/<channelKey> (§9.1, S5-02) */
export const LINE_WEBHOOK_PATH_PREFIX = '/api/webhooks/line/'

export function lineWebhookPath(channelKey: string): string {
  return `${LINE_WEBHOOK_PATH_PREFIX}${encodeURIComponent(channelKey)}`
}

/** The webhook URL to register at LINE: APP_URL (without a trailing slash) + the channel's route */
export function lineWebhookUrl(appUrl: string, channelKey: string): string {
  return `${appUrl.replace(/\/+$/, '')}${lineWebhookPath(channelKey)}`
}

export type LineSecretField = 'channelSecret' | 'channelAccessToken'

/** The stored row; the two secrets as sealed text (v1.<key id>.…), for services only — never for a screen. */
export interface LineChannelStored {
  readonly id: string
  readonly channelKey: string
  readonly providerId: string
  readonly messagingChannelId: string
  readonly sealed: Readonly<Record<LineSecretField, string>>
  readonly liffId: string | null
  readonly liffChannelId: string | null
  readonly richMenuLinkedId: string | null
  readonly richMenuUnlinkedId: string | null
  readonly active: boolean
  readonly version: number
  readonly updatedAt: Date
}

export async function readLineChannelStored(organizationId: string): Promise<LineChannelStored | null> {
  const row = await forTenant(organizationId).lineChannelConfig.findFirst({
    select: {
      id: true,
      channelKey: true,
      providerId: true,
      messagingChannelId: true,
      channelSecretEnc: true,
      channelAccessTokenEnc: true,
      liffId: true,
      liffChannelId: true,
      richMenuLinkedId: true,
      richMenuUnlinkedId: true,
      active: true,
      version: true,
      updatedAt: true,
    },
  })
  if (!row) return null
  const { channelSecretEnc, channelAccessTokenEnc, ...rest } = row
  return { ...rest, sealed: { channelSecret: channelSecretEnc, channelAccessToken: channelAccessTokenEnc } }
}

/** Opens a sealed secret of this organization's channel; null when it cannot be opened (e.g. ENCRYPTION_KEY changed). */
export type LineSecretOpener = (field: LineSecretField, sealed: string) => string | null

/** What the settings screen learns about a write-only secret: whether it is set, never any character of it */
export interface LineSecretStatusDto {
  /** A value is stored */
  readonly set: boolean
  /** The stored value opens with the current ENCRYPTION_KEY; when false the admin enters it again */
  readonly readable: boolean
}

export interface LineChannelSettingsDto {
  readonly configured: boolean
  readonly channelKey: string | null
  /** What the admin pastes into LINE Developers Console → Messaging API → Webhook URL */
  readonly webhookUrl: string | null
  readonly providerId: string | null
  readonly messagingChannelId: string | null
  readonly channelSecret: LineSecretStatusDto
  readonly channelAccessToken: LineSecretStatusDto
  readonly liffId: string | null
  readonly liffChannelId: string | null
  readonly richMenuLinkedId: string | null
  readonly richMenuUnlinkedId: string | null
  readonly active: boolean
  /** Sent back as expectedVersion when saving (CONFLICT_VERSION when someone saved in between) */
  readonly version: number | null
  readonly updatedAt: string | null
}

const NOT_SET: LineSecretStatusDto = { set: false, readable: true }

/**
 * The settings screen's view (FR-ADM-006 AC2): every field but the two secrets, of which only whether each is set and
 * still opens. The caller checked admin.channels.
 */
export async function readLineChannelSettings(organizationId: string, open: LineSecretOpener, appUrl: string = getEnv().APP_URL): Promise<LineChannelSettingsDto> {
  const stored = await readLineChannelStored(organizationId)
  if (!stored) {
    return {
      configured: false,
      channelKey: null,
      webhookUrl: null,
      providerId: null,
      messagingChannelId: null,
      channelSecret: NOT_SET,
      channelAccessToken: NOT_SET,
      liffId: null,
      liffChannelId: null,
      richMenuLinkedId: null,
      richMenuUnlinkedId: null,
      active: false,
      version: null,
      updatedAt: null,
    }
  }
  // Opened only to tell whether it still opens; the value itself goes no further than this line
  const status = (field: LineSecretField): LineSecretStatusDto => ({ set: true, readable: open(field, stored.sealed[field]) !== null })
  return {
    configured: true,
    channelKey: stored.channelKey,
    webhookUrl: lineWebhookUrl(appUrl, stored.channelKey),
    providerId: stored.providerId,
    messagingChannelId: stored.messagingChannelId,
    channelSecret: status('channelSecret'),
    channelAccessToken: status('channelAccessToken'),
    liffId: stored.liffId,
    liffChannelId: stored.liffChannelId,
    richMenuLinkedId: stored.richMenuLinkedId,
    richMenuUnlinkedId: stored.richMenuUnlinkedId,
    active: stored.active,
    version: stored.version,
    updatedAt: stored.updatedAt.toISOString(),
  }
}

/** What LIFF pages, cards and senders need to know about the channel, without any secret; null when not set up. */
export interface LineChannelPublicDto {
  readonly channelKey: string
  readonly active: boolean
  readonly providerId: string
  readonly messagingChannelId: string
  readonly liffId: string | null
  readonly liffChannelId: string | null
  readonly richMenuLinkedId: string | null
  readonly richMenuUnlinkedId: string | null
}

export async function readLineChannelPublic(organizationId: string): Promise<LineChannelPublicDto | null> {
  const stored = await readLineChannelStored(organizationId)
  if (!stored) return null
  return {
    channelKey: stored.channelKey,
    active: stored.active,
    providerId: stored.providerId,
    messagingChannelId: stored.messagingChannelId,
    liffId: stored.liffId,
    liffChannelId: stored.liffChannelId,
    richMenuLinkedId: stored.richMenuLinkedId,
    richMenuUnlinkedId: stored.richMenuUnlinkedId,
  }
}
