import type { LineChannelInputView, LineChannelView } from './types'

// The form of /admin/line as typed (FR-ADM-006 AC2) and what a save sends of it. Every value is sent trimmed, and the
// form compares what it would send with what is saved: a space typed after a value is no change, so it never holds the
// connection test and the rich menus back as "not saved yet". The two secrets start empty — the page never has them —
// and empty keeps what is saved.

export interface LineChannelDraft {
  readonly providerId: string
  readonly messagingChannelId: string
  readonly channelSecret: string
  readonly channelAccessToken: string
  readonly liffId: string
  readonly liffChannelId: string
  readonly active: boolean
}

/** The form as it starts from what is saved: the secrets empty */
export const draftOf = (view: LineChannelView): LineChannelDraft => ({
  providerId: view.providerId,
  messagingChannelId: view.messagingChannelId,
  channelSecret: '',
  channelAccessToken: '',
  liffId: view.liffId,
  liffChannelId: view.liffChannelId,
  active: view.active,
})

/** What a save of this form sends, against the version the page shows */
export function saveInputOf(draft: LineChannelDraft, expectedVersion: number | null): LineChannelInputView {
  return {
    providerId: draft.providerId.trim(),
    messagingChannelId: draft.messagingChannelId.trim(),
    channelSecret: draft.channelSecret.trim(),
    channelAccessToken: draft.channelAccessToken.trim(),
    liffId: draft.liffId.trim(),
    liffChannelId: draft.liffChannelId.trim(),
    active: draft.active,
    expectedVersion,
  }
}

/** The save would change something: what it would send differs from what is saved, or a secret is typed */
export function isDirty(draft: LineChannelDraft, view: LineChannelView): boolean {
  const sent = saveInputOf(draft, view.version)
  return (
    sent.channelSecret !== '' ||
    sent.channelAccessToken !== '' ||
    sent.providerId !== view.providerId ||
    sent.messagingChannelId !== view.messagingChannelId ||
    sent.liffId !== view.liffId ||
    sent.liffChannelId !== view.liffChannelId ||
    sent.active !== view.active
  )
}
