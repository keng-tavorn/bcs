import { pinProblem } from '@/core/pin'
import { hashPin } from '@/server/auth/pin'
import { holdsDoaReferencedPosition } from '@/server/auth/session'
import { systemCtx } from '@/server/context'
import { forTenant } from '@/server/db/tenant'
import { appendEvents, type EventDraft } from '@/server/events/append'

// Transaction PINs of the demo organization (docs/sub-specs/S5.md, row step-up; FR-AUTH-005). When SEED_DEV_PIN is set
// (local and staging only, src/lib/env.ts), every active demo member who holds now a position a DOA version names as
// approver gets it as their PIN, so the presenter and the e2e tests can approve high amounts and policy in LIFF and on
// the web. Without it nobody has a PIN and approvers set their own at first use. A member who has a PIN keeps it, so
// running the seed again changes nothing (pnpm db:reset starts over). Each PIN set is an auth.pin_set event of the seed.
// The PIN is never printed: errors and the report hold counts only.

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

/** Sets `pin` as the PIN of every active approver of the organization who has none (see above) */
export async function seedDevPins(organizationId: string, pin: string, now: Date): Promise<SeedPinsReport> {
  const problem = pinProblem(pin)
  if (problem) throw new SeedPinError(`SEED_DEV_PIN ใช้ไม่ได้: ${PROBLEM_TH[problem]} — เลือก PIN 6 หลักที่เดายาก (FR-AUTH-005 AC1)`)
  const db = forTenant(organizationId)
  const holders = await db.positionAssignment.findMany({
    where: { validFrom: { lte: now }, OR: [{ validTo: null }, { validTo: { gt: now } }], member: { status: 'ACTIVE' } },
    select: { memberId: true },
    distinct: ['memberId'],
    orderBy: { memberId: 'asc' },
  })
  const approvers: string[] = []
  for (const { memberId } of holders) if (await holdsDoaReferencedPosition(organizationId, memberId, now)) approvers.push(memberId)
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
