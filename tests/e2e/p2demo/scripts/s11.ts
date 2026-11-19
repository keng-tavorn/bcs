import { randomUUID } from 'node:crypto'
import { systemClock } from '@/lib/clock'
import { grantStepUp } from '@/server/auth/step-up'
import { makeCtx, type Ctx } from '@/server/context'
import { prisma } from '@/server/db/client'
import { setDefaultOutboxSender } from '@/server/events/outbox'
import { INPUT_WORKBOOKS, loadInputWorkbook } from '@/server/seed/workbook'
import { decideTask } from '@/server/services/approvals/decide'
import { completeUpload, requestUpload } from '@/server/services/files'
import { assignSupplier, consolidateNow } from '@/server/services/procurement'
import { submitPo } from '@/server/services/purchase-orders'
import { createDraft, editRequest, submitRequest } from '@/server/services/requests'
import { attachFile } from '@/server/services/requests/attachments'
import { scanFile } from '@/server/services/suppliers/documents'
import { E2E_DB, E2E_P2DEMO } from '../../../support/e2e-env'

// Run by the core scenes of S11 of phase 2 (tests/e2e/p2demo/16- 17- 19- 22-…, S11-15 · through ../support.ts s11()) against
// the p2demo e2e database only, on SIMEC of the phase-1 workbook: what happens before and outside the screens of a scene,
// and what it reads back. Every business step goes through the app's own commands (never a row written by hand); the
// texts of a request come from the scene's row of sheet Demo_Script_P2 (or the Request_History row it names), so no Thai
// is passed on the command line. Prints JSON on its last line; amounts are satang as strings, days YYYY-MM-DD.
//   po <scene> <requester> <budgetLineCode> <siteCode> [historyRef]
//                           the request a PO of the scene comes from, made the way a member makes it: drafted by the
//                           requester with the row's type, amounts and screening answers (expectJson.request of scene 16;
//                           expectJson.po of scene 17 with the title of the Request_History row historyRef), sent — with
//                           the DPA and the one quotation and its single-source reason the form's rules ask for (ATT-DPA
//                           ATT-QUOTES) — passed by any reviewer of the workflow and approved by the DOA's approver (with
//                           the PIN's step-up when the amount asks it); then PROCUREMENT (proc_officer) assigns the row's
//                           supplier in the pool and consolidates: the PO is a DRAFT on procurement's desk. Prints the
//                           request (number, rule, approver, reviewers) and the PO (id, status, amounts)
//   try-submit <poId>       po.submit by proc_officer as the PO page's button would send it: the refusal's code and the
//                           risk gate's reason (a refused submit writes nothing). Only for a PO the gate blocks
//   assessment <supplier>   the supplier's newest risk assessment: number, status, what it was opened from and with
//                           (screening, categories, payee type, work scopes), the questions of its set with their Thai text
//                           and options, its answers, points and tier, dates, its review tasks (round, holder's code,
//                           rules, parts, status) and the e-mails the contact got about it (template, the link's purpose
//                           and days); the supplier's tier and status
//   scan-evidence <assessmentId>
//                           the central scan of every evidence file of the assessment's answers still PENDING, clean (job
//                           file-scan: the e2e app has no Inngest), so the reviewers may open them
//   po-gate <poId>          the PO's status, its stored risk gate and the po.risk_gate_passed events written for it
//   invite-link <assessmentId>
//                           the newest e-mail to the contact that links to the questionnaire (opened or returned): its
//                           template, contact, link (as the notice holds it before it is sent) and the reviewer's words
//   override <supplier>     the supplier's newest override: number, status, cap, last day, use; its DOA route (document
//                           type, rule, amount, step-up threshold) and tasks (holder, decision, channel) and step-ups
//   pay-flag <supplier> <payDate>
//                           what riskOverridesForPayment gives a payment run of that day for the supplier (S9's flag)
//   ai-draft <assessmentId> job risk-ai-draft as risk_assessment.opened starts it, the model answering with the
//                           proposals of scene 22's row (rowClient); its result and the RISK_ANSWER_DRAFT actions
//   ai-summary <assessmentId>
//                           job risk-ai-summary for each OPEN review task of the assessment (review_task.assigned), the
//                           model answering with the sentences of scene 22's row
//   agent <on|off>          the organization's admin switches the Risk Agent on or off (ai_agent.update)
//   ai-propose <exceptAssessmentId|->
//                           for the screen review of S11-16 (scripts/design-review/s11-pages.spec.ts): job risk-ai-draft
//                           on the first assessment still open (other than the one given) whose supplier has a portal
//                           contact and files the AI may read, the model proposing the first option of the first three
//                           questions it is asked (the checks and caps are the app's). An assessment with a draft nobody
//                           took in yet is reused. Prints the assessment, its supplier, the contact and the job's result
if (new URL(process.env.DATABASE_URL ?? 'postgresql://x/none').pathname !== `/${E2E_DB}`) throw new Error('the scene script of phase 2 runs in its e2e database only')
if (!E2E_P2DEMO) throw new Error('the scene script of phase 2 runs in p2demo mode only (E2E_P2DEMO=1)')
setDefaultOutboxSender(null)
const [mode, ...args] = process.argv.slice(2)
const org = await prisma.organization.findFirstOrThrow({ where: { code: 'SIMEC' }, select: { id: true } })
const organizationId = org.id
const out = (v: unknown) => console.log(JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x instanceof Date ? x.toISOString() : x)))
const day = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null)
const codeOf = async (memberId: string | null) => (memberId ? ((await prisma.member.findUnique({ where: { id: memberId }, select: { employeeCode: true } }))?.employeeCode ?? null) : null)
const memberIdOf = async (code: string) => (await prisma.member.findFirstOrThrow({ where: { organizationId, employeeCode: code }, select: { id: true } })).id
const ctxOf = async (code: string, channel: Ctx['channel'] = 'WEB'): Promise<Ctx> => makeCtx({ organizationId, actor: { type: 'USER', memberId: await memberIdOf(code) }, channel, now: systemClock.now() })
const options = () => ({ idempotencyKey: randomUUID(), sender: null })
const must = <T>(step: string, r: { ok: true; data: T } | { ok: false; error: { code: string; message?: string; details?: unknown } }): T => {
  if (!r.ok) throw new Error(`${step}: ${r.error.code} ${r.error.message ?? ''} ${JSON.stringify(r.error.details ?? {})}`)
  return r.data
}

/** A one-page PDF of a few ASCII lines: the DPA and the quotation a scene's requester attaches (synthetic) */
function pdf(lines: readonly string[]): Uint8Array {
  const text = lines.map((l, i) => `BT /F1 12 Tf 72 ${760 - i * 18} Td (${l.replace(/[()\\]/g, ' ')}) Tj ET`).join('\n')
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', `<< /Length ${text.length} >>\nstream\n${text}\nendstream`]
  let body = '%PDF-1.4\n'
  const offsets: number[] = []
  objects.forEach((o, i) => {
    offsets.push(body.length)
    body += `${i + 1} 0 obj\n${o}\nendobj\n`
  })
  const xref = body.length
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return new TextEncoder().encode(body)
}

async function upload(ctx: Ctx, fileName: string, content: Uint8Array): Promise<string> {
  const asked = must(`upload ${fileName}`, await requestUpload(ctx, { fileName, mimeType: 'application/pdf', sizeBytes: content.length }))
  const put = await fetch(asked.uploadUrl, { method: 'PUT', headers: { 'content-type': 'application/pdf' }, body: new Uint8Array(content) })
  if (!put.ok) throw new Error(`the storage refused ${fileName} (${put.status})`)
  return must(`record ${fileName}`, await completeUpload(ctx, { ticket: asked.ticket }, { sender: null, suppressOutbox: true })).fileId
}

/** The Thai date a year from today (a service of twelve months ends then: forms.yaml asks HIRE_SERVICE for its end) */
const yearOn = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bangkok' }).format(new Date(systemClock.now().getTime() + 365 * 86_400_000))

async function sceneRow(scene: number) {
  const workbook = await loadInputWorkbook(INPUT_WORKBOOKS.p1)
  const row = workbook.table('Demo_Script_P2').find((r) => Number(r.values.scene) === scene)
  if (!row) throw new Error(`Demo_Script_P2 has no scene ${scene}`)
  return { workbook, expect: JSON.parse(String(row.values.expectJson)) as Record<string, unknown>, supplier: String(row.values.supplier ?? '') }
}

interface SceneRequest {
  readonly requestType: string
  readonly title?: string
  readonly net: string
  readonly vat: string
  readonly gross: string
  readonly form: Record<string, string>
}

async function makePo(scene: number, requester: string, budgetLineCode: string, siteCode: string, historyRef: string | undefined) {
  const { workbook, expect, supplier: supplierCode } = await sceneRow(scene)
  const asked = (expect.request ?? expect.po) as SceneRequest | undefined
  if (!asked) throw new Error(`scene ${scene}: expectJson has neither request nor po`)
  let title = asked.title
  if (!title) {
    const history = workbook.table('Request_History').find((r) => String(r.values.ref) === historyRef)
    if (!history) throw new Error(`scene ${scene} names no title: give the Request_History row its PO is like (${historyRef ?? 'none given'})`)
    title = String(history.values.title)
  }
  // the price before VAT: a request whose prices include VAT waits in the pool (TODO(NEW-50) of the round), and the row's
  // net and VAT are what the request computes from it (scene 17: 112,149.53 + 7,850.47 = 120,000.00)
  const unitPrice = asked.net
  // the line's category as procurement codes it (BR-RSK-03 reads it from the PO's lines): the row's assessment category
  const category = ((expect.assessment as { categoryCodes?: string[] } | undefined)?.categoryCodes ?? [])[0]
  const supplier = await prisma.supplier.findFirstOrThrow({ where: { organizationId, code: supplierCode }, select: { id: true, nameTh: true } })
  const line = await prisma.budgetLine.findFirstOrThrow({ where: { organizationId, code: budgetLineCode, status: 'OPEN' }, select: { id: true } })
  const site = siteCode === '-' ? null : await prisma.deliverySite.findFirstOrThrow({ where: { organizationId, code: siteCode }, select: { id: true } })
  const service = asked.requestType === 'HIRE_SERVICE' || asked.form.category === 'SOFTWARE'
  const formData: Record<string, string> = asked.requestType === 'HIRE_SERVICE' ? { scopeOfWork: title, servicePeriod: title.match(/\d+\s*เดือน/)?.[0] ?? title, ...asked.form } : { ...asked.form }
  if (asked.requestType === 'IT_PURCHASE' && !formData.category) formData.category = /ไลเซนส์|ซอฟต์แวร์/.test(title) ? 'SOFTWARE' : 'HARDWARE'
  const me = await ctxOf(requester)
  const draft = must(
    'draft',
    await createDraft(
      me,
      {
        requestTypeCode: asked.requestType,
        title,
        formData,
        priceIncludesVat: false,
        budgetLineId: line.id,
        ...(site ? { deliverySiteId: site.id } : {}),
        suggestedSupplierId: supplier.id,
        lines: [{ description: title, ...(category ? { categoryCode: category } : {}), quantity: '1', uom: asked.requestType === 'HIRE_SERVICE' ? 'งาน' : 'รายการ', unitPrice, ...(service ? { serviceEndDate: yearOn() } : {}) }],
      },
      options(),
    ),
  )
  const requestId = draft.requestId
  let sent = await submitRequest(await ctxOf(requester), { requestId }, options())
  const unmet = !sent.ok && sent.error.code === 'ATTACHMENT_RULE_FAILED' ? new Set(((sent.error.details?.failures ?? []) as ReadonlyArray<{ rule: string }>).map((f) => f.rule)) : new Set<string>()
  const unknown = [...unmet].find((rule) => rule !== 'ATT-QUOTES' && rule !== 'ATT-DPA')
  if (unknown) throw new Error(`scene ${scene}: the request asks for ${unknown}, which the scene cannot attach`)
  if (unmet.has('ATT-DPA')) {
    const fileId = await upload(await ctxOf(requester), `dpa-scene-${scene}.pdf`, pdf(['Data processing agreement (synthetic)', `Scene ${scene} supplier ${supplierCode}`]))
    must('attach DPA', await attachFile(await ctxOf(requester), { requestId, fileId, kind: 'DPA' }, options()))
  }
  if (unmet.has('ATT-QUOTES')) {
    // the supplier's one quotation and the single-source reason the form asks with it (forms.yaml ATT-QUOTES)
    const fileId = await upload(await ctxOf(requester), `quotation-scene-${scene}.pdf`, pdf(['Quotation (synthetic)', `Scene ${scene} supplier ${supplierCode}`, `THB ${unitPrice} before VAT`]))
    must(
      'quotation',
      await editRequest(
        await ctxOf(requester),
        { requestId, formData: { ...formData, singleSourceJustification: `ผู้ขายรายเดียวที่รับงาน ${title}` }, quotations: [{ supplierName: supplier.nameTh, supplierId: supplier.id, amount: unitPrice, includesVat: false, fileId, selected: true }] },
        options(),
      ),
    )
  }
  if (unmet.size > 0) sent = await submitRequest(await ctxOf(requester), { requestId }, options())
  const number = must('submit', sent).number

  // the reviewers of the workflow pass first (if any rule matched), then the DOA's approver approves
  const reviewers: Array<{ code: string | null; rules: string[] }> = []
  // a route of the workflow's reviewers and the DOA's steps closes in a few rounds; one that keeps a task open after its
  // holder decided would loop for ever, so the script stops and names what is still open (S11-15 review)
  for (let round = 0; ; round++) {
    const open = await prisma.approvalTask.findMany({
      where: { organizationId, status: 'OPEN', step: { route: { subjectType: 'REQUEST', subjectId: requestId, status: 'ACTIVE' } } },
      select: { id: true, assigneeMemberId: true, workflowRuleCodes: true, step: { select: { kind: true, route: { select: { ruleCode: true, amountSatang: true, doaVersion: { select: { stepUpThresholdSatang: true } } } } } } },
    })
    if (open.length === 0) break
    if (round >= 10) throw new Error(`scene ${scene}: request ${requestId} still has open tasks after ${round} rounds: ${(await Promise.all(open.map((t) => codeOf(t.assigneeMemberId)))).join(' ')}`)
    for (const task of open) {
      const code = (await codeOf(task.assigneeMemberId))!
      if (task.step.kind === 'REVIEW') {
        reviewers.push({ code, rules: task.workflowRuleCodes })
      } else {
        const { amountSatang, doaVersion } = task.step.route
        if (amountSatang !== null && doaVersion.stepUpThresholdSatang !== null && amountSatang >= doaVersion.stepUpThresholdSatang) {
          const granted = await grantStepUp({ organizationId, memberId: task.assigneeMemberId, subjectType: 'REQUEST', subjectId: requestId, method: 'PIN', pin: process.env.SEED_DEV_PIN ?? '', channel: 'WEB' }, systemClock.now(), { sender: null })
          if (!granted.ok) throw new Error(`the PIN step-up of ${code} was refused (${granted.reason})`)
        }
      }
      must(`decide ${code}`, await decideTask(await ctxOf(code), { taskId: task.id, decision: 'APPROVE' }, options()))
    }
  }
  const route = await prisma.approvalRoute.findFirstOrThrow({ where: { organizationId, subjectType: 'REQUEST', subjectId: requestId }, orderBy: { createdAt: 'desc' }, select: { ruleCode: true, escalatedFromRuleCode: true } })
  const approved = await prisma.approvalTask.findFirst({ where: { organizationId, status: 'APPROVED', step: { kind: 'APPROVAL', route: { subjectType: 'REQUEST', subjectId: requestId } } }, select: { decidedByMemberId: true } })
  const request = await prisma.request.findUniqueOrThrow({ where: { id: requestId }, select: { status: true, netSatang: true, vatSatang: true, grossSatang: true, lines: { select: { id: true } } } })
  if (request.status !== 'APPROVED') throw new Error(`scene ${scene}: the request is ${request.status}, not APPROVED`)

  // PROCUREMENT orders it: the row's supplier for its lines, then the round that makes the PO
  must('assign supplier', await assignSupplier(await ctxOf('proc_officer'), { requestLineIds: request.lines.map((l) => l.id), supplierId: supplier.id }, options()))
  const round = must('consolidate', await consolidateNow(await ctxOf('proc_officer'), options()))
  const po = await prisma.purchaseOrder.findFirstOrThrow({
    where: { organizationId, id: { in: [...round.purchaseOrderIds] }, lines: { some: { sources: { some: { requestLine: { requestId } } } } } },
    select: { id: true, status: true, netSatang: true, vatSatang: true, grossSatang: true, supplier: { select: { code: true } } },
  })
  out({
    request: { id: requestId, number, status: request.status, netSatang: request.netSatang, vatSatang: request.vatSatang, grossSatang: request.grossSatang, rule: route.escalatedFromRuleCode ?? route.ruleCode, approver: await codeOf(approved?.decidedByMemberId ?? null), reviewers },
    po: { id: po.id, status: po.status, supplier: po.supplier.code, netSatang: po.netSatang, vatSatang: po.vatSatang, grossSatang: po.grossSatang },
  })
}

async function trySubmit(poId: string) {
  const r = await submitPo(await ctxOf('proc_officer'), { poId }, options())
  out(r.ok ? { ok: true } : { ok: false, code: r.error.code, details: r.error.details ?? null })
}

async function assessment(supplierCode: string) {
  const supplier = await prisma.supplier.findFirstOrThrow({ where: { organizationId, code: supplierCode }, select: { id: true, riskTier: true, riskStatus: true, riskAssessedAt: true, riskValidUntil: true, currentRiskAssessmentId: true } })
  const a = await prisma.riskAssessment.findFirst({ where: { organizationId, supplierId: supplier.id }, orderBy: { createdAt: 'desc' } })
  if (!a) return out({ supplier: { ...supplier, riskValidUntil: day(supplier.riskValidUntil) }, assessment: null })
  const questions = await prisma.riskQuestion.findMany({ where: { organizationId, questionnaireId: a.questionnaireId }, orderBy: { sortOrder: 'asc' }, select: { code: true, domain: true, textTh: true, options: true, evidenceScope: true } })
  const answers = await prisma.riskAnswer.findMany({ where: { organizationId, assessmentId: a.id }, select: { id: true, questionCode: true, optionCode: true, source: true, points: true, evidenceDocumentId: true, evidenceAiReadable: true, agentActionId: true } })
  const files = await prisma.fileLink.findMany({ where: { organizationId, subjectType: 'RiskAnswer', subjectId: { in: answers.map((x) => x.id) }, kind: 'RISK_EVIDENCE' }, select: { subjectId: true, file: { select: { scanStatus: true } } } })
  const docs = await prisma.supplierDocument.findMany({ where: { organizationId, id: { in: answers.flatMap((x) => (x.evidenceDocumentId ? [x.evidenceDocumentId] : [])) } }, select: { id: true, documentTypeCode: true, scope: true, expiresOn: true } })
  const tasks = await prisma.reviewTask.findMany({ where: { organizationId, assessmentId: a.id }, orderBy: [{ reviewRound: 'asc' }, { slotNo: 'asc' }], select: { id: true, reviewRound: true, ruleCodes: true, riskDomains: true, status: true, assigneeMemberId: true } })
  const notices = await prisma.supplierNotice.findMany({ where: { organizationId, subjectId: a.id }, orderBy: { createdAt: 'asc' }, select: { templateKey: true, data: true, createdAt: true } })
  const links = await prisma.portalInviteLink.findMany({ where: { organizationId, supplierId: supplier.id, purpose: 'RISK_QUESTIONNAIRE', createdAt: { gte: a.createdAt } }, orderBy: { createdAt: 'asc' }, select: { purpose: true, createdAt: true, expiresAt: true } })
  out({
    supplier: { riskTier: supplier.riskTier, riskStatus: supplier.riskStatus, riskValidUntil: day(supplier.riskValidUntil), current: supplier.currentRiskAssessmentId === a.id },
    assessment: {
      id: a.id,
      number: a.number,
      status: a.status,
      triggerPoId: a.triggerPoId,
      openedBy: await codeOf(a.openedById),
      screening: a.screening,
      categoryCodes: a.categoryCodes,
      payeeType: a.payeeType,
      workScopes: a.workScopes,
      inherentTier: a.inherentTier,
      pointsTotal: a.pointsTotal,
      tier: a.tier,
      reviewRound: a.reviewRound,
      completedOn: day(a.completedOn),
      validUntil: day(a.validUntil),
      remindOn: day(a.remindOn),
      returnReason: a.returnReason,
    },
    questions: questions.map((q) => ({ code: q.code, domain: q.domain, textTh: q.textTh, evidenceScope: q.evidenceScope, options: (q.options as Array<{ code: string; labelTh: string; points: number }>).map((o) => ({ code: o.code, labelTh: o.labelTh, points: o.points })) })),
    answers: answers.map((x) => ({ question: x.questionCode, option: x.optionCode, source: x.source, points: x.points, evidenceDocument: ((d) => (d ? { docType: d.documentTypeCode, scope: d.scope, expiresOn: day(d.expiresOn) } : null))(docs.find((d) => d.id === x.evidenceDocumentId)), aiReadable: x.evidenceAiReadable, fromAi: x.agentActionId !== null, files: files.filter((f) => f.subjectId === x.id).map((f) => f.file.scanStatus) })),
    tasks: await Promise.all(tasks.map(async (t) => ({ id: t.id, round: t.reviewRound, rules: t.ruleCodes, domains: t.riskDomains, status: t.status, holder: await codeOf(t.assigneeMemberId) }))),
    notices: notices.map((n) => ({ templateKey: n.templateKey, at: n.createdAt })),
    links: links.map((l) => ({ purpose: l.purpose, days: Math.round((l.expiresAt.getTime() - l.createdAt.getTime()) / 86_400_000) })),
  })
}

async function scanEvidence(assessmentId: string) {
  const answers = await prisma.riskAnswer.findMany({ where: { organizationId, assessmentId }, select: { id: true } })
  const links = await prisma.fileLink.findMany({ where: { organizationId, subjectType: 'RiskAnswer', subjectId: { in: answers.map((x) => x.id) }, kind: 'RISK_EVIDENCE', file: { scanStatus: 'PENDING' } }, select: { fileId: true } })
  const now = systemClock.now()
  for (const l of links) await scanFile(organizationId, l.fileId, now)
  out({ scanned: links.length })
}

async function poGate(poId: string) {
  const po = await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: poId }, select: { status: true, number: true, riskGate: true, riskOverrideId: true } })
  const passed = await prisma.event.findMany({ where: { organizationId, aggregateId: poId, type: 'po.risk_gate_passed' }, orderBy: { seq: 'asc' }, select: { data: true } })
  out({ status: po.status, number: po.number, riskGate: po.riskGate, overrideId: po.riskOverrideId, passed: passed.map((e) => e.data) })
}

async function inviteLink(assessmentId: string) {
  // the newest e-mail that carries a link to the questionnaire (opened, returned); the e2e app sends nothing to Mailpit
  const notice = await prisma.supplierNotice.findFirstOrThrow({ where: { organizationId, subjectId: assessmentId, templateKey: { in: ['supplier.risk_questionnaire', 'supplier.risk_returned'] } }, orderBy: { createdAt: 'desc' }, select: { templateKey: true, contactId: true, data: true } })
  const data = notice.data as { url?: string; reason?: string }
  out({ templateKey: notice.templateKey, contactId: notice.contactId, url: data.url ?? null, reason: data.reason ?? null })
}

async function override(supplierCode: string) {
  const supplier = await prisma.supplier.findFirstOrThrow({ where: { organizationId, code: supplierCode }, select: { id: true, riskStatus: true } })
  const o = await prisma.riskOverride.findFirstOrThrow({ where: { organizationId, supplierId: supplier.id }, orderBy: { createdAt: 'desc' } })
  const route = o.currentRouteId
    ? await prisma.approvalRoute.findUniqueOrThrow({
        where: { id: o.currentRouteId },
        select: { subjectType: true, ruleCode: true, amountSatang: true, status: true, doaVersion: { select: { stepUpThresholdSatang: true } }, steps: { select: { tasks: { select: { id: true, status: true, assigneeMemberId: true, decision: true, channel: true } } } } },
      })
    : null
  const tasks = route ? await Promise.all(route.steps.flatMap((s) => s.tasks).map(async (t) => ({ id: t.id, status: t.status, holder: await codeOf(t.assigneeMemberId), decision: t.decision, channel: t.channel }))) : []
  const grants = route ? await prisma.stepUpGrant.findMany({ where: { organizationId, subjectType: 'RISK_OVERRIDE', subjectId: o.id }, select: { method: true, usedAt: true } }) : []
  out({
    id: o.id,
    number: o.number,
    status: o.status,
    capGrossSatang: o.capGrossSatang,
    expiresOn: day(o.expiresOn),
    usedCount: o.usedCount,
    usedGrossSatang: o.usedGrossSatang,
    requestedBy: await codeOf(o.requestedById),
    route: route ? { subjectType: route.subjectType, rule: route.ruleCode, amountSatang: route.amountSatang, status: route.status, stepUpThresholdSatang: route.doaVersion.stepUpThresholdSatang } : null,
    tasks,
    stepUps: grants.map((g) => ({ method: g.method, used: g.usedAt !== null })),
    supplierRiskStatus: supplier.riskStatus,
  })
}

async function payFlag(supplierCode: string, payDate: string) {
  const { riskOverridesForPayment } = await import('@/server/queries/risk-overrides')
  const { forTenant } = await import('@/server/db/tenant')
  const supplier = await prisma.supplier.findFirstOrThrow({ where: { organizationId, code: supplierCode }, select: { id: true } })
  const map = await forTenant(organizationId).$transaction((tx) => riskOverridesForPayment(tx, [supplier.id], payDate))
  out({ overrides: map.get(supplier.id) ?? [] })
}

/**
 * What the model answers in a scene, from the scene's row: the seed's documents carry the day they were seeded, so no
 * answer recorded on one day matches the next (the fixture key holds the files' bytes). As the S13 scenes of phase 1
 * do, the row is the model's answer; every check, cap and confidence after it is the app's own code.
 */
async function rowClient(output: unknown) {
  const { NO_USAGE, PROMPTS, setAiClientForTests } = await import('@/integrations/ai')
  const run = async <T>(request: { purpose: keyof typeof PROMPTS; model: string; schema: { parse: (v: unknown) => T } }) => ({ ok: true as const, output: request.schema.parse(output), promptVersion: PROMPTS[request.purpose].version, model: request.model, usage: NO_USAGE, latencyMs: 0 })
  setAiClientForTests({ mode: 'fixture', extract: run, write: run } as never)
}

/** Plays job risk-ai-draft for an assessment as the event would start it (the e2e app has no Inngest) */
async function aiDraft(assessmentId: string) {
  const { riskAiDraftRun } = await import('@/server/jobs/risk-ai')
  const { expect } = await sceneRow(22)
  const proposals = expect.proposals as Array<{ question: string; option: string; confidenceBp: number; sourceRef: string; quote: string }>
  // the model's percent (the schema's confidence); the code turns it into bp and caps it by its check
  await rowClient({ answers: proposals.map((p) => ({ questionCode: p.question, optionCode: p.option, sourceRef: p.sourceRef, quote: p.quote, confidence: Math.round(p.confidenceBp / 100) })) })
  const result = await riskAiDraftRun({ name: 'bcs/risk_assessment.opened', data: { organizationId, aggregateId: assessmentId } }, { run: (_id, fn) => fn() })
  const actions = await prisma.agentAction.findMany({ where: { organizationId, subjectType: 'RISK_ASSESSMENT', subjectId: assessmentId, purpose: 'RISK_ANSWER_DRAFT' }, orderBy: { createdAt: 'asc' }, select: { status: true, errorCode: true, output: true, fieldConfidence: true, verification: true, inputRefs: true } })
  out({ result, actions })
}

/** Plays job risk-ai-summary for every OPEN review task of an assessment (review_task.assigned) */
async function aiSummary(assessmentId: string) {
  const { riskAiSummaryRun } = await import('@/server/jobs/risk-ai')
  const { expect } = await sceneRow(22)
  await rowClient({ sentences: (expect.summary as { sentences: string[] }).sentences, inconsistentQuestionCodes: [] })
  const tasks = await prisma.reviewTask.findMany({ where: { organizationId, assessmentId, status: 'OPEN' }, select: { id: true, assigneeMemberId: true } })
  const results = []
  for (const t of tasks) results.push({ taskId: t.id, holder: await codeOf(t.assigneeMemberId), result: await riskAiSummaryRun({ data: { organizationId, aggregateId: t.id } }, { run: (_id, fn) => fn() }) })
  out(results)
}

/** For the screen review (S11-16): proposals of the AI on an open assessment, so the portal's box and the dialog's ticks show */
async function aiPropose(except: string | null) {
  const { riskAiDraftRun } = await import('@/server/jobs/risk-ai')
  const { riskDraftSource } = await import('@/server/services/risk/ai-assist')
  const { systemCtx } = await import('@/server/context')
  const { forTenant } = await import('@/server/db/tenant')
  const open = await prisma.riskAssessment.findMany({ where: { organizationId, status: { in: ['DRAFT', 'RETURNED'] }, ...(except ? { id: { not: except } } : {}) }, orderBy: { createdAt: 'asc' }, select: { id: true, supplierId: true } })
  for (const a of open) {
    const contact = await prisma.supplierContact.findFirst({ where: { organizationId, supplierId: a.supplierId, status: 'ACTIVE', portalEnabled: true }, orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }], select: { email: true } })
    if (!contact) continue
    const pending = await prisma.agentAction.findFirst({ where: { organizationId, purpose: 'RISK_ANSWER_DRAFT', subjectType: 'RISK_ASSESSMENT', subjectId: a.id, status: 'DRAFT', appliedAt: null }, select: { id: true } })
    if (pending) return out({ assessment: a.id, supplierId: a.supplierId, contact: contact.email, result: 'SKIPPED_DRAFTED' })
    const source = await forTenant(organizationId).$transaction((tx) => riskDraftSource(tx, systemCtx(organizationId, systemClock.now(), 'design-review'), a.id))
    if (!source.ok) continue
    const label = source.data.files[0]!.label
    await rowClient({ answers: source.data.ask.slice(0, 3).map((q) => ({ questionCode: q.code, optionCode: q.options[0]!.code, sourceRef: label, quote: '', confidence: 80 })) })
    const result = await riskAiDraftRun({ name: 'bcs/risk_assessment.opened', data: { organizationId, aggregateId: a.id } }, { run: (_id, fn) => fn() })
    if (result === 'DRAFTED') return out({ assessment: a.id, supplierId: a.supplierId, contact: contact.email, result })
  }
  out({ assessment: null, supplierId: null, contact: null, result: 'NONE' })
}

if (mode === 'po') {
  const [scene, requester, budgetLineCode, siteCode, historyRef] = args
  if (!/^\d+$/.test(scene ?? '') || !requester || !budgetLineCode || !siteCode) throw new Error('po <scene> <requester> <budgetLineCode> <siteCode|-> [historyRef]')
  await makePo(Number(scene), requester, budgetLineCode, siteCode, historyRef)
} else if (mode === 'try-submit' && args[0]) {
  await trySubmit(args[0])
} else if (mode === 'assessment' && args[0]) {
  await assessment(args[0])
} else if (mode === 'scan-evidence' && args[0]) {
  await scanEvidence(args[0])
} else if (mode === 'po-gate' && args[0]) {
  await poGate(args[0])
} else if (mode === 'invite-link' && args[0]) {
  await inviteLink(args[0])
} else if (mode === 'override' && args[0]) {
  await override(args[0])
} else if (mode === 'pay-flag' && args[0] && /^\d{4}-\d{2}-\d{2}$/.test(args[1] ?? '')) {
  await payFlag(args[0], args[1]!)
} else if (mode === 'ai-draft' && args[0]) {
  await aiDraft(args[0])
} else if (mode === 'ai-summary' && args[0]) {
  await aiSummary(args[0])
} else if (mode === 'ai-propose' && args[0]) {
  await aiPropose(args[0] === '-' ? null : args[0])
} else if (mode === 'agent' && (args[0] === 'on' || args[0] === 'off')) {
  // the organization's admin switches the Risk Agent on or off (/admin/ai · ai_agent.update · FR-AI-306 AC6)
  const { updateAgentSetting } = await import('@/server/services/ai/settings')
  const admin = await prisma.roleAssignment.findFirstOrThrow({ where: { organizationId, role: 'ORG_ADMIN', revokedAt: null, member: { status: 'ACTIVE' } }, select: { member: { select: { employeeCode: true } } } })
  must('agent', await updateAgentSetting(await ctxOf(admin.member.employeeCode!), { agent: 'RISK', enabled: args[0] === 'on' }, options()))
  out({ agent: 'RISK', enabled: args[0] === 'on' })
} else {
  throw new Error(`unknown mode ${mode ?? ''}`)
}
await prisma.$disconnect()
