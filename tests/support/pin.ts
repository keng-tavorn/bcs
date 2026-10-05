import { stepUpNeeded } from '@/core/pin'
import { hashPin } from '@/server/auth/pin'
import { grantStepUp, type StepUpChannel } from '@/server/auth/step-up'
import { prisma } from '@/server/db/client'
import { seedDevPins } from '@/server/seed/pins'

// The transaction PIN in service tests (FR-AUTH-005, S5-05). Deciding a policy task, or a task whose amount the DOA
// counted is at or above its version's stepUpThreshold, takes a PIN step-up for that document, given in the last 5
// minutes on the security clock (real time) and used once. Tests give their approvers this PIN the way the demo seed
// does (seedDevPins: every member who holds a position a DOA version names) and step up before such a decision.

/** A PIN that passes the rules of FR-AUTH-005 AC1 (src/core/pin) */
export const TEST_PIN = '739164'

/** Every active approver of the organization gets TEST_PIN, as pnpm db:seed gives SEED_DEV_PIN (src/server/seed/pins.ts) */
export function seedTestPins(organizationId: string, now: Date = new Date()) {
  return seedDevPins(organizationId, TEST_PIN, now)
}

/**
 * TEST_PIN for a member the seed does not cover (a delegate, a contract signatory without a position), set on the row
 * when the member has none; the screens set it with a fresh proof instead (self.set_pin)
 */
export async function ensureTestPin(memberId: string): Promise<void> {
  const member = await prisma.member.findUniqueOrThrow({ where: { id: memberId }, select: { transactionPinHash: true } })
  if (!member.transactionPinHash) await prisma.member.update({ where: { id: memberId }, data: { transactionPinHash: await hashPin(TEST_PIN) } })
}

/** A PIN step-up of the member for one document, now on the security clock; throws when the PIN is refused */
export async function pinStepUp(organizationId: string, memberId: string, subjectType: string, subjectId: string, channel?: StepUpChannel): Promise<string> {
  await ensureTestPin(memberId)
  const granted = await grantStepUp({ organizationId, memberId, subjectType, subjectId, method: 'PIN', pin: TEST_PIN, ...(channel ? { channel } : {}) }, new Date(), { sender: null })
  if (!granted.ok) throw new Error(`PIN step-up refused: ${granted.reason}`)
  return granted.grantId
}

/**
 * What the decision page's server action hands the commands of src/app/(workspace)/_tracking/commands.ts with a PIN:
 * real time, and the change of session id after a right PIN (NFR-SEC-04), which a test without a browser counts here
 */
export function testStepUpSession() {
  const rotated: Date[] = []
  return {
    securityNow: new Date(),
    rotateSession: async () => {
      rotated.push(new Date())
      return true
    },
    sender: null,
    rotated,
  }
}

/**
 * Before deciding this task: the step-up its decision needs (FR-AUTH-005 AC2), by the member who decides it — read from
 * the task's route and DOA version as the deciding command reads them. null when the task needs none.
 */
export async function stepUpForTask(taskId: string, deciderMemberId: string, channel?: StepUpChannel): Promise<string | null> {
  const task = await prisma.approvalTask.findUniqueOrThrow({
    where: { id: taskId },
    select: { organizationId: true, step: { select: { route: { select: { subjectType: true, subjectId: true, amountSatang: true, doaVersion: { select: { stepUpThresholdSatang: true } } } } } } },
  })
  const route = task.step.route
  if (!stepUpNeeded({ subjectType: route.subjectType, amountSatang: route.amountSatang, stepUpThresholdSatang: route.doaVersion.stepUpThresholdSatang })) return null
  return pinStepUp(task.organizationId, deciderMemberId, route.subjectType, route.subjectId, channel)
}
