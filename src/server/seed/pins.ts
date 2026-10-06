import { randomInt } from 'node:crypto'
import { isPinLocked, PIN_LENGTH, pinProblem } from '@/core/pin'
import { systemClock } from '@/lib/clock'
import { hashPin, isCheckablePinHash, verifyPin } from '@/server/auth/pin'
import { holdsDoaReferencedPosition } from '@/server/auth/session'
import { systemCtx } from '@/server/context'
import { forTenant } from '@/server/db/tenant'
import { appendEvents, type EventDraft } from '@/server/events/append'

// Transaction PINs of the demo organization (docs/sub-specs/S5.md, row step-up; FR-AUTH-005, ADR-047 item 9). When
// SEED_DEV_PIN is set (local and staging only, src/lib/env.ts), the seed (prisma/seed.ts) gives it to every active demo
// member who holds now a position a DOA version names as approver, so the presenter and the e2e tests can approve high
// amounts and policy in LIFF and on the web. A member who has a PIN keeps it, so running the seed again changes nothing
// (pnpm db:reset starts over); approversWithoutPin names who does not hold it. Each PIN set is an auth.pin_set event of
// the seed. Without SEED_DEV_PIN nobody gets a PIN and approvers set their own at /settings/pin at first use; the demo
// history still decides as an approver does, with a PIN step-up, so the approvers without a PIN hold a one-time PIN
// (randomDemoPin) while it runs, which it takes back before it ends (giveOneTimePins, takeBackOneTimePins). No PIN is
// ever printed: errors and the report hold counts and employee codes only.

export class SeedPinError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SeedPinError'
  }
}

export interface SeedPinsReport {
  /** Members who got the PIN now */
  readonly set: number
  /** Approvers who already had a PIN and kept it */
  readonly kept: number
}

const PROBLEM_TH = {
  FORMAT: 'ต้องเป็นตัวเลข 6 หลัก',
  ALL_SAME: 'ห้ามใช้เลขเดียวกันทั้งชุด',
  SEQUENCE: 'ห้ามใช้เลขเรียงขึ้นหรือลง',
  COMMON: 'เป็นเลขที่คนใช้บ่อยจนเดาง่าย',
} as const

/**
 * The one-time PIN of the demo history when SEED_DEV_PIN is not set: six random digits from node:crypto, drawn again
 * until the PIN rule of FR-AUTH-005 AC1 accepts them. Never printed, and stored only as hashes while the history runs.
 */
export function randomDemoPin(): string {
  for (;;) {
    const pin = String(randomInt(0, 10 ** PIN_LENGTH)).padStart(PIN_LENGTH, '0')
    if (pinProblem(pin) === null) return pin
  }
}

/** The active members who hold, at `now`, a position a DOA version names as approver: the ones seedDevPins gives the PIN */
async function demoApprovers(organizationId: string, now: Date): Promise<string[]> {
  const holders = await forTenant(organizationId).positionAssignment.findMany({
    where: { validFrom: { lte: now }, OR: [{ validTo: null }, { validTo: { gt: now } }], member: { status: 'ACTIVE' } },
    select: { memberId: true },
    distinct: ['memberId'],
    orderBy: { memberId: 'asc' },
  })
  const approvers: string[] = []
  for (const { memberId } of holders) if (await holdsDoaReferencedPosition(organizationId, memberId, now)) approvers.push(memberId)
  return approvers
}

/** Sets `pin` as the PIN of every active approver of the organization who has none (see above) */
export async function seedDevPins(organizationId: string, pin: string, now: Date): Promise<SeedPinsReport> {
  const problem = pinProblem(pin)
  if (problem) throw new SeedPinError(`SEED_DEV_PIN ใช้ไม่ได้: ${PROBLEM_TH[problem]} — เลือก PIN 6 หลักที่เดายาก (FR-AUTH-005 AC1)`)
  const db = forTenant(organizationId)
  const approvers = await demoApprovers(organizationId, now)
  // Argon2 runs before the transaction (a salt of its own for each member)
  const hashes = new Map<string, string>()
  for (const memberId of approvers) hashes.set(memberId, await hashPin(pin))
  const ctx = systemCtx(organizationId, now, 'seed')
  return db.$transaction(async (tx) => {
    const events: EventDraft[] = []
    for (const [memberId, transactionPinHash] of hashes) {
      // Only a member without a PIN, in one conditional update, so a PIN set in between is never overwritten
      const { count } = await tx.member.updateMany({ where: { id: memberId, transactionPinHash: null }, data: { transactionPinHash, pinFailedCount: 0, pinLockedUntil: null } })
      if (count === 1) events.push({ type: 'auth.pin_set', aggregateType: 'Auth', aggregateId: memberId, data: { replaced: false, proof: null, unlocked: false } })
    }
    await appendEvents(tx, ctx, events)
    return { set: events.length, kept: hashes.size - events.length }
  })
}

/**
 * The demo approvers (as seedDevPins counts them at `now`) whose PIN is not `pin` — none, one this server cannot check,
 * another one, or locked now on the security clock — by employee code, so the demo history refuses before it writes
 * anything rather than stop half way at a step-up (src/server/services/demo-history). The seed compares the PIN it
 * holds with the stored hashes; it reads only and counts no try, as it is no sign-in.
 */
export async function approversWithoutPin(organizationId: string, pin: string, now: Date): Promise<string[]> {
  const securityNow = systemClock.now()
  const ids = await demoApprovers(organizationId, now)
  const rows = await forTenant(organizationId).member.findMany({ where: { id: { in: ids } }, select: { employeeCode: true, transactionPinHash: true, pinLockedUntil: true }, orderBy: { employeeCode: 'asc' } })
  const without: string[] = []
  for (const row of rows) {
    const hash = row.transactionPinHash
    const usable = hash !== null && isCheckablePinHash(hash) && !isPinLocked(row.pinLockedUntil, securityNow) && (await verifyPin(pin, hash))
    if (!usable) without.push(row.employeeCode ?? '?')
  }
  return without
}

/** The one-time PINs the demo history gave: each member who got one, with the hash given (only that one is taken back) */
export type OneTimePins = ReadonlyMap<string, string>

/**
 * Without SEED_DEV_PIN (ADR-047 item 9: the seed gives nobody a PIN) the demo history still decides as an approver does,
 * with a PIN step-up (FR-AUTH-005 AC2): every demo approver without a PIN holds `pin` while it runs. Nobody is told it,
 * and takeBackOneTimePins removes it before the history ends — no member ever holds it as their PIN, so it records no
 * auth.pin_set. A member who has a PIN keeps it. Seed only (local and staging), like seedDevPins.
 */
export async function giveOneTimePins(organizationId: string, pin: string, now: Date): Promise<OneTimePins> {
  if (pinProblem(pin)) throw new SeedPinError('the one-time PIN of the demo history breaks the PIN rules (FR-AUTH-005 AC1)')
  const approvers = await demoApprovers(organizationId, now)
  // Argon2 runs before the transaction (a salt of its own for each member)
  const hashes = new Map<string, string>()
  for (const memberId of approvers) hashes.set(memberId, await hashPin(pin))
  const given = new Map<string, string>()
  await forTenant(organizationId).$transaction(async (tx) => {
    for (const [memberId, transactionPinHash] of hashes) {
      // Only a member without a PIN, in one conditional update, so a PIN set in between is never overwritten
      const { count } = await tx.member.updateMany({ where: { id: memberId, transactionPinHash: null }, data: { transactionPinHash, pinFailedCount: 0, pinLockedUntil: null } })
      if (count === 1) given.set(memberId, transactionPinHash)
    }
  })
  return given
}

/** Takes the one-time PINs back: those members hold no PIN again, with no wrong tries counted (a PIN set since stays) */
export async function takeBackOneTimePins(organizationId: string, given: OneTimePins): Promise<void> {
  if (given.size === 0) return
  await forTenant(organizationId).$transaction(async (tx) => {
    for (const [memberId, transactionPinHash] of given) {
      await tx.member.updateMany({ where: { id: memberId, transactionPinHash }, data: { transactionPinHash: null, pinFailedCount: 0, pinLockedUntil: null } })
    }
  })
}
