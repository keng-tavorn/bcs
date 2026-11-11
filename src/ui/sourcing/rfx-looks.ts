import type { BadgeLook } from '../document/badge-looks'

// The status badges of an RFx and of an invite (S10-12 · §9.10: a light colour with an icon and the word, never colour
// alone). Data only, so a server page and a client form read the same table.

export const RFX_STATUSES = ['DRAFT', 'OPEN', 'CLOSED', 'EVALUATING', 'AWARDED', 'CONCLUDED', 'CANCELLED'] as const
export type RfxStatusKey = (typeof RFX_STATUSES)[number]

export const RFX_STATUS_LOOK: Readonly<Record<RfxStatusKey, BadgeLook>> = {
  DRAFT: { tone: 'neutral', icon: 'FilePen' },
  OPEN: { tone: 'info', icon: 'Send' },
  CLOSED: { tone: 'warn', icon: 'Lock' },
  EVALUATING: { tone: 'warn', icon: 'Hourglass' },
  AWARDED: { tone: 'ok', icon: 'CircleCheck' },
  CONCLUDED: { tone: 'ok', icon: 'CircleCheckBig' },
  CANCELLED: { tone: 'danger', icon: 'Ban' },
}

export const isRfxStatus = (v: string): v is RfxStatusKey => (RFX_STATUSES as readonly string[]).includes(v)

export const RFX_KINDS = ['RFQ', 'RFP', 'RFI'] as const
export type RfxKindKey = (typeof RFX_KINDS)[number]
export const isRfxKind = (v: string): v is RfxKindKey => (RFX_KINDS as readonly string[]).includes(v)

export const INVITE_STATUSES = ['INVITED', 'VIEWED', 'DECLINED', 'BID_SUBMITTED', 'WITHDRAWN', 'EXPIRED', 'REMOVED'] as const
export type InviteStatusKey = (typeof INVITE_STATUSES)[number]

export const INVITE_STATUS_LOOK: Readonly<Record<InviteStatusKey, BadgeLook>> = {
  INVITED: { tone: 'neutral', icon: 'Send' },
  VIEWED: { tone: 'info', icon: 'CircleDot' },
  DECLINED: { tone: 'danger', icon: 'CircleX' },
  BID_SUBMITTED: { tone: 'ok', icon: 'CircleCheck' },
  WITHDRAWN: { tone: 'warn', icon: 'Undo2' },
  EXPIRED: { tone: 'neutral', icon: 'AlarmClock' },
  REMOVED: { tone: 'neutral', icon: 'Ban' },
}

export const isInviteStatus = (v: string): v is InviteStatusKey => (INVITE_STATUSES as readonly string[]).includes(v)
