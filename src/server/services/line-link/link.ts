import { z } from 'zod'
import { err, ok, type AppError, type Result } from '@/core/result'
import { isLineApiError, LINE_USER_ID_IN_PATH } from '@/integrations/line'
import { systemClock } from '@/lib/clock'
import { LIFF_ID_TOKEN_MAX_LENGTH } from '@/lib/constants'
import { getEnv } from '@/lib/env'
import { newId } from '@/lib/ids'
import { logger } from '@/lib/logger'
import { verifyLiffIdToken } from '@/server/auth/liff'
import { authorize } from '@/server/authz'
import { actorMemberId, makeCtx, type Ctx } from '@/server/context'
import { lockRowsForUpdate } from '@/server/db/sql/locks'
import { countRateLimited } from '@/server/db/sql/rate-limit'
import { forTenant, type TenantTx } from '@/server/db/tenant'
import type { OutboxSender } from '@/server/events/outbox'
import type { NotificationDraft } from '@/server/notifications/create'
import { checkLineLinkCode, LINE_LINK_CODE_MAX_LENGTH, LINE_LINK_CODE_TTL_MS, signLineLinkCode, type LineLinkCodeCheck } from '@/server/line/link-code'
import { lineLinkedMessages } from '@/server/line/link-messages'
import { liffLink } from '@/server/line/webhook/messages'
import { StoredLineEvent } from '@/server/line/webhook/body'
import { lockLineChannelForLinking, openLineChannel } from '../line-channel'
import { defineCommand, runCommand, type CommandOutcome } from '../_pipeline'
import { lineLinkRefusal, refusedCommand } from './refusals'
import { switchLineRichMenuNow } from './rich-menu'

// Linking a member's LINE account (FR-LINE-001 AC1 AC2 AC3, §9.2 steps 1 to 4, S5 sub-spec row "ผูกบัญชี").
//  1. The signed-in member asks for a one-time code (issueLineLinkCode, self.lineLink): nothing is written; the screen
//     draws the QR of `url`, the LIFF page /liff/link?code=… in LINE. Starting from LINE instead (AC2), the LIFF page
//     signs in with e-mail, password and the authenticator first (Better Auth, as on the web), then asks for a code the
//     same way and goes on with step 2.
//  2. The LIFF page shows whose account the code links (previewLineLinkCode: the organization and the member's name,
//     read only, LINE not asked) and waits for the person to confirm with a tap: a code someone else sent would link the
//     opener's LINE account to the sender's member, so the page never posts on its own from a URL.
//  3. On the tap the page posts { code, idToken } to /api/liff/link (linkLineAccount). The code is checked here first —
//     signature, age, its organization and member — so a guessed or changed code never makes BCS call LINE; then the
//     member's link requests are counted (LINE_LINK_ATTEMPTS_MAX within the code's lifetime, NFR-SEC-05), so nobody
//     holding codes can make BCS hammer LINE's verify endpoint that every LIFF sign-in needs. The ID token is checked by
//     LINE's verify endpoint as a LIFF sign-in checks it (BR-LINE-02, verifyLiffIdToken); its `sub` is the LINE user
//     id, and nothing the browser says about the user is read (BR-LINE-01).
//  4. Command line.link, as the member the code names, on channel LIFF: under the Organization row lock the channel save
//     takes (lockLineChannelForLinking), the channel must be switched on with this environment's LIFF app; the member
//     must still be ACTIVE; the LINE account must not be linked to anyone in the organization and the member to no other
//     LINE account (one live link each, AC3; the partial unique indexes of ChannelIdentity hold the same); a code issued
//     before the member's last unlink no longer links (unlinking ends the codes shown before it); then the code is spent
//     by inserting its sha256 into ChannelLinkCode (unique: once), and the ChannelIdentity is made with providerKey =
//     the channel's provider (LINE user ids differ per provider). Event line.linked, and in the same transaction the
//     security notice to the member's e-mail (security.notice LINE_LINKED, ADR-049 item 10).
//     Member.lineReachable follows the last follow or unfollow LINE sent for this LINE user (BR-LINE-08), true when it
//     sent none: it describes this LINE account from now on, not one linked before.
//  5. After the commit: the LINKED rich menu for this user at once (job line-rich-menu tries again when LINE fails, and
//     the member's next follow sets it when LINE did not keep it) and a welcome message (a push with the link's id as
//     retry key, so a retried link never sends it twice). Neither can turn the answer into a failure: the link stands.
// The idempotency key is the code's hash: sending the same request again replays its answer; the same code with
// another LINE account is the same key with other input, refused as TOKEN_USED.

/** Link requests the codes of one member may make within LINE_LINK_CODE_TTL_MS before LINE is no longer asked */
export const LINE_LINK_ATTEMPTS_MAX = 10

const LinkRequest = z.strictObject({
  code: z.string().min(1).max(LINE_LINK_CODE_MAX_LENGTH),
  idToken: z.string().min(1).max(LIFF_ID_TOKEN_MAX_LENGTH),
})
export type LinkLineAccountRequest = z.input<typeof LinkRequest>

const LinkLineInput = z.strictObject({
  codeHash: z.string().regex(/^[0-9a-f]{64}$/),
  codeIssuedAt: z.iso.datetime({ offset: true }),
  codeExpiresAt: z.iso.datetime({ offset: true }),
  lineUserId: z.string().regex(LINE_USER_ID_IN_PATH),
  /** The LIFF channel whose ID token was verified: the organization's channel must use it (ADR-024) */
  liffChannelId: z.string().min(1),
})

export interface LineLinkResult {
  readonly identityId: string
  readonly memberId: string
}

const forbidden = (message: string) => ({ ok: false, error: { code: 'FORBIDDEN', message } }) as const

/** A code issued before the member's last unlink: the unlink ended it (refused like an expired code, with this reason) */
const UNLINKED_SINCE: AppError = { code: 'TOKEN_EXPIRED', message: 'the link code was issued before the last unlink', details: { reason: 'UNLINKED_SINCE' } }

/** When the member's last LINE link ended; null when none ended yet */
async function lastUnlinkedAt(tx: TenantTx, memberId: string): Promise<Date | null> {
  const last = await tx.channelIdentity.findFirst({
    where: { memberId, channel: 'LINE', unlinkedAt: { not: null } },
    orderBy: { unlinkedAt: 'desc' },
    select: { unlinkedAt: true },
  })
  return last?.unlinkedAt ?? null
}

/** The code was issued before the member's last unlink (on the same security clock as the codes) */
async function endedByUnlink(tx: TenantTx, memberId: string, issuedAt: Date): Promise<boolean> {
  const ended = await lastUnlinkedAt(tx, memberId)
  return ended !== null && issuedAt.getTime() <= ended.getTime()
}

/**
 * Member.lineReachable for a LINE user from the follow and unfollow events LINE sent about them in the active mode, the
 * last by LINE's time deciding; null when LINE sent none. Every recorded one counts, whatever its processing said: an
 * unfollow of a user who was not linked yet was skipped then (nobody to mark), but it still says the user blocked the
 * account.
 */
async function reachableFromLine(tx: TenantTx, lineUserId: string): Promise<boolean | null> {
  const rows = await tx.lineWebhookEvent.findMany({
    where: {
      type: { in: ['follow', 'unfollow'] },
      AND: [{ payload: { path: ['userId'], equals: lineUserId } }, { payload: { path: ['mode'], equals: 'active' } }],
    },
    select: { type: true, payload: true, receivedAt: true },
  })
  let last: { type: string; at: number } | null = null
  for (const row of rows) {
    const payload = StoredLineEvent.safeParse(row.payload)
    const at = payload.success && payload.data.occurredAt ? Date.parse(payload.data.occurredAt) : row.receivedAt.getTime()
    if (!last || at > last.at) last = { type: row.type, at }
  }
  return last === null ? null : last.type === 'follow'
}

export const linkLineCommand = defineCommand({
  name: 'line.link',
  capability: 'self.lineLink',
  input: LinkLineInput,
  async execute(tx, input, ctx): Promise<CommandOutcome<LineLinkResult>> {
    const memberId = actorMemberId(ctx)
    if (!memberId) return forbidden('a member links their own LINE account')
    // Only the member themself, and only while ACTIVE (an invited or deactivated member holds no capability)
    const allowed = await authorize(tx, ctx, 'self.lineLink', { ownerMemberIds: [memberId] })
    if (!allowed.ok) return { ok: false, error: allowed.error }
    // The Organization row lock comes first (the channel save takes it too): the provider cannot change under the link
    const channel = await lockLineChannelForLinking(tx, ctx.organizationId)
    if (!channel?.active) return refusedCommand('LINE_NOT_ENABLED')
    // One query at a time on the transaction's connection
    const config = await tx.lineChannelConfig.findFirst({ select: { liffChannelId: true } })
    const organization = await tx.organization.findUnique({ where: { id: ctx.organizationId }, select: { status: true } })
    // A LIFF sign-in accepts the links of an active organization whose channel uses this LIFF app only (liff.ts)
    if (config?.liffChannelId !== input.liffChannelId || organization?.status !== 'ACTIVE') return refusedCommand('LINE_NOT_ENABLED')
    // The member may have been deactivated since the check above: read again under their row lock
    await lockRowsForUpdate(tx, 'Member', ctx.organizationId, [memberId])
    const member = await tx.member.findUnique({ where: { id: memberId }, select: { status: true, userId: true } })
    if (member?.status !== 'ACTIVE' || !member.userId) return forbidden('the member is not active')
    const account = await tx.channelIdentity.findFirst({
      where: { channel: 'LINE', providerKey: channel.providerId, externalUserId: input.lineUserId, unlinkedAt: null },
      select: { memberId: true },
    })
    if (account) return refusedCommand(account.memberId === memberId ? 'ALREADY_LINKED' : 'ACCOUNT_LINKED_TO_ANOTHER_MEMBER')
    const own = await tx.channelIdentity.findFirst({ where: { memberId, channel: 'LINE', unlinkedAt: null }, select: { id: true } })
    if (own) return refusedCommand('MEMBER_LINKED_TO_ANOTHER_ACCOUNT')
    // Unlinking ends every code shown before it (a QR photographed earlier dies with the link); under the member lock,
    // which the unlink and a deactivation take too
    if (await endedByUnlink(tx, memberId, new Date(input.codeIssuedAt))) return { ok: false, error: UNLINKED_SINCE }
    // The code works once: its hash is unique per organization (a refusal above rolls this back with the savepoint)
    const spent = await tx.channelLinkCode.createMany({
      data: [{ organizationId: ctx.organizationId, memberId, codeHash: input.codeHash, expiresAt: new Date(input.codeExpiresAt), usedAt: ctx.now }],
      skipDuplicates: true,
    })
    if (spent.count !== 1) return { ok: false, error: { code: 'TOKEN_USED', message: 'the link code was used already' } }
    const identityId = newId()
    await tx.channelIdentity.create({
      data: { id: identityId, organizationId: ctx.organizationId, memberId, channel: 'LINE', providerKey: channel.providerId, externalUserId: input.lineUserId, linkedAt: ctx.now },
    })
    // Delivery bookkeeping (§4.7 rule 2), about this LINE account from now on
    const reachable = (await reachableFromLine(tx, input.lineUserId)) ?? true
    await tx.member.update({ where: { id: memberId }, data: { lineReachable: reachable } })
    return {
      ok: true,
      result: { identityId, memberId },
      events: [{ type: 'line.linked', aggregateType: 'ChannelIdentity', aggregateId: identityId, data: { memberId } }],
      // ADR-049 item 10: the account owner hears of every link at once, by e-mail only like the other security notices
      // (§10.1), so a QR or link someone else used to link their own LINE account is noticed and undone. One per link
      // (the dedupe key is the link's id); it names nothing of the LINE account — no LINE user id (NFR-SEC-09)
      notifications: [lineLinkedNotice(memberId, identityId)],
    }
  },
})

/** The security notice of a new link (security.notice, kind LINE_LINKED, to the member's own account) */
function lineLinkedNotice(memberId: string, identityId: string): NotificationDraft {
  return {
    recipientMemberId: memberId,
    templateKey: 'security.notice',
    data: { kind: 'LINE_LINKED' },
    urgency: 'IMMEDIATE',
    dedupeKey: `security.notice:line_linked:${identityId}`,
    subjectType: 'Member',
    subjectId: memberId,
  }
}

// ---------- step 1: the code ----------

export interface LineLinkCodeDto {
  /** The one-time code (a bearer secret for 10 minutes: keep it in the page only, never in a log) */
  readonly code: string
  /** The LIFF page that links in LINE (https://liff.line.me/<LIFF ID>/link?code=…): the QR's content and the link */
  readonly url: string
  readonly expiresAt: string
}

/** Whether LINE can be linked in the organization now, as a LIFF sign-in will need it: switched on, with this LIFF app */
function lineReady(channel: { readonly active: boolean; readonly liffId: string | null; readonly liffChannelId: string | null } | null): channel is {
  readonly active: true
  readonly liffId: string
  readonly liffChannelId: string
} {
  const liffChannelId = getEnv().LINE_LIFF_CHANNEL_ID
  return Boolean(channel?.active && channel.liffId && liffChannelId && channel.liffChannelId === liffChannelId)
}

/**
 * Step 1 (self.lineLink): a one-time code for the signed-in member, on the security clock. Refused when LINE is not set
 * up here (LINE_NOT_ENABLED) or the member is linked already (ALREADY_LINKED: unlink first). Writes nothing.
 */
export async function issueLineLinkCode(ctx: Ctx, securityNow: Date = systemClock.now()): Promise<Result<LineLinkCodeDto>> {
  const memberId = actorMemberId(ctx)
  if (!memberId) return err('FORBIDDEN', 'a member links their own LINE account')
  return forTenant(ctx.organizationId).$transaction(async (tx): Promise<Result<LineLinkCodeDto>> => {
    const allowed = await authorize(tx, ctx, 'self.lineLink', { ownerMemberIds: [memberId] })
    if (!allowed.ok) return { ok: false, error: allowed.error }
    const channel = await tx.lineChannelConfig.findFirst({ select: { active: true, liffId: true, liffChannelId: true } })
    if (!lineReady(channel)) return { ok: false, error: lineLinkRefusal('LINE_NOT_ENABLED') }
    const live = await tx.channelIdentity.findFirst({ where: { memberId, channel: 'LINE', unlinkedAt: null }, select: { id: true } })
    if (live) return { ok: false, error: lineLinkRefusal('ALREADY_LINKED') }
    const { code, expiresAt } = signLineLinkCode({ organizationId: ctx.organizationId, memberId }, securityNow)
    return ok({ code, url: liffLink(channel.liffId, `/link?code=${encodeURIComponent(code)}`), expiresAt: expiresAt.toISOString() })
  })
}

export interface MyLineLinkDto {
  /** LINE can be linked here now: the organization's channel is on, with this environment's LIFF app */
  readonly available: boolean
  readonly linked: boolean
  readonly linkedAt: string | null
  /** Member.lineReachable: false once the member blocked the account (BR-LINE-08); e-mail is used instead */
  readonly reachable: boolean
}

/** The member's own link, for /settings/line and the LIFF pages (self.lineLink). Never the LINE user id. */
export async function getMyLineLink(ctx: Ctx): Promise<Result<MyLineLinkDto>> {
  const memberId = actorMemberId(ctx)
  if (!memberId) return err('FORBIDDEN', 'members only')
  return forTenant(ctx.organizationId).$transaction(async (tx): Promise<Result<MyLineLinkDto>> => {
    const allowed = await authorize(tx, ctx, 'self.lineLink', { ownerMemberIds: [memberId] })
    if (!allowed.ok) return { ok: false, error: allowed.error }
    const channel = await tx.lineChannelConfig.findFirst({ select: { active: true, liffId: true, liffChannelId: true } })
    const live = await tx.channelIdentity.findFirst({ where: { memberId, channel: 'LINE', unlinkedAt: null }, select: { linkedAt: true } })
    const member = await tx.member.findUniqueOrThrow({ where: { id: memberId }, select: { lineReachable: true } })
    return ok({ available: lineReady(channel), linked: live !== null, linkedAt: live?.linkedAt.toISOString() ?? null, reachable: member.lineReachable })
  })
}

// ---------- step 2: what the code links, before the tap ----------

const PreviewRequest = z.strictObject({ code: z.string().min(1).max(LINE_LINK_CODE_MAX_LENGTH) })
export type PreviewLineLinkCodeRequest = z.input<typeof PreviewRequest>

export interface LineLinkPreviewDto {
  /** The organization the code links into: its display name, or its legal name */
  readonly organizationName: string
  /** The member the code links (whoever opened the code checks that this is them before the tap) */
  readonly memberNameTh: string
  readonly memberNameEn: string | null
  readonly expiresAt: string
}

/** The answer to a code that is not one of this server's, or is too old */
function codeRefusal(check: Extract<LineLinkCodeCheck, { ok: false }>): Result<never> {
  return check.reason === 'EXPIRED' ? err('TOKEN_EXPIRED', 'the link code has expired') : err('TOKEN_INVALID', 'not a link code of this server')
}

/**
 * Step 2, for the LIFF page /liff/link before anything is linked: whose account the code links — the organization and
 * the member's name, nothing else about them — so the person who opened it sees it is their own account and confirms
 * with a tap. Reads only: LINE is not asked and nothing is written. The code itself is the credential (signed by this
 * server for that member), as an e-mail action link is. Refusals as the link answers them: VALIDATION_FAILED,
 * TOKEN_INVALID, TOKEN_EXPIRED (also { reason: UNLINKED_SINCE }), TOKEN_USED, FORBIDDEN (the member is not active),
 * INVALID_STATE_TRANSITION { reason: LINE_NOT_ENABLED }.
 */
export async function previewLineLinkCode(request: unknown, options: { readonly now?: Date } = {}): Promise<Result<LineLinkPreviewDto>> {
  const parsed = PreviewRequest.safeParse(request)
  if (!parsed.success) return err('VALIDATION_FAILED', 'the body is { code }', { field: parsed.error.issues[0]?.path.join('.') || '(body)' })
  const code = checkLineLinkCode(parsed.data.code, options.now ?? systemClock.now())
  if (!code.ok) return codeRefusal(code)
  return forTenant(code.organizationId).$transaction(async (tx): Promise<Result<LineLinkPreviewDto>> => {
    const organization = await tx.organization.findUnique({ where: { id: code.organizationId }, select: { status: true, displayName: true, legalNameTh: true } })
    const channel = await tx.lineChannelConfig.findFirst({ select: { active: true, liffId: true, liffChannelId: true } })
    if (organization?.status !== 'ACTIVE' || !lineReady(channel)) return { ok: false, error: lineLinkRefusal('LINE_NOT_ENABLED') }
    const member = await tx.member.findUnique({ where: { id: code.memberId }, select: { status: true, userId: true, displayNameTh: true, displayNameEn: true } })
    if (member?.status !== 'ACTIVE' || !member.userId) return err('FORBIDDEN', 'the member is not active')
    if (await tx.channelLinkCode.findFirst({ where: { codeHash: code.codeHash }, select: { id: true } })) return err('TOKEN_USED', 'the link code was used already')
    if (await endedByUnlink(tx, code.memberId, code.issuedAt)) return { ok: false, error: UNLINKED_SINCE }
    return ok({
      organizationName: organization.displayName ?? organization.legalNameTh,
      memberNameTh: member.displayNameTh,
      memberNameEn: member.displayNameEn,
      expiresAt: code.expiresAt.toISOString(),
    })
  })
}

// ---------- step 3: POST /api/liff/link ----------

export interface LinkLineAccountOptions {
  /** Security clock; real time unless a test gives its own */
  readonly now?: Date
  readonly requestId?: string
  /** Outbox sender override (tests); see RunOptions */
  readonly sender?: OutboxSender | null
}

export interface LineLinkedDto {
  readonly linked: true
}

/**
 * Step 3 and 4 for the LIFF page, after the person confirmed: the code, the member's count of link requests, the ID
 * token, then command line.link. Answers TOKEN_INVALID (a code this server did not make, or changed), TOKEN_EXPIRED
 * (also { reason: UNLINKED_SINCE }), TOKEN_USED, RATE_LIMITED { reason: LINK_ATTEMPTS, time } (LINE is not asked),
 * UNAUTHENTICATED { reason: ID_TOKEN_INVALID }, EXTERNAL_SERVICE_ERROR { service: LINE } (LINE could not be asked),
 * FORBIDDEN (the member is not active), INVALID_STATE_TRANSITION { reason } (./refusals.ts), VALIDATION_FAILED (a body
 * other than { code, idToken }).
 */
export async function linkLineAccount(request: unknown, options: LinkLineAccountOptions = {}): Promise<Result<LineLinkedDto>> {
  const parsed = LinkRequest.safeParse(request)
  if (!parsed.success) return err('VALIDATION_FAILED', 'the body is { code, idToken }', { field: parsed.error.issues[0]?.path.join('.') || '(body)' })
  const now = options.now ?? systemClock.now()
  const code = checkLineLinkCode(parsed.data.code, now)
  if (!code.ok) return codeRefusal(code)
  // Counted before LINE is asked: only a valid code gets this far, and it names its member (NFR-SEC-05)
  const attempts = await countRateLimited(`bcs:line-link:${code.organizationId}:${code.memberId}`, LINE_LINK_CODE_TTL_MS, LINE_LINK_ATTEMPTS_MAX, now)
  if (!attempts.allowed) {
    logger.warn({ organizationId: code.organizationId, requestId: options.requestId ?? null, refusal: 'RATE_LIMITED' }, 'LINE link refused: too many link requests for one member')
    return err('RATE_LIMITED', 'too many link requests; try again later', { reason: 'LINK_ATTEMPTS', time: attempts.resetAt.toISOString() })
  }
  const verified = await verifyLiffIdToken(parsed.data.idToken, now)
  if (!verified.ok) {
    if (verified.reason === 'INVALID') return err('UNAUTHENTICATED', 'LINE did not accept the ID token', { reason: 'ID_TOKEN_INVALID' })
    if (verified.reason === 'UNAVAILABLE') return err('EXTERNAL_SERVICE_ERROR', 'LINE could not be asked about the ID token', { service: 'LINE' })
    return { ok: false, error: lineLinkRefusal('LINE_NOT_ENABLED') }
  }
  const ctx = makeCtx({
    organizationId: code.organizationId,
    actor: { type: 'USER', memberId: code.memberId },
    channel: 'LIFF',
    now,
    ...(options.requestId ? { requestId: options.requestId } : {}),
  })
  const linked = await runCommand(
    ctx,
    linkLineCommand,
    {
      codeHash: code.codeHash,
      codeIssuedAt: code.issuedAt.toISOString(),
      codeExpiresAt: code.expiresAt.toISOString(),
      lineUserId: verified.lineUserId,
      liffChannelId: getEnv().LINE_LIFF_CHANNEL_ID ?? '',
    },
    { idempotencyKey: `line-link:${code.codeHash}`, ...(options.sender === undefined ? {} : { sender: options.sender }) },
  )
  if (!linked.ok) {
    logger.info({ organizationId: ctx.organizationId, requestId: ctx.requestId, refusal: linked.error.code, reason: linked.error.details?.reason ?? null }, 'LINE link refused')
    // The same code with another LINE account: the code is spent
    if (linked.error.code === 'IDEMPOTENCY_CONFLICT') return err('TOKEN_USED', 'the link code was used already')
    return { ok: false, error: linked.error }
  }
  // Committed: nothing below may report the link as failed (as runCommand's own rule after the commit)
  await switchLineRichMenuNow(ctx.organizationId, linked.data.identityId)
  await welcome(ctx.organizationId, verified.lineUserId, linked.data.identityId)
  return ok({ linked: true })
}

/** §9.2 step 2: the welcome message, best effort (a LINE user who has not added the account yet cannot get it). Never throws. */
async function welcome(organizationId: string, lineUserId: string, identityId: string): Promise<void> {
  try {
    const opened = await openLineChannel(organizationId)
    if (!opened.ok) return
    // The link's id as X-Line-Retry-Key: a replayed link never sends it twice
    await opened.channel.api.pushMessage(lineUserId, lineLinkedMessages(), { retryKey: identityId })
  } catch (error) {
    logger.warn(
      { organizationId, identityId, ...(isLineApiError(error) ? { reason: error.reason, status: error.status } : { reason: 'UNEXPECTED' }) },
      'the welcome message of a new LINE link was not sent; the link stands',
    )
  }
}
