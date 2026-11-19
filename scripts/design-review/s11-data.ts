import { prisma } from '../../src/server/db/client'
import { E2E_DB, E2E_P2DEMO } from '../../tests/support/e2e-env'

// S11-16 (§9.9 step 4): the records the screen review of S11 opens (scripts/design-review/s11-pages.spec.ts), on the p2demo
// database after the @p2demo scenes played on it (SIMEC of the phase-1 workbook). Prints JSON on its last line.
//   targets   the organization; the assessment scene 22 sent (answers the AI proposed and the contact confirmed), its
//             supplier's portal contact, its open review tasks with their holders (each with the AI's summary); the
//             override scene 17 asked and its approval task; the PO scene 18 left held at the gate; the workflow version
//             the review tasks follow; the questionnaire version in force; a supplier with a completed assessment
// The AI's proposals the portal's box and the on-behalf dialog show come from tests/e2e/p2demo/scripts/s11.ts ai-propose
// (the AI adapter is for tests and the agents only · INV-AI-05).
if (new URL(process.env.DATABASE_URL ?? 'postgresql://x/none').pathname !== `/${E2E_DB}`) throw new Error('the screen review of S11 runs in its e2e database only')
if (!E2E_P2DEMO) throw new Error('the screen review of S11 runs in p2demo mode only (E2E_P2DEMO=1)')
const [mode] = process.argv.slice(2)

const org = await prisma.organization.findFirstOrThrow({ where: { code: 'SIMEC' }, select: { id: true, code: true } })
const organizationId = org.id
const codeOf = async (memberId: string | null | undefined) => (memberId ? ((await prisma.member.findUnique({ where: { id: memberId }, select: { employeeCode: true } }))?.employeeCode ?? null) : null)
const contactOf = async (supplierId: string) =>
  (await prisma.supplierContact.findFirst({ where: { organizationId, supplierId, status: 'ACTIVE', portalEnabled: true }, orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }], select: { email: true } }))?.email ?? null

/** Scene 22's assessment: the one whose answers came from the AI and a person confirmed */
async function sceneAiAssessment() {
  const answer = await prisma.riskAnswer.findFirst({ where: { organizationId, agentActionId: { not: null } }, orderBy: { createdAt: 'desc' }, select: { assessmentId: true } })
  return answer ? prisma.riskAssessment.findUnique({ where: { id: answer.assessmentId }, select: { id: true, supplierId: true, reviewRound: true } }) : null
}

if (mode === 'targets') {
  const sent = await sceneAiAssessment()
  const tasks = sent ? await prisma.reviewTask.findMany({ where: { organizationId, assessmentId: sent.id, reviewRound: sent.reviewRound, status: 'OPEN' }, orderBy: [{ groupNo: 'asc' }, { slotNo: 'asc' }], select: { id: true, assigneeMemberId: true, workflowVersionId: true } }) : []
  const override = await prisma.riskOverride.findFirst({ where: { organizationId, number: { not: null } }, orderBy: { submittedAt: 'desc' }, select: { id: true, supplierId: true } })
  const overrideTask = override
    ? await prisma.approvalTask.findFirst({ where: { organizationId, step: { route: { subjectType: 'RISK_OVERRIDE', subjectId: override.id } } }, orderBy: { createdAt: 'desc' }, select: { id: true, assignee: { select: { employeeCode: true } } } })
    : null
  // scene 18: the registry says the supplier is gone, so the gate holds its new PO (a draft on procurement's desk)
  const heldPo = await prisma.purchaseOrder.findFirst({ where: { organizationId, status: 'DRAFT', supplier: { registryFlag: { not: 'NONE' } } }, orderBy: { createdAt: 'desc' }, select: { id: true } })
  const questionnaire = await prisma.riskQuestionnaire.findFirst({ where: { organizationId, status: 'PUBLISHED' }, orderBy: { versionNo: 'desc' }, select: { id: true } })
  const completed = await prisma.riskAssessment.findFirst({ where: { organizationId, status: 'COMPLETED' }, orderBy: { completedAt: 'desc' }, select: { supplierId: true } })
  console.log(
    JSON.stringify({
      org: org.code.toLowerCase(),
      organizationId,
      sentAssessment: sent?.id ?? null,
      sentSupplier: sent?.supplierId ?? null,
      sentContact: sent ? await contactOf(sent.supplierId) : null,
      reviewTasks: await Promise.all(tasks.map(async (t) => ({ id: t.id, code: await codeOf(t.assigneeMemberId) }))),
      workflowVersion: tasks[0]?.workflowVersionId ?? null,
      override: override?.id ?? null,
      overrideTask: overrideTask ? { id: overrideTask.id, code: overrideTask.assignee?.employeeCode ?? null } : null,
      heldPo: heldPo?.id ?? null,
      questionnaire: questionnaire?.id ?? null,
      completedSupplier: completed?.supplierId ?? null,
    }),
  )
} else throw new Error(`unknown mode ${mode}`)
await prisma.$disconnect()
