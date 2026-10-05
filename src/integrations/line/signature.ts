import { createHmac, timingSafeEqual } from 'node:crypto'

// x-line-signature (BR-LINE-03): base64 of HMAC-SHA256 over the raw request body, keyed with the channel secret as
// text. The webhook checks it on the raw bytes before parsing anything, and compares in constant time.

const SIGNATURE_BYTES = 32
/** base64 of 32 bytes: 43 characters and one "=" */
const SIGNATURE_TEXT = /^[A-Za-z0-9+/]{43}=$/

/** The x-line-signature LINE sends with this body for this channel. */
export function lineSignature(channelSecret: string, rawBody: string | Uint8Array): string {
  if (channelSecret === '') throw new TypeError('a channel secret is required')
  return createHmac('sha256', channelSecret).update(rawBody).digest('base64')
}

/** True only when `header` is exactly the signature of `rawBody` (constant-time; any other form is refused). */
export function isValidLineSignature(channelSecret: string, rawBody: string | Uint8Array, header: string | null | undefined): boolean {
  if (!header || !SIGNATURE_TEXT.test(header) || channelSecret === '') return false
  const given = Buffer.from(header, 'base64')
  const expected = createHmac('sha256', channelSecret).update(rawBody).digest()
  return given.length === SIGNATURE_BYTES && timingSafeEqual(given, expected)
}
