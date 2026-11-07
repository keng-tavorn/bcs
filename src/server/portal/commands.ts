import { z } from 'zod'
import { err, ok, type AppError, type Result } from '@/core/result'
import { verifyOtp as checkOtp } from '@/core/supplier-onboarding'
import { MS_PER_DAY, MS_PER_HOUR, MS_PER_MINUTE } from '@/lib/constants'
import { newId } from '@/lib/ids'
import { logger } from '@/lib/logger'
import { supplierSettingsOf } from '@/lib/org-settings'
import { PORTAL_NEW_DEVICE_DAYS } from '@/lib/portal-limits'
import { systemCtx, type Ctx } from '@/server/context'
import { lockRowsForUpdate } from '@/server/db/sql/locks'
import { forTenant, type TenantTx } from '@/server/db/tenant'
import { appendEvents, type EventDraft } from '@/server/events/append'
import { enqueueSupplierNotice } from '@/server/notifications/supplier-notices'
import { PORTAL_SUPPLIER_TEMPLATES } from '@/server/notifications/supplier-templates-portal'
import { defineCommand, runCommand, type CommandOutcome } from '@/server/services/_pipeline'
import { ipHash, newOtpCode, newSecret, otpCodeHash, sha256Hex, userAgentHash } from './crypto'
import { issuePortalLink } from './links'
import type { PortalOrg } from './org'
import { PORTAL_PRIVACY_NOTICE_VERSION } from './privacy'
import { hitIpLimit, hitScopeLimit, type LimitVerdict } from './rate-limit'
import { CONTACT_SELECT, contactMayEnter, portalCtx, type PortalSessionState } from './session'

// The portal's sign-in (S7-04 · ADR-183 · BR-PORTAL ข้อ 01 ถึง ข้อ 04 · docs/sub-specs/S7.md "คำสั่งของขั้น"): an e-mail asks
// for a LOGIN link → the link, used once by a POST, sends a six-digit code → the code, from the same browser, IP and
// user agent that used the link, opens a new session. Every step that knows its contact runs as that contact
// (actor SUPPLIER, channel PORTAL · INV-SUP-05); an e-mail nobody holds is answered exactly as one that is known. No
// code, token, e-mail address or IP reaches an event or a log; the secrets the browser keeps are made here and only
// their hashes go into a command, so CommandLog never holds one either.

/** What a request to the portal brings besides its form */
export interface PortalRequestMeta {
  readonly ip: string
  readonly userAgent: string
  readonly now: Date
  readonly requestId?: string
}

/** S7-05 registers here what a first sign-in of an application's contact moves (INVITED → DRAFT, EXISTING → APPROVED) */
export type SignedInHook = (tx: TenantTx, ctx: Ctx, contact: { readonly id: string; readonly applicationId: string | null; readonly supplierId: string | null }) => Promise<readonly EventDraft[]>
const signedInHooks: SignedInHook[] = []
export function onPortalSignedIn(hook: SignedInHook): void {
  signedInHooks.push(hook)
}

const RATE_LIMITED: AppError = { code: 'RATE_LIMITED', message: 'too many requests; try again later' }
const HEX64 = z.string().regex(/^[0-9a-f]{64}$/)

/**
 * Over a limit: the answer, and — for the first refusal of the window only, so a flood never fills the append-only
 * Event table — an event security.rate_limited (by the system: the requester may be nobody yet)
 */
async function rateLimited(org: PortalOrg, now: Date, verdict: LimitVerdict, scopeKind: 'IP' | 'CONTACT', bucket: 'LINK' | 'OTP', contactId: string | null): Promise<Result<never>> {
  if (verdict === 'OVER') return { ok: false, error: RATE_LIMITED }
  try {
    await forTenant(org.organizationId).$transaction((tx) =>
      appendEvents(tx, systemCtx(org.organizationId, now, 'portal-rate-limit'), [
        { type: 'security.rate_limited', aggregateType: 'Security', aggregateId: org.organizationId, data: { scopeKind, bucket, contactId } },
      ]),
    )
  } catch (error) {
    logger.warn({ organizationId: org.organizationId, scopeKind, bucket, error: (error as Error).name }, 'portal rate limit event not written')
  }
  return { ok: false, error: RATE_LIMITED }
}

async function supplierSettings(tx: TenantTx, organizationId: string) {
  const org = await tx.organization.findUniqueOrThrow({ where: { id: organizationId }, select: { settings: true } })
  return supplierSettingsOf(org.settings)
}

// ---------- portal.requestLink: an e-mailed LOGIN link ----------

const requestLinkCommand = defineCommand({
  name: 'portal.requestLink',
  capability: 'portal.signIn',
  input: z.object({ orgCode: z.string().min(1).max(40) }),
  async execute(tx, input, ctx): Promise<CommandOutcome<{ sent: true }>> {
    if (ctx.actor.type !== 'SUPPLIER') return { ok: false, error: { code: 'FORBIDDEN', message: 'a contact asks for their own link' } }
    const contactId = ctx.actor.supplierContactId
    const link = await issuePortalLink(tx, { organizationId: ctx.organizationId, orgCode: input.orgCode, contactId, purpose: 'LOGIN', now: ctx.now })
    const notice = await enqueueSupplierNotice(tx, ctx, {
      templateKey: PORTAL_SUPPLIER_TEMPLATES.loginLink,
      contactId,
      subjectType: 'SupplierContact',
      subjectId: contactId,
      dedupeKey: `portal.login_link:${link.linkId}`,
      data: { url: link.url, expiresAt: link.expiresAt.toISOString() },
    })
    return {
      ok: true,
      result: { sent: true },
      events: [{ type: 'portal_session.link_requested', aggregateType: 'SupplierContact', aggregateId: contactId, data: { contactId, linkId: link.linkId, purpose: 'LOGIN' } }, ...notice.events],
      notifications: notice.notifications,
      outbox: notice.outbox,
    }
  },
})

/**
 * /portal/<org>/login: an e-mail asks for a sign-in link. Known or not, enabled or not, the answer is the same (sent),
 * and the limits count the address whether it is known or not, so the answer never tells whether it exists.
 */
export async function requestLoginLink(org: PortalOrg, input: { readonly email: string }, meta: PortalRequestMeta): Promise<Result<{ sent: true }>> {
  const email = z.email().max(254).safeParse(input.email.trim().toLowerCase())
  if (!email.success) return err('VALIDATION_FAILED', 'invalid e-mail', { field: 'email' })
  const byIp = await hitIpLimit(ipHash(meta.ip), 'LINK', meta.now)
  if (byIp !== 'OK') return rateLimited(org, meta.now, byIp, 'IP', 'LINK', null)
  const byEmail = await hitScopeLimit(org.organizationId, { kind: 'CONTACT', key: sha256Hex(`email:${email.data}`) }, 'LINK', meta.now)
  if (byEmail !== 'OK') return rateLimited(org, meta.now, byEmail, 'CONTACT', 'LINK', null)
  const contact = await forTenant(org.organizationId).supplierContact.findFirst({ where: { email: email.data, status: 'ACTIVE' }, select: CONTACT_SELECT })
  if (!contact || !contactMayEnter(contact)) return ok({ sent: true })
  const ctx = portalCtx(org.organizationId, contact, meta.now, meta.requestId)
  const sent = await runCommand(ctx, requestLinkCommand, { orgCode: org.code }, { idempotencyKey: `portal:link:${newId()}` })
  return sent.ok ? ok({ sent: true }) : sent
}

// ---------- portal.startOtp: a link used once sends a code ----------

const startOtpCommand = defineCommand({
  name: 'portal.startOtp',
  capability: 'portal.signIn',
  input: z.object({ linkId: z.uuid(), ipHash: HEX64, userAgentHash: HEX64 }),
  async execute(tx, input, ctx): Promise<CommandOutcome<{ challengeId: string }>> {
    if (ctx.actor.type !== 'SUPPLIER') return { ok: false, error: { code: 'FORBIDDEN', message: 'a contact uses their own link' } }
    const contactId = ctx.actor.supplierContactId
    await lockRowsForUpdate(tx, 'PortalInviteLink', ctx.organizationId, [input.linkId])
    const link = await tx.portalInviteLink.findUnique({ where: { id: input.linkId }, select: { contactId: true, purpose: true, usedAt: true, revokedAt: true, expiresAt: true } })
    if (!link || link.contactId !== contactId || link.revokedAt) return { ok: false, error: { code: 'TOKEN_INVALID', message: 'unknown link' } }
    if (link.usedAt) return { ok: false, error: { code: 'TOKEN_USED', message: 'the link was used already' } }
    if (link.expiresAt.getTime() <= ctx.now.getTime()) return { ok: false, error: { code: 'TOKEN_EXPIRED', message: 'the link has expired' } }
    // the contact may still enter, read under the transaction (deactivated meanwhile → no code is sent)
    const holder = await tx.supplierContact.findUniqueOrThrow({ where: { id: contactId }, select: CONTACT_SELECT })
    if (!contactMayEnter(holder)) return { ok: false, error: { code: 'TOKEN_INVALID', message: 'the contact may not use the portal' } }
    await tx.portalInviteLink.update({ where: { id: input.linkId }, data: { usedAt: ctx.now } })

    const settings = await supplierSettings(tx, ctx.organizationId)
    const contact = await tx.supplierContact.findUniqueOrThrow({ where: { id: contactId }, select: { email: true } })
    const challengeId = newId()
    const code = newOtpCode()
    const expiresAt = new Date(ctx.now.getTime() + settings.otpMinutes * MS_PER_MINUTE)
    await tx.portalOtpChallenge.create({
      data: {
        id: challengeId,
        organizationId: ctx.organizationId,
        contactId,
        codeHash: otpCodeHash(challengeId, code),
        channel: settings.otpChannel,
        sentTo: contact.email,
        expiresAt,
        requestIpHash: input.ipHash,
        userAgentHash: input.userAgentHash,
        // the business clock: verifyOtp measures the code's life from here (BR-PORTAL ข้อ 02)
        createdAt: ctx.now,
      },
    })
    const notice = await enqueueSupplierNotice(tx, ctx, {
      templateKey: PORTAL_SUPPLIER_TEMPLATES.otp,
      contactId,
      subjectType: 'SupplierContact',
      subjectId: contactId,
      // a new row for every code: a code is never deduplicated against an earlier one (BR-NOTI ข้อ 09)
      dedupeKey: `portal.otp:${challengeId}`,
      data: { code, expiresAt: expiresAt.toISOString() },
    })
    return {
      ok: true,
      result: { challengeId },
      events: [
        { type: 'portal_session.otp_requested', aggregateType: 'SupplierContact', aggregateId: contactId, data: { contactId, challengeId, linkId: input.linkId, purpose: link.purpose } },
        ...notice.events,
      ],
      notifications: notice.notifications,
      outbox: notice.outbox,
    }
  },
})

/**
 * POST of /portal/<org>/link/<token>: the link is used, and its contact gets a code. The answer names the challenge;
 * the browser keeps it with the token (bcs_portal_otp), so the code is tried only where the link was used.
 */
export async function consumePortalLink(org: PortalOrg, input: { readonly token: string }, meta: PortalRequestMeta): Promise<Result<{ challengeId: string }>> {
  const byIp = await hitIpLimit(ipHash(meta.ip), 'OTP', meta.now)
  if (byIp !== 'OK') return rateLimited(org, meta.now, byIp, 'IP', 'OTP', null)
  const link = await forTenant(org.organizationId).portalInviteLink.findUnique({
    where: { organizationId_tokenHash: { organizationId: org.organizationId, tokenHash: sha256Hex(input.token) } },
    select: { id: true, usedAt: true, revokedAt: true, expiresAt: true, contact: { select: CONTACT_SELECT } },
  })
  if (!link || link.revokedAt || !contactMayEnter(link.contact)) return err('TOKEN_INVALID', 'unknown link')
  // a link used before is TOKEN_USED for every browser (the command checks again under its lock)
  if (link.usedAt) return err('TOKEN_USED', 'the link was used already')
  if (link.expiresAt.getTime() <= meta.now.getTime()) return err('TOKEN_EXPIRED', 'the link has expired')
  const byContact = await hitScopeLimit(org.organizationId, { kind: 'CONTACT', key: link.contact.id }, 'OTP', meta.now)
  if (byContact !== 'OK') return rateLimited(org, meta.now, byContact, 'CONTACT', 'OTP', link.contact.id)
  const ctx = portalCtx(org.organizationId, link.contact, meta.now, meta.requestId)
  return runCommand(ctx, startOtpCommand, { linkId: link.id, ipHash: ipHash(meta.ip), userAgentHash: userAgentHash(meta.userAgent) }, { idempotencyKey: `portal:${sha256Hex(input.token)}` })
}

// ---------- portal.verifyOtp: the code opens a session ----------

type VerifyResult =
  | { readonly verified: true; readonly sessionId: string }
  | { readonly verified: false; readonly code: 'OTP_INVALID'; readonly remaining: number }
  | { readonly verified: false; readonly code: 'OTP_LOCKED'; readonly lockedUntil: string }

const verifyOtpCommand = defineCommand({
  name: 'portal.verifyOtp',
  capability: 'portal.signIn',
  input: z.object({
    challengeId: z.uuid(),
    tokenHash: HEX64,
    attemptHash: HEX64,
    ipHash: HEX64,
    userAgentHash: HEX64,
    sessionHash: HEX64,
    csrfTokenHash: HEX64,
    priorSessionHash: HEX64.nullable(),
  }),
  async execute(tx, input, ctx): Promise<CommandOutcome<VerifyResult>> {
    if (ctx.actor.type !== 'SUPPLIER') return { ok: false, error: { code: 'FORBIDDEN', message: 'a contact signs in as themself' } }
    const contactId = ctx.actor.supplierContactId
    const invalid: CommandOutcome<VerifyResult> = { ok: false, error: { code: 'OTP_INVALID', message: 'the code is not right' } }
    await lockRowsForUpdate(tx, 'PortalOtpChallenge', ctx.organizationId, [input.challengeId])
    const challenge = await tx.portalOtpChallenge.findUnique({ where: { id: input.challengeId } })
    if (!challenge || challenge.contactId !== contactId || challenge.usedAt) return invalid
    // the compensating control of a code sent to the same inbox as the link (BR-PORTAL ข้อ 02 · OQ-181): only where the
    // link was used — the same link, IP and user agent; a mismatch is not counted as an attempt
    // the very link that asked for this code: used in the transaction that created the challenge, at the same instant
    const link = await tx.portalInviteLink.findFirst({ where: { tokenHash: input.tokenHash, contactId, usedAt: challenge.createdAt }, select: { id: true } })
    if (!link || challenge.requestIpHash !== input.ipHash || challenge.userAgentHash !== input.userAgentHash) return invalid

    const settings = await supplierSettings(tx, ctx.organizationId)
    const checked = checkOtp({ createdAt: challenge.createdAt, codeHash: challenge.codeHash, attempts: challenge.attempts, lockedUntil: challenge.lockedUntil }, input.attemptHash, ctx.now, settings)
    if (!checked.ok) {
      if (checked.code === 'OTP_INVALID') {
        await tx.portalOtpChallenge.update({ where: { id: challenge.id }, data: { attempts: checked.attempts } })
        return {
          ok: true,
          result: { verified: false, code: 'OTP_INVALID', remaining: checked.remaining },
          events: [{ type: 'portal_session.otp_failed', aggregateType: 'SupplierContact', aggregateId: contactId, data: { contactId, challengeId: challenge.id, attempts: checked.attempts, remaining: checked.remaining } }],
        }
      }
      if ('lockedUntil' in checked) {
        await tx.portalOtpChallenge.update({ where: { id: challenge.id }, data: { attempts: checked.attempts, lockedUntil: checked.lockedUntil } })
        return {
          ok: true,
          result: { verified: false, code: 'OTP_LOCKED', lockedUntil: checked.lockedUntil.toISOString() },
          events: [
            { type: 'portal_session.otp_locked', aggregateType: 'SupplierContact', aggregateId: contactId, data: { contactId, challengeId: challenge.id, attempts: checked.attempts, lockedUntil: checked.lockedUntil.toISOString() } },
          ],
        }
      }
      return { ok: false, error: { code: checked.code, message: checked.code === 'OTP_EXPIRED' ? 'the code has expired' : 'too many wrong codes', ...(challenge.lockedUntil ? { details: { lockedUntil: challenge.lockedUntil.toISOString() } } : {}) } }
    }

    // the code is right: it and every other open code of the contact are closed, and a new session starts (its id
    // changes at every sign-in · NFR-SEC-04); a session this browser still held is ended
    await tx.portalOtpChallenge.updateMany({ where: { contactId, usedAt: null }, data: { usedAt: ctx.now } })
    const events: EventDraft[] = []
    if (input.priorSessionHash) {
      const prior = await tx.portalSession.findFirst({ where: { sessionHash: input.priorSessionHash, contactId, revokedAt: null }, select: { id: true } })
      if (prior) {
        await tx.portalSession.update({ where: { id: prior.id }, data: { revokedAt: ctx.now, revokedReason: 'LOGOUT' } })
        events.push({ type: 'portal_session.revoked', aggregateType: 'SupplierContact', aggregateId: contactId, data: { contactId, sessionId: prior.id, reason: 'LOGOUT' } })
      }
    }
    await lockRowsForUpdate(tx, 'SupplierContact', ctx.organizationId, [contactId])
    const contact = await tx.supplierContact.findUniqueOrThrow({ where: { id: contactId }, select: { ...CONTACT_SELECT, firstSignedInAt: true } })
    if (!contactMayEnter(contact)) return invalid
    const seenBefore = await tx.portalSession.count({
      where: { contactId, userAgentHash: input.userAgentHash, createdAt: { gte: new Date(ctx.now.getTime() - PORTAL_NEW_DEVICE_DAYS * MS_PER_DAY) } },
    })
    const firstSignIn = contact.firstSignedInAt === null
    const newDevice = seenBefore === 0
    const sessionId = newId()
    await tx.portalSession.create({
      data: {
        id: sessionId,
        organizationId: ctx.organizationId,
        contactId,
        sessionHash: input.sessionHash,
        csrfTokenHash: input.csrfTokenHash,
        lastSeenAt: ctx.now,
        expiresAt: new Date(ctx.now.getTime() + settings.sessionMaxHours * MS_PER_HOUR),
        userAgentHash: input.userAgentHash,
        ipHash: input.ipHash,
        createdAt: ctx.now,
      },
    })
    if (firstSignIn) await tx.supplierContact.update({ where: { id: contactId }, data: { firstSignedInAt: ctx.now } })
    events.push({ type: 'portal_session.signed_in', aggregateType: 'SupplierContact', aggregateId: contactId, data: { contactId, sessionId, challengeId: challenge.id, newDevice, firstSignIn } })

    // a device not seen for 90 days signing in after the first time: the address in the register hears of it (the
    // supplier's own, or the contact's while the application is not a supplier yet)
    const effects = { outbox: [] as Awaited<ReturnType<typeof enqueueSupplierNotice>>['outbox'], notifications: [] as Awaited<ReturnType<typeof enqueueSupplierNotice>>['notifications'] }
    if (newDevice && !firstSignIn) {
      const notice = await enqueueSupplierNotice(tx, ctx, {
        templateKey: PORTAL_SUPPLIER_TEMPLATES.newDevice,
        ...(contact.supplierId ? { supplierId: contact.supplierId } : { contactId }),
        subjectType: 'SupplierContact',
        subjectId: contactId,
        dedupeKey: `portal.new_device:${sessionId}`,
        data: { contactName: contact.nameTh, signedInAt: ctx.now.toISOString() },
      })
      events.push(...notice.events)
      effects.outbox.push(...notice.outbox)
      effects.notifications.push(...notice.notifications)
    }
    for (const hook of signedInHooks) events.push(...(await hook(tx, ctx, { id: contactId, applicationId: contact.applicationId, supplierId: contact.supplierId })))
    return { ok: true, result: { verified: true, sessionId }, events, notifications: effects.notifications, outbox: effects.outbox }
  },
})

/** The secrets of a new session, for the browser's cookies */
export interface PortalSessionSecrets {
  readonly sessionId: string
  readonly csrfToken: string
}

/**
 * POST of /portal/<org>/otp: the code typed, with what the browser kept from the link. Right → the secrets of a new
 * session; wrong → OTP_INVALID with the tries left, OTP_LOCKED after the last one, OTP_EXPIRED at the code's end.
 */
export async function verifyPortalOtp(
  org: PortalOrg,
  input: { readonly challengeId: string; readonly token: string; readonly code: string; readonly priorSessionId?: string | null },
  meta: PortalRequestMeta,
): Promise<Result<PortalSessionSecrets>> {
  if (!/^\d{6}$/.test(input.code)) return err('VALIDATION_FAILED', 'a code is six digits', { field: 'code' })
  if (!z.uuid().safeParse(input.challengeId).success) return err('OTP_INVALID', 'the code is not right')
  const byIp = await hitIpLimit(ipHash(meta.ip), 'OTP', meta.now)
  if (byIp !== 'OK') return rateLimited(org, meta.now, byIp, 'IP', 'OTP', null)
  const challenge = await forTenant(org.organizationId).portalOtpChallenge.findUnique({ where: { id: input.challengeId }, select: { attempts: true, contact: { select: CONTACT_SELECT } } })
  if (!challenge || !contactMayEnter(challenge.contact)) return err('OTP_INVALID', 'the code is not right')
  const secrets = { sessionId: newSecret(), csrfToken: newSecret() }
  const ctx = portalCtx(org.organizationId, challenge.contact, meta.now, meta.requestId)
  const done = await runCommand(
    ctx,
    verifyOtpCommand,
    {
      challengeId: input.challengeId,
      tokenHash: sha256Hex(input.token),
      attemptHash: otpCodeHash(input.challengeId, input.code),
      ipHash: ipHash(meta.ip),
      userAgentHash: userAgentHash(meta.userAgent),
      sessionHash: sha256Hex(secrets.sessionId),
      csrfTokenHash: sha256Hex(secrets.csrfToken),
      priorSessionHash: input.priorSessionId ? sha256Hex(input.priorSessionId) : null,
    },
    // portal:<challengeId>:<attemptNo> (docs/sub-specs/S7.md): never anything derived from the code itself
    { idempotencyKey: `portal:${input.challengeId}:${challenge.attempts + 1}` },
  )
  if (!done.ok) return done
  const r = done.data
  if (r.verified) return ok(secrets)
  return r.code === 'OTP_INVALID' ? err('OTP_INVALID', 'the code is not right', { remaining: r.remaining }) : err('OTP_LOCKED', 'too many wrong codes', { lockedUntil: r.lockedUntil })
}

// ---------- signed in: sign out, accept the privacy notice ----------

const signOutCommand = defineCommand({
  name: 'portal.signOut',
  capability: 'portal.self',
  input: z.object({ sessionId: z.uuid() }),
  async execute(tx, input, ctx): Promise<CommandOutcome<{ signedOut: true }>> {
    if (ctx.actor.type !== 'SUPPLIER') return { ok: false, error: { code: 'FORBIDDEN', message: 'a contact signs out themself' } }
    const contactId = ctx.actor.supplierContactId
    const ended = await tx.portalSession.updateMany({ where: { id: input.sessionId, contactId, revokedAt: null }, data: { revokedAt: ctx.now, revokedReason: 'LOGOUT' } })
    if (ended.count === 0) return { ok: false, error: { code: 'UNAUTHENTICATED', message: 'no session' } }
    return { ok: true, result: { signedOut: true }, events: [{ type: 'portal_session.signed_out', aggregateType: 'SupplierContact', aggregateId: contactId, data: { contactId, sessionId: input.sessionId } }] }
  },
})

export function signOutPortal(state: PortalSessionState): Promise<Result<{ signedOut: true }>> {
  return runCommand(state.ctx, signOutCommand, { sessionId: state.sessionId }, { idempotencyKey: `portal:signout:${state.sessionId}` })
}

const acceptPrivacyCommand = defineCommand({
  name: 'portal.acceptPrivacyNotice',
  capability: 'portal.self',
  input: z.object({ version: z.literal(PORTAL_PRIVACY_NOTICE_VERSION) }),
  async execute(tx, input, ctx): Promise<CommandOutcome<{ version: string }>> {
    if (ctx.actor.type !== 'SUPPLIER') return { ok: false, error: { code: 'FORBIDDEN', message: 'a contact accepts for themself' } }
    const contactId = ctx.actor.supplierContactId
    await tx.supplierContact.update({ where: { id: contactId }, data: { privacyNoticeVersion: input.version, privacyNoticeAcceptedAt: ctx.now, version: { increment: 1 } } })
    return {
      ok: true,
      result: { version: input.version },
      events: [{ type: 'supplier_contact.privacy_notice_accepted', aggregateType: 'SupplierContact', aggregateId: contactId, data: { privacyNoticeVersion: input.version } }],
    }
  },
})

/** The contact accepts the privacy notice the portal shows now (BR-PORTAL ข้อ 08) */
export function acceptPrivacyNotice(state: PortalSessionState, input: { readonly version: string }, idempotencyKey: string): Promise<Result<{ version: string }>> {
  return runCommand(state.ctx, acceptPrivacyCommand, input, { idempotencyKey })
}
