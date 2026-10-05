import { randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { keyId, needsResealing, openSecret, parseEncryptionKey, sealedKeyId, sealSecret, SecretBoxError, type SecretKeyring } from '@/server/crypto/secret-box'

// NFR-SEC-07 · FR-ADM-006 AC2: the secrets of a tenant (the LINE channel secret and access token) are stored sealed with
// AES-256-GCM under ENCRYPTION_KEY, with a key id so the key can be rotated; a changed byte, another key or another
// context is refused, and no error repeats the secret or the key.

const key = () => new Uint8Array(randomBytes(32))
const ring = (current: Uint8Array, previous: Uint8Array[] = []): SecretKeyring => ({ current, previous })
const CONTEXT = 'LineChannelConfig:0198c6d2-0000-7000-8000-000000000001:channelSecret'
const SECRET = '0123456789abcdef0123456789abcdef'

function refusal(run: () => unknown): string {
  try {
    run()
  } catch (error) {
    expect(error).toBeInstanceOf(SecretBoxError)
    const message = (error as Error).message
    expect(message).not.toContain(SECRET)
    return (error as SecretBoxError).reason
  }
  throw new Error('expected the sealed value to be refused')
}

/** The sealed text with one byte of one segment flipped (segments: 2 = iv, 3 = ciphertext, 4 = tag) */
function flipped(sealed: string, segment: number): string {
  const parts = sealed.split('.')
  const bytes = Buffer.from(parts[segment]!, 'base64url')
  bytes[0] = bytes[0]! ^ 0x01
  parts[segment] = bytes.toString('base64url')
  return parts.join('.')
}

describe('[FR-ADM-006/AC2] secrets are sealed with AES-256-GCM and open only unchanged, with the same key and context', () => {
  it('round-trips ASCII, Thai and long values, in the versioned format with a key id and a 12-byte IV', () => {
    const k = key()
    for (const plain of [SECRET, 'รหัสลับของช่องทาง LINE 🍎', 'A'.repeat(4000)]) {
      const sealed = sealSecret(plain, CONTEXT, ring(k))
      expect(sealed).toMatch(/^v1\.[0-9a-f]{8}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/)
      const [, kid, iv, , tag] = sealed.split('.')
      expect(kid).toBe(keyId(k))
      expect(Buffer.from(iv!, 'base64url')).toHaveLength(12)
      expect(Buffer.from(tag!, 'base64url')).toHaveLength(16)
      expect(sealed).not.toContain(plain)
      expect(openSecret(sealed, CONTEXT, ring(k))).toBe(plain)
    }
  })

  it('uses a fresh random IV for every value, so the same secret never seals to the same text', () => {
    const k = key()
    const sealed = new Set(Array.from({ length: 50 }, () => sealSecret(SECRET, CONTEXT, ring(k))))
    expect(sealed.size).toBe(50)
    const ivs = new Set([...sealed].map((s) => s.split('.')[2]))
    expect(ivs.size).toBe(50)
  })

  it('refuses a changed IV, ciphertext or tag as TAMPERED', () => {
    const k = key()
    const sealed = sealSecret(SECRET, CONTEXT, ring(k))
    for (const segment of [2, 3, 4]) expect(refusal(() => openSecret(flipped(sealed, segment), CONTEXT, ring(k)))).toBe('TAMPERED')
  })

  it('refuses a value copied to another field or organization (the context is authenticated)', () => {
    const k = key()
    const sealed = sealSecret(SECRET, CONTEXT, ring(k))
    expect(refusal(() => openSecret(sealed, CONTEXT.replace('channelSecret', 'channelAccessToken'), ring(k)))).toBe('TAMPERED')
    expect(refusal(() => openSecret(sealed, CONTEXT.replace('0001', '0002'), ring(k)))).toBe('TAMPERED')
  })

  it('refuses the wrong key: an unknown key id, or a key id changed to the one of the key in use', () => {
    const k = key()
    const other = key()
    const sealed = sealSecret(SECRET, CONTEXT, ring(k))
    expect(refusal(() => openSecret(sealed, CONTEXT, ring(other)))).toBe('UNKNOWN_KEY')
    const relabelled = sealed.replace(`.${keyId(k)}.`, `.${keyId(other)}.`)
    expect(refusal(() => openSecret(relabelled, CONTEXT, ring(other)))).toBe('TAMPERED')
  })

  it('opens values of an earlier key kept in the keyring, and tells which values to seal again (rotation)', () => {
    const old = key()
    const current = key()
    const sealedBefore = sealSecret(SECRET, CONTEXT, ring(old))
    expect(openSecret(sealedBefore, CONTEXT, ring(current, [old]))).toBe(SECRET)
    expect(needsResealing(sealedBefore, ring(current, [old]))).toBe(true)
    const sealedNow = sealSecret(SECRET, CONTEXT, ring(current, [old]))
    expect(sealedKeyId(sealedNow)).toBe(keyId(current))
    expect(needsResealing(sealedNow, ring(current, [old]))).toBe(false)
  })

  it('refuses text that is not a sealed value of version 1', () => {
    const k = key()
    const sealed = sealSecret(SECRET, CONTEXT, ring(k))
    const [, kid, iv, ciphertext, tag] = sealed.split('.')
    expect(refusal(() => openSecret(SECRET, CONTEXT, ring(k)))).toBe('MALFORMED')
    expect(refusal(() => openSecret(sealed.split('.').slice(0, 4).join('.'), CONTEXT, ring(k)))).toBe('MALFORMED')
    expect(refusal(() => openSecret(`${sealed}.extra`, CONTEXT, ring(k)))).toBe('MALFORMED')
    expect(refusal(() => openSecret(['v1', kid, `${iv}=`, ciphertext, tag].join('.'), CONTEXT, ring(k)))).toBe('MALFORMED')
    expect(refusal(() => openSecret(['v1', kid, iv!.slice(2), ciphertext, tag].join('.'), CONTEXT, ring(k)))).toBe('MALFORMED')
    expect(refusal(() => openSecret(['v2', kid, iv, ciphertext, tag].join('.'), CONTEXT, ring(k)))).toBe('UNSUPPORTED_VERSION')
    expect(sealedKeyId('not sealed')).toBeNull()
  })

  it('reads ENCRYPTION_KEY as base64 of exactly 32 bytes and never repeats the value', () => {
    const raw = randomBytes(32)
    expect(Buffer.from(parseEncryptionKey(`base64:${raw.toString('base64')}`))).toEqual(raw)
    for (const value of ['base64:REPLACE_WITH_32_RANDOM_BYTES_BASE64', `base64:${randomBytes(16).toString('base64')}`, raw.toString('base64')]) {
      let message = ''
      try {
        parseEncryptionKey(value)
      } catch (error) {
        message = (error as Error).message
      }
      expect(message, value).toMatch(/ENCRYPTION_KEY/)
      expect(message).not.toContain(value)
    }
  })

  it('refuses to seal an empty secret or without a context (programming errors)', () => {
    const k = key()
    expect(() => sealSecret('', CONTEXT, ring(k))).toThrow(TypeError)
    expect(() => sealSecret(SECRET, ' ', ring(k))).toThrow(TypeError)
    expect(() => openSecret(sealSecret(SECRET, CONTEXT, ring(k)), '', ring(k))).toThrow(TypeError)
  })
})
