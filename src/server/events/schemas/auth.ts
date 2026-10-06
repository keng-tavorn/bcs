import { z } from 'zod'
import { defineEvents } from '../registry'

// Security events (spec §10.2 auth.*; auth.login_locked added, see §16.11). The aggregate id is the member when
// the e-mail maps to exactly one member; the e-mail itself is never stored.
const common = { memberKnown: z.boolean(), ip: z.string().optional() }

defineEvents('Auth', {
  // step liff: a sign-in with a LINE ID token (S5-03, src/server/auth/liff.ts, channel LIFF); a refused one says why —
  // SIGNED_IN_AS_ANOTHER_USER: the browser held a live session of another sign-in identity, which stayed
  'auth.login_succeeded': { schema: z.object({ ...common, step: z.enum(['password', 'two_factor', 'liff']) }) },
  'auth.login_failed': {
    schema: z.object({ ...common, step: z.enum(['password', 'two_factor', 'liff']), reason: z.enum(['TOKEN_INVALID', 'LINK_REQUIRED', 'LINK_AMBIGUOUS', 'SIGNED_IN_AS_ANOTHER_USER']).optional() }),
  },
  'auth.login_locked': { schema: z.object({ ...common, reason: z.enum(['ACCOUNT', 'IP']) }) },
  'auth.2fa_enabled': { schema: z.object({ memberKnown: z.boolean(), method: z.literal('TOTP') }) },
  // ORG_ADMIN reset (FR-AUTH-002 AC3): the reason is a Comment referenced by id; for a member the DOA relies on, the reset
  // comes from an approved IDENTITY_RESET authority change, which holds the reason (BR-AUTH-07)
  'auth.2fa_reset': {
    schema: z.union([
      z.strictObject({ reasonCommentId: z.uuid(), sessionsRevoked: z.number().int().nonnegative() }),
      z.strictObject({ orgAuthorityChangeId: z.uuid(), sessionsRevoked: z.number().int().nonnegative() }),
    ]),
  },
  // FR-AUTH-005 AC1 (NEW-30): the member set or changed their transaction PIN after proving who they are again — `proof`
  // says how (null: the demo seed, local and staging only). `replaced`: they had a PIN before; `unlocked`: it was locked
  // after five wrong PINs. Never the PIN or its hash. The aggregate id is the member.
  'auth.pin_set': { schema: z.strictObject({ replaced: z.boolean(), proof: z.enum(['PASSWORD', 'TOTP']).nullable(), unlocked: z.boolean() }) },
})

// FR-AUTH-005 AC3: the fifth wrong PIN in a row locked the member's PIN until `lockedUntil`, while they asked for a
// step-up on this document (a subject of an approval route). Written by src/server/auth/step-up.ts in its own
// transaction once the fifth PIN was checked, so it stays although the decision is refused; step-up.ts checks this
// schema before it counts the try. Here with the sign-in events because the PIN is a credential; the aggregate id is
// the member.
defineEvents('Security', {
  'security.pin_locked': {
    schema: z.strictObject({
      failedAttempts: z.number().int().positive(),
      lockedUntil: z.iso.datetime({ offset: true }),
      subjectType: z.enum(['REQUEST', 'PURCHASE_ORDER', 'VARIANCE', 'DOA_VERSION', 'ORG_AUTHORITY_CHANGE']),
      subjectId: z.uuid(),
    }),
  },
})
