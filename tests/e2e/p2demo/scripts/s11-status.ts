import { randomUUID } from 'node:crypto'
import { satangToAmount } from '@/core/money/dto'
import { poGate, riskStatusAt, type RegistryFlag } from '@/core/risk'
import { dateIn } from '@/core/supplier-docs'
import { makeCtx, type Ctx } from '@/server/context'
import { prisma } from '@/server/db/client'
import { forTenant } from '@/server/db/tenant'
import { setDefaultOutboxSender } from '@/server/events/outbox'
import { decideTask } from '@/server/services/approvals/decide'
import { assignSupplier, consolidateNow } from '@/server/services/procurement'
import { freeLines } from '@/server/services/procurement/pool'
import { submitPo } from '@/server/services/purchase-orders'
import { createDraft, submitRequest } from '@/server/services/requests'
import { requestRiskOverride, riskPolicyInEffect, riskTiersInEffect, runRiskReviewDaily } from '@/server/services/risk'
import { E2E_DB, E2E_P2DEMO } from '../../../support/e2e-env'

// Run by the scenes of S11 that read a supplier's risk status and the risk report (tests/e2e/p2demo 18 20 21, S11-15,
// through ../support.ts s11Status) against the p2demo e2e database only, on SIMEC of the phase-1 workbook: what happens
// outside the screens, and what a scene reads back. Every change goes through the real commands. Prints JSON on its last
// line; amounts are satang as strings, days are Thai days (YYYY-MM-DD).
//   supplier <code>              a supplier's risk: id, name, registry flag, tier and status, its COMPLETED assessment
//                                (tier, completedOn, validUntil, remindOn) and its reviews (reason, status, due day)
//   po-like <code> <actor>       a new DRAFT PO of the supplier, as the history would make one: one unit of the first line
//                                of the request behind its last PO (same requester, type, answers, site and budget line
//                                code in today's fiscal year · under the form's quotation threshold), sent and approved
//                                by whoever the route names, then the actor (PROCUREMENT) gives the line the supplier and
//                                runs "รวมตอนนี้" — refused when another line in the pool already has a supplier, so the
//                                round drafts this PO alone. Prints the PO's id
//   submit <poId> <actor> [day]  po.submit of the PO as the actor, now or at 09:00 of `day` (the gate's clock): ok, or the
//                                refusal's code and reason (nothing is written when the gate refuses)
//   override <poId> <actor>      riskOverride.request for the PO's supplier as the actor (a cap of the PO's gross, 30 days):
//                                ok, or the refusal's code and reason (BR-RSK-12: a flagged supplier gets none)
//   unblock <code>               the gate of core (poGate) for the supplier's registry flag once an assessment completed
//                                after the flag is current: whether a HIGH PO would then pass (GC-RSK-45 GC-RSK-49)
//   daily <code> <day>           job risk-review-daily on `day` at 07:15 (the clock of Inngest dev: the e2e app has no
//                                Inngest), unless the supplier already shows what that day makes (its SCHEDULED review
//                                once the day reached remindOn, OVERDUE once it passed validUntil) — then it only reads.
//                                Refused when the run would touch anything but this supplier (another assessment due,
//                                an override to expire, another supplier whose state moves, a questionnaire to take
//                                effect), so the scenes after it find the database as they expect. Prints whether it ran,
//                                the supplier (as `supplier`), its open assessment and the e-mails the supplier was sent
//   report-facts                 what the scenes did today that /reports/risk reads as of now: the assessments completed
//                                today (with the supplier's tier before), the suppliers whose first PO went out today at
//                                the HIGH gate, the active suppliers created today (never assessed), and the overrides
//                                (number, status, last day)
if (new URL(process.env.DATABASE_URL ?? 'postgresql://x/none').pathname !== `/${E2E_DB}`) throw new Error('the scene script of phase 2 runs in its e2e database only')
if (!E2E_P2DEMO) throw new Error('the scene script of phase 2 runs in p2demo mode only (E2E_P2DEMO=1)')
setDefaultOutboxSender(null)
const [mode, ...args] = process.argv.slice(2)
const org = await prisma.organization.findFirstOrThrow({ where: { code: 'SIMEC' }, select: { id: true } })
const organizationId = org.id
const TZ = 'Asia/Bangkok'
const out = (v: unknown) => console.log(JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x)))
const iso = (d: Date) => d.toISOString().slice(0, 10)
const DAY = /^\d{4}-\d{2}-\d{2}$/
const dayArg = (v: string | undefined) => {
  if (!v || !DAY.test(v)) throw new Error(`not a day: ${v}`)
  return v
}
const opts = () => ({ idempotencyKey: randomUUID(), sender: null })
const must = <T>(step: string, r: { ok: true; data: T } | { ok: false; error: unknown }): T => {
  if (!r.ok) throw new Error(`${mode} ${args.join(' ')}: ${step} refused ${JSON.stringify(r.error)}`)
  return r.data
}
const memberId = async (code: string) => (await prisma.member.findFirstOrThrow({ where: { organizationId, employeeCode: code }, select: { id: true } })).id
const ctxOf = (id: string, now: Date): Ctx => makeCtx({ organizationId, actor: { type: 'USER', memberId: id }, channel: 'WEB', now })
const supplierOf = (code: string) => prisma.supplier.findFirstOrThrow({ where: { organizationId, code }, select: { id: true, code: true, nameTh: true, status: true, registryFlag: true, riskTier: true, riskStatus: true } })
const refusal = (r: { ok: true } | { ok: false; error: { code: string; details?: Record<string, unknown> } }) =>
  r.ok ? { ok: true as const, code: null, reason: null } : { ok: false as const, code: r.error.code, reason: (r.error.details?.reason as string | undefined) ?? null }

async function supplierFacts(code: string) {
  const s = await supplierOf(code)
  const a = await prisma.riskAssessment.findFirst({ where: { organizationId, supplierId: s.id, status: 'COMPLETED' }, select: { id: true, number: true, tier: true, completedAt: true, validUntil: true, remindOn: true } })
  const reviews = await prisma.riskReview.findMany({ where: { organizationId, supplierId: s.id }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], select: { reason: true, status: true, dueAt: true, registryFlag: true, sourceAssessmentId: true } })
  return {
    ...s,
    assessment: a ? { id: a.id, number: a.number, tier: a.tier, completedOn: a.completedAt ? dateIn(a.completedAt, TZ) : null, validUntil: a.validUntil ? iso(a.validUntil) : null, remindOn: a.remindOn ? iso(a.remindOn) : null } : null,
    reviews: reviews.map((r) => ({ reason: r.reason, status: r.status, dueOn: dateIn(r.dueAt, TZ), registryFlag: r.registryFlag, sourceAssessmentId: r.sourceAssessmentId })),
  }
}

if (mode === 'supplier') {
  out(await supplierFacts(args[0]!))
} else if (mode === 'po-like') {
  const [code, actorCode] = args as [string, string]
  const now = new Date()
  const today = dateIn(now, TZ)
  const supplier = await supplierOf(code)
  const actor = await memberId(actorCode)
  // the request behind the supplier's last PO (the history's): what the new one is like
  const last = await prisma.purchaseOrder.findFirstOrThrow({
    where: { organizationId, supplierId: supplier.id, submittedAt: { not: null } },
    orderBy: { submittedAt: 'desc' },
    select: {
      lines: {
        orderBy: { lineNo: 'asc' },
        take: 1,
        select: {
          sources: {
            take: 1,
            select: {
              requestLine: {
                select: {
                  description: true,
                  uom: true,
                  unitPriceSatang: true,
                  vatable: true,
                  categoryCode: true,
                  serviceEndDate: true,
                  request: { select: { title: true, formData: true, budgetLineId: true, deliverySiteId: true, requesterMemberId: true, chargedDepartmentId: true, requestType: { select: { code: true } } } },
                },
              },
            },
          },
        },
      },
    },
  })
  const line = last.lines[0]?.sources[0]?.requestLine
  if (!line) throw new Error(`po-like: the last PO of ${code} has no request line`)
  const r = line.request
  // the same budget line code in the fiscal year of today
  const oldBudget = r.budgetLineId ? await prisma.budgetLine.findUniqueOrThrow({ where: { id: r.budgetLineId }, select: { code: true } }) : null
  const day = new Date(`${today}T00:00:00Z`)
  const year = await prisma.fiscalYear.findFirstOrThrow({ where: { organizationId, startsOn: { lte: day }, endsOn: { gte: day } }, select: { id: true } })
  const budget = oldBudget ? await prisma.budgetLine.findFirst({ where: { organizationId, fiscalYearId: year.id, code: oldBudget.code, status: 'OPEN' }, select: { id: true } }) : null
  const requester = ctxOf(r.requesterMemberId, now)
  const serviceEnd = line.serviceEndDate ? dateIn(new Date(now.getTime() + 30 * 86_400_000), TZ) : null
  const draft = must(
    'draft',
    await createDraft(
      requester,
      {
        requestTypeCode: r.requestType.code,
        title: r.title,
        chargedDepartmentId: r.chargedDepartmentId,
        formData: r.formData as Record<string, string>,
        ...(budget ? { budgetLineId: budget.id } : {}),
        ...(r.deliverySiteId ? { deliverySiteId: r.deliverySiteId } : {}),
        // the supplier of the last PO may not be the category's preferred one any more (S10's approved awards make one ·
        // BR-FORM-12): the requester says why; submit clears the reason when the category has none
        preferredSupplierOverrideReason: 'สั่งซ้ำจากผู้ขายรายเดิมของงานนี้ (ฉากทดสอบ)',
        lines: [{ description: line.description, quantity: '1', uom: line.uom, unitPrice: satangToAmount(line.unitPriceSatang), vatable: line.vatable, ...(line.categoryCode ? { categoryCode: line.categoryCode } : {}), ...(serviceEnd ? { serviceEndDate: serviceEnd } : {}) }],
      },
      opts(),
    ),
  )
  const requestId = draft.requestId
  // a request like one sent before: the requester says why (BR-DUP-05)
  let sent = await submitRequest(requester, { requestId }, opts())
  if (!sent.ok && sent.error.details?.reason === 'DUPLICATE_UNACKNOWLEDGED') sent = await submitRequest(requester, { requestId, duplicateReason: 'ซื้อเพิ่มจากผู้ขายรายเดิมตามรอบงาน (ฉากทดสอบ)' }, opts())
  must('submit request', sent)
  // whoever the route names decides, step by step, until the request is approved
  for (let i = 0; ; i++) {
    const now2 = new Date()
    const state = await prisma.request.findUniqueOrThrow({ where: { id: requestId }, select: { status: true } })
    if (state.status === 'APPROVED') break
    const task = await prisma.approvalTask.findFirst({
      where: { organizationId, status: 'OPEN', step: { status: 'ACTIVE', route: { subjectType: 'REQUEST', subjectId: requestId, status: 'ACTIVE' } } },
      orderBy: [{ slotNo: 'asc' }, { id: 'asc' }],
      select: { id: true, assigneeMemberId: true },
    })
    if (!task || i > 8) throw new Error(`po-like: the request stays ${state.status} with no task to decide`)
    must('decide', await decideTask(ctxOf(task.assigneeMemberId, now2), { taskId: task.id, decision: 'APPROVE' }, opts()))
  }
  const lines = await prisma.requestLine.findMany({ where: { organizationId, requestId }, select: { id: true } })
  const mine = new Set(lines.map((l) => l.id))
  const others = await forTenant(organizationId).$transaction(async (tx) => (await freeLines(tx, { withSupplierOnly: true })).filter((l) => !mine.has(l.requestLineId)))
  if (others.length) throw new Error(`po-like: ${others.length} other line(s) in the pool already have a supplier; "รวมตอนนี้" would draft their POs too`)
  const proc = ctxOf(actor, new Date())
  must('assign supplier', await assignSupplier(proc, { requestLineIds: [...mine], supplierId: supplier.id }, opts()))
  const round = must('consolidate', await consolidateNow(proc, opts()))
  const po = await prisma.purchaseOrder.findFirstOrThrow({ where: { organizationId, id: { in: [...round.purchaseOrderIds] }, lines: { some: { sources: { some: { requestLine: { requestId } } } } } }, select: { id: true, status: true, grossSatang: true } })
  if (round.purchaseOrderIds.length !== 1) throw new Error(`po-like: the round drafted ${round.purchaseOrderIds.length} POs`)
  out({ id: po.id, status: po.status, grossSatang: po.grossSatang })
} else if (mode === 'submit') {
  const [poId, actorCode, day] = args as [string, string, string | undefined]
  const at = day ? new Date(`${dayArg(day)}T09:00:00+07:00`) : new Date()
  out(refusal(await submitPo(ctxOf(await memberId(actorCode), at), { poId }, opts())))
} else if (mode === 'override') {
  const [poId, actorCode] = args as [string, string]
  const now = new Date()
  const po = await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: poId }, select: { supplierId: true, grossSatang: true } })
  const asked = await requestRiskOverride(
    ctxOf(await memberId(actorCode), now),
    { supplierId: po.supplierId, poId, reason: 'ต้องใช้วัสดุจากผู้ขายรายนี้ด่วน (ฉากทดสอบ)', capGross: satangToAmount(po.grossSatang > 0n ? po.grossSatang : 100n), expiresOn: dateIn(new Date(now.getTime() + 30 * 86_400_000), TZ) },
    opts(),
  )
  out(refusal(asked))
} else if (mode === 'unblock') {
  const s = await supplierOf(args[0]!)
  const today = dateIn(new Date(), TZ)
  const allowed = await forTenant(organizationId).$transaction(async (tx) => {
    const tiers = await riskTiersInEffect(tx)
    const policy = await riskPolicyInEffect(tx)
    if (!tiers.ok || !policy.ok) throw new Error('unblock: no tiers or policy in effect')
    // the worst case of the reassessment: a HIGH supplier whose new assessment is current and covers the PO's work
    const d = poGate({ tier: 'HIGH', tiers: tiers.data, policy: policy.data, registryFlag: s.registryFlag as RegistryFlag, assessedAfterFlag: true, assessment: 'CURRENT', screeningCovered: true, override: null, poId: '', poDate: today, grossSatang: 0n, countedGrossSatang: 0n, trigger: 'SUBMIT' })
    return d.allowed
  })
  out({ code: s.code, registryFlag: s.registryFlag, allowed })
} else if (mode === 'daily') {
  const code = args[0]!
  const day = dayArg(args[1])
  const at = new Date(`${day}T07:15:00+07:00`)
  const before = await supplierFacts(code)
  const a = before.assessment
  if (!a?.validUntil || !a.remindOn) throw new Error(`daily: ${code} has no COMPLETED assessment with a cycle`)
  const scheduled = before.reviews.some((r) => r.reason === 'SCHEDULED' && r.sourceAssessmentId === a.id)
  const needed = (day >= a.remindOn && !scheduled) || (riskStatusAt({ validUntil: a.validUntil, remindOn: a.remindOn, today: day }) === 'OVERDUE' && before.riskStatus !== 'OVERDUE')
  let result: unknown = null
  if (needed) {
    // the run of that day must touch this supplier only (scenes 21 and 22 read the rest as the seed and earlier scenes left it)
    const dayDate = new Date(`${day}T00:00:00Z`)
    const due = await prisma.riskAssessment.findMany({ where: { organizationId, status: 'COMPLETED', remindOn: { lte: dayDate }, supplierId: { not: before.id }, supplier: { status: 'ACTIVE' } }, select: { id: true, supplier: { select: { code: true } } } })
    const reviewed = new Set((await prisma.riskReview.findMany({ where: { organizationId, reason: 'SCHEDULED', sourceAssessmentId: { in: due.map((d) => d.id) } }, select: { sourceAssessmentId: true } })).map((r) => r.sourceAssessmentId))
    const otherDue = due.filter((d) => !reviewed.has(d.id)).map((d) => d.supplier.code)
    const expiring = (await prisma.riskOverride.findMany({ where: { organizationId, status: 'APPROVED', expiresOn: { lt: dayDate } }, select: { number: true } })).map((o) => o.number)
    const moving = (
      await prisma.supplier.findMany({
        where: { organizationId, id: { not: before.id }, riskStatus: { in: ['CURRENT', 'EXPIRING', 'IN_PROGRESS'] }, currentRiskAssessment: { isNot: null } },
        select: { code: true, riskStatus: true, currentRiskAssessment: { select: { validUntil: true, remindOn: true } } },
      })
    ).filter((s) => s.currentRiskAssessment?.validUntil && s.currentRiskAssessment.remindOn && riskStatusAt({ validUntil: iso(s.currentRiskAssessment.validUntil), remindOn: iso(s.currentRiskAssessment.remindOn), today: day }) !== s.riskStatus)
    const versions = await prisma.riskQuestionnaire.count({ where: { organizationId, status: 'PUBLISHED', effectiveFrom: { gt: new Date(), lte: at } } })
    if (otherDue.length || expiring.length || moving.length || versions) {
      throw new Error(`daily ${day}: the run would touch more than ${code} — assessments due ${otherDue.join(' ')} · overrides to expire ${expiring.join(' ')} · suppliers whose state moves ${moving.map((s) => s.code).join(' ')} · questionnaire versions ${versions}`)
    }
    result = await runRiskReviewDaily(organizationId, at, { sender: null })
  }
  const after = await supplierFacts(code)
  const open = await prisma.riskAssessment.findFirst({ where: { organizationId, supplierId: after.id, status: { in: ['DRAFT', 'IN_REVIEW', 'RETURNED'] } }, select: { number: true, status: true } })
  const notices = await prisma.supplierNotice.findMany({ where: { organizationId, supplierId: after.id, subjectType: 'RiskAssessment' }, orderBy: { createdAt: 'asc' }, select: { templateKey: true } })
  out({ ran: needed, result, supplier: after, openAssessment: open, notices: [...new Set(notices.map((n) => n.templateKey))] })
} else if (mode === 'report-facts') {
  const today = dateIn(new Date(), TZ)
  const startOfToday = new Date(`${today}T00:00:00+07:00`)
  const done = await prisma.riskAssessment.findMany({ where: { organizationId, status: 'COMPLETED', completedAt: { gte: startOfToday }, supplier: { status: 'ACTIVE' } }, select: { supplierId: true, tier: true, supplier: { select: { code: true } } } })
  const completedToday = await Promise.all(
    done.map(async (d) => {
      const before = await prisma.riskAssessment.findFirst({ where: { organizationId, supplierId: d.supplierId, completedAt: { lt: startOfToday }, status: { in: ['COMPLETED', 'SUPERSEDED'] } }, orderBy: { completedAt: 'desc' }, select: { tier: true } })
      return { code: d.supplier.code, tier: d.tier, before: before?.tier ?? null }
    }),
  )
  const sent = await prisma.purchaseOrder.findMany({ where: { organizationId, status: { not: 'CANCELLED' }, submittedAt: { gte: startOfToday } }, select: { supplierId: true, riskGate: true, supplier: { select: { code: true } } } })
  const firstHighToday: string[] = []
  for (const p of sent) {
    const tier = (p.riskGate as { tier?: string } | null)?.tier
    if (tier !== 'HIGH' || firstHighToday.includes(p.supplier.code)) continue
    const earlier = await prisma.purchaseOrder.count({ where: { organizationId, supplierId: p.supplierId, status: { not: 'CANCELLED' }, submittedAt: { lt: startOfToday } } })
    if (earlier === 0) firstHighToday.push(p.supplier.code)
  }
  const overrides = await prisma.riskOverride.findMany({ where: { organizationId, status: { in: ['APPROVED', 'EXPIRED'] } }, orderBy: { expiresOn: 'asc' }, select: { number: true, status: true, expiresOn: true } })
  // suppliers that joined today: an application decided today (scene 1 of S7 · the seed's are decided days before),
  // never assessed until an assessment of theirs completes (by business time: the seed itself runs today)
  const joined = await prisma.supplierApplication.findMany({ where: { organizationId, status: 'APPROVED', decidedAt: { gte: startOfToday }, approvedSupplierId: { not: null } }, select: { approvedSupplierId: true } })
  const newToday = await prisma.supplier.count({ where: { organizationId, status: 'ACTIVE', id: { in: joined.map((j) => j.approvedSupplierId!) } } })
  out({ today, completedToday, newToday, firstHighToday: firstHighToday.sort(), overrides: overrides.map((o) => ({ number: o.number, status: o.status, expiresOn: iso(o.expiresOn) })) })
} else {
  throw new Error(`unknown mode ${mode}`)
}
await prisma.$disconnect()
