import { z } from 'zod'
import { PIN_FAILURE_LIMIT, PIN_LENGTH, PIN_LOCK_MINUTES } from '@/core/pin'
import { err, ok, type Result } from '@/core/result'
import { systemClock } from '@/lib/clock'
import { LIFF_ID_TOKEN_MAX_LENGTH, MS_PER_MINUTE } from '@/lib/constants'
import { logger } from '@/lib/logger'
import { verifyLiffIdToken } from '@/server/auth/liff'
import { endMemberLiffSessions } from '@/server/auth/liff-sessions'
import { authorize } from '@/server/authz'
import { actorMemberId, type Ctx } from '@/server/context'
import { countRateLimited } from '@/server/db/sql/rate-limit'
import { forTenant } from '@/server/db/tenant'
import type { OutboxSender } from '@/server/events/outbox'
import { LINE_LINK_CODE_TTL_MS } from '@/server/line/link-code'
import { issueLineLinkCode, LINE_LINK_ATTEMPTS_MAX, lineLinkRefusal, linkLineAccount, unlinkMyLine, type LineLinkedDto } from '../line-link'

// What the LIFF shell needs from the server besides the LINE link service (S5-06, §9.4): the facts the help page and the
// PIN field state (from the rules themselves, never written again in a page), the organization's administrators for the
// help page, FR-LINE-001 AC2 — a member who signed in with e-mail, password and 2FA inside LIFF links the LINE account
// the page was opened with — and, for /liff/link, whether the member's link is to the LINE account the page is open in
// and ending a link from there (FR-LINE-001 AC3).
//  - Linking from LIFF is the same trust path as a QR code: a one-time code is issued for the signed-in member
//    (issueLineLinkCode, self.lineLink) and spent at once with the LIFF ID token (linkLineAccount: the member's attempts
//    counted, LINE verifies the token, command line.link on channel LIFF). Nothing new is trusted.
//  - "This LINE" is the LINE user of the page's own ID token, verified by LINE (BR-LINE-01, BR-LINE-02), never the
//    member's link alone: a member signed in with a password in another person's or a new phone's LINE app is told that
//    their account is linked to another LINE account, not that this one is linked. Each such check asks LINE once, so a
//    member's checks are counted like their link requests (LINE_LINK_ATTEMPTS_MAX within LINE_LINK_CODE_TTL_MS).
//  - Unlinking from LIFF ends only the link the page showed: "this" LINE account's, or "the other" one's. Ending the link
//    of another LINE account needs the password sign-in (a web session): a session opened with LINE alone stands for
//    the LINE account it was opened with, and must not reach a link it does not stand for.
//  - A link ended or made from LIFF ends every LIFF session of the member's sign-in identity
//    (src/server/auth/liff-sessions.ts): moving the link to a new phone signs the old phone out at once, instead of
//    leaving its session to work again as soon as the new link stands. The LINE app that is linked signs in again by
//    itself; the password session of the page that made the change is kept.

export interface LiffFacts {
  /** Digits of a transaction PIN (FR-AUTH-005 AC1) */
  readonly pinLength: number
  /** Wrong PINs in a row that lock it, and for how long (FR-AUTH-005 AC3) */
  readonly pinFailureLimit: number
  readonly pinLockMinutes: number
  /** How long a link code works (§9.2) */
  readonly linkCodeMinutes: number
}

/** Product rules a LIFF page states; the same for everyone, no organization data */
export function liffFacts(): LiffFacts {
  return { pinLength: PIN_LENGTH, pinFailureLimit: PIN_FAILURE_LIMIT, pinLockMinutes: PIN_LOCK_MINUTES, linkCodeMinutes: LINE_LINK_CODE_TTL_MS / MS_PER_MINUTE }
}

export interface LiffAdministratorDto {
  readonly nameTh: string
  readonly nameEn: string | null
}

/**
 * The organization's administrators for the help page (§9.4 /liff/help: "ช่องทางติดต่อผู้ดูแล"): the active members
 * holding ORG_ADMIN now, by name only — no e-mail or phone (whether those may be shown is the user's decision; until
 * then names only). Any active member of the organization may read them, under self.lineLink (the LINE self-service of a
 * member, OWN scope; §2.4 has no grant of its own for this, §9.4 implies it); nobody else, not SYSTEM or a platform admin.
 */
export async function listLiffAdministrators(ctx: Ctx): Promise<Result<LiffAdministratorDto[]>> {
  const memberId = actorMemberId(ctx)
  if (!memberId) return err('FORBIDDEN', 'members only')
  return forTenant(ctx.organizationId).$transaction(async (tx): Promise<Result<LiffAdministratorDto[]>> => {
    const allowed = await authorize(tx, ctx, 'self.lineLink', { ownerMemberIds: [memberId] })
    if (!allowed.ok) return { ok: false, error: allowed.error }
    const admins = await tx.member.findMany({
      where: { status: 'ACTIVE', roleAssignments: { some: { role: 'ORG_ADMIN', revokedAt: null } } },
      select: { displayNameTh: true, displayNameEn: true },
      orderBy: [{ displayNameTh: 'asc' }, { id: 'asc' }],
    })
    return ok(admins.map((a) => ({ nameTh: a.displayNameTh, nameEn: a.displayNameEn })))
  })
}

const IdTokenOnly = z.strictObject({ idToken: z.string().min(1).max(LIFF_ID_TOKEN_MAX_LENGTH) })

const validationFailed = (error: z.ZodError, shape: string) => err('VALIDATION_FAILED', `the body is ${shape}`, { field: error.issues[0]?.path.join('.') || '(body)' })

export interface LinkThisLineOptions {
  /** Security clock; real time unless a test gives its own */
  readonly now?: Date
  /** Outbox sender override (tests) */
  readonly sender?: OutboxSender | null
}

/**
 * FR-LINE-001 AC2: the signed-in member (ctx, from a web sign-in with e-mail, password and 2FA inside LIFF) links the
 * LINE account whose ID token the LIFF page sends ({ idToken }). Answers as issueLineLinkCode and linkLineAccount do:
 * FORBIDDEN (not an active member), INVALID_STATE_TRANSITION { reason } (LINE_NOT_ENABLED, ALREADY_LINKED, …),
 * RATE_LIMITED, UNAUTHENTICATED { reason: ID_TOKEN_INVALID }, EXTERNAL_SERVICE_ERROR, VALIDATION_FAILED { field }.
 * The code never leaves the server.
 */
export async function linkThisLineAccount(ctx: Ctx, request: unknown, options: LinkThisLineOptions = {}): Promise<Result<LineLinkedDto>> {
  const parsed = IdTokenOnly.safeParse(request)
  if (!parsed.success) return validationFailed(parsed.error, '{ idToken }')
  const memberId = actorMemberId(ctx)
  const now = options.now ?? systemClock.now()
  const issued = await issueLineLinkCode(ctx, now)
  if (!issued.ok) return issued
  const linked = await linkLineAccount(
    { code: issued.data.code, idToken: parsed.data.idToken },
    { now, requestId: ctx.requestId, ...(options.sender === undefined ? {} : { sender: options.sender }) },
  )
  // A LIFF session opened before this link stood on an older one (a phone the member no longer uses)
  if (linked.ok && memberId) await endLiffSessionsAfterLinkChange(ctx, memberId, 'linked')
  return linked
}

/**
 * After a link of the member was made or ended from LIFF: every LIFF session of the member's sign-in identity ends
 * (src/server/auth/liff-sessions.ts). The change is committed and stands whatever happens here: a failure is logged
 * (no token, no LINE user id), and the LIFF pages refuse such a session anyway (liffSessionStandsForMember).
 */
async function endLiffSessionsAfterLinkChange(ctx: Ctx, memberId: string, change: 'linked' | 'unlinked'): Promise<void> {
  try {
    await endMemberLiffSessions(ctx.organizationId, memberId)
  } catch (error) {
    logger.warn(
      { organizationId: ctx.organizationId, requestId: ctx.requestId, change, reason: error instanceof Error ? error.name : 'UNEXPECTED' },
      'the LIFF sessions of a member were not ended after a LINE link change; LIFF pages refuse them anyway',
    )
  }
}

// ---------- which LINE account the member's link is, and ending it from LIFF ----------

/** The member's link seen from the LINE account a LIFF page is open in: that one, another one, or none */
export type ThisLineLink = 'this' | 'other' | 'none'

interface MemberLink {
  readonly memberId: string
  /** The member's live LINE link, if any */
  readonly link: { readonly id: string; readonly externalUserId: string; readonly providerKey: string } | null
  /** The provider of the organization's LINE channel (LINE user ids differ per provider, §9.2) */
  readonly providerId: string | null
}

/** The member's own live link (self.lineLink), read before anyone asks LINE about a token */
async function readMemberLink(ctx: Ctx): Promise<Result<MemberLink>> {
  const memberId = actorMemberId(ctx)
  if (!memberId) return err('FORBIDDEN', 'members only')
  return forTenant(ctx.organizationId).$transaction(async (tx): Promise<Result<MemberLink>> => {
    const allowed = await authorize(tx, ctx, 'self.lineLink', { ownerMemberIds: [memberId] })
    if (!allowed.ok) return { ok: false, error: allowed.error }
    // One query at a time on the transaction's connection
    const link = await tx.channelIdentity.findFirst({ where: { memberId, channel: 'LINE', unlinkedAt: null }, select: { id: true, externalUserId: true, providerKey: true } })
    const channel = await tx.lineChannelConfig.findFirst({ select: { providerId: true } })
    return ok({ memberId, link, providerId: channel?.providerId ?? null })
  })
}

/** The LINE user of the page's ID token, verified by LINE; the member's checks are counted first (NFR-SEC-05) */
async function verifiedLineUser(ctx: Ctx, memberId: string, idToken: string, now: Date): Promise<Result<string>> {
  const checks = await countRateLimited(`bcs:liff-line-check:${ctx.organizationId}:${memberId}`, LINE_LINK_CODE_TTL_MS, LINE_LINK_ATTEMPTS_MAX, now)
  if (!checks.allowed) return err('RATE_LIMITED', 'too many LINE checks; try again later', { reason: 'LINE_CHECKS', time: checks.resetAt.toISOString() })
  const verified = await verifyLiffIdToken(idToken, now)
  if (verified.ok) return ok(verified.lineUserId)
  if (verified.reason === 'INVALID') return err('UNAUTHENTICATED', 'LINE did not accept the ID token', { reason: 'ID_TOKEN_INVALID' })
  if (verified.reason === 'UNAVAILABLE') return err('EXTERNAL_SERVICE_ERROR', 'LINE could not be asked about the ID token', { service: 'LINE' })
  return { ok: false, error: lineLinkRefusal('LINE_NOT_ENABLED') }
}

const isThisLine = (read: MemberLink, lineUserId: string): boolean =>
  read.link !== null && read.link.externalUserId === lineUserId && read.link.providerKey === read.providerId

export interface ThisLineOptions {
  /** Security clock; real time unless a test gives its own */
  readonly now?: Date
}

/**
 * /liff/link for a linked member: is their link to the LINE account the page is open in ({ idToken } of that page)?
 * Reads only. Answers { link: this | other | none }, or FORBIDDEN (not an active member), VALIDATION_FAILED,
 * RATE_LIMITED { reason: LINE_CHECKS, time }, UNAUTHENTICATED { reason: ID_TOKEN_INVALID }, EXTERNAL_SERVICE_ERROR.
 * Never the LINE user id of either account.
 */
export async function whichLineIsLinked(ctx: Ctx, request: unknown, options: ThisLineOptions = {}): Promise<Result<{ readonly link: ThisLineLink }>> {
  const parsed = IdTokenOnly.safeParse(request)
  if (!parsed.success) return validationFailed(parsed.error, '{ idToken }')
  const read = await readMemberLink(ctx)
  if (!read.ok) return read
  if (!read.data.link) return ok({ link: 'none' })
  const lineUser = await verifiedLineUser(ctx, read.data.memberId, parsed.data.idToken, options.now ?? systemClock.now())
  if (!lineUser.ok) return lineUser
  return ok({ link: isThisLine(read.data, lineUser.data) ? 'this' : 'other' })
}

const UnlinkRequest = z.strictObject({ idToken: z.string().min(1).max(LIFF_ID_TOKEN_MAX_LENGTH), which: z.enum(['this', 'other']) })

/** An idempotency key of the page's submission: any short text, new for every submission */
const IDEMPOTENCY_KEY_MAX_LENGTH = 200

export interface UnlinkInLiffOptions {
  readonly idempotencyKey: string
  /** How the member signed in on this page: with LINE (liff) or with a password (web), read from the server's session */
  readonly signIn: 'liff' | 'web'
  /** Security clock; real time unless a test gives its own */
  readonly now?: Date
}

/**
 * FR-LINE-001 AC3 from the LINE side: the member ends the link the page showed — `which` "this" (the LINE account of
 * the page's ID token) or "other" (their link to another LINE account, before linking this one). The link must still be
 * the one the page showed (INVALID_STATE_TRANSITION { reason: LINK_CHANGED } otherwise, NOT_LINKED when there is none);
 * "other" needs the password sign-in (FORBIDDEN { reason: PASSWORD_SIGN_IN_REQUIRED } for a LINE sign-in). Then command
 * line.unlink for that link only (unlinkMyLine: Event line.unlinked, the rich menu back to UNLINKED), and every LIFF
 * session of the member's sign-in identity ends — the old phone's of "other", and this page's own for "this".
 */
export async function unlinkLineInLiff(ctx: Ctx, request: unknown, options: UnlinkInLiffOptions): Promise<Result<{ readonly unlinked: true }>> {
  const parsed = UnlinkRequest.safeParse(request)
  if (!parsed.success) return validationFailed(parsed.error, '{ idToken, which }')
  if (typeof options.idempotencyKey !== 'string' || options.idempotencyKey.length === 0 || options.idempotencyKey.length > IDEMPOTENCY_KEY_MAX_LENGTH) {
    return err('VALIDATION_FAILED', 'idempotencyKey is required', { field: 'idempotencyKey' })
  }
  const read = await readMemberLink(ctx)
  if (!read.ok) return read
  const link = read.data.link
  if (!link) return { ok: false, error: lineLinkRefusal('NOT_LINKED') }
  if (parsed.data.which === 'other' && options.signIn !== 'web') {
    return err('FORBIDDEN', 'ending the link of another LINE account needs the password sign-in', { reason: 'PASSWORD_SIGN_IN_REQUIRED' })
  }
  const lineUser = await verifiedLineUser(ctx, read.data.memberId, parsed.data.idToken, options.now ?? systemClock.now())
  if (!lineUser.ok) return lineUser
  if ((parsed.data.which === 'this') !== isThisLine(read.data, lineUser.data)) {
    return err('INVALID_STATE_TRANSITION', 'the LINE link is not the one the page showed', { reason: 'LINK_CHANGED' })
  }
  const ended = await unlinkMyLine(ctx, { identityId: link.id }, { idempotencyKey: options.idempotencyKey })
  if (!ended.ok) return ended
  await endLiffSessionsAfterLinkChange(ctx, read.data.memberId, 'unlinked')
  return ok({ unlinked: true })
}
