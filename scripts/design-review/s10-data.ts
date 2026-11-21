import { prisma } from '../../src/server/db/client'
import { E2E_DB, E2E_P2DEMO } from '../../tests/support/e2e-env'

// S10-20 (§9.9 step 4): the records the screen review of S10 opens (scripts/design-review/s10-pages.spec.ts), on the
// p2demo database after the @p2demo scenes played on it (SIMEC of the phase-1 workbook). Prints JSON on its last line.
//   targets   the organization; the RFQ of scene 9 (awarded) with who made it, an evaluator, its award, the award's
//             approval task and its holder, a PO it drafted, its winner's and a loser's contact; the RFP of the seed
//             (awarded); the RFI (concluded); the open RFx of scene 13 and the contacts invited to it (a Thai one when
//             there is one, the foreign one); a draft RFx
if (new URL(process.env.DATABASE_URL ?? 'postgresql://x/none').pathname !== `/${E2E_DB}`) throw new Error('the screen review of S10 runs in its e2e database only')
if (!E2E_P2DEMO) throw new Error('the screen review of S10 runs in p2demo mode only (E2E_P2DEMO=1)')
const [mode] = process.argv.slice(2)
if (mode !== 'targets') throw new Error(`unknown mode ${mode}`)

const org = await prisma.organization.findFirstOrThrow({ where: { code: 'SIMEC' }, select: { id: true, code: true } })
const organizationId = org.id
const codeOf = async (memberId: string | null | undefined) =>
  memberId ? ((await prisma.member.findUnique({ where: { id: memberId }, select: { employeeCode: true } }))?.employeeCode ?? null) : null
const rfxOf = (kind: 'RFQ' | 'RFP' | 'RFI', status: 'AWARDED' | 'CONCLUDED' | 'OPEN' | 'DRAFT') =>
  prisma.rfxEvent.findFirst({ where: { organizationId, kind, status }, orderBy: { updatedAt: 'desc' }, select: { id: true, createdById: true, scorecardId: true } })

const rfq = await rfxOf('RFQ', 'AWARDED')
const rfp = await rfxOf('RFP', 'AWARDED')
const rfi = await rfxOf('RFI', 'CONCLUDED')
const open = await prisma.rfxEvent.findFirst({ where: { organizationId, status: 'OPEN' }, orderBy: { openedAt: 'desc' }, select: { id: true, createdById: true } })
const draft = await prisma.rfxEvent.findFirst({ where: { organizationId, status: 'DRAFT' }, orderBy: { updatedAt: 'desc' }, select: { id: true, createdById: true } })
const evaluator = rfq?.scorecardId ? await prisma.scorecardEvaluator.findFirst({ where: { organizationId, scorecardId: rfq.scorecardId }, orderBy: { assignedAt: 'asc' }, select: { memberId: true } }) : null
const award = rfq ? await prisma.awardDecision.findFirst({ where: { organizationId, rfxEventId: rfq.id, status: 'APPROVED' }, select: { id: true } }) : null
const task = await prisma.approvalTask.findFirst({
  where: { organizationId, step: { route: { subjectType: 'AWARD_DECISION' } } },
  orderBy: { assignedAt: 'desc' },
  select: { id: true, assignee: { select: { employeeCode: true } } },
})
const po = award ? await prisma.purchaseOrder.findFirst({ where: { organizationId, awardDecisionId: award.id }, orderBy: { createdAt: 'asc' }, select: { id: true } }) : null

/** The primary (or first) contact of each supplier invited to the RFx, with the supplier's place in the award */
async function contactsOf(rfxEventId: string | undefined) {
  if (!rfxEventId) return []
  const invites = await prisma.rfxInvite.findMany({
    where: { organizationId, rfxEventId, supplierId: { not: null }, status: { in: ['INVITED', 'VIEWED', 'BID_SUBMITTED'] } },
    orderBy: { invitedAt: 'asc' },
    select: { supplierId: true, contact: { select: { email: true, locale: true } } },
  })
  const won = award ? new Set((await prisma.awardLine.findMany({ where: { organizationId, awardDecisionId: award.id }, select: { supplierId: true } })).map((l) => l.supplierId)) : new Set<string>()
  return invites.map((i) => ({ email: i.contact.email, locale: i.contact.locale.toLowerCase(), won: won.has(i.supplierId!) }))
}
const rfqContacts = await contactsOf(rfq?.id)
const openContacts = await contactsOf(open?.id)

console.log(
  JSON.stringify({
    org: org.code.toLowerCase(),
    rfq: rfq ? { id: rfq.id, by: await codeOf(rfq.createdById), evaluator: await codeOf(evaluator?.memberId) } : null,
    rfp: rfp ? { id: rfp.id, by: await codeOf(rfp.createdById) } : null,
    rfi: rfi ? { id: rfi.id, by: await codeOf(rfi.createdById) } : null,
    open: open ? { id: open.id, by: await codeOf(open.createdById) } : null,
    draft: draft ? { id: draft.id, by: await codeOf(draft.createdById) } : null,
    awardTask: task ? { id: task.id, code: task.assignee?.employeeCode ?? null } : null,
    awardPo: po?.id ?? null,
    winnerContact: rfqContacts.find((c) => c.won)?.email ?? null,
    loserContact: rfqContacts.find((c) => !c.won)?.email ?? null,
    openThaiContact: openContacts.find((c) => c.locale === 'th')?.email ?? null,
    openForeignContact: openContacts.find((c) => c.locale !== 'th')?.email ?? null,
  }),
)
await prisma.$disconnect()
