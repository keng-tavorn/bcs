import { getLineClient, type LineChannelApi } from '@/integrations/line'
import { readLineChannelStored, type LineChannelPublicDto } from '@/server/queries/line-channel'
import { openLineSecret } from './secrets'

// The organization's LINE channel opened for the server's own work: the webhook checks x-line-signature with the
// channel secret (BR-LINE-03, S5-02), the senders push and reply with the access token (S5-05, S5-08) and the rich menu
// command calls LINE (S5-04). The caller is a system path that already knows the organization (the webhook finds it by
// the channelKey of its URL), so nothing here checks a capability — and nothing here may reach a screen, a log or an
// event: the secret is in clear.

export interface OpenedLineChannel extends LineChannelPublicDto {
  readonly organizationId: string
  /** For x-line-signature only (BR-LINE-03); never log it, store it elsewhere or send it anywhere */
  readonly channelSecret: string
  /** The Messaging API of this channel, authorized with its access token */
  readonly api: LineChannelApi
}

export type OpenLineChannelResult =
  | { readonly ok: true; readonly channel: OpenedLineChannel }
  /** NOT_CONFIGURED: no LineChannelConfig · SECRET_UNREADABLE: the stored secret or token does not open (ENCRYPTION_KEY changed) */
  | { readonly ok: false; readonly reason: 'NOT_CONFIGURED' | 'SECRET_UNREADABLE' }

export async function openLineChannel(organizationId: string): Promise<OpenLineChannelResult> {
  const stored = await readLineChannelStored(organizationId)
  if (!stored) return { ok: false, reason: 'NOT_CONFIGURED' }
  const channelSecret = openLineSecret(organizationId, 'channelSecret', stored.sealed.channelSecret)
  const accessToken = openLineSecret(organizationId, 'channelAccessToken', stored.sealed.channelAccessToken)
  if (channelSecret === null || accessToken === null) return { ok: false, reason: 'SECRET_UNREADABLE' }
  return {
    ok: true,
    channel: {
      organizationId,
      channelKey: stored.channelKey,
      active: stored.active,
      providerId: stored.providerId,
      messagingChannelId: stored.messagingChannelId,
      liffId: stored.liffId,
      liffChannelId: stored.liffChannelId,
      richMenuLinkedId: stored.richMenuLinkedId,
      richMenuUnlinkedId: stored.richMenuUnlinkedId,
      channelSecret,
      api: getLineClient().channel(accessToken),
    },
  }
}
