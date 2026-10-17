import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { E2E_DB } from '../../../support/e2e-env'

// Run by the S13 scenes of phase 1 (tests/e2e/p1demo/12-…, 13-…, 14-…, through support.ts script()) against the run's
// p1demo database only. The e2e app runs no Inngest, so the background job ai-agent-run and ai-approval-brief are played
// here, in this process, through the same services the jobs call — with the AI client this process sets for itself:
//   - step 0 of the request form (Intake): no recorded answer can match a web step 0 (the runtime text lists the
//     organization's types and sites, the recordings of the evaluation list the catalogue too), so the answer is the
//     scene row's own (expectJson: aiType aiTitle aiSite aiLines aiConfidence, the supplier of aiSupplier from sheet
//     Suppliers), as a model would read it from the quotation;
//   - the quotation read (Document Agent): the recorded LIVE answer of the file the scene uploaded, served by the
//     fixture client of AI_MODE=fixture (the key is the file's sha256), nothing injected;
//   - the Approval Brief: its facts carry the real clock (the hours left of the SLA), so no recording can match either;
//     the sentences are the scene row's (expectJson.briefSentences), every value a placeholder the code fills in.
// The organization is the one of sheet Org of the phase-1 workbook; every object is found by the values of the sheet
// (the actor's code, the request type and title of the row), never by an id typed in a test. Prints JSON on its last
// line; amounts are satang as strings.
//   intake <scene> [sinceMs]  answers every PENDING Intake action the scene's actor asked for; prints how many, and how
//                            many Intake actions the actor asked for since sinceMs (epoch ms)
//   read <scene>              answers every PENDING quotation read the scene's actor asked for (the recorded answer)
//   request <scene>           the request the scene sent (actor, type finalType, title aiTitle): amounts, budget line, site,
//                            suggested supplier, route and open tasks, flags, quotations with their files, and the AI
//                            actions on it
//   brief <scene>             writes the Approval Brief of the open task of the request of expectJson.requestOfScene held
//                            by the row's expectedApprover (the job's work), then reads it as that member reads it
//                            (approvalBriefOf); with what the database says beside it: the budget line's balance and the
//                            supplier's POs of the last 365 days
//   line <budgetKey>          the budget line of that key in the fiscal year of today (sheet Budget): id and code
//   question <code>           the newest question the member asked BCS AI: status, the tools it used, the kind of answer
// Loads the app's modules only when tsx runs it.

const SUPPLIER_HISTORY_DAYS = 365
const MS_PER_DAY = 86_400_000

interface IntakeLine {
  readonly description: string
  readonly qty: string
  readonly unit: string
  readonly unitPrice: string
}

async function main(command: string | undefined, args: readonly string[]): Promise<unknown> {
  if (new URL(process.env.DATABASE_URL ?? 'postgresql://x/none').pathname !== `/${E2E_DB}`) throw new Error('the S13 scene script runs in the e2e database only')
  const [{ systemClock }, { makeCtx }, { prisma }, { INPUT_WORKBOOKS, loadInputWorkbook }, { setAiClientForTests }, { PROMPT_VERSIONS }, ai] = await Promise.all([
    import('@/lib/clock'),
    import('@/server/context'),
    import('@/server/db/client'),
    import('@/server/seed/workbook'),
    import('@/integrations/ai'),
    import('@/lib/ai-config'),
    import('@/server/services/ai'),
  ])
  type AiClient = import('@/integrations/ai').AiClient
  try {
    const workbook = await loadInputWorkbook(INPUT_WORKBOOKS.p1)
    const orgCode = workbook.keyValues('Org').get('code')?.value
    if (!orgCode) throw new Error('the Org sheet names no organization code')
    const org = await prisma.organization.findUniqueOrThrow({ where: { code: orgCode }, select: { id: true } })
    const organizationId = org.id
    const now = systemClock.now()
    const satang = (v: bigint | null | undefined) => (v === null || v === undefined ? null : v.toString())

    /** A row of sheet Demo_Script_P1 with its expectJson */
    function sceneRow(scene: string | undefined) {
      if (!scene || !/^\d{1,2}$/.test(scene)) throw new Error(`a scene number, not ${scene ?? '(none)'}`)
      const row = workbook.table('Demo_Script_P1').find((r) => r.values.scene === scene)
      if (!row) throw new Error(`Demo_Script_P1 has no scene ${scene}`)
      return { values: row.values, expect: JSON.parse(row.values.expectJson ?? '{}') as Record<string, unknown> }
    }
    const expected = <T>(row: { expect: Record<string, unknown> }, key: string): T => {
      if (!Object.hasOwn(row.expect, key)) throw new Error(`expectJson has no "${key}"`)
      return row.expect[key] as T
    }
    async function memberOf(code: string | null | undefined) {
      const member = code ? await prisma.member.findFirst({ where: { organizationId, employeeCode: code }, select: { id: true } }) : null
      if (!member) throw new Error(`the organization ${orgCode} has no member ${code ?? '(empty)'}`)
      return member
    }
    const noUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }

    // ---------- step 0: the Intake Agent, answered with the row's reading of the quotation ----------

    async function intake(scene: string | undefined, sinceMs: string | undefined) {
      const row = sceneRow(scene)
      const member = await memberOf(row.values.actor)
      const supplierCode = expected<string>(row, 'aiSupplier')
      const supplier = workbook.table('Suppliers').find((r) => r.values.code === supplierCode)
      if (!supplier) throw new Error(`sheet Suppliers has no ${supplierCode}`)
      const lines = expected<IntakeLine[]>(row, 'aiLines')
      const confidence = expected<number>(row, 'aiConfidence')
      // Every field the model reads, with the row's confidence: what the organization's minimum then asks one by one is the
      // critical fields' (quantities, prices, the supplier of the register), as expectJson.intakeMustConfirm says
      const fields = ['requestType', 'title', 'siteCode', 'supplier.name', 'supplier.taxId', 'supplier.branch', ...lines.flatMap((_, i) => ['description', 'qty', 'unit', 'unitPrice'].map((f) => `lines.${i}.${f}`))]
      const answer = {
        requestTypeCode: expected<string>(row, 'aiType'),
        title: expected<string>(row, 'aiTitle'),
        siteCode: expected<string>(row, 'aiSite'),
        neededBy: null,
        lines: lines.map((l) => ({ description: l.description, itemCode: null, qty: l.qty, unit: l.unit, unitPrice: l.unitPrice })),
        supplier: { name: supplier.values.nameTh ?? null, taxId: supplier.values.taxId ?? null, branch: supplier.values.branchCode ?? null },
        confidence: fields.map((field) => ({ field, value: confidence })),
      }
      const client: AiClient = {
        mode: 'fixture',
        extract: async (request) => ({ ok: true, promptVersion: PROMPT_VERSIONS[request.purpose], model: request.model, output: request.schema.parse(answer), usage: { input: 2600, output: 420, cacheRead: 0, cacheWrite: 0 }, latencyMs: 1200 }),
        write: async (request) => ({ ok: false, errorCode: 'FIXTURE_MISSING', promptVersion: PROMPT_VERSIONS[request.purpose], usage: noUsage, latencyMs: 0 }),
      }
      const pending = await prisma.agentAction.findMany({ where: { organizationId, purpose: 'INTAKE', status: 'PENDING', requestedById: member.id }, select: { id: true }, orderBy: { createdAt: 'asc' } })
      setAiClientForTests(client)
      const results: string[] = []
      try {
        for (const action of pending) results.push(await ai.runIntake(organizationId, action.id, now))
      } finally {
        setAiClientForTests(null)
      }
      const failed = await prisma.agentAction.findMany({ where: { id: { in: pending.map((a) => a.id) }, status: 'FAILED' }, select: { errorCode: true } })
      const since = sinceMs && /^\d{13}$/.test(sinceMs) ? new Date(Number(sinceMs)) : null
      const asked = since ? await prisma.agentAction.count({ where: { organizationId, purpose: 'INTAKE', requestedById: member.id, createdAt: { gte: since } } }) : null
      return { pending: pending.length, drafted: results.filter((r) => r === 'DRAFT').length, results, failed: failed.map((f) => f.errorCode), asked }
    }

    // ---------- the quotation read: the recorded answer of the uploaded file ----------

    async function read(scene: string | undefined) {
      const row = sceneRow(scene)
      const member = await memberOf(row.values.actor)
      const pending = await prisma.agentAction.findMany({ where: { organizationId, purpose: 'QUOTATION_READ', status: 'PENDING', requestedById: member.id }, select: { id: true }, orderBy: { createdAt: 'asc' } })
      // The client of AI_MODE=fixture: tests/fixtures/ai/QUOTATION_READ/<sha256 of the file>.json
      setAiClientForTests(null)
      const results: string[] = []
      for (const action of pending) results.push(await ai.runDocumentRead(organizationId, action.id, now))
      const failed = await prisma.agentAction.findMany({ where: { id: { in: pending.map((a) => a.id) }, status: 'FAILED' }, select: { errorCode: true } })
      return { pending: pending.length, drafted: results.filter((r) => r === 'DRAFT').length, results, failed: failed.map((f) => f.errorCode) }
    }

    // ---------- the request the scene sent ----------

    async function requestOf(row: ReturnType<typeof sceneRow>) {
      const member = await memberOf(row.values.actor)
      const found = await prisma.request.findFirst({
        where: { organizationId, requesterMemberId: member.id, requestType: { code: expected<string>(row, 'finalType') }, title: expected<string>(row, 'aiTitle'), submittedAt: { not: null } },
        orderBy: { submittedAt: 'desc' },
        select: { id: true },
      })
      return found?.id ?? null
    }

    async function requestFacts(id: string) {
      const r = await prisma.request.findUniqueOrThrow({
        where: { id },
        select: {
          id: true,
          number: true,
          status: true,
          title: true,
          priceIncludesVat: true,
          netSatang: true,
          vatSatang: true,
          grossSatang: true,
          formData: true,
          requestType: { select: { code: true } },
          budgetLine: { select: { id: true, code: true } },
          deliverySite: { select: { code: true } },
          suggestedSupplier: { select: { id: true, code: true } },
          lines: { orderBy: { lineNo: 'asc' }, select: { description: true, quantity: true, uom: true, unitPriceSatang: true, serviceEndDate: true } },
          quotations: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], select: { supplierName: true, amountSatang: true, includesVat: true, netSatang: true, isSelected: true, supplier: { select: { code: true } }, file: { select: { fileName: true, mimeType: true, sha256: true } } } },
          currentRoute: { select: { ruleCode: true, amountBasis: true, amountSatang: true, steps: { orderBy: { stepNo: 'asc' }, select: { stepNo: true, tasks: { select: { id: true, status: true, assignee: { select: { employeeCode: true } } } } } } } },
        },
      })
      const flags = await prisma.requestFlag.findMany({ where: { organizationId, requestId: id }, select: { kind: true } })
      const actions = await prisma.agentAction.findMany({ where: { organizationId, subjectType: 'REQUEST', subjectId: id }, select: { purpose: true, status: true }, orderBy: { createdAt: 'asc' } })
      const events = await prisma.event.findMany({ where: { organizationId, aggregateType: 'Request', aggregateId: id }, select: { type: true }, orderBy: { seq: 'asc' } })
      return {
        id: r.id,
        number: r.number,
        status: r.status,
        title: r.title,
        requestType: r.requestType.code,
        priceIncludesVat: r.priceIncludesVat,
        net: satang(r.netSatang),
        vat: satang(r.vatSatang),
        gross: satang(r.grossSatang),
        formData: r.formData,
        budgetLine: r.budgetLine?.code ?? null,
        budgetLineId: r.budgetLine?.id ?? null,
        site: r.deliverySite?.code ?? null,
        suggestedSupplier: r.suggestedSupplier?.code ?? null,
        lines: r.lines.map((l) => ({ description: l.description, quantity: l.quantity.toString(), uom: l.uom, unitPrice: satang(l.unitPriceSatang), serviceEndDate: l.serviceEndDate ? l.serviceEndDate.toISOString().slice(0, 10) : null })),
        quotations: r.quotations.map((q) => ({ supplier: q.supplier?.code ?? null, supplierName: q.supplierName, amount: satang(q.amountSatang), includesVat: q.includesVat, net: satang(q.netSatang), selected: q.isSelected, file: q.file })),
        route: r.currentRoute ? { ruleCode: r.currentRoute.ruleCode, amountBasis: r.currentRoute.amountBasis, amount: satang(r.currentRoute.amountSatang) } : null,
        tasks: (r.currentRoute?.steps ?? []).flatMap((s) => s.tasks.map((t) => ({ id: t.id, stepNo: s.stepNo, status: t.status, assignee: t.assignee.employeeCode }))),
        flags: flags.map((f) => f.kind),
        actions,
        events: events.map((e) => e.type),
      }
    }

    async function request(scene: string | undefined) {
      const id = await requestOf(sceneRow(scene))
      return id ? await requestFacts(id) : null
    }

    // ---------- the Approval Brief of the request's open task ----------

    async function brief(scene: string | undefined) {
      const row = sceneRow(scene)
      const asked = sceneRow(String(expected<number>(row, 'requestOfScene')))
      const id = await requestOf(asked)
      if (!id) throw new Error(`scene ${String(asked.values.scene)} sent no request: run the p1demo scenes in order`)
      const facts = await requestFacts(id)
      const approver = row.values.expectedApprover
      const task = facts.tasks.find((t) => t.status === 'OPEN' && t.assignee === approver)
      if (!task) throw new Error(`the request ${facts.number ?? id} has no open task held by ${approver ?? '(empty)'}`)
      const assignee = await memberOf(approver)
      const sentences = expected<string[]>(row, 'briefSentences')
      const client: AiClient = {
        mode: 'fixture',
        extract: async (request) => ({ ok: false, errorCode: 'FIXTURE_MISSING', promptVersion: PROMPT_VERSIONS[request.purpose], usage: noUsage, latencyMs: 0 }),
        write: async (request) => ({ ok: true, promptVersion: PROMPT_VERSIONS[request.purpose], model: request.model, output: request.schema.parse({ sentences }), usage: { input: 900, output: 120, cacheRead: 0, cacheWrite: 0 }, latencyMs: 400 }),
      }
      setAiClientForTests(client)
      let result: string
      try {
        result = await ai.runBrief(organizationId, task.id, now)
      } finally {
        setAiClientForTests(null)
      }
      const action = await prisma.agentAction.findFirst({ where: { organizationId, purpose: 'BRIEF', subjectType: 'APPROVAL_TASK', subjectId: task.id }, orderBy: { createdAt: 'desc' }, select: { status: true, errorCode: true } })
      // As the approver reads it on the decision bar (facts built now, under their rights)
      const read = await ai.approvalBriefOf(makeCtx({ organizationId, actor: { type: 'USER', memberId: assignee.id }, channel: 'WEB', now: systemClock.now() }), task.id)
      if (!read.ok) throw new Error(`approvalBriefOf: ${read.error.code}`)
      // What the database says beside it: the line's balance, and the supplier's POs of the last 365 days
      const balance = facts.budgetLineId ? await prisma.budgetLineBalance.findUnique({ where: { budgetLineId: facts.budgetLineId }, select: { availableSatang: true } }) : null
      const supplier = facts.suggestedSupplier ? await prisma.supplier.findFirst({ where: { organizationId, code: facts.suggestedSupplier }, select: { id: true } }) : null
      const pos = supplier
        ? await prisma.purchaseOrder.findMany({
            where: { organizationId, supplierId: supplier.id, createdAt: { gte: new Date(now.getTime() - SUPPLIER_HISTORY_DAYS * MS_PER_DAY) }, status: { notIn: ['DRAFT', 'CANCELLED'] } },
            orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
            select: { grossSatang: true },
          })
        : []
      return {
        taskId: task.id,
        number: facts.number,
        requestStatus: facts.status,
        result,
        action,
        status: read.data.status,
        facts: read.data.facts,
        sentences: read.data.sentences,
        db: { budgetAvailable: satang(balance?.availableSatang), supplierPoCount: pos.length, supplierLastPoGross: satang(pos[0]?.grossSatang) },
      }
    }

    // ---------- the budget line of a key this fiscal year, and the questions to BCS AI ----------

    async function line(key: string | undefined) {
      const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bangkok' }).format(now)
      const fiscalYear = `FY${Number(today.slice(0, 4)) + 543}`
      const row = workbook.table('Budget').find((r) => r.values.budgetKey === key && r.values.fiscalYear === fiscalYear)
      if (!row?.values.code) throw new Error(`sheet Budget has no line of key ${key ?? '(none)'} in ${fiscalYear}`)
      const found = await prisma.budgetLine.findFirstOrThrow({ where: { organizationId, code: row.values.code }, select: { id: true, code: true } })
      return { ...found, fiscalYear }
    }

    async function question(code: string | undefined) {
      const member = await memberOf(code)
      const action = await prisma.agentAction.findFirst({ where: { organizationId, purpose: 'QUESTION', requestedById: member.id }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], select: { status: true, output: true, errorCode: true } })
      if (!action) return null
      const output = (action.output ?? {}) as { tools?: string[]; kind?: string }
      return { status: action.status, tools: output.tools ?? null, kind: output.kind ?? null, errorCode: action.errorCode }
    }

    switch (command) {
      case 'intake':
        return await intake(args[0], args[1])
      case 'read':
        return await read(args[0])
      case 'request':
        return await request(args[0])
      case 'brief':
        return await brief(args[0])
      case 'line':
        return await line(args[0])
      case 'question':
        return await question(args[0])
      default:
        throw new Error(`unknown S13 scene command ${command ?? '(none)'}`)
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
