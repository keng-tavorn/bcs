import { z } from 'zod'

// How the identifiers of a LINE provider and its channels look in LINE Developers Console (§9.2), so a value pasted into
// the wrong field is refused when an ORG_ADMIN saves the channel settings (FR-ADM-006 AC2) instead of failing later
// at LINE. Kept lenient where LINE does not promise a format: a provider id is any short identifier.

/** Channel ids are numbers (10 digits today) */
export const LINE_CHANNEL_ID_PATTERN = /^\d{1,20}$/
/** The channel secret is 32 hexadecimal characters; it signs webhooks (BR-LINE-03) */
export const LINE_CHANNEL_SECRET_PATTERN = /^[0-9a-fA-F]{32}$/
/** A channel access token (long-lived from the console, or v2.1): base64 or JWT characters, no spaces */
export const LINE_ACCESS_TOKEN_PATTERN = /^[A-Za-z0-9+/=._-]{16,2048}$/
/** A LIFF ID is "<channel id of the LIFF or MINI App channel>-<suffix>", e.g. 1234567890-AbCdEfGh */
export const LIFF_ID_PATTERN = /^(\d{1,20})-[A-Za-z0-9]{1,32}$/
/** The provider id: LINE shows a number; anything short without spaces is accepted */
export const LINE_PROVIDER_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/

const trimmed = (pattern: RegExp, message: string) => z.string().trim().regex(pattern, message)

export const lineProviderId = trimmed(LINE_PROVIDER_ID_PATTERN, 'provider id: letters, digits, . _ - (at most 64)')
export const lineChannelId = trimmed(LINE_CHANNEL_ID_PATTERN, 'channel id: digits only')
export const lineChannelSecret = trimmed(LINE_CHANNEL_SECRET_PATTERN, 'channel secret: 32 hexadecimal characters')
export const lineAccessToken = trimmed(LINE_ACCESS_TOKEN_PATTERN, 'channel access token: 16 to 2048 characters without spaces')
export const liffId = trimmed(LIFF_ID_PATTERN, 'LIFF ID: <channel id>-<suffix>')

/** The channel id a LIFF ID belongs to (the digits before "-"), or null when it is not a LIFF ID. */
export function liffChannelIdOf(value: string): string | null {
  return LIFF_ID_PATTERN.exec(value.trim())?.[1] ?? null
}
