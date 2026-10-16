import { createHash } from 'node:crypto'

// A BCS Go device's push token at rest (BR-APP-12, NFR-SEC-07, S17-10): sealed with ENCRYPTION_KEY (src/server/crypto/
// secret-box.ts) under the context of its own row, so a sealed token copied to another row or organization does not
// open; its sha256 keeps one row in use per token (PushDevice_token_in_use). Shared by push-devices (which seals) and
// deliverNotification (which opens). A token is never logged (NFR-SEC-09).

/** sha256 of the token, 64 lower-case hex (the CHECK of PushDevice.tokenHash) */
export const pushTokenHash = (token: string): string => createHash('sha256').update(token, 'utf8').digest('hex')

/** The associated data of a sealed token */
export const pushTokenContext = (organizationId: string, deviceId: string): string => `PushDevice:${organizationId}:${deviceId}:token`
