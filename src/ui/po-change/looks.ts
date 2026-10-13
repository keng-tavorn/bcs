import type { BadgeLook } from '../document/badge-looks'

// The status badges of a PO's tier-2 invoices and of its changes (§9.10 ป้ายสถานะ: a light background with its ink, an
// icon and a word, never colour alone): drafts and cancelled neutral, waiting and mismatches warn, approved and ready ok,
// paid or in a payment run info, rejected danger.

export const AP_INVOICE_BADGES: Readonly<Record<string, BadgeLook>> = {
  DRAFT: { tone: 'neutral', icon: 'FilePen' },
  EXCEPTION: { tone: 'warn', icon: 'AlarmClock' },
  PENDING_APPROVAL: { tone: 'warn', icon: 'Clock' },
  READY_FOR_PAYMENT: { tone: 'ok', icon: 'CircleCheck' },
  IN_PAYMENT_RUN: { tone: 'info', icon: 'Wallet' },
  PAID: { tone: 'ok', icon: 'CircleCheckBig' },
  REJECTED: { tone: 'danger', icon: 'CircleX' },
  CANCELLED: { tone: 'neutral', icon: 'Ban' },
}

export const PO_CHANGE_BADGES: Readonly<Record<string, BadgeLook>> = {
  DRAFT: { tone: 'neutral', icon: 'FilePen' },
  PENDING_APPROVAL: { tone: 'warn', icon: 'Clock' },
  APPROVED: { tone: 'ok', icon: 'CircleCheck' },
  REJECTED: { tone: 'danger', icon: 'CircleX' },
  CANCELLED: { tone: 'neutral', icon: 'Ban' },
}
