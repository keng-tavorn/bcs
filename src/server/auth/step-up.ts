import { timingSafeEqual } from 'node:crypto'
import { symmetricDecrypt } from 'better-auth/crypto'
import { z } from 'zod'
import { afterWrongPin, isPinFormat, isPinLocked, PIN_FAILURE_LIMIT, pinAttemptsLeft, pinLockEndsAt, stepUpNeeded, type StepUpRoute, type WrongPinOutcome } from '@/core/pin'
import { APPROVAL_SUBJECTS } from '@/core/sod'
import { STEP_UP_METHODS } from '@/core/step-up-methods'
import type { AppError } from '@/core/result'
import { systemClock } from '@/lib/clock'
import { COMMAND_TX_MAX_WAIT_MS, COMMAND_TX_TIMEOUT_MS, MS_PER_SECOND, STEP_UP_TTL_MS, TOTP_ACCEPTED_DRIFT_STEPS } from '@/lib/constants'
import { newId } from '@/lib/ids'
import { hotp, TOTP_PERIOD_SECONDS } from '@/lib/totp'
import { makeCtx, type Channel, type Ctx } from '@/server/context'
import { lockRowsForUpdate } from '@/server/db/sql/locks'
import { setTransactionTimeouts } from '@/server/db/sql/timeouts'
import { systemDb } from '@/server/db/system'
import { forTenant, type TenantTx } from '@/server/db/tenant'
import { appendEvents, validateEventDraft, type AppendedEvent, type EventDraft } from '@/server/events/append'
import { dispatchOutbox, enqueueOutbox, getDefaultOutboxSender, type OutboxDraft, type OutboxSender } from '@/server/events/outbox'
import { createNotifications } from '@/server/notifications/create'
import { auth } from './auth'
import { recordAuthEvent } from './auth-events'
import { beginLoginAttempt, settleLoginAttempt } from './lockout'
import { isCheckablePinHash, PIN_PROOF_TTL_MS, PinHashError, signPinChangeProof, verifyPin, type IdentityProofMethod } from './pin'

// Step-up (spec FR-AUTH-005, BR-TOK-05, BR-DOA-15, §9.3, NFR-SEC-04). Some decisions need the member to prove who they
// are again for that one document: every DOA version (initial package included) and authority change, and every task
// whose amount the DOA counted is at or above the version's stepUpThreshold (stepUpNeeded of src/core/pin). The proof is
// a grant for that document, valid 5 minutes and used once by the decision. A new grant for a document uses up an
// unused one the member still holds for it, so one entry of the PIN decides one task. Times here are the security
// clock (real time), never the business clock that e2e tests move.
//
// A grant is earned with the transaction PIN of ./pin.ts only (S5-05, FR-AUTH-005, ADR-047 item 8), on every channel.
// Five wrong PINs in a row lock it for 15 minutes (src/core/pin); the fifth writes security.pin_locked and e-mails the
// owner security.notice (§10.1). A try runs in three steps, like a sign-in (lockout.ts), so the lock never fails open:
//   1. reserve: in its own transaction, which commits before the PIN is checked, holding the member's row lock, the try
//      is counted as wrong, and the fifth locks the PIN at once. Parallel tries are counted one by one, so at most five
//      are ever checked, and nothing that fails afterwards can take a try back off the count;
//   2. check: Argon2, with no transaction open;
//   3. settle: a right PIN starts the count again, lifts the lock its own try made (a lock another try made in the
//      meantime stands) and gets the grant; the fifth wrong PIN records its lock (the event, the notification and their
//      outbox rows). A PIN changed in the meantime voids the check. If this step fails, the count and the lock stay as
//      step 1 wrote them; only the lock's event and e-mail can be missing then.
// Everything a later write could refuse is checked before step 1: the ids, with the validator of the event schemas, and
// the lock's event itself. Wrong PINs are counted on Member (pinFailedCount, pinLockedUntil): security bookkeeping like
// AuthAttempt for sign-ins, not a business event.
//
// Every deciding command names the proofs it takes (consumeStepUp, requireStepUp): PIN_ONLY, for request, PO and
// variance decisions and for policy alike (policyStepUpMethods). The authenticator code (TOTP) stopped being a step-up
// at S5-05 — it stays the second factor of the sign-in — so a TOTP grant written before then never decides anything.
// After a grant the caller changes the session id (NFR-SEC-04, ./session-rotation.ts).
//
// Setting a PIN needs a fresh proof of who the member is (proveIdentityForPin): the password or the code of a confirmed
// authenticator, counted and recorded like a sign-in, gives a proof good for 5 minutes (./pin.ts).

/**
 * TOTP names the grants of the authenticator code made before S5-05 (StepUpGrant.method); grants are made with the PIN
 * and, from S17-15, a passkey (./passkey.ts)
 */
export type StepUpMethod = 'TOTP' | 'PIN' | 'PASSKEY'

/** What a grant allows: deciding the one document it names */
export const STEP_UP_PURPOSE = 'DECIDE'

/** The documents a step-up is for: the subjects of approval routes (ApprovalSubjectType of prisma/schema.prisma) */
export const STEP_UP_SUBJECT_TYPES = APPROVAL_SUBJECTS

/** Where the member typed the PIN; kept as the channel of security.pin_locked (APP: the BCS Go app, BR-APP-02) */
export type StepUpChannel = 'WEB' | 'LIFF' | 'PWA' | 'APP'
const STEP_UP_CHANNELS = ['WEB', 'LIFF', 'PWA', 'APP'] as const

/** The proofs every decision that needs a step-up takes (FR-AUTH-005 AC2, ADR-047 item 8): the PIN only */
export const PIN_ONLY: readonly StepUpMethod[] = ['PIN']

/**
 * What every deciding command accepts as its step-up (FR-AUTH-005 AC5, BR-DOA-25): requests, purchase orders,
 * variances, policy and the phase-1 subjects read it here and nowhere else — the PIN and, from S17-15, a passkey
 * (BR-AUTH-09, OQ-168: src/core/step-up-methods, golden step-up-methods)
 */
export const DECISION_STEP_UP_METHODS: readonly StepUpMethod[] = STEP_UP_METHODS

/**
 * The proofs a policy decision (BR-DOA-15) takes: those of every decision, on every channel — the PIN since S5-05, when
 * the web's decision page switched from the authenticator code to it, and a passkey since S17-15. The channel stays in
 * the signature for the callers.
 */
export function policyStepUpMethods(_channel?: Channel): readonly StepUpMethod[] {
  return DECISION_STEP_UP_METHODS
}

interface StepUpSubject {
  readonly organizationId: string
  /** The signed-in member: the caller takes it from the session, never from the request */
  readonly memberId: string
  readonly subjectType: string
  readonly subjectId: string
}

/** A try of the PIN for one document, typed where the member typed it (the channel of security.pin_locked; WEB when left out) */
export type StepUpRequest = StepUpSubject & { readonly method: 'PIN'; readonly pin: string; readonly channel?: StepUpChannel }

export type StepUpOutcome =
  | { readonly ok: true; readonly grantId: string; readonly expiresAt: Date; readonly method: StepUpMethod }
  /** Five wrong PINs in a row locked it (FR-AUTH-005 AC3); retryAt when the lock ends */
  | { readonly ok: false; readonly reason: 'LOCKED'; readonly method: StepUpMethod; readonly retryAt: Date | null }
  /** Wrong PIN; attemptsLeft before the PIN locks */
  | { readonly ok: false; readonly reason: 'INVALID_CODE'; readonly method: StepUpMethod; readonly attemptsLeft: number | null }
  /** No PIN set, or one that must be set again (made under a key the server no longer holds) */
  | { readonly ok: false; readonly reason: 'NO_SECOND_FACTOR'; readonly method: StepUpMethod }

export type StepUpRefusal = Extract<StepUpOutcome, { ok: false }>

export interface StepUpOptions {
  /** Outbox sender for the lock's event and e-mail; defaults to the app's (Inngest); null leaves them to the sweeper (tests) */
  readonly sender?: OutboxSender | null
  /** The HTTP request that asked for the step-up, so security.pin_locked joins its logs and events (NFR-OBS-01) */
  readonly requestId?: string
  readonly correlationId?: string
}

// The ids with the same validator as the event schemas (Zod's uuid: RFC 9562 version and variant), so that nothing passed
// here can make the lock's event, or any other write, refuse after a PIN was checked. Event.requestId is text (a request
// id may come from a header); Event.correlationId is a uuid column.
const REQUEST_ID_MAX = 200
const StepUpIds = z.object({
  organizationId: z.uuid(),
  memberId: z.uuid(),
  subjectType: z.enum(STEP_UP_SUBJECT_TYPES),
  subjectId: z.uuid(),
  requestId: z.string().min(1).max(REQUEST_ID_MAX).optional(),
  correlationId: z.uuid().optional(),
})
const PinTry = z.object({ pin: z.string(), channel: z.enum(STEP_UP_CHANNELS).optional() })

/**
 * Checks the PIN and, when it is right, grants a step-up for one document (5 minutes, used once). The member and the
 * document come from the session and the task, never from the request: anything else — another method than the PIN
 * included (the authenticator code is no step-up since S5-05) — is a programming error, thrown before any try is
 * counted or any PIN checked.
 */
export async function grantStepUp(input: StepUpRequest, now: Date, options: StepUpOptions = {}): Promise<StepUpOutcome> {
  const { organizationId, memberId, subjectType, subjectId } = input
  const ids = StepUpIds.safeParse({ organizationId, memberId, subjectType, subjectId, requestId: options.requestId, correlationId: options.correlationId })
  const pinTry = input.method === 'PIN' && PinTry.safeParse({ pin: input.pin, channel: input.channel }).success
  if (!ids.success || !pinTry || Number.isNaN(now.getTime())) {
    throw new TypeError('a step-up is a PIN of the member for one document of an approval route, named by their ids, at a valid time')
  }
  // The lock's event, as the fifth wrong PIN would write it: checked now, it can no longer refuse after the check
  validateEventDraft(pinLockedEvent(input, pinLockEndsAt(now)))
  return grantByPin(input, now, options)
}

const expiryOf = (now: Date) => new Date(now.getTime() + STEP_UP_TTL_MS)

/**
 * A grant for one document. One the member still holds unused for it is used up, so one proof decides one task (§9.3).
 * The PIN's check and a passkey's (./passkey.ts) both end here.
 */
export async function issueGrant(tx: TenantTx, input: StepUpSubject, method: StepUpMethod, now: Date): Promise<StepUpOutcome> {
  const { organizationId, memberId, subjectType, subjectId } = input
  await tx.stepUpGrant.updateMany({ where: { memberId, subjectType, subjectId, purpose: STEP_UP_PURPOSE, usedAt: null, expiresAt: { gt: now } }, data: { usedAt: now } })
  const grantId = newId()
  const expiresAt = expiryOf(now)
  await tx.stepUpGrant.create({ data: { id: grantId, organizationId, memberId, purpose: STEP_UP_PURPOSE, subjectType, subjectId, method, grantedAt: now, expiresAt } })
  return { ok: true, grantId, expiresAt, method }
}

// ---------- the password or the code again, counted like a sign-in ----------

type CountedCheck = { readonly kind: 'LOCKED'; readonly retryAt: Date } | { readonly kind: 'CHECKED'; readonly matches: boolean | null }

/**
 * A second check of who the member is, counted toward the sign-in lock like a sign-in (NFR-SEC-05) and recorded like
 * one (FR-AUTH-001 AC3): a wrong answer, or a method the member has not set up, is auth.login_failed; a refusal while
 * the account is locked is auth.login_locked. matches is null when the member has no such method.
 */
async function countedIdentityCheck(email: string, step: 'password' | 'two_factor', now: Date, check: () => Promise<boolean | null>): Promise<CountedCheck> {
  const attempt = await beginLoginAttempt(email, 'unknown', now)
  if (!attempt.allowed) {
    await recordAuthEvent('auth.login_locked', email, { reason: attempt.reason }, now)
    return { kind: 'LOCKED', retryAt: attempt.retryAt }
  }
  const matches = await check()
  await settleLoginAttempt(attempt.attemptId, matches === true)
  if (matches !== true) await recordAuthEvent('auth.login_failed', email, { step }, now)
  return { kind: 'CHECKED', matches }
}

// ---------- the authenticator code, to prove who the member is before setting a PIN ----------

function sameCode(a: string, b: string): boolean {
  return a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b))
}

/**
 * Checks a TOTP code of the member's sign-in identity against the steps around `nowMs`; null without a confirmed
 * authenticator. Confirmed as Better Auth's own sign-in counts it (and ./proof-methods.ts offers it): two-step sign-in is
 * on for the identity (twoFactorEnabled) and its authenticator is not a setup started and never confirmed with a code
 * (TwoFactor.verified true, or null as on rows made before Better Auth had the column). A setup never confirmed is no
 * authenticator yet — the sign-in refuses its codes — so its codes never prove who the member is before a PIN is set.
 */
async function totpMatches(userId: string, code: string, nowMs: number): Promise<boolean | null> {
  const row = await systemDb.twoFactor.findFirst({
    where: { userId, secret: { gt: '' }, OR: [{ verified: true }, { verified: null }], user: { is: { twoFactorEnabled: true } } },
    select: { secret: true },
  })
  if (!row?.secret) return null
  const key = (await auth.$context).secretConfig
  const secret = await symmetricDecrypt({ key, data: row.secret })
  const step = Math.floor(nowMs / (TOTP_PERIOD_SECONDS * MS_PER_SECOND))
  let match = false
  for (let drift = -TOTP_ACCEPTED_DRIFT_STEPS; drift <= TOTP_ACCEPTED_DRIFT_STEPS; drift++) match = sameCode(hotp(secret, step + drift), code) || match
  return match
}

// ---------- PIN (FR-AUTH-005) ----------

interface PinCheck {
  readonly outcome: StepUpOutcome
  /** Outbox rows of the lock (its event and the e-mail), sent after commit */
  readonly outboxIds: readonly string[]
}

const refused = (outcome: StepUpRefusal): PinCheck => ({ outcome, outboxIds: [] })

type Reservation = { readonly kind: 'refused'; readonly outcome: StepUpRefusal } | { readonly kind: 'counted'; readonly pinHash: string; readonly wrong: WrongPinOutcome }

const TX_OPTIONS = { isolationLevel: 'ReadCommitted', maxWait: COMMAND_TX_MAX_WAIT_MS, timeout: COMMAND_TX_TIMEOUT_MS } as const

/** The event of a lock, FR-AUTH-005 AC3 (never the PIN) */
function pinLockedEvent(input: StepUpSubject, lockedUntil: Date): EventDraft {
  return {
    type: 'security.pin_locked',
    aggregateType: 'Security',
    aggregateId: input.memberId,
    data: { failedAttempts: PIN_FAILURE_LIMIT, lockedUntil: lockedUntil.toISOString(), subjectType: input.subjectType, subjectId: input.subjectId },
  }
}

/** The same message shape runCommand sends for every event (src/server/services/_pipeline.ts, which auth may not import) */
function eventOutboxDraft(ctx: Ctx, e: AppendedEvent): OutboxDraft {
  return {
    eventName: `bcs/${e.type}`,
    payload: { eventId: e.id, organizationId: ctx.organizationId, type: e.type, aggregateType: e.aggregateType, aggregateId: e.aggregateId, occurredAt: e.occurredAt, correlationId: ctx.correlationId, data: e.data },
  }
}

/** FR-AUTH-005 AC3, §10.1: the lock is an event and an e-mail to the account owner, written when the lock is settled */
async function recordPinLock(tx: TenantTx, ctx: Ctx, input: StepUpSubject, lockedUntil: Date): Promise<string[]> {
  const until = lockedUntil.toISOString()
  const events = await appendEvents(tx, ctx, [pinLockedEvent(input, lockedUntil)])
  const notified = await createNotifications(tx, ctx.organizationId, [
    {
      recipientMemberId: input.memberId,
      templateKey: 'security.notice',
      data: { kind: 'PIN_LOCKED', lockedUntil: until },
      urgency: 'IMMEDIATE',
      dedupeKey: `security.notice:pin_locked:${input.memberId}:${until}`,
      subjectType: 'Member',
      subjectId: input.memberId,
    },
  ])
  return enqueueOutbox(tx, ctx.organizationId, [...events.map((e) => eventOutboxDraft(ctx, e)), ...notified])
}

const PIN_STATE = { status: true, transactionPinHash: true, pinFailedCount: true, pinLockedUntil: true } as const

/** The member's PIN state under their row lock: PIN tries and PIN changes of one member run one at a time */
async function lockedPinState(tx: TenantTx, organizationId: string, memberId: string) {
  const [found] = await lockRowsForUpdate(tx, 'Member', organizationId, [memberId])
  return found ? tx.member.findUniqueOrThrow({ where: { id: memberId }, select: PIN_STATE }) : null
}

async function grantByPin(input: StepUpSubject & { readonly pin: string; readonly channel?: StepUpChannel }, now: Date, options: StepUpOptions): Promise<StepUpOutcome> {
  const { organizationId, memberId } = input
  const db = forTenant(organizationId)

  // 1. Reserve: the try counts as wrong, committed before the PIN is checked
  const reservation = await db.$transaction(async (tx): Promise<Reservation> => {
    await setTransactionTimeouts(tx)
    const member = await lockedPinState(tx, organizationId, memberId)
    if (!member || member.status !== 'ACTIVE') return { kind: 'refused', outcome: { ok: false, reason: 'NO_SECOND_FACTOR', method: 'PIN' } }
    if (isPinLocked(member.pinLockedUntil, now)) return { kind: 'refused', outcome: { ok: false, reason: 'LOCKED', method: 'PIN', retryAt: member.pinLockedUntil } }
    // No PIN, or one that cannot be checked here (damaged, or made under a key the server no longer holds): set a new one
    if (!member.transactionPinHash || !isCheckablePinHash(member.transactionPinHash)) return { kind: 'refused', outcome: { ok: false, reason: 'NO_SECOND_FACTOR', method: 'PIN' } }
    // Something that is not six digits is no guess of a PIN: refused unchecked and uncounted
    if (!isPinFormat(input.pin)) return { kind: 'refused', outcome: { ok: false, reason: 'INVALID_CODE', method: 'PIN', attemptsLeft: pinAttemptsLeft(member.pinFailedCount) } }
    const wrong = afterWrongPin(member.pinFailedCount, now)
    await tx.member.update({ where: { id: memberId }, data: { pinFailedCount: wrong.failedCount, pinLockedUntil: wrong.lockedUntil } })
    return { kind: 'counted', pinHash: member.transactionPinHash, wrong }
  }, TX_OPTIONS)
  if (reservation.kind === 'refused') return reservation.outcome
  const { wrong } = reservation

  // 2. Check, with no transaction open
  let matches: boolean
  try {
    matches = await verifyPin(input.pin, reservation.pinHash)
  } catch (error) {
    // Not expected after isCheckablePinHash(); the try stays counted
    if (error instanceof PinHashError) return { ok: false, reason: 'NO_SECOND_FACTOR', method: 'PIN' }
    throw error
  }
  // A wrong PIN that did not lock is settled already: step 1 counted it
  if (!matches && !wrong.locked) return { ok: false, reason: 'INVALID_CODE', method: 'PIN', attemptsLeft: pinAttemptsLeft(wrong.failedCount) }

  // 3. Settle
  const ctx = makeCtx({
    organizationId,
    actor: { type: 'USER', memberId },
    channel: input.channel ?? 'WEB',
    now,
    ...(options.requestId ? { requestId: options.requestId } : {}),
    ...(options.correlationId ? { correlationId: options.correlationId } : {}),
  })
  const settled = await db.$transaction(async (tx): Promise<PinCheck> => {
    await setTransactionTimeouts(tx)
    const member = await lockedPinState(tx, organizationId, memberId)
    if (!member || member.status !== 'ACTIVE') return refused({ ok: false, reason: 'NO_SECOND_FACTOR', method: 'PIN' })
    // The PIN was changed while this try was checked: the check is void, and the new PIN's count and lock stay as they are
    if (member.transactionPinHash !== reservation.pinHash) return refused({ ok: false, reason: 'INVALID_CODE', method: 'PIN', attemptsLeft: pinAttemptsLeft(member.pinFailedCount) })
    const ownLock = wrong.lockedUntil !== null && member.pinLockedUntil?.getTime() === wrong.lockedUntil.getTime()
    if (matches) {
      // Another try locked the PIN while this one was checked: that lock stands, for this PIN as for any other
      if (!ownLock && isPinLocked(member.pinLockedUntil, now)) return refused({ ok: false, reason: 'LOCKED', method: 'PIN', retryAt: member.pinLockedUntil })
      // A right PIN starts the count of wrong ones again ("five in a row") and lifts the lock its own try made
      await tx.member.update({ where: { id: memberId }, data: { pinFailedCount: 0, pinLockedUntil: null } })
      return { outcome: await issueGrant(tx, input, 'PIN', now), outboxIds: [] }
    }
    // The fifth wrong PIN in a row: step 1 locked the PIN. Unless a new PIN lifted that lock meanwhile, record it and
    // tell the owner (FR-AUTH-005 AC3, §10.1)
    if (!ownLock || !wrong.lockedUntil) return refused({ ok: false, reason: 'INVALID_CODE', method: 'PIN', attemptsLeft: pinAttemptsLeft(member.pinFailedCount) })
    const outboxIds = await recordPinLock(tx, ctx, input, wrong.lockedUntil)
    return { outcome: { ok: false, reason: 'LOCKED', method: 'PIN', retryAt: wrong.lockedUntil }, outboxIds }
  }, TX_OPTIONS)
  if (settled.outboxIds.length > 0) {
    // After commit, like runCommand: one best-effort send that never throws; the outbox-sweeper sends what is left.
    // Relay bookkeeping uses real time.
    const sender = options.sender === undefined ? getDefaultOutboxSender() : options.sender
    await dispatchOutbox(settled.outboxIds, sender, systemClock.now())
  }
  return settled.outcome
}

/**
 * How a refused step-up reads as an error of §14.2, for the screens and LIFF: STEP_UP_LOCKED {time: when the lock ends},
 * VALIDATION_FAILED {field: pin, reason: WRONG, attemptsLeft}, STEP_UP_REQUIRED {reason: PIN_NOT_SET}. Neither the
 * message nor the details ever hold the PIN (NFR-SEC-09).
 */
export function stepUpRefusalError(refusal: StepUpRefusal): AppError {
  switch (refusal.reason) {
    case 'LOCKED':
      return { code: 'STEP_UP_LOCKED', message: 'five wrong PINs in a row: the PIN is locked for a while', details: { method: refusal.method, ...(refusal.retryAt ? { time: refusal.retryAt.toISOString() } : {}) } }
    case 'INVALID_CODE':
      return { code: 'VALIDATION_FAILED', message: 'wrong PIN', details: { field: 'pin', reason: 'WRONG', ...(refusal.attemptsLeft !== null ? { attemptsLeft: refusal.attemptsLeft } : {}) } }
    case 'NO_SECOND_FACTOR':
      return { code: 'STEP_UP_REQUIRED', message: 'set a transaction PIN first', details: { method: refusal.method, reason: 'PIN_NOT_SET' } }
  }
}

// ---------- using a grant (the deciding command) ----------

/**
 * Uses the member's live grant for this document inside the deciding command (once only). `methods` are the proofs the
 * command takes: PIN_ONLY (policyStepUpMethods() gives the same). null when there is none: the command answers
 * STEP_UP_REQUIRED.
 */
export async function consumeStepUp(
  tx: TenantTx,
  input: { readonly memberId: string; readonly subjectType: string; readonly subjectId: string; readonly methods: readonly StepUpMethod[] },
  now: Date,
): Promise<string | null> {
  if (input.methods.length === 0) throw new TypeError('a deciding command names the proofs of a step-up it takes')
  const grant = await tx.stepUpGrant.findFirst({
    where: { memberId: input.memberId, subjectType: input.subjectType, subjectId: input.subjectId, purpose: STEP_UP_PURPOSE, method: { in: [...input.methods] }, usedAt: null, expiresAt: { gt: now } },
    orderBy: { grantedAt: 'desc' },
    select: { id: true },
  })
  if (!grant) return null
  const used = await tx.stepUpGrant.updateMany({ where: { id: grant.id, usedAt: null }, data: { usedAt: now } })
  return used.count === 1 ? grant.id : null
}

export type StepUpGate = { readonly ok: true; readonly grantId: string | null } | { readonly ok: false; readonly error: AppError }

/**
 * FR-AUTH-005 AC2: the gate a deciding command runs in its transaction, at `now` on the security clock. When the route
 * needs a step-up (stepUpNeeded: a policy subject, or an amount at or above the version's stepUpThreshold), the member's
 * live grant for this document is used, once; without one the decision is refused STEP_UP_REQUIRED {method: the
 * preferred proof}. grantId is null when the route needs none. `methods` as for consumeStepUp(). Every decision is
 * gated alike — approve, return and reject ("ตัดสินงาน", ADR-047 item 8); asking the requester is not a decision.
 */
export async function requireStepUp(
  tx: TenantTx,
  input: { readonly memberId: string; readonly route: StepUpRoute & { readonly subjectId: string }; readonly methods: readonly StepUpMethod[] },
  now: Date,
): Promise<StepUpGate> {
  const { route, methods } = input
  if (methods.length === 0) throw new TypeError('a deciding command names the proofs of a step-up it takes')
  if (!stepUpNeeded(route)) return { ok: true, grantId: null }
  const grantId = await consumeStepUp(tx, { memberId: input.memberId, subjectType: route.subjectType, subjectId: route.subjectId, methods }, now)
  if (grantId) return { ok: true, grantId }
  return {
    ok: false,
    error: {
      code: 'STEP_UP_REQUIRED',
      message: 'this decision needs a step-up for this document, given in the last 5 minutes',
      details: { subjectType: route.subjectType, subjectId: route.subjectId, method: methods[0] },
    },
  }
}

// ---------- proving who the member is, to set a PIN ----------

/** Better Auth's longest password (src/server/auth/auth.ts): anything longer is wrong without hashing it */
const PASSWORD_INPUT_MAX = 128

/** Checks the password of the member's sign-in identity with Better Auth's own hasher; null without a password */
async function passwordMatches(userId: string, password: string): Promise<boolean | null> {
  const account = await systemDb.account.findFirst({ where: { userId, providerId: 'credential' }, select: { password: true } })
  if (!account?.password) return null
  return (await auth.$context).password.verify({ hash: account.password, password })
}

export type IdentityProofRequest = { readonly organizationId: string; readonly memberId: string } & (
  | { readonly method: 'PASSWORD'; readonly password: string }
  | { readonly method: 'TOTP'; readonly code: string }
)

export type IdentityProofOutcome =
  | { readonly ok: true; readonly proofToken: string; readonly expiresAt: Date; readonly method: IdentityProofMethod }
  /** The sign-in lock of the account (FR-AUTH-001 AC3): this check counts like a sign-in */
  | { readonly ok: false; readonly reason: 'LOCKED'; readonly retryAt: Date }
  /** INVALID: wrong password or code · NOT_AVAILABLE: no active membership, no password or no confirmed authenticator */
  | { readonly ok: false; readonly reason: 'INVALID' | 'NOT_AVAILABLE' }

/**
 * Setting or changing a PIN starts here (FR-AUTH-005 AC1): the member proves who they are again with the password or
 * the authenticator code, at `now` on the security clock. It counts toward the sign-in lock and is recorded like a
 * sign-in (auth.login_failed, auth.login_locked), so a stolen session cannot be used to guess the password unseen. The
 * proof is good for 5 minutes and one PIN (./pin.ts).
 */
export async function proveIdentityForPin(input: IdentityProofRequest, now: Date): Promise<IdentityProofOutcome> {
  const member = await systemDb.member.findFirst({
    where: { id: input.memberId, organizationId: input.organizationId, status: 'ACTIVE' },
    select: { email: true, userId: true, transactionPinHash: true },
  })
  if (!member?.userId) return { ok: false, reason: 'NOT_AVAILABLE' }
  const userId = member.userId
  const checked =
    input.method === 'PASSWORD'
      ? await countedIdentityCheck(member.email, 'password', now, async () => (input.password.length > PASSWORD_INPUT_MAX ? false : passwordMatches(userId, input.password)))
      : await countedIdentityCheck(member.email, 'two_factor', now, () => totpMatches(userId, input.code.trim(), now.getTime()))
  if (checked.kind === 'LOCKED') return { ok: false, reason: 'LOCKED', retryAt: checked.retryAt }
  if (checked.matches === null) return { ok: false, reason: 'NOT_AVAILABLE' }
  if (!checked.matches) return { ok: false, reason: 'INVALID' }
  const proofToken = signPinChangeProof({ organizationId: input.organizationId, memberId: input.memberId, currentPinHash: member.transactionPinHash }, input.method, now)
  return { ok: true, proofToken, expiresAt: new Date(now.getTime() + PIN_PROOF_TTL_MS), method: input.method }
}
