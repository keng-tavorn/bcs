import type { AppError } from '@/core/result'
import type { CommandFailure } from '../_pipeline'

// Why linking or unlinking LINE is refused when the request itself is fine (FR-LINE-001): INVALID_STATE_TRANSITION
// (409) with details.reason, which the screens and the LIFF page turn into words (they never show `message`).
//  - LINE_NOT_ENABLED: the organization has no LINE channel saved, switched on and with the LIFF app of this
//    environment (ADR-024), or the organization is not active: an ORG_ADMIN sets it up on /admin/line
//  - ALREADY_LINKED: this member is linked to this very LINE account already
//  - ACCOUNT_LINKED_TO_ANOTHER_MEMBER: this LINE account is linked to another member of the organization (AC3: one
//    member per LINE account); that member unlinks first
//  - MEMBER_LINKED_TO_ANOTHER_ACCOUNT: this member is linked to another LINE account (one live link per member); they
//    unlink it first from /settings/line or from that LINE account
//  - NOT_LINKED: there is no live link to end

export const LINE_LINK_REFUSALS = ['LINE_NOT_ENABLED', 'ALREADY_LINKED', 'ACCOUNT_LINKED_TO_ANOTHER_MEMBER', 'MEMBER_LINKED_TO_ANOTHER_ACCOUNT', 'NOT_LINKED'] as const
export type LineLinkRefusal = (typeof LINE_LINK_REFUSALS)[number]

const MESSAGES: Readonly<Record<LineLinkRefusal, string>> = {
  LINE_NOT_ENABLED: 'LINE is not set up for this organization',
  ALREADY_LINKED: 'this LINE account is linked to this member already',
  ACCOUNT_LINKED_TO_ANOTHER_MEMBER: 'this LINE account is linked to another member of the organization',
  MEMBER_LINKED_TO_ANOTHER_ACCOUNT: 'this member is linked to another LINE account',
  NOT_LINKED: 'no LINE account is linked',
}

export function lineLinkRefusal(reason: LineLinkRefusal): AppError {
  return { code: 'INVALID_STATE_TRANSITION', message: MESSAGES[reason], details: { reason } }
}

export function refusedCommand(reason: LineLinkRefusal): CommandFailure {
  return { ok: false, error: lineLinkRefusal(reason) }
}
