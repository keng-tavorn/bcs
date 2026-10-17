import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { E2E_DB } from '../../../support/e2e-env'

// Run by the S6 scenes 3, 4 and 5 of phase 1 (P1-08, tests/e2e/p1demo/03- to 05-…spec.ts, through support.ts script())
// against the p1demo e2e database only: what the database says about the workflow versions, a budget transfer and a
// request's flags, on the organization named by sheet Org of the phase-1 workbook. Reads only; nothing is changed.
// Prints JSON on its last line; amounts are satang as strings.
//   workflow <code>            every version of the workflow (number, status, period, who sent and approved it, its
//                              rules' conditions), the open approval task of a version waiting for approval (the task,
//                              its holder and DOA rule), the versions' own events, and the version in effect now
//   subject-task <type> <id>   the approval route of a document (BUDGET_TRANSFER, WORKFLOW_VERSION …): its DOA rule and
//                              amount, and every task with its holder, status, decision's event and the step-up grant
//                              that decision used (whose, for which document, by what proof, spent)
//   transfer <id>              a budget transfer: number, kind, status, amount, its lines (planned and balance now, and
//                              what this transfer moved on each in the ledger), its route and the events of its story
//   flags <requestNumber>      a request's flags (kind, the requests matched by number, the reason given, route number),
//                              its lines as sent (catalogue item, quantity, unit, price), its source request, how its
//                              draft was made (request.drafted: source, channel, who) and supplier
// To the p1demo project of playwright.config.ts only the *.spec.ts files of tests/e2e/p1demo are test files: this one
// does its work only when tsx runs it, and loads the app's modules only then.

async function main(command: string | undefined, args: readonly string[]): Promise<unknown> {
  if (new URL(process.env.DATABASE_URL ?? 'postgresql://x/none').pathname !== `/${E2E_DB}`) throw new Error('the S6 scene script runs in the e2e database only')
  const [{ systemClock }, { prisma }, { INPUT_WORKBOOKS, loadInputWorkbook }] = await Promise.all([import('@/lib/clock'), import('@/server/db/client'), import('@/server/seed/workbook')])
  const workbook = await loadInputWorkbook(INPUT_WORKBOOKS.p1)
  const orgCode = workbook.keyValues('Org').get('code')?.value
  if (!orgCode) throw new Error('the Org sheet names no organization code')
  const org = await prisma.organization.findUniqueOrThrow({ where: { code: orgCode }, select: { id: true } })
  const organizationId = org.id
  const satang = (value: bigint | null | undefined) => (value === null || value === undefined ? null : value.toString())
  const iso = (value: Date | null | undefined) => (value ? value.toISOString() : null)

  /** Member ids → employee codes, for whatever the facts name */
  async function codesOf(ids: ReadonlyArray<string | null | undefined>) {
    const wanted = [...new Set(ids.filter((id): id is string => typeof id === 'string'))]
    const found = await prisma.member.findMany({ where: { organizationId, id: { in: wanted } }, select: { id: true, employeeCode: true } })
    const codes = new Map(found.map((m) => [m.id, m.employeeCode ?? m.id] as const))
    return (id: string | null | undefined) => (id ? (codes.get(id) ?? id) : null)
  }

  /** The routes of a document, newest last, each with its tasks and the events of their decisions */
  async function routesOf(subjectType: string, subjectId: string) {
    const routes = await prisma.approvalRoute.findMany({
      where: { organizationId, subjectType: subjectType as never, subjectId },
      orderBy: { routeNo: 'asc' },
      select: {
        id: true,
        routeNo: true,
        status: true,
        ruleCode: true,
        amountBasis: true,
        amountSatang: true,
        doaVersion: { select: { code: true, versionNo: true } },
        steps: {
          orderBy: { stepNo: 'asc' },
          select: {
            stepNo: true,
            kind: true,
            tasks: {
              orderBy: { assignedAt: 'asc' },
              select: { id: true, status: true, decision: true, channel: true, resolvedFrom: true, assigneeMemberId: true, principalMemberId: true, decidedByMemberId: true },
            },
          },
        },
      },
    })
    const taskIds = routes.flatMap((r) => r.steps.flatMap((s) => s.tasks.map((t) => t.id)))
    const decided = await prisma.event.findMany({
      where: { organizationId, type: 'approval_task.decided', aggregateType: 'ApprovalTask', aggregateId: { in: taskIds } },
      select: { aggregateId: true, channel: true, actorMemberId: true, doaRuleCode: true, data: true },
    })
    const grantIdOf = (data: unknown) => {
      const id = (data ?? {}) as { stepUpGrantId?: unknown }
      return typeof id.stepUpGrantId === 'string' ? id.stepUpGrantId : null
    }
    // The step-up grants the decisions used (BR-DOA-15): whose, for which document, by what proof, and spent
    const grants = await prisma.stepUpGrant.findMany({
      where: { organizationId, id: { in: decided.map((e) => grantIdOf(e.data)).filter((id): id is string => id !== null) } },
      select: { id: true, memberId: true, subjectType: true, subjectId: true, method: true, usedAt: true },
    })
    const codeOf = await codesOf([
      ...routes.flatMap((r) => r.steps.flatMap((s) => s.tasks.flatMap((t) => [t.assigneeMemberId, t.principalMemberId, t.decidedByMemberId]))),
      ...decided.map((e) => e.actorMemberId),
      ...grants.map((g) => g.memberId),
    ])
    return routes.map((r) => ({
      id: r.id,
      routeNo: r.routeNo,
      status: r.status,
      ruleCode: r.ruleCode,
      amountBasis: r.amountBasis,
      amount: satang(r.amountSatang),
      doa: { code: r.doaVersion.code, versionNo: r.doaVersion.versionNo },
      tasks: r.steps.flatMap((s) =>
        s.tasks.map((t) => {
          const event = decided.find((e) => e.aggregateId === t.id)
          const grantId = event ? grantIdOf(event.data) : null
          const grant = grants.find((g) => g.id === grantId)
          return {
            id: t.id,
            stepNo: s.stepNo,
            stepKind: s.kind,
            status: t.status,
            decision: t.decision,
            channel: t.channel,
            resolvedFrom: t.resolvedFrom,
            assignee: codeOf(t.assigneeMemberId),
            principal: codeOf(t.principalMemberId),
            decidedBy: codeOf(t.decidedByMemberId),
            decided: event ? { channel: event.channel, by: codeOf(event.actorMemberId), doaRuleCode: event.doaRuleCode, stepUp: grantId !== null } : null,
            stepUpGrant: grant ? { method: grant.method, by: codeOf(grant.memberId), subjectType: grant.subjectType, subjectId: grant.subjectId, used: grant.usedAt !== null } : null,
          }
        }),
      ),
    }))
  }

  async function workflow(code: string) {
    const at = systemClock.now()
    const versions = await prisma.workflowVersion.findMany({
      where: { organizationId, code },
      orderBy: { versionNo: 'asc' },
      select: {
        id: true,
        versionNo: true,
        status: true,
        effectiveFrom: true,
        effectiveTo: true,
        changeReason: true,
        submittedById: true,
        approvedById: true,
        rules: { orderBy: { sortOrder: 'asc' }, select: { code: true, requestTypeCodes: true, when: true } },
      },
    })
    const codeOf = await codesOf(versions.flatMap((v) => [v.submittedById, v.approvedById]))
    const events = await prisma.event.findMany({ where: { organizationId, aggregateType: 'WorkflowVersion', aggregateId: { in: versions.map((v) => v.id) } }, orderBy: { seq: 'asc' }, select: { aggregateId: true, type: true, data: true } })
    const open = []
    for (const v of versions.filter((x) => x.status === 'PENDING_APPROVAL')) {
      for (const route of await routesOf('WORKFLOW_VERSION', v.id)) {
        for (const t of route.tasks.filter((x) => x.status === 'OPEN')) open.push({ taskId: t.id, versionId: v.id, versionNo: v.versionNo, assignee: t.assignee, resolvedFrom: t.resolvedFrom, ruleCode: route.ruleCode, doa: route.doa })
      }
    }
    const inEffect = versions.find((v) => v.status === 'PUBLISHED' && v.effectiveFrom <= at && (v.effectiveTo === null || v.effectiveTo > at))
    return {
      now: at.toISOString(),
      inEffectVersionNo: inEffect?.versionNo ?? null,
      versions: versions.map((v) => ({
        id: v.id,
        versionNo: v.versionNo,
        status: v.status,
        effectiveFrom: v.effectiveFrom.toISOString(),
        effectiveTo: iso(v.effectiveTo),
        changeReason: v.changeReason,
        submittedBy: codeOf(v.submittedById),
        approvedBy: codeOf(v.approvedById),
        rules: v.rules.map((r) => ({ code: r.code, requestTypeCodes: r.requestTypeCodes, when: r.when })),
        events: events.filter((e) => e.aggregateId === v.id).map((e) => ({ type: e.type, data: e.data })),
      })),
      open,
    }
  }

  async function transfer(id: string) {
    const row = await prisma.budgetTransfer.findFirst({
      where: { organizationId, id },
      select: {
        id: true,
        number: true,
        kind: true,
        status: true,
        amountSatang: true,
        reason: true,
        submittedById: true,
        fromBudgetLineId: true,
        toBudgetLineId: true,
      },
    })
    if (!row) return null
    const lineIds = [row.fromBudgetLineId, row.toBudgetLineId].filter((x): x is string => x !== null)
    const lines = await prisma.budgetLine.findMany({
      where: { organizationId, id: { in: lineIds } },
      select: { id: true, code: true, plannedSatang: true, balance: { select: { availableSatang: true, reservedSatang: true, committedSatang: true, actualSatang: true } } },
    })
    const ledger = await prisma.budgetLedgerEntry.findMany({ where: { organizationId, sourceType: 'BUDGET_TRANSFER', sourceId: row.id }, orderBy: [{ budgetLineId: 'asc' }, { seq: 'asc' }], select: { budgetLineId: true, fromBucket: true, toBucket: true, amountSatang: true } })
    const lineFacts = (lineId: string | null) => {
      const line = lines.find((l) => l.id === lineId)
      if (!line) return null
      return {
        code: line.code,
        planned: satang(line.plannedSatang),
        available: satang(line.balance?.availableSatang ?? 0n),
        reserved: satang(line.balance?.reservedSatang ?? 0n),
        moves: ledger.filter((e) => e.budgetLineId === line.id).map((e) => ({ from: e.fromBucket, to: e.toBucket, amount: satang(e.amountSatang) })),
      }
    }
    const routes = await routesOf('BUDGET_TRANSFER', row.id)
    const taskIds = routes.flatMap((r) => r.tasks.map((t) => t.id))
    // The story of the transfer: its own events and the decisions of its tasks, in the order they happened
    const story = await prisma.event.findMany({
      where: { organizationId, OR: [{ aggregateType: 'BudgetTransfer', aggregateId: row.id }, { aggregateType: 'ApprovalTask', aggregateId: { in: taskIds }, type: 'approval_task.decided' }] },
      orderBy: { seq: 'asc' },
      select: { type: true, channel: true },
    })
    const codeOf = await codesOf([row.submittedById])
    return {
      id: row.id,
      number: row.number,
      kind: row.kind,
      status: row.status,
      amount: satang(row.amountSatang),
      reason: row.reason,
      submittedBy: codeOf(row.submittedById),
      from: lineFacts(row.fromBudgetLineId),
      to: lineFacts(row.toBudgetLineId),
      routes,
      events: story.map((e) => ({ type: e.type, channel: e.channel })),
    }
  }

  async function flags(number: string) {
    const request = await prisma.request.findFirst({
      where: { organizationId, number },
      select: {
        id: true,
        number: true,
        status: true,
        title: true,
        sourceRequestId: true,
        budgetLine: { select: { code: true } },
        deliverySite: { select: { code: true } },
        suggestedSupplier: { select: { code: true } },
        lines: { orderBy: { lineNo: 'asc' }, select: { description: true, quantity: true, uom: true, unitPriceSatang: true, netSatang: true, catalogItem: { select: { code: true } } } },
      },
    })
    if (!request) return null
    const rows = await prisma.requestFlag.findMany({ where: { organizationId, requestId: request.id }, orderBy: [{ routeNo: 'asc' }, { kind: 'asc' }], select: { kind: true, routeNo: true, matchedRequestIds: true, acknowledgedReason: true, acknowledgedById: true } })
    const matched = await prisma.request.findMany({ where: { organizationId, id: { in: rows.flatMap((r) => r.matchedRequestIds) } }, select: { id: true, number: true } })
    const numberOf = new Map(matched.map((m) => [m.id, m.number] as const))
    const source = request.sourceRequestId ? await prisma.request.findFirst({ where: { organizationId, id: request.sourceRequestId }, select: { number: true } }) : null
    const flagged = await prisma.event.findMany({ where: { organizationId, aggregateType: 'Request', aggregateId: request.id, type: 'request.flagged' }, orderBy: { seq: 'asc' }, select: { data: true } })
    // How the draft was made (FR-INT-101 AC1): request.drafted names its source when it is not typed in by hand
    const drafted = await prisma.event.findFirst({ where: { organizationId, aggregateType: 'Request', aggregateId: request.id, type: 'request.drafted' }, orderBy: { seq: 'asc' }, select: { channel: true, actorMemberId: true, data: true } })
    const codeOf = await codesOf([...rows.map((r) => r.acknowledgedById), drafted?.actorMemberId])
    return {
      id: request.id,
      number: request.number,
      status: request.status,
      title: request.title,
      source: source?.number ?? null,
      drafted: drafted ? { source: ((drafted.data ?? {}) as { source?: unknown }).source ?? null, channel: drafted.channel, by: codeOf(drafted.actorMemberId) } : null,
      budgetLine: request.budgetLine?.code ?? null,
      site: request.deliverySite?.code ?? null,
      supplier: request.suggestedSupplier?.code ?? null,
      lines: request.lines.map((l) => ({ item: l.catalogItem?.code ?? null, description: l.description, quantity: l.quantity.toString(), uom: l.uom, unitPrice: satang(l.unitPriceSatang), net: satang(l.netSatang) })),
      flags: rows.map((r) => ({
        kind: r.kind,
        routeNo: r.routeNo,
        matched: r.matchedRequestIds.map((m) => numberOf.get(m) ?? m),
        acknowledgedReason: r.acknowledgedReason,
        acknowledgedBy: codeOf(r.acknowledgedById),
      })),
      flaggedEvents: flagged.map((e) => {
        const data = (e.data ?? {}) as { kind?: unknown; matchedRequestIds?: unknown }
        return { kind: data.kind ?? null, matched: Array.isArray(data.matchedRequestIds) ? data.matchedRequestIds.map((m) => numberOf.get(String(m)) ?? String(m)) : [] }
      }),
    }
  }

  try {
    switch (command) {
      case 'workflow':
        if (!args[0]) throw new Error('workflow <code>')
        return await workflow(args[0])
      case 'subject-task': {
        if (!args[0] || !args[1]) throw new Error('subject-task <subjectType> <subjectId>')
        const routes = await routesOf(args[0], args[1])
        return { routes, open: routes.flatMap((r) => r.tasks.filter((t) => t.status === 'OPEN').map((t) => ({ ...t, ruleCode: r.ruleCode, amount: r.amount }))) }
      }
      case 'transfer':
        if (!args[0]) throw new Error('transfer <id>')
        return await transfer(args[0])
      case 'flags':
        if (!args[0]) throw new Error('flags <requestNumber>')
        return await flags(args[0])
      default:
        throw new Error(`unknown S6 scene command ${command ?? '(none)'}`)
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
