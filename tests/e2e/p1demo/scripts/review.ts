import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { E2E_DB } from '../../../support/e2e-env'

// Run by scene 1 of phase 1 (P1-08, the parallel reviewers of S6 · FR-WF-101; tests/e2e/p1demo/support.ts script())
// against the run's e2e database only, on SIMEC — the organization of sheet Org of the phase-1 workbook. What the request
// screens do not say and day.ts's request facts leave out: the steps of the route with their kind, status, SLA and the
// quorum of their groups; each task with the workflow rules it answers for and its decision's channel; the request's
// form answers, its lines (catalogue items), quotations, flags (BR-DUP-05), questions and answers, its own events and
// those of its steps; the price reference of its lines (BR-PRC-01, as the approver's card reads it); and the task
// notices about it with their status. Prints JSON on its last line; amounts are satang as strings.
//   facts <requestId>

async function main(command: string | undefined, args: readonly string[]): Promise<unknown> {
  if (new URL(process.env.DATABASE_URL ?? 'postgresql://x/none').pathname !== `/${E2E_DB}`) throw new Error('the review scene runs in the e2e database only')
  const [{ systemClock }, { prisma }, { INPUT_WORKBOOKS, loadInputWorkbook }, { priceReferenceForCard }] = await Promise.all([
    import('@/lib/clock'),
    import('@/server/db/client'),
    import('@/server/seed/workbook'),
    import('@/server/queries/price-reference'),
  ])
  const workbook = await loadInputWorkbook(INPUT_WORKBOOKS.p1)
  const orgCode = workbook.keyValues('Org').get('code')?.value
  if (!orgCode) throw new Error('the Org sheet names no organization code')
  const org = await prisma.organization.findUniqueOrThrow({ where: { code: orgCode }, select: { id: true } })
  const satang = (value: bigint | null | undefined) => (value === null || value === undefined ? null : value.toString())

  async function facts(requestId: string) {
    const r = await prisma.request.findFirst({
      where: { organizationId: org.id, id: requestId },
      select: {
        id: true,
        number: true,
        status: true,
        formData: true,
        suggestedSupplier: { select: { code: true } },
        lines: { orderBy: { lineNo: 'asc' }, select: { lineNo: true, description: true, quantity: true, uom: true, unitPriceSatang: true, catalogItem: { select: { code: true } } } },
        quotations: { orderBy: { createdAt: 'asc' }, select: { supplierName: true, supplier: { select: { code: true } }, amountSatang: true, includesVat: true, isSelected: true, fileId: true } },
        currentRoute: {
          select: {
            id: true,
            ruleCode: true,
            amountSatang: true,
            doaVersion: { select: { code: true, versionNo: true, stepUpThresholdSatang: true } },
            steps: {
              orderBy: { stepNo: 'asc' },
              select: {
                id: true,
                stepNo: true,
                kind: true,
                status: true,
                slaBusinessMinutes: true,
                reviewGroups: true,
                tasks: { orderBy: [{ slotNo: 'asc' }, { assignedAt: 'asc' }], select: { id: true, slotNo: true, status: true, decision: true, channel: true, workflowRuleCodes: true, assignee: { select: { employeeCode: true } } } },
              },
            },
          },
        },
      },
    })
    if (!r) throw new Error(`no request ${requestId} in ${orgCode}`)
    const steps = r.currentRoute?.steps ?? []
    const tasks = steps.flatMap((s) => s.tasks)
    const decided = await prisma.event.findMany({
      where: { organizationId: org.id, type: 'approval_task.decided', aggregateType: 'ApprovalTask', aggregateId: { in: tasks.map((t) => t.id) } },
      select: { aggregateId: true, channel: true },
    })
    const stepEvents = await prisma.event.findMany({
      where: { organizationId: org.id, aggregateType: 'ApprovalStep', aggregateId: { in: steps.map((s) => s.id) } },
      orderBy: { seq: 'asc' },
      select: { aggregateId: true, type: true, data: true },
    })
    const own = await prisma.event.findMany({ where: { organizationId: org.id, aggregateType: 'Request', aggregateId: r.id }, orderBy: { seq: 'asc' }, select: { type: true, channel: true } })
    const flags = await prisma.requestFlag.findMany({ where: { organizationId: org.id, requestId: r.id }, orderBy: { createdAt: 'asc' }, select: { kind: true, matchedRequestIds: true, acknowledgedReason: true } })
    const matched = await prisma.request.findMany({ where: { organizationId: org.id, id: { in: flags.flatMap((f) => f.matchedRequestIds) } }, select: { id: true, number: true } })
    const asked = await prisma.infoRequest.findMany({
      where: { organizationId: org.id, requestId: r.id },
      orderBy: { askedAt: 'asc' },
      select: { taskId: true, question: true, answer: true, askedById: true, answeredById: true },
    })
    const notices = await prisma.notification.findMany({
      where: { organizationId: org.id, subjectId: r.id, templateKey: { in: ['task.assigned', 'task.review_assigned'] } },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: { templateKey: true, status: true, data: true, recipientMemberId: true },
    })
    const people = await prisma.member.findMany({
      where: { organizationId: org.id, id: { in: [...asked.flatMap((a) => [a.askedById, a.answeredById]), ...notices.map((n) => n.recipientMemberId)].filter((id): id is string => id !== null) } },
      select: { id: true, employeeCode: true },
    })
    const codeOf = (id: string | null) => (id === null ? null : (people.find((p) => p.id === id)?.employeeCode ?? id))
    const price = await priceReferenceForCard(org.id, r.id, systemClock.now())
    return {
      id: r.id,
      number: r.number,
      status: r.status,
      form: r.formData,
      suggestedSupplier: r.suggestedSupplier?.code ?? null,
      lines: r.lines.map((l) => ({ lineNo: l.lineNo, description: l.description, quantity: l.quantity.toString(), uom: l.uom, unitPrice: satang(l.unitPriceSatang), item: l.catalogItem?.code ?? null })),
      quotations: r.quotations.map((q) => ({ supplierName: q.supplierName, supplier: q.supplier?.code ?? null, amount: satang(q.amountSatang), includesVat: q.includesVat, chosen: q.isSelected, file: q.fileId !== null })),
      route: r.currentRoute
        ? {
            ruleCode: r.currentRoute.ruleCode,
            amount: satang(r.currentRoute.amountSatang),
            doa: { code: r.currentRoute.doaVersion.code, versionNo: r.currentRoute.doaVersion.versionNo, stepUpThreshold: satang(r.currentRoute.doaVersion.stepUpThresholdSatang) },
          }
        : null,
      steps: steps.map((s) => ({
        stepNo: s.stepNo,
        kind: s.kind,
        status: s.status,
        slaBusinessMinutes: s.slaBusinessMinutes,
        quorums: Array.isArray(s.reviewGroups) ? s.reviewGroups.map((g) => (g as { quorum?: unknown }).quorum ?? null) : [],
        tasks: s.tasks.map((t) => ({
          id: t.id,
          slotNo: t.slotNo,
          assignee: t.assignee.employeeCode,
          status: t.status,
          decision: t.decision,
          channel: t.channel,
          rules: t.workflowRuleCodes,
          decidedOn: decided.find((e) => e.aggregateId === t.id)?.channel ?? null,
        })),
        events: stepEvents.filter((e) => e.aggregateId === s.id).map((e) => ({ type: e.type, outcome: (e.data as { outcome?: unknown }).outcome ?? null })),
      })),
      flags: flags.map((f) => ({ kind: f.kind, matched: f.matchedRequestIds.map((id) => matched.find((m) => m.id === id)?.number ?? id), acknowledgedReason: f.acknowledgedReason })),
      questions: asked.map((a) => ({ taskId: a.taskId, by: codeOf(a.askedById), question: a.question, answer: a.answer, answeredBy: codeOf(a.answeredById) })),
      events: own.map((e) => ({ type: e.type, channel: e.channel })),
      notices: notices.map((n) => ({ templateKey: n.templateKey, status: n.status, recipient: codeOf(n.recipientMemberId), taskId: (n.data as { taskId?: unknown }).taskId ?? null })),
      priceRef: (price?.lines ?? []).map((l) => ({ lineNo: l.lineNo, count: l.count, median: l.medianSatang, status: l.status, alert: l.alert })),
    }
  }

  try {
    switch (command) {
      case 'facts':
        if (!args[0]) throw new Error('facts <requestId>')
        return await facts(args[0])
      default:
        throw new Error(`unknown review scene command ${command ?? '(none)'}`)
    }
  } finally {
    await prisma.$disconnect()
  }
}

const ranByTsx = process.argv[1] !== undefined && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
if (ranByTsx) {
  const [command, ...args] = process.argv.slice(2)
  console.log(JSON.stringify(await main(command, args)))
}
