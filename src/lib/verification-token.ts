// The shape of a printed document's QR token (S6-19, BR-QR-01): base64url of HMAC-SHA256, 32 bytes, 43 characters. One
// definition for the server, which looks a token up (src/server/verification/token.ts), and for BCS Go's scan on the
// phone (src/ui/go-receive/scan.ts), which takes nothing else as a BCS QR (BR-APP-11).
export const VERIFICATION_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/

/** A string that could be a token */
export const looksLikeToken = (value: string): boolean => VERIFICATION_TOKEN_PATTERN.test(value)
