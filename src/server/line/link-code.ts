import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { MS_PER_MINUTE, MS_PER_SECOND } from '@/lib/constants'
import { getEnv } from '@/lib/env'

// The one-time code that links a member's LINE account (FR-LINE-001 AC1, §9.2 step 1, S5 sub-spec row "ผูกบัญชี"). The
// signed-in member asks for it (self.lineLink); the screen shows it as a QR and as the LIFF link /liff/link?code=…; the
// member opens it in LINE, and POST /api/liff/link spends it together with the LINE ID token. Issuing writes nothing: the
// code is an HMAC with BETTER_AUTH_SECRET over the organization, the member, when it was issued and a random nonce, so
// only this server makes one and nobody can change what it names. It lives LINE_LINK_CODE_TTL_MS on the security clock
// (real time, so e2e time travel never stretches it). The link records the sha256 of the code in ChannelLinkCode with
// usedAt (unique per organization), so a code links once. Every part has exactly one spelling (the base64url parts are
// checked to re-encode to themselves, the time has no leading zero), so no second spelling of a spent code passes
// with another hash. The code is a bearer secret for 10 minutes: it is never logged, stored in clear or put in an event.
// Not writing at issue differs from §9.2 step 1 ("/settings/line สร้าง ChannelLinkCode"), as the S5 sub-spec decided
// (ChannelLinkCode.usedAt is required): an issued code cannot be cancelled one by one. The link command refuses a code
// issued before the member's last unlink, so ending a link also ends every code shown before it; a newer code does not
// end an older one.
//
//   l1.<organization id>.<member id>.<issued at, ms since 1970>.<nonce>.<HMAC-SHA256>   (ids and nonce: 16 bytes)

/** How long a link code works after it was issued (FR-LINE-001 AC1: 10 minutes) */
export const LINE_LINK_CODE_TTL_MS = 10 * MS_PER_MINUTE
/** Servers of one deployment may disagree by a few seconds; a code issued further ahead than this is refused */
const CLOCK_SKEW_MS = 30 * MS_PER_SECOND
const CONTEXT = 'bcs/line-link-code/v1'
const NONCE_BYTES = 16
const CODE = /^l1\.([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{22})\.([1-9]\d{0,14})\.([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{43})$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
/** Longer than any code this module makes (about 130 characters): anything longer is refused unread */
export const LINE_LINK_CODE_MAX_LENGTH = 200

export interface LineLinkCodeSubject {
  readonly organizationId: string
  readonly memberId: string
}

const idPart = (uuid: string): string => {
  if (!UUID.test(uuid)) throw new TypeError('a link code names an organization and a member by their uuid')
  return Buffer.from(uuid.replace(/-/g, ''), 'hex').toString('base64url')
}

const uuidOf = (part: string): string => {
  const hex = Buffer.from(part, 'base64url').toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

const canonical = (part: string): boolean => Buffer.from(part, 'base64url').toString('base64url') === part

function mac(org: string, member: string, issuedAt: string, nonce: string): Buffer {
  return createHmac('sha256', getEnv().BETTER_AUTH_SECRET).update([CONTEXT, org, member, issuedAt, nonce].join('|')).digest()
}

/** The digest the link stores (ChannelLinkCode.codeHash): sha256 of the code, hexadecimal */
export function lineLinkCodeHash(code: string): string {
  return createHash('sha256').update(code).digest('hex')
}

/** A new code for this member, issued at `issuedAt` on the security clock; nothing is written. */
export function signLineLinkCode(subject: LineLinkCodeSubject, issuedAt: Date): { readonly code: string; readonly expiresAt: Date } {
  const org = idPart(subject.organizationId)
  const member = idPart(subject.memberId)
  const at = String(issuedAt.getTime())
  const nonce = randomBytes(NONCE_BYTES).toString('base64url')
  return { code: `l1.${org}.${member}.${at}.${nonce}.${mac(org, member, at, nonce).toString('base64url')}`, expiresAt: new Date(issuedAt.getTime() + LINE_LINK_CODE_TTL_MS) }
}

export type LineLinkCodeCheck =
  | {
      readonly ok: true
      readonly organizationId: string
      readonly memberId: string
      /** When it was issued, on the security clock: a code issued before the member's last unlink no longer links */
      readonly issuedAt: Date
      readonly expiresAt: Date
      /** What ChannelLinkCode.codeHash holds once the code is spent */
      readonly codeHash: string
    }
  /** MALFORMED: not a code of this form · NOT_VALID: not signed by this server (forged or changed) · EXPIRED: too old */
  | { readonly ok: false; readonly reason: 'MALFORMED' | 'NOT_VALID' | 'EXPIRED' }

/** Reads a code at `now` on the security clock. Whether it was spent already is the link command's to find out. */
export function checkLineLinkCode(code: string, now: Date): LineLinkCodeCheck {
  if (code.length > LINE_LINK_CODE_MAX_LENGTH) return { ok: false, reason: 'MALFORMED' }
  const m = CODE.exec(code)
  if (!m) return { ok: false, reason: 'MALFORMED' }
  const [, org, member, at, nonce, signature] = m as unknown as [string, string, string, string, string, string]
  if (![org, member, nonce, signature].every(canonical)) return { ok: false, reason: 'MALFORMED' }
  const given = Buffer.from(signature, 'base64url')
  const expected = mac(org, member, at, nonce)
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return { ok: false, reason: 'NOT_VALID' }
  const issuedAtMs = Number(at)
  const age = now.getTime() - issuedAtMs
  if (age >= LINE_LINK_CODE_TTL_MS || age < -CLOCK_SKEW_MS) return { ok: false, reason: 'EXPIRED' }
  return {
    ok: true,
    organizationId: uuidOf(org),
    memberId: uuidOf(member),
    issuedAt: new Date(issuedAtMs),
    expiresAt: new Date(issuedAtMs + LINE_LINK_CODE_TTL_MS),
    codeHash: lineLinkCodeHash(code),
  }
}
