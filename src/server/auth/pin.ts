import { argon2, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { isPinFormat } from '@/core/pin'
import { BYTES_PER_KIB, BYTES_PER_MIB, MS_PER_SECOND, STEP_UP_TTL_MS } from '@/lib/constants'
import { getEnv } from '@/lib/env'
import { keyId, parseEncryptionKey, type SecretKeyring } from '@/server/crypto/secret-box'

// The transaction PIN at rest, and the proof that lets a member set it (spec FR-AUTH-005 AC1, NFR-SEC-09).
//
// Hash: argon2id of Node 24 (node:crypto) with the parameters of PIN_HASH_PARAMS. A PIN has only a million values, so
// the cost alone would not stop someone who holds a copy of the database. The hash therefore also takes Argon2's secret
// input (K of RFC 9106 §3.1, a "pepper") derived from ENCRYPTION_KEY, which is never stored in the database: a copy of
// the database alone cannot check a single guess. The stored text names that key by its public id
// (src/server/crypto/secret-box.ts), so the key can be rotated. A PIN hashed under a key the server no longer holds cannot
// be checked, and its owner sets a new one. The stored text is a PHC string with the key id, base64 without padding:
//
//   $argon2id$v=19$m=19456,t=2,p=1,keyid=<8 hex>$<16-byte salt>$<32-byte tag>
//
// A check recomputes the tag with the stored salt and parameters and compares the two in constant time. Neither the PIN
// nor its hash is ever logged, returned or put in an event.

/**
 * argon2id cost: the first argon2id configuration of the OWASP Password Storage Cheat Sheet (19 MiB of memory, 2 passes,
 * 1 lane), about 35 ms on a developer machine. Each hash carries its own parameters, so raising them later needs no
 * migration: new PINs get the new cost and old ones are still checked with theirs.
 */
export const PIN_HASH_PARAMS = { memoryKib: (19 * BYTES_PER_MIB) / BYTES_PER_KIB, passes: 2, parallelism: 1 } as const
const ARGON2_VERSION = 19
const SALT_BYTES = 16
const TAG_BYTES = 32
// A stored hash outside these bounds is refused before Argon2 runs, so a damaged row cannot make the server spend a lot
// of memory or time on one check
const MAX_MEMORY_KIB = (64 * BYTES_PER_MIB) / BYTES_PER_KIB
const MAX_PASSES = 10
const MAX_PARALLELISM = 8
const MIN_MEMORY_BLOCKS_PER_LANE = 8
const PEPPER_CONTEXT = 'bcs/transaction-pin/argon2-secret/v1'
const STORED = /^\$argon2id\$v=(\d+)\$m=(\d{1,8}),t=(\d{1,3}),p=(\d{1,3}),keyid=([0-9a-f]{8})\$([A-Za-z0-9+/]{22})\$([A-Za-z0-9+/]{43})$/

export type PinHashFailure = 'MALFORMED' | 'UNKNOWN_KEY'

/** A stored PIN hash that cannot be checked: damaged, or made under a key the server no longer holds */
export class PinHashError extends Error {
  readonly reason: PinHashFailure
  constructor(reason: PinHashFailure) {
    super(`stored PIN hash refused: ${reason}`)
    this.name = 'PinHashError'
    this.reason = reason
  }
}

let envKeyring: SecretKeyring | null = null
function defaultKeyring(): SecretKeyring {
  envKeyring ??= { current: parseEncryptionKey(getEnv().ENCRYPTION_KEY) }
  return envKeyring
}

/** Argon2's secret input for one key: an HMAC of a fixed label, so the PIN pepper is never the encryption key itself */
const pepperOf = (key: Uint8Array) => createHmac('sha256', key).update(PEPPER_CONTEXT).digest()

const toB64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64').replace(/=+$/, '')

/** Bytes of a base64 field, refused unless it is the canonical spelling of its bytes */
function fromB64(text: string): Buffer {
  const bytes = Buffer.from(text, 'base64')
  if (toB64(bytes) !== text) throw new PinHashError('MALFORMED')
  return bytes
}

interface Argon2Cost {
  readonly memoryKib: number
  readonly passes: number
  readonly parallelism: number
}

function derive(pin: string, salt: Uint8Array, cost: Argon2Cost, pepper: Uint8Array): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    argon2(
      'argon2id',
      { message: Buffer.from(pin, 'utf8'), nonce: salt, parallelism: cost.parallelism, tagLength: TAG_BYTES, memory: cost.memoryKib, passes: cost.passes, secret: pepper },
      (error, tag) => (error ? reject(error) : resolve(tag)),
    )
  })
}

interface StoredPin {
  readonly cost: Argon2Cost
  readonly keyId: string
  readonly salt: Buffer
  readonly tag: Buffer
}

function parseStored(stored: string): StoredPin {
  const m = STORED.exec(stored)
  if (!m || Number(m[1]) !== ARGON2_VERSION) throw new PinHashError('MALFORMED')
  const cost = { memoryKib: Number(m[2]), passes: Number(m[3]), parallelism: Number(m[4]) }
  const inBounds =
    cost.parallelism >= 1 &&
    cost.parallelism <= MAX_PARALLELISM &&
    cost.passes >= 1 &&
    cost.passes <= MAX_PASSES &&
    cost.memoryKib >= MIN_MEMORY_BLOCKS_PER_LANE * cost.parallelism &&
    cost.memoryKib <= MAX_MEMORY_KIB
  if (!inBounds) throw new PinHashError('MALFORMED')
  const salt = fromB64(m[6]!)
  const tag = fromB64(m[7]!)
  if (salt.length !== SALT_BYTES || tag.length !== TAG_BYTES) throw new PinHashError('MALFORMED')
  return { cost, keyId: m[5]!, salt, tag }
}

/** The text stored in Member.transactionPinHash for this PIN (six digits; the caller checks the PIN rule first) */
export async function hashPin(pin: string, keyring: SecretKeyring = defaultKeyring()): Promise<string> {
  // The PIN itself is never part of an error
  if (!isPinFormat(pin)) throw new TypeError('a PIN is six digits')
  const salt = randomBytes(SALT_BYTES)
  const tag = await derive(pin, salt, PIN_HASH_PARAMS, pepperOf(keyring.current))
  const { memoryKib, passes, parallelism } = PIN_HASH_PARAMS
  return `$argon2id$v=${ARGON2_VERSION}$m=${memoryKib},t=${passes},p=${parallelism},keyid=${keyId(keyring.current)}$${toB64(salt)}$${toB64(tag)}`
}

/** The key a stored hash was made under, when the server still holds it */
const keyOf = (parsed: StoredPin, keyring: SecretKeyring) => [keyring.current, ...(keyring.previous ?? [])].find((k) => keyId(k) === parsed.keyId)

/**
 * Whether verifyPin() can check a PIN against this stored text: well formed, and made under a key the server holds.
 * Cheap (no Argon2), so the step-up asks it before it counts a try (src/server/auth/step-up.ts).
 */
export function isCheckablePinHash(stored: string, keyring: SecretKeyring = defaultKeyring()): boolean {
  try {
    return keyOf(parseStored(stored), keyring) !== undefined
  } catch (error) {
    if (error instanceof PinHashError) return false
    throw error
  }
}

/**
 * Whether `pin` is the PIN of this stored hash, compared in constant time. Throws PinHashError when the stored text is
 * damaged or names a key the server does not hold: that PIN cannot be checked and must be set again.
 */
export async function verifyPin(pin: string, stored: string, keyring: SecretKeyring = defaultKeyring()): Promise<boolean> {
  const parsed = parseStored(stored)
  const key = keyOf(parsed, keyring)
  if (!key) throw new PinHashError('UNKNOWN_KEY')
  // Anything but six digits was never a PIN
  if (!isPinFormat(pin)) return false
  const tag = await derive(pin, parsed.salt, parsed.cost, pepperOf(key))
  return tag.length === parsed.tag.length && timingSafeEqual(tag, parsed.tag)
}

// ---------- the proof that lets a member set a PIN ----------
//
// Setting or changing a PIN needs the member to prove who they are again within the last 5 minutes on the security
// clock: the password or the authenticator code (docs/sub-specs/S5.md, row PIN). proveIdentityForPin() of step-up.ts
// checks one of them and signs this proof; the self.pin command reads it. It is an HMAC with BETTER_AUTH_SECRET over the
// organization, the member, how they proved it, when, a random nonce, and a digest of the member's PIN hash at that
// moment. Nobody can make one without the server key; it is good for one member of one organization for 5 minutes; and
// once a PIN is set with it the digest no longer matches, so it sets one PIN only. It holds no secret of the member, but
// it is a bearer proof: it goes back only to the session that earned it, and it is never logged or stored. It travels
// as `proofToken` (the result of confirmIdentityForPin and the input of self.set_pin), a key name the logger redacts at
// any depth and in JSON text (NFR-SEC-09, src/lib/logger.ts). The nonce matters for the command: CommandLog keeps a
// sha256 of the command's input (the PIN and this proof), and 128 random bits that exist nowhere else make that digest
// useless for guessing the PIN, even to someone with the database and the key.
//
//   p1.<PASSWORD | TOTP>.<issued at, ms since 1970>.<nonce, 16 bytes>.<HMAC-SHA256>      (base64url)

export type IdentityProofMethod = 'PASSWORD' | 'TOTP'

/** A proof is good for the step-up window: 5 minutes (NFR-SEC-04) */
export const PIN_PROOF_TTL_MS = STEP_UP_TTL_MS
// Servers of one deployment may disagree by a few seconds; a proof from further ahead than this is refused
const PROOF_CLOCK_SKEW_MS = 30 * MS_PER_SECOND
const PROOF_CONTEXT = 'bcs/pin-change-proof/v1'
const PROOF_NONCE_BYTES = 16
const PROOF = /^p1\.(PASSWORD|TOTP)\.(\d{1,15})\.([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{43})$/

/** What a proof binds besides its method and time */
export interface PinProofSubject {
  readonly organizationId: string
  readonly memberId: string
  /** Member.transactionPinHash when the proof is made or read; null when the member has no PIN yet */
  readonly currentPinHash: string | null
}

function proofMac(subject: PinProofSubject, method: IdentityProofMethod, issuedAtMs: number, nonce: string): Buffer {
  const pinState = createHash('sha256')
    .update(subject.currentPinHash ?? '')
    .digest('hex')
  return createHmac('sha256', getEnv().BETTER_AUTH_SECRET)
    .update([PROOF_CONTEXT, subject.organizationId, subject.memberId, method, String(issuedAtMs), nonce, pinState].join('|'))
    .digest()
}

/** Signs the proof for a member who has just proved who they are with `method` at `issuedAt` (security clock) */
export function signPinChangeProof(subject: PinProofSubject, method: IdentityProofMethod, issuedAt: Date): string {
  const issuedAtMs = issuedAt.getTime()
  const nonce = randomBytes(PROOF_NONCE_BYTES).toString('base64url')
  return `p1.${method}.${issuedAtMs}.${nonce}.${proofMac(subject, method, issuedAtMs, nonce).toString('base64url')}`
}

export type PinProofCheck =
  | { readonly ok: true; readonly method: IdentityProofMethod }
  /** MALFORMED: not a proof · NOT_VALID: not signed for this member and PIN state (forged, someone else's, or spent) · EXPIRED: older than 5 minutes */
  | { readonly ok: false; readonly reason: 'MALFORMED' | 'NOT_VALID' | 'EXPIRED' }

/** Reads a proof for this member and their PIN as it is now, at `now` on the security clock */
export function checkPinChangeProof(proof: string, subject: PinProofSubject, now: Date): PinProofCheck {
  const m = PROOF.exec(proof)
  if (!m) return { ok: false, reason: 'MALFORMED' }
  const method = m[1] as IdentityProofMethod
  const issuedAtMs = Number(m[2])
  const nonce = m[3]!
  const given = Buffer.from(m[4]!, 'base64url')
  if (given.toString('base64url') !== m[4] || Buffer.from(nonce, 'base64url').toString('base64url') !== nonce) return { ok: false, reason: 'MALFORMED' }
  const expected = proofMac(subject, method, issuedAtMs, nonce)
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return { ok: false, reason: 'NOT_VALID' }
  const age = now.getTime() - issuedAtMs
  if (age >= PIN_PROOF_TTL_MS || age < -PROOF_CLOCK_SKEW_MS) return { ok: false, reason: 'EXPIRED' }
  return { ok: true, method }
}
