import { satangToAmount } from '@/core/money/dto'
import type { BadgeLook } from '../document/badge-looks'

// The look of a risk override's state (S11-08 · §9.10 ป้ายสถานะ): a light background with its ink, an icon and a word —
// never colour alone (NFR-A11Y-03). Asked and returned wait for the requester, sent waits for the approvers, approved lets
// POs out, the rest are over.

export type OverrideStatus = 'DRAFT' | 'PENDING_APPROVAL' | 'APPROVED' | 'REJECTED' | 'RETURNED' | 'CANCELLED' | 'EXPIRED'

export const OVERRIDE_BADGES: Readonly<Record<OverrideStatus, BadgeLook>> = {
  DRAFT: { tone: 'neutral', icon: 'FilePen' },
  PENDING_APPROVAL: { tone: 'warn', icon: 'Hourglass' },
  APPROVED: { tone: 'ok', icon: 'CircleCheck' },
  REJECTED: { tone: 'danger', icon: 'CircleX' },
  RETURNED: { tone: 'warn', icon: 'Undo2' },
  CANCELLED: { tone: 'neutral', icon: 'Ban' },
  EXPIRED: { tone: 'neutral', icon: 'Clock' },
}

/** Baht with two decimals from satang, as a form field holds it ("120000.00"): the money I/O format of core */
export const bahtField = satangToAmount
