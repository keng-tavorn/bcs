// The proofs a step-up takes and whether a passkey assertion earns one (S17-15, FR-AUTH-005, FR-PLT-301 AC3 AC4,
// BR-AUTH-09, OQ-168 · golden step-up-methods). Pure: the server works out the facts of an assertion — the signature,
// the challenge, the flags of the authenticator data, who owns the credential — and this says what they come to.
//  - Every subject that needs a step-up (stepUpNeeded of src/core/pin: a policy subject, or an amount at or above the
//    DOA version's stepUpThreshold) takes the transaction PIN and a passkey alike, on every channel.
//  - A passkey assertion earns the same grant as the PIN — one document, 5 minutes, used once, then a new session id —
//    when it was made on this environment's origin and RP ID, by a credential of the member of the session, for a
//    challenge issued to them for this document within 5 minutes and not used yet, with a valid signature, with the
//    user verified (fingerprint, face or the device's own lock) and with a signature counter that moved forward.
//    The first fact that fails is the reason, in that order.

/** The proofs of a step-up (StepUpMethod of prisma/schema.prisma); TOTP grants made before S5-05 decide nothing */
export type StepUpProof = 'PIN' | 'PASSKEY'

/** What every deciding command accepts as its step-up, whatever the document (BR-AUTH-09) */
export const STEP_UP_METHODS: readonly StepUpProof[] = ['PIN', 'PASSKEY']

/** How long a grant lives (STEP_UP_TTL_MS of src/lib/constants, in seconds) */
export const STEP_UP_GRANT_SECONDS = 300

/** The proofs a step-up for this subject takes: the PIN and the passkey, for every subject alike */
export function stepUpMethodsFor(_subjectType: string): readonly StepUpProof[] {
  return STEP_UP_METHODS
}

/** What the server found of one passkey assertion */
export interface AssertionFacts {
  /** clientData.origin is the environment's origin and the RP ID hash is its domain's (APP_URL); true when not said */
  readonly originMatches?: boolean
  readonly signatureValid: boolean
  /** The challenge was issued less than 5 minutes ago */
  readonly challengeFresh: boolean
  readonly challengeUnused: boolean
  /** The UV flag of the authenticator data */
  readonly userVerified: boolean
  /** The credential is one of the member of the session, not revoked, and the member is ACTIVE */
  readonly credentialOwnedBySessionUser: boolean
  /** The new signature counter is above the stored one, or both are 0 (a synced passkey); true when not said */
  readonly signCountAdvanced?: boolean
}

export type PasskeyRefusal = 'ORIGIN_MISMATCH' | 'NOT_OWNER' | 'CHALLENGE_EXPIRED' | 'CHALLENGE_USED' | 'SIGNATURE' | 'UV_REQUIRED' | 'SIGN_COUNT'

export type PasskeyVerdict =
  | { readonly verdict: 'GRANT'; readonly method: 'PASSKEY'; readonly ttlSeconds: number; readonly uses: 1; readonly rotateSession: true }
  | { readonly verdict: 'REFUSED'; readonly reason: PasskeyRefusal }

/** BR-AUTH-09: what an assertion comes to; the first fact that fails is the reason */
export function passkeyAssertionVerdict(facts: AssertionFacts): PasskeyVerdict {
  const refused = (reason: PasskeyRefusal): PasskeyVerdict => ({ verdict: 'REFUSED', reason })
  if (facts.originMatches === false) return refused('ORIGIN_MISMATCH')
  if (!facts.credentialOwnedBySessionUser) return refused('NOT_OWNER')
  if (!facts.challengeFresh) return refused('CHALLENGE_EXPIRED')
  if (!facts.challengeUnused) return refused('CHALLENGE_USED')
  if (!facts.signatureValid) return refused('SIGNATURE')
  if (!facts.userVerified) return refused('UV_REQUIRED')
  if (facts.signCountAdvanced === false) return refused('SIGN_COUNT')
  return { verdict: 'GRANT', method: 'PASSKEY', ttlSeconds: STEP_UP_GRANT_SECONDS, uses: 1, rotateSession: true }
}

/**
 * The signature counter rule (BR-AUTH-09, WebAuthn §6.1.1): when either the stored or the new counter is not 0, the new
 * one must be greater; a passkey synced between devices sends 0 always and passes
 */
export function signCountAdvanced(stored: bigint, received: bigint): boolean {
  if (stored === 0n && received === 0n) return true
  return received > stored
}
