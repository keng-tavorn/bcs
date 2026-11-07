import { createHash, randomBytes, randomInt } from 'node:crypto'
import { OTP_CODE_SPACE } from '@/lib/constants'

// Secrets of the portal (BR-PORTAL ข้อ 01 ถึง 03): links, session ids and CSRF tokens are 32 random bytes; the database
// keeps only their sha256 (hex, 64 characters, as the CHECKs of S7-01 require). IPs and user agents are kept as hashes
// too, never in clear (NFR-SEC-09).

/** 32 random bytes as base64url: a link token, a session id or a CSRF token */
export const newSecret = (): string => randomBytes(32).toString('base64url')

export const sha256Hex = (text: string): string => createHash('sha256').update(text).digest('hex')

/** A six-digit one-time code from the CSPRNG, zero-padded (BR-PORTAL ข้อ 02) */
export const newOtpCode = (): string => String(randomInt(0, OTP_CODE_SPACE)).padStart(6, '0')

/** What a challenge stores of its code: sha256 of `<challengeId>:<code>` (BR-PORTAL ข้อ 02) */
export const otpCodeHash = (challengeId: string, code: string): string => sha256Hex(`${challengeId}:${code}`)

/** The hash of an IP or a user agent, salted by its kind so the two never compare equal */
export const ipHash = (ip: string): string => sha256Hex(`ip:${ip}`)
export const userAgentHash = (userAgent: string): string => sha256Hex(`ua:${userAgent}`)
