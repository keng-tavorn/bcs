import { openSecret, sealSecret, SecretBoxError } from '@/server/crypto/secret-box'
import type { LineSecretField } from '@/server/queries/line-channel'

// The channel secret and the channel access token of an organization are sealed with AES-256-GCM (NFR-SEC-07) bound to
// the organization and the field, so a value copied into another row or field does not open (src/server/crypto).

export const lineSecretContext = (organizationId: string, field: LineSecretField) => `LineChannelConfig:${organizationId}:${field}`

export function sealLineSecret(organizationId: string, field: LineSecretField, plaintext: string): string {
  return sealSecret(plaintext, lineSecretContext(organizationId, field))
}

/** The secret in clear, or null when the stored value does not open (another ENCRYPTION_KEY, a changed value). */
export function openLineSecret(organizationId: string, field: LineSecretField, sealed: string): string | null {
  try {
    return openSecret(sealed, lineSecretContext(organizationId, field))
  } catch (error) {
    if (error instanceof SecretBoxError) return null
    throw error
  }
}
