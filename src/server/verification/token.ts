import { createHash, createHmac } from 'node:crypto'
import { getEnv } from '@/lib/env'
import { keyId, parseEncryptionKey } from '@/server/crypto/secret-box'

// The token of a printed document's QR (S6-19 · BR-QR-01 · ADR-109): base64url(HMAC-SHA256(K, the DocumentVerification
// row's id)) with K = HMAC-SHA256(ENCRYPTION_KEY, "bcs:document-verification:v1") — derived from the encryption key like
// the PIN pepper, never the key itself. The token is computed again from the row whenever the PDF is printed, so the
// same row always prints the same QR, and nothing about the document can be read from it. The database keeps only
// tokenHash = sha256 of the token string (its UTF-8 bytes) as 64 lowercase hex digits: the one form /verify and S17's
// scan look a token up by.

const CONTEXT = 'bcs:document-verification:v1'

export interface VerificationKey {
  readonly key: Buffer
  /** Which encryption key K came from (the first 8 hex digits of its sha256, as sealed secrets name it) */
  readonly keyId: string
}

let current: VerificationKey | null = null

/** K of the current ENCRYPTION_KEY */
export function verificationKey(): VerificationKey {
  if (!current) {
    const encryptionKey = parseEncryptionKey(getEnv().ENCRYPTION_KEY)
    current = { key: createHmac('sha256', encryptionKey).update(CONTEXT).digest(), keyId: keyId(encryptionKey) }
  }
  return current
}

/** The token of a DocumentVerification row: base64url, 43 characters */
export function verificationToken(rowId: string, key: VerificationKey = verificationKey()): string {
  return createHmac('sha256', key.key).update(rowId).digest('base64url')
}

/** sha256 of the token string as 64 lowercase hex digits */
export function verificationTokenHash(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex')
}

/** A string that could be a token: base64url of 32 bytes */
export const looksLikeToken = (value: string) => /^[A-Za-z0-9_-]{43}$/.test(value)
