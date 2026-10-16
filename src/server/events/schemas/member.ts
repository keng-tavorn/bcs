import { z } from 'zod'
import { defineEvents } from '../registry'

// Member events (spec §10.2 + additions recorded in §16.11). Data holds ids, codes and counts only —
// free-text reasons live in Comment and are referenced by id (spec §4.5).
// S6-09 added DOA_ADMIN (FR-ADM-101)
const role = z.enum(['PROCUREMENT', 'FINANCE', 'BUDGET_ADMIN', 'RECEIVER', 'EXECUTIVE', 'AUDITOR', 'ORG_ADMIN', 'DOA_ADMIN'])

defineEvents('Member', {
  'member.invited': { schema: z.object({ invitationId: z.uuid(), roles: z.array(role), resent: z.boolean() }) },
  'member.activated': { schema: z.object({ via: z.enum(['INVITATION', 'SEED']) }) },
  'member.deactivated': {
    schema: z.object({
      reasonCommentId: z.uuid(),
      revoked: z.record(z.string(), z.number().int().nonnegative()),
    }),
  },
  'member.role_granted': { schema: z.object({ role, scopeDepartmentId: z.uuid().nullable() }) },
  'member.role_revoked': { schema: z.object({ role }) },
  // Not in the §10.2 catalog (added, see §16.11)
  'member.session_revoked': { schema: z.object({ sessionId: z.uuid(), self: z.boolean() }) },
  // NEW-31 (FR-LINE-006 AC3): a member turns their own daily summary off or on. Approval and SLA notices cannot be
  // turned off (BR-NOTI-04), so the summary is the only preference this event carries.
  // The preferences that changed: the daily summary, push in the BCS Go app (appPush, S17-10), or both
  'member.notification_prefs_updated': {
    schema: z.object({ digest: z.boolean().optional(), appPush: z.boolean().optional() }).refine((d) => d.digest !== undefined || d.appPush !== undefined, { message: 'names a preference' }),
  },
})
