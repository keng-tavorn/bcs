import type { LineChannelSettingsDto } from '@/server/queries/line-channel'
import type { LineChannelView } from '@/ui/admin-line/types'

/** The saved channel as /admin/line shows it: of the two secrets only whether each is set (the DTO has nothing more) */
export function toLineChannelView(dto: LineChannelSettingsDto): LineChannelView {
  return {
    configured: dto.configured,
    webhookUrl: dto.webhookUrl,
    providerId: dto.providerId ?? '',
    messagingChannelId: dto.messagingChannelId ?? '',
    channelSecret: { set: dto.channelSecret.set, readable: dto.channelSecret.readable },
    channelAccessToken: { set: dto.channelAccessToken.set, readable: dto.channelAccessToken.readable },
    liffId: dto.liffId ?? '',
    liffChannelId: dto.liffChannelId ?? '',
    active: dto.active,
    richMenus: dto.richMenuLinkedId !== null && dto.richMenuUnlinkedId !== null,
    version: dto.version,
  }
}
