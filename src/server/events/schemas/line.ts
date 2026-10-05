import { z } from 'zod'
import { defineEvents } from '../registry'

// The LINE link of a member (spec §10.2 "ช่องทาง", FR-LINE-001, §9.2). The aggregate is the ChannelIdentity row: one row
// per link, kept with unlinkedAt when it ends, so the history of every link stays. The data names the member and never
// the LINE user id, the link code or the ID token (NFR-SEC-09): the row holds the LINE user id for the system's own
// work, and the event's channel says where it happened (LIFF for a link; WEB or LIFF for an unlink; the admin's channel
// for a deactivation).
defineEvents('ChannelIdentity', {
  // A member linked their LINE account with a one-time code, from the LIFF page /liff/link (S5-04)
  'line.linked': { schema: z.strictObject({ memberId: z.uuid() }) },
  // SELF: the member unlinked it (the workspace or the LIFF app) · MEMBER_DEACTIVATED: an ORG_ADMIN deactivated the
  // member, in the same transaction (FR-AUTH-003 AC2, FR-LINE-001 AC3)
  'line.unlinked': { schema: z.strictObject({ memberId: z.uuid(), reason: z.enum(['SELF', 'MEMBER_DEACTIVATED']) }) },
})
