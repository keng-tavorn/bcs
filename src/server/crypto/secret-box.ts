import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { getEnv } from '@/lib/env'

// Secrets of a tenant at rest (NFR-SEC-07, FR-ADM-006 AC2): AES-256-GCM with ENCRYPTION_KEY ("base64:" + 32 bytes), a
// random 12-byte IV for every value and the 16-byte tag checked on every read, so a changed byte is refused instead of
// decrypting to something else. Text format, version 1 (base64url without padding):
//
//   v1.<key id>.<iv>.<ciphertext>.<tag>
//
// The key id (the first 8 hex digits of sha256 of the key) names the key that sealed the value, so a new ENCRYPTION_KEY
// can be rolled in later while older values are still opened with the key they name (NFR-SEC-07: "พร้อม key id เพื่อ
// หมุนคีย์ได้"). The version, the key id and the caller's context — which secret of which row, such as
// "LineChannelConfig:<organizationId>:channelSecret" — are authenticated as associated data: a sealed value copied into
// another field or another organization does not open. Errors name what is wrong, never a value or a key.

const VERSION = 'v1'
const ALGORITHM = 'aes-256-gcm'
const KEY_BYTES = 32
const IV_BYTES = 12
const TAG_BYTES = 16
const KEY_ID_HEX = 8
const KEY_PREFIX = 'base64:'
const SEGMENT = /^[A-Za-z0-9_-]+$/
const KEY_ID = /^[0-9a-f]{8}$/

export type SecretBoxFailure = 'MALFORMED' | 'UNSUPPORTED_VERSION' | 'UNKNOWN_KEY' | 'TAMPERED'

export class SecretBoxError extends Error {
  readonly reason: SecretBoxFailure
  constructor(reason: SecretBoxFailure) {
    super(`sealed secret refused: ${reason}`)
    this.name = 'SecretBoxError'
    this.reason = reason
  }
}

/** The key that seals new values, and older keys that still open what they sealed (key rotation, NFR-SEC-07). */
export interface SecretKeyring {
  readonly current: Uint8Array
  readonly previous?: readonly Uint8Array[]
}

/** The 32 bytes of an ENCRYPTION_KEY value ("base64:…"); throws without repeating the value. */
export function parseEncryptionKey(value: string): Uint8Array {
  if (!value.startsWith(KEY_PREFIX)) throw new TypeError('ENCRYPTION_KEY must start with base64:')
  const key = Buffer.from(value.slice(KEY_PREFIX.length), 'base64')
  if (key.length !== KEY_BYTES) throw new TypeError(`ENCRYPTION_KEY must decode to ${KEY_BYTES} bytes`)
  return new Uint8Array(key)
}

/** Public name of a key: the first 8 hex digits of its sha256 (a key of 256 random bits cannot be found from it). */
export function keyId(key: Uint8Array): string {
  if (key.length !== KEY_BYTES) throw new TypeError(`an AES-256 key has ${KEY_BYTES} bytes`)
  return createHash('sha256').update(key).digest('hex').slice(0, KEY_ID_HEX)
}

let envKeyring: SecretKeyring | null = null
function defaultKeyring(): SecretKeyring {
  envKeyring ??= { current: parseEncryptionKey(getEnv().ENCRYPTION_KEY) }
  return envKeyring
}

const associatedData = (kid: string, context: string) => Buffer.from(`${VERSION}.${kid}.${context}`, 'utf8')

function requireContext(context: string): void {
  if (context.trim() === '') throw new TypeError('a sealed secret needs a context (which secret of which row)')
}

/** Encrypts one secret for storage. `context` must be given again, unchanged, to open it. */
export function sealSecret(plaintext: string, context: string, keyring: SecretKeyring = defaultKeyring()): string {
  if (plaintext === '') throw new TypeError('an empty secret is not sealed')
  requireContext(context)
  const kid = keyId(keyring.current)
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv(ALGORITHM, keyring.current, iv, { authTagLength: TAG_BYTES })
  cipher.setAAD(associatedData(kid, context))
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return [VERSION, kid, iv.toString('base64url'), ciphertext.toString('base64url'), tag.toString('base64url')].join('.')
}

/** One base64url segment, refused unless it is the canonical spelling of its bytes (no padding, no stray bits). */
function decodeSegment(segment: string): Buffer {
  if (!SEGMENT.test(segment)) throw new SecretBoxError('MALFORMED')
  const bytes = Buffer.from(segment, 'base64url')
  if (bytes.toString('base64url') !== segment) throw new SecretBoxError('MALFORMED')
  return bytes
}

interface SealedParts {
  readonly kid: string
  readonly iv: Buffer
  readonly ciphertext: Buffer
  readonly tag: Buffer
}

function parseSealed(sealed: string): SealedParts {
  const parts = sealed.split('.')
  if (parts[0] !== VERSION) throw new SecretBoxError(parts.length === 5 && /^v\d+$/.test(parts[0] ?? '') ? 'UNSUPPORTED_VERSION' : 'MALFORMED')
  if (parts.length !== 5) throw new SecretBoxError('MALFORMED')
  const [, kid = '', iv = '', ciphertext = '', tag = ''] = parts
  if (!KEY_ID.test(kid)) throw new SecretBoxError('MALFORMED')
  const parsed = { kid, iv: decodeSegment(iv), ciphertext: decodeSegment(ciphertext), tag: decodeSegment(tag) }
  if (parsed.iv.length !== IV_BYTES || parsed.tag.length !== TAG_BYTES) throw new SecretBoxError('MALFORMED')
  return parsed
}

/** Decrypts a value sealed by sealSecret with the same context. Throws SecretBoxError when it cannot be trusted. */
export function openSecret(sealed: string, context: string, keyring: SecretKeyring = defaultKeyring()): string {
  requireContext(context)
  const parts = parseSealed(sealed)
  const key = [keyring.current, ...(keyring.previous ?? [])].find((k) => keyId(k) === parts.kid)
  if (!key) throw new SecretBoxError('UNKNOWN_KEY')
  const decipher = createDecipheriv(ALGORITHM, key, parts.iv, { authTagLength: TAG_BYTES })
  decipher.setAAD(associatedData(parts.kid, context))
  decipher.setAuthTag(parts.tag)
  try {
    return Buffer.concat([decipher.update(parts.ciphertext), decipher.final()]).toString('utf8')
  } catch {
    // GCM refused the tag: the ciphertext, IV, tag, key id or context differs from what was sealed
    throw new SecretBoxError('TAMPERED')
  }
}

/** The key id a sealed value names, or null when it is not a sealed value of a known version. */
export function sealedKeyId(sealed: string): string | null {
  try {
    return parseSealed(sealed).kid
  } catch {
    return null
  }
}

/** True when the value was sealed with a key other than the current one (a rotation job seals it again). */
export function needsResealing(sealed: string, keyring: SecretKeyring = defaultKeyring()): boolean {
  return sealedKeyId(sealed) !== keyId(keyring.current)
}
