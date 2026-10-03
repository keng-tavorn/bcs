import { createHmac } from 'node:crypto'
import { MS_PER_SECOND } from './constants'

// RFC 4226/6238 one-time codes compatible with Better Auth's two-factor plugin (HMAC-SHA1 keyed by the raw
// secret string, 6 digits, 30-second period). Used by the demo seed (deterministic secrets for local/staging
// only), by tests and by the step-up check of src/server/auth/step-up.ts — never to verify sign-ins (Better Auth
// does that). Built on node:crypto, no new dependency.

export const TOTP_PERIOD_SECONDS = 30
export const TOTP_DIGITS = 6

export function hotp(secret: string, counter: number, digits = TOTP_DIGITS): string {
  const message = Buffer.alloc(8)
  message.writeBigUInt64BE(BigInt(counter))
  const digest = createHmac('sha1', Buffer.from(secret, 'utf8')).update(message).digest()
  const offset = digest[digest.length - 1]! & 0x0f
  const binary =
    ((digest[offset]! & 0x7f) << 24) | ((digest[offset + 1]! & 0xff) << 16) | ((digest[offset + 2]! & 0xff) << 8) | (digest[offset + 3]! & 0xff)
  return String(binary % 10 ** digits).padStart(digits, '0')
}

export function totp(secret: string, atMs: number = Date.now(), period = TOTP_PERIOD_SECONDS, digits = TOTP_DIGITS): string {
  return hotp(secret, Math.floor(atMs / (period * MS_PER_SECOND)), digits)
}

/** Deterministic 32-character secret for a seeded demo user (local/staging only). */
export function deriveSeedTotpSecret(seedKey: string, userCode: string): string {
  return createHmac('sha256', seedKey).update(`bcs-seed-totp:${userCode}`).digest('base64url').slice(0, 32)
}

/** Ten deterministic single-use backup codes for a seeded demo user (local/staging only), like `a1b2c-3d4e5`. */
export function deriveSeedBackupCodes(seedKey: string, userCode: string, count = 10): string[] {
  return Array.from({ length: count }, (_, i) => {
    const hex = createHmac('sha256', seedKey).update(`bcs-seed-backup:${userCode}:${i}`).digest('hex')
    return `${hex.slice(0, 5)}-${hex.slice(5, 10)}`
  })
}

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

export function base32(bytes: Uint8Array): string {
  let bits = 0
  let value = 0
  let out = ''
  for (const byte of bytes) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31]
  return out
}

/** Decodes base32 (the `secret` parameter of an otpauth:// URI) back to bytes. */
export function fromBase32(text: string): Buffer {
  let bits = 0
  let value = 0
  const out: number[] = []
  for (const ch of text.replace(/=+$/, '').toUpperCase()) {
    const index = BASE32.indexOf(ch)
    if (index < 0) throw new Error('invalid base32')
    value = (value << 5) | index
    bits += 5
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff)
      bits -= 8
    }
  }
  return Buffer.from(out)
}

/** otpauth:// URI for authenticator apps (the key is the raw secret's bytes, base32-encoded). */
export function otpauthUri(secret: string, account: string, issuer = 'BCS'): string {
  const label = encodeURIComponent(`${issuer}:${account}`)
  const params = new URLSearchParams({ secret: base32(Buffer.from(secret, 'utf8')), issuer, digits: String(TOTP_DIGITS), period: String(TOTP_PERIOD_SECONDS) })
  return `otpauth://totp/${label}?${params.toString()}`
}
