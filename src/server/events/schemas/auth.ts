import { z } from 'zod'
import { defineEvents } from '../registry'

// Security events (spec §10.2 auth.*; auth.login_locked added, see §16.11). The aggregate id is the member when
// the e-mail maps to exactly one member; the e-mail itself is never stored.
const common = { memberKnown: z.boolean(), ip: z.string().optional() }

defineEvents('Auth', {
  'auth.login_succeeded': { schema: z.object({ ...common, step: z.enum(['password', 'two_factor']) }) },
  'auth.login_failed': { schema: z.object({ ...common, step: z.enum(['password', 'two_factor']) }) },
  'auth.login_locked': { schema: z.object({ ...common, reason: z.enum(['ACCOUNT', 'IP']) }) },
  'auth.2fa_enabled': { schema: z.object({ memberKnown: z.boolean(), method: z.literal('TOTP') }) },
  // ORG_ADMIN reset (FR-AUTH-002 AC3): the reason is a Comment referenced by id
  'auth.2fa_reset': { schema: z.object({ reasonCommentId: z.uuid(), sessionsRevoked: z.number().int().nonnegative() }) },
})
