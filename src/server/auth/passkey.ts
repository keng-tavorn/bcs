import { createHash, randomBytes } from 'node:crypto'
import { generateAuthenticationOptions, generateRegistrationOptions, verifyAuthenticationResponse, verifyRegistrationResponse, type AuthenticationResponseJSON, type AuthenticatorTransportFuture, type PublicKeyCredentialCreationOptionsJSON, type PublicKeyCredentialRequestOptionsJSON, type RegistrationResponseJSON } from '@simplewebauthn/server'
import { isoBase64URL, parseAuthenticatorData } from '@simplewebauthn/server/helpers'
import { z } from 'zod'
import { passkeyAssertionVerdict, signCountAdvanced, type PasskeyRefusal } from '@/core/step-up-methods'
import { COMMAND_TX_MAX_WAIT_MS, COMMAND_TX_TIMEOUT_MS, MS_PER_DAY, MS_PER_MINUTE, PASSKEY_STEP_UPS_PER_MINUTE, PASSKEY_ATTESTATION_MAX, PASSKEY_CEREMONY_TIMEOUT_MS, PASSKEY_CHALLENGE_TTL_MS, PASSKEY_CLIENT_DATA_MAX, PASSKEY_CREDENTIAL_ID_MAX, PASSKEY_SIGNATURE_MAX } from '@/lib/constants'
import { getEnv } from '@/lib/env'
import { newId } from '@/lib/ids'
import { systemClock } from '@/lib/clock'
import { countRateLimited } from '@/server/db/sql/rate-limit'
import { forTenant, type TenantTx } from '@/server/db/tenant'
import { dispatchOutbox, enqueueOutbox, getDefaultOutboxSender, type OutboxSender } from '@/server/events/outbox'
import { createNotifications } from '@/server/notifications/create'
import { lockRowsForUpdate } from '@/server/db/sql/locks'
import { issueGrant, STEP_UP_SUBJECT_TYPES, type StepUpOutcome } from './step-up'

// Passkeys of BCS (S17-15, FR-PLT-301 AC3 AC4, BR-AUTH-09 to BR-AUTH-11, ADR-166, OQ-167 OQ-168): WebAuthn credentials
// with user verification — the fingerprint, face or screen lock of the member's own device — checked by BCS itself
// with @simplewebauthn/server, never through an endpoint of Better Auth under /api/auth/*. A passkey is a proof of
// step-up like the transaction PIN, never a way to sign in.
//  - Every ceremony starts with a challenge used once (PasskeyChallenge): 32 random bytes, of which only the sha256 of
//    their base64url is kept; REGISTER to add a passkey, STEP_UP for one document; good for 5 minutes on the security
//    clock (real time, never the business clock e2e tests move). Issuing one drops the member's challenges a day past
//    their expiry; a member asks for a handful a minute at most (RATE_LIMITED beyond).
//  - The relying party is the environment itself: its RP ID is the host of APP_URL and the only origin taken is APP_URL's
//    origin (BR-AUTH-09: anything else is ORIGIN_MISMATCH). The BCS Go app's WebView uses the domain's passkeys through
//    Digital Asset Links (/.well-known/assetlinks.json, S17-09).
//  - A step-up assertion is weighed fact by fact (passkeyAssertionVerdict of src/core/step-up-methods): the origin and
//    RP ID, the credential of the session's member (active, not revoked), a live unused STEP_UP challenge issued to them
//    for this document, the signature, the UV flag, and the signature counter (a counter that went back is refused
//    SIGN_COUNT and its owner told by e-mail). A passkey that passes earns the PIN's grant (issueGrant of ./step-up.ts:
//    one document, 5 minutes, used once), in the transaction that marks the challenge used and stores the new counter.
//    The caller then changes the session id (NFR-SEC-04), as after a PIN.

const RP_NAME = 'BCS'
/** COSE algorithms taken: ES256 and RS256 (what platform authenticators make) */
const ALGORITHMS = [-7, -257]
const TX_OPTIONS = { isolationLevel: 'ReadCommitted', maxWait: COMMAND_TX_MAX_WAIT_MS, timeout: COMMAND_TX_TIMEOUT_MS } as const

/** The relying party of this environment: APP_URL's host and origin */
export function relyingParty(): { readonly rpID: string; readonly origin: string } {
  const url = new URL(getEnv().APP_URL)
  return { rpID: url.hostname, origin: url.origin }
}

const sha256Hex = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex')

export type ChallengeFor = { readonly purpose: 'REGISTER' } | { readonly purpose: 'STEP_UP'; readonly subjectType: string; readonly subjectId: string }

/** A new challenge for the member (base64url, as the options carry it); only its hash is stored */
export async function issueChallenge(tx: TenantTx, organizationId: string, memberId: string, kind: ChallengeFor, now: Date): Promise<Uint8Array<ArrayBuffer>> {
  const bytes = new Uint8Array(randomBytes(32))
  await tx.passkeyChallenge.deleteMany({ where: { memberId, expiresAt: { lt: new Date(now.getTime() - MS_PER_DAY) } } })
  await tx.passkeyChallenge.create({
    data: {
      id: newId(),
      organizationId,
      memberId,
      purpose: kind.purpose,
      challengeHash: sha256Hex(isoBase64URL.fromBuffer(bytes)),
      subjectType: kind.purpose === 'STEP_UP' ? kind.subjectType : null,
      subjectId: kind.purpose === 'STEP_UP' ? kind.subjectId : null,
      expiresAt: new Date(now.getTime() + PASSKEY_CHALLENGE_TTL_MS),
      createdAt: now,
    },
  })
  return bytes
}

/** What the browser sent in clientDataJSON; null when it cannot be read */
export function clientDataOf(clientDataJSON: unknown): { readonly type: string; readonly challenge: string; readonly origin: string } | null {
  if (typeof clientDataJSON !== 'string' || !isoBase64URL.isBase64URL(clientDataJSON)) return null
  try {
    const parsed = JSON.parse(isoBase64URL.toUTF8String(clientDataJSON)) as { type?: unknown; challenge?: unknown; origin?: unknown }
    return typeof parsed.type === 'string' && typeof parsed.challenge === 'string' && typeof parsed.origin === 'string' ? { type: parsed.type, challenge: parsed.challenge, origin: parsed.origin } : null
  } catch {
    return null
  }
}

/** The challenge a response answers, found by the hash of its base64url */
export const challengeHashOf = (challenge: string) => sha256Hex(challenge)

// ---------- adding a passkey (the command is src/server/services/self/passkeys.ts) ----------

export interface RegistrationMember {
  readonly organizationId: string
  readonly memberId: string
  readonly email: string
  readonly displayName: string
}

/** The options of navigator.credentials.create for this member: UV required, none of their passkeys again */
export async function registrationOptions(tx: TenantTx, member: RegistrationMember, now: Date): Promise<PublicKeyCredentialCreationOptionsJSON> {
  const { rpID } = relyingParty()
  const existing = await tx.memberPasskey.findMany({ where: { memberId: member.memberId, revokedAt: null }, select: { credentialId: true, transports: true } })
  const challenge = await issueChallenge(tx, member.organizationId, member.memberId, { purpose: 'REGISTER' }, now)
  return generateRegistrationOptions({
    rpName: RP_NAME,
    rpID,
    userName: member.email,
    userDisplayName: member.displayName,
    userID: new TextEncoder().encode(member.memberId),
    challenge,
    timeout: PASSKEY_CEREMONY_TIMEOUT_MS,
    attestationType: 'none',
    excludeCredentials: existing.map((p) => ({ id: p.credentialId, transports: p.transports as AuthenticatorTransportFuture[] })),
    authenticatorSelection: { residentKey: 'preferred', userVerification: 'required' },
    supportedAlgorithmIDs: ALGORITHMS,
  })
}

export const RegistrationResponse = z.object({
  id: z.string().min(1).max(PASSKEY_CREDENTIAL_ID_MAX),
  rawId: z.string().min(1).max(PASSKEY_CREDENTIAL_ID_MAX),
  type: z.literal('public-key'),
  response: z.looseObject({ clientDataJSON: z.string().min(1).max(PASSKEY_CLIENT_DATA_MAX), attestationObject: z.string().min(1).max(PASSKEY_ATTESTATION_MAX), transports: z.array(z.string().max(32)).max(8).optional() }),
  clientExtensionResults: z.record(z.string(), z.unknown()).default({}),
  authenticatorAttachment: z.string().max(32).optional(),
})

export type RegistrationCheck =
  | { readonly ok: true; readonly credentialId: string; readonly publicKey: Uint8Array; readonly signCount: number; readonly transports: string[] }
  | { readonly ok: false; readonly reason: 'CHALLENGE' | 'ORIGIN_MISMATCH' | 'ATTESTATION' | 'UV_REQUIRED' }

/**
 * A new credential, checked against a live REGISTER challenge of this member (used once: marked in the caller's
 * transaction), this environment's origin and RP ID, and the UV flag (BR-AUTH-10)
 */
export async function checkRegistration(tx: TenantTx, memberId: string, response: z.infer<typeof RegistrationResponse>, now: Date): Promise<RegistrationCheck & { readonly challengeId?: string }> {
  const client = clientDataOf(response.response.clientDataJSON)
  if (!client) return { ok: false, reason: 'ATTESTATION' }
  const { rpID, origin } = relyingParty()
  if (client.origin !== origin) return { ok: false, reason: 'ORIGIN_MISMATCH' }
  const challenge = await tx.passkeyChallenge.findFirst({ where: { challengeHash: challengeHashOf(client.challenge), memberId, purpose: 'REGISTER', usedAt: null, expiresAt: { gt: now } }, select: { id: true } })
  if (!challenge) return { ok: false, reason: 'CHALLENGE' }
  let verified
  try {
    verified = await verifyRegistrationResponse({ response: response as unknown as RegistrationResponseJSON, expectedChallenge: client.challenge, expectedOrigin: origin, expectedRPID: rpID, requireUserVerification: false, supportedAlgorithmIDs: ALGORITHMS })
  } catch {
    return { ok: false, reason: 'ATTESTATION' }
  }
  if (!verified.verified) return { ok: false, reason: 'ATTESTATION' }
  if (!verified.registrationInfo.userVerified) return { ok: false, reason: 'UV_REQUIRED' }
  const { credential } = verified.registrationInfo
  return { ok: true, challengeId: challenge.id, credentialId: credential.id, publicKey: credential.publicKey, signCount: credential.counter, transports: [...(credential.transports ?? response.response.transports ?? [])] }
}

// ---------- a step-up with a passkey ----------

const StepUpIds = z.object({ organizationId: z.uuid(), memberId: z.uuid(), subjectType: z.enum(STEP_UP_SUBJECT_TYPES), subjectId: z.uuid() })

export const AuthenticationResponse = z.object({
  id: z.string().min(1).max(PASSKEY_CREDENTIAL_ID_MAX),
  rawId: z.string().min(1).max(PASSKEY_CREDENTIAL_ID_MAX),
  type: z.literal('public-key'),
  response: z.looseObject({
    clientDataJSON: z.string().min(1).max(PASSKEY_CLIENT_DATA_MAX),
    authenticatorData: z.string().min(1).max(PASSKEY_CLIENT_DATA_MAX),
    signature: z.string().min(1).max(PASSKEY_SIGNATURE_MAX),
    userHandle: z.string().max(PASSKEY_SIGNATURE_MAX).nullish(),
  }),
  clientExtensionResults: z.record(z.string(), z.unknown()).default({}),
  authenticatorAttachment: z.string().max(32).optional(),
})

export interface PasskeySubject {
  readonly organizationId: string
  /** The member of the session: the caller takes it from the session, never from the request */
  readonly memberId: string
  readonly subjectType: string
  readonly subjectId: string
}

export type StepUpOptionsOutcome = { readonly ok: true; readonly options: PublicKeyCredentialRequestOptionsJSON } | { readonly ok: false; readonly reason: 'NO_PASSKEY' | 'RATE_LIMITED' }

/** The options of navigator.credentials.get for a step-up on one document: the member's passkeys in use, UV required */
export async function stepUpOptions(subject: PasskeySubject, now: Date = systemClock.now()): Promise<StepUpOptionsOutcome> {
  const ids = StepUpIds.parse(subject)
  // Every press writes a challenge: a member asks for a handful a minute, never thousands
  if (!(await countRateLimited(`bcs:passkey-step-up:${ids.memberId}`, MS_PER_MINUTE, PASSKEY_STEP_UPS_PER_MINUTE, now)).allowed) return { ok: false, reason: 'RATE_LIMITED' }
  return forTenant(ids.organizationId).$transaction(async (tx) => {
    const member = await tx.member.findFirst({ where: { id: ids.memberId, status: 'ACTIVE' }, select: { id: true } })
    const passkeys = member ? await tx.memberPasskey.findMany({ where: { memberId: ids.memberId, revokedAt: null }, select: { credentialId: true, transports: true } }) : []
    if (passkeys.length === 0) return { ok: false, reason: 'NO_PASSKEY' } as const
    const challenge = await issueChallenge(tx, ids.organizationId, ids.memberId, { purpose: 'STEP_UP', subjectType: ids.subjectType, subjectId: ids.subjectId }, now)
    const { rpID } = relyingParty()
    const options = await generateAuthenticationOptions({
      rpID,
      challenge,
      timeout: PASSKEY_CEREMONY_TIMEOUT_MS,
      userVerification: 'required',
      allowCredentials: passkeys.map((p) => ({ id: p.credentialId, transports: p.transports as AuthenticatorTransportFuture[] })),
    })
    return { ok: true, options } as const
  }, TX_OPTIONS)
}

export type PasskeyStepUpOutcome = Extract<StepUpOutcome, { ok: true }> | { readonly ok: false; readonly reason: 'PASSKEY'; readonly refusal: PasskeyRefusal | 'MALFORMED' }

export interface PasskeyStepUpRequest extends PasskeySubject {
  /** What navigator.credentials.get answered (AuthenticationResponseJSON) */
  readonly response: unknown
}

/**
 * BR-AUTH-09: checks a passkey assertion for one document and, when every fact holds, grants the step-up (5 minutes,
 * used once), at `now` on the security clock. The member and the document come from the session and the task, never
 * from the request. A counter that went back tells the owner by e-mail.
 */
export async function grantStepUpByPasskey(input: PasskeyStepUpRequest, now: Date, options: { readonly sender?: OutboxSender | null } = {}): Promise<PasskeyStepUpOutcome> {
  const ids = StepUpIds.parse({ organizationId: input.organizationId, memberId: input.memberId, subjectType: input.subjectType, subjectId: input.subjectId })
  const parsed = AuthenticationResponse.safeParse(input.response)
  const malformed = { ok: false, reason: 'PASSKEY', refusal: 'MALFORMED' } as const
  if (!parsed.success) return malformed
  const response = parsed.data
  const client = clientDataOf(response.response.clientDataJSON)
  if (!client || client.type !== 'webauthn.get' || !isoBase64URL.isBase64URL(response.response.authenticatorData)) return malformed
  let authData: ReturnType<typeof parseAuthenticatorData>
  try {
    authData = parseAuthenticatorData(isoBase64URL.toBuffer(response.response.authenticatorData))
  } catch {
    return malformed
  }
  const { rpID, origin } = relyingParty()
  const db = forTenant(ids.organizationId)
  const [challenge, passkey, member] = await Promise.all([
    db.passkeyChallenge.findFirst({ where: { challengeHash: challengeHashOf(client.challenge) }, select: { id: true, memberId: true, purpose: true, subjectType: true, subjectId: true, expiresAt: true, usedAt: true } }),
    db.memberPasskey.findFirst({ where: { credentialId: response.id }, select: { id: true, memberId: true, publicKey: true, signCount: true, transports: true, revokedAt: true } }),
    db.member.findFirst({ where: { id: ids.memberId }, select: { status: true } }),
  ])
  // A challenge issued to someone else, or for another document, is none of this step-up's
  const forThis = challenge !== null && challenge.memberId === ids.memberId && challenge.purpose === 'STEP_UP' && challenge.subjectType === ids.subjectType && challenge.subjectId === ids.subjectId
  const owned = passkey !== null && passkey.memberId === ids.memberId && passkey.revokedAt === null && member?.status === 'ACTIVE'
  const received = BigInt(authData.counter)
  let signatureValid = false
  if (owned) {
    try {
      // The counter rule is checked here (signCountAdvanced) so its refusal says SIGN_COUNT; the library sees none
      const checked = await verifyAuthenticationResponse({
        response: response as unknown as AuthenticationResponseJSON,
        expectedChallenge: client.challenge,
        expectedOrigin: origin,
        expectedRPID: rpID,
        credential: { id: response.id, publicKey: new Uint8Array(passkey.publicKey), counter: 0, transports: passkey.transports as AuthenticatorTransportFuture[] },
        requireUserVerification: false,
      })
      signatureValid = checked.verified
    } catch {
      signatureValid = false
    }
  }
  const verdict = passkeyAssertionVerdict({
    originMatches: client.origin === origin && Buffer.from(authData.rpIdHash).equals(createHash('sha256').update(rpID).digest()),
    credentialOwnedBySessionUser: owned,
    challengeFresh: forThis && challenge.expiresAt > now,
    challengeUnused: forThis && challenge.usedAt === null,
    signatureValid,
    userVerified: authData.flags.uv,
    signCountAdvanced: owned ? signCountAdvanced(passkey.signCount, received) : true,
  })
  if (verdict.verdict === 'REFUSED') {
    if (verdict.reason === 'SIGN_COUNT' && owned) await tellSignCount(ids, passkey.id, now, options)
    return { ok: false, reason: 'PASSKEY', refusal: verdict.reason }
  }
  return db.$transaction(async (tx) => {
    // Under the member's row lock — the lock their deactivation, a reset of their identity and a passkey's removal take
    // — what was read above is read again: a passkey revoked meanwhile, or a member no longer active, earns nothing
    const [locked] = await lockRowsForUpdate(tx, 'Member', ids.organizationId, [ids.memberId])
    const still = locked ? await tx.member.findUnique({ where: { id: ids.memberId }, select: { status: true } }) : null
    if (still?.status !== 'ACTIVE') return { ok: false, reason: 'PASSKEY', refusal: 'NOT_OWNER' } as const
    // The counter moves forward only: an answer settling after a later one is refused, never written back
    const counted = await tx.memberPasskey.updateMany({
      where: { id: passkey!.id, memberId: ids.memberId, revokedAt: null, ...(received === 0n ? { signCount: 0n } : { signCount: { lt: received } }) },
      data: { signCount: received, lastUsedAt: now, version: { increment: 1 } },
    })
    if (counted.count !== 1) {
      const current = await tx.memberPasskey.findUnique({ where: { id: passkey!.id }, select: { revokedAt: true } })
      return { ok: false, reason: 'PASSKEY', refusal: current?.revokedAt ? 'NOT_OWNER' : 'SIGN_COUNT' } as const
    }
    // Used once: a second answer to the same challenge, however close, finds it used
    const spent = await tx.passkeyChallenge.updateMany({ where: { id: challenge!.id, usedAt: null }, data: { usedAt: now } })
    if (spent.count !== 1) throw new ChallengeSpent()
    const granted = await issueGrant(tx, ids, 'PASSKEY', now)
    if (!granted.ok) throw new Error('a grant is always issued')
    return granted
  }, TX_OPTIONS).catch((error: unknown) => {
    // The challenge went to a parallel answer: this transaction is rolled back, the counter with it
    if (error instanceof ChallengeSpent) return { ok: false, reason: 'PASSKEY', refusal: 'CHALLENGE_USED' } as const
    throw error
  })
}

/** A challenge another answer used in the meantime: rolls the grant's transaction back */
class ChallengeSpent extends Error {}

/** BR-AUTH-09: a signature counter that went back may be a copied authenticator; its owner hears of it by e-mail */
async function tellSignCount(ids: { organizationId: string; memberId: string }, passkeyId: string, now: Date, options: { readonly sender?: OutboxSender | null }): Promise<void> {
  const outboxIds = await forTenant(ids.organizationId).$transaction(async (tx) => {
    const notified = await createNotifications(tx, ids.organizationId, [
      {
        recipientMemberId: ids.memberId,
        templateKey: 'security.notice',
        data: { kind: 'PASSKEY_SIGN_COUNT' },
        urgency: 'IMMEDIATE',
        // One notice per passkey a day: an attacker replaying a copy cannot flood the owner's inbox
        dedupeKey: `security.notice:passkey_sign_count:${passkeyId}:${now.toISOString().slice(0, 10)}`,
        subjectType: 'Member',
        subjectId: ids.memberId,
      },
    ])
    return enqueueOutbox(tx, ids.organizationId, notified)
  }, TX_OPTIONS)
  const sender = options.sender === undefined ? getDefaultOutboxSender() : options.sender
  if (sender && outboxIds.length) await dispatchOutbox(outboxIds, sender, systemClock.now())
}
