import { randomUUID } from 'node:crypto'
import { TZDate } from '@date-fns/tz'
import { satangToAmount } from '@/core/money/dto'
import { systemClock } from '@/lib/clock'
import { hashPin } from '@/server/auth/pin'
import { makeCtx } from '@/server/context'
import { prisma } from '@/server/db/client'
import { createDraft, submitRequest } from '../support/requests'
import { E2E_DB, E2E_PIN } from '../support/e2e-env'
import { makeRoom } from './budget-room'

/** The demo organization the e2e seed makes: other scenes' test organizations reuse the same employee codes */
const DEMO_ORG = 'DEMO'

// Activity for the e2e specs of the PIN on the decision page (S5-05, FR-AUTH-005 AC2 AC3), made through the services in
// the e2e database only, like tests/e2e/tasks-fixtures.ts. Each Playwright project passes its own requester and
// approver, so desktop and mobile never decide the same task. Prints one line: FIXTURE <json>.
//   at-threshold <requester>   a request whose amount with VAT is exactly the stepUpThreshold of the demo organization's
//                              DOA version in effect (read from the database, never written here), waiting for its approver
//   pin-off <member>           the member holds no PIN for a while (as before they set one at /settings/pin)
//   pin-on <member>            the member holds the e2e seed's PIN again (E2E_PIN), with no wrong tries
//   pin-unlock <member>        the lock of five wrong PINs ends now, as it would after 15 minutes
// The PIN states are test set-up of the member's row (the screens change a PIN with a fresh proof, self.set_pin); every
// spec that turns a PIN off or locks it turns it back on in the same test (Playwright runs one test at a time).
if (new URL(process.env.DATABASE_URL ?? 'postgresql://x/none').pathname !== `/${E2E_DB}`) throw new Error('e2e fixtures are created in the e2e database only')

const now = systemClock.now()
const key = () => ({ idempotencyKey: randomUUID(), sender: null })
const TITLE = 'เครื่องปั่นไฟสำรองไซต์งาน'
const pad = (n: number) => String(n).padStart(2, '0')

async function atThreshold(requesterCode: string) {
  const m = await prisma.member.findFirstOrThrow({ where: { employeeCode: requesterCode, organization: { code: DEMO_ORG } }, select: { id: true, organizationId: true, primaryDepartmentId: true } })
  const ctx = makeCtx({ organizationId: m.organizationId, actor: { type: 'USER', memberId: m.id }, channel: 'WEB', now })
  const version = await prisma.doaVersion.findFirstOrThrow({
    where: { organizationId: m.organizationId, status: 'PUBLISHED', effectiveFrom: { lte: now }, OR: [{ effectiveTo: null }, { effectiveTo: { gt: now } }] },
    orderBy: { effectiveFrom: 'desc' },
    select: { stepUpThresholdSatang: true },
  })
  if (version.stepUpThresholdSatang === null) throw new Error('the DOA version in effect sets no stepUpThreshold')
  // An open budget line of the requester's department in the fiscal year of today (as tasks-fixtures.ts picks one)
  const today = new TZDate(now.getTime(), 'Asia/Bangkok')
  const day = new Date(`${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}T00:00:00Z`)
  const lines = await prisma.budgetLine.findMany({
    where: { organizationId: m.organizationId, departmentId: m.primaryDepartmentId ?? undefined, status: 'OPEN', fiscalYear: { startsOn: { lte: day }, endsOn: { gte: day } } },
    orderBy: { code: 'asc' },
    select: { id: true, code: true },
  })
  const line = lines.find((l) => l.code.includes('OPEX')) ?? lines[0]
  if (!line) throw new Error('no open budget line in the fiscal year of today')
  // the specs of a run spend the same lines: a budget admin tops this one up when they have left less (./budget-room.ts)
  await makeRoom(line.code, version.stepUpThresholdSatang)
  const draft = await createDraft(
    ctx,
    { requestTypeCode: 'BUY_GOODS', title: TITLE, priceIncludesVat: true, budgetLineId: line.id, lines: [{ description: 'เครื่องปั่นไฟ', quantity: '1', uom: 'เครื่อง', unitPrice: satangToAmount(version.stepUpThresholdSatang) }] },
    key(),
  )
  if (!draft.ok) throw new Error(`draft failed: ${JSON.stringify(draft.error)}`)
  const sent = await submitRequest(ctx, { requestId: draft.data.requestId }, key())
  if (!sent.ok) throw new Error(`submit failed: ${JSON.stringify(sent.error)}`)
  const task = await prisma.approvalTask.findFirstOrThrow({ where: { status: 'OPEN', step: { route: { subjectType: 'REQUEST', subjectId: draft.data.requestId } } }, select: { id: true } })
  return { requestId: draft.data.requestId, number: sent.data.number, taskId: task.id, amount: satangToAmount(version.stepUpThresholdSatang) }
}

/** The PIN state of one demo member: none, the e2e seed's again, or the end of a lock */
async function pinState(memberCode: string, state: 'off' | 'on' | 'unlock') {
  const m = await prisma.member.findFirstOrThrow({ where: { employeeCode: memberCode, organization: { code: DEMO_ORG } }, select: { id: true } })
  if (state === 'off') await prisma.member.update({ where: { id: m.id }, data: { transactionPinHash: null, pinFailedCount: 0, pinLockedUntil: null } })
  if (state === 'on') await prisma.member.updateMany({ where: { id: m.id, transactionPinHash: null }, data: { transactionPinHash: await hashPin(E2E_PIN), pinFailedCount: 0, pinLockedUntil: null } })
  if (state === 'unlock') await prisma.member.update({ where: { id: m.id }, data: { pinFailedCount: 0, pinLockedUntil: null } })
  return { memberId: m.id }
}

const [scenario, ...args] = process.argv.slice(2)
let out: unknown
switch (scenario) {
  case 'at-threshold':
    out = await atThreshold(args[0]!)
    break
  case 'pin-off':
    out = await pinState(args[0]!, 'off')
    break
  case 'pin-on':
    out = await pinState(args[0]!, 'on')
    break
  case 'pin-unlock':
    out = await pinState(args[0]!, 'unlock')
    break
  default:
    throw new Error(`unknown scenario ${scenario}`)
}
await prisma.$disconnect()
console.log(`FIXTURE ${JSON.stringify(out)}`)
