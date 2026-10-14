import { amountToSatang, satangToAmount } from '@/core/money/dto'
import { lineNet, vatFromNet } from '@/core/money/math'
import type { AiClient } from '@/integrations/ai'
import { setAiClientForTests } from '@/integrations/ai'
import { PROMPT_VERSIONS, type AiPurposeName } from '@/lib/ai-config'
import { systemClock } from '@/lib/clock'
import { prisma } from '@/server/db/client'
import { getReceivingPo } from '@/server/queries/receiving'
import { makeCtx } from '@/server/context'
import { runBrief, runDoaDraft, runDocumentRead, runIntake, runMonthlyGrant } from '@/server/services/ai'
import { decimalText } from '@/server/services/ai/assist-contract'
import { E2E_DB } from '../support/e2e-env'

// Run by tests/e2e/ai-document.spec.ts against the e2e database only (S13-07, FR-AI-303 AC1 AC3 AC4). The e2e app sends
// no outbox to Inngest, so this plays the job ai-agent-run: it answers each PENDING read of the Document Agent with a
// reading made from what the test uploaded for — a quotation of a supplier of the register, or a delivery note naming
// every line of the PO with what is still to come — through the same service the job calls (runDocumentRead). The
// demo organization keeps the AI module off; a test switches it on for itself and off again (the runs are serial).
//   SCENE_MODE  on     AI module and the Document Agent on, the month's credits granted
//               off    AI module off again
//               run    answer every PENDING Document read; prints how many
//               state  prints the status and confirmed paths of SCENE_ACTION (the newest read when empty)
//               brief  writes the Approval Brief of an open approval task of a request (the job's work); prints it
if (new URL(process.env.DATABASE_URL ?? 'postgresql://x/none').pathname !== `/${E2E_DB}`) throw new Error('the AI scene runs in the e2e database only')
const mode = process.env.SCENE_MODE ?? ''
if (!['on', 'off', 'run', 'state', 'brief', 'doa-cleanup'].includes(mode)) throw new Error('SCENE_MODE must be on, off, run, state, brief or doa-cleanup')

const now = systemClock.now()
// SCENE_ORG: another organization of the e2e database (an S8 scene's, tests/e2e/s8-scene.ts ai-invoice); DEMO otherwise
const org = await prisma.organization.findFirstOrThrow({ where: { code: process.env.SCENE_ORG || 'DEMO' }, select: { id: true, taxId: true } })
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bangkok' }).format(now)

async function setModule(enabled: boolean) {
  const row = await prisma.orgModule.findFirst({ where: { organizationId: org.id, module: 'AI' }, select: { id: true } })
  if (row) await prisma.orgModule.update({ where: { id: row.id }, data: { enabled } })
  else await prisma.orgModule.create({ data: { organizationId: org.id, module: 'AI', enabled, enabledAt: now, contractRef: 'E2E-S13', reason: 'ทดสอบผู้อ่านเอกสาร' } })
}

async function readingFor(purpose: AiPurposeName, subjectType: string | null, subjectId: string | null) {
  const supplier = await prisma.supplier.findFirstOrThrow({ where: { organizationId: org.id, taxId: { not: null }, status: 'ACTIVE' }, select: { nameTh: true, taxId: true, branchCode: true }, orderBy: { code: 'asc' } })
  const base = { docNo: 'QT-E2E-1', docDate: today, currency: 'THB', seller: { name: supplier.nameTh, taxId: supplier.taxId, branch: supplier.branchCode }, buyer: { taxId: org.taxId }, discountTotal: null, confidence: [{ field: 'seller.name', value: 97 }, { field: 'priceIncludesVat', value: 96 }, { field: 'net', value: 98 }] }
  if (purpose === 'DELIVERY_NOTE_READ' && subjectType === 'PURCHASE_ORDER' && subjectId) {
    const po = await getReceivingPo(makeCtx({ organizationId: org.id, actor: { type: 'SYSTEM' }, channel: 'SYSTEM', now }), subjectId)
    const lines = (po?.lines ?? []).map((l) => ({ description: l.description, qty: l.outstanding, unit: l.uom, unitPrice: null, amount: null }))
    return { ...base, docType: 'DELIVERY_NOTE', docNo: 'DN-E2E-1', priceIncludesVat: null, lines, net: null, vat: null, gross: null }
  }
  if (purpose === 'INVOICE_READ' && subjectType === 'PURCHASE_ORDER' && subjectId) {
    // A tax invoice of the PO's supplier for what was received, at the PO's prices (S13-20): it matches as typed by hand
    const po = await prisma.purchaseOrder.findUniqueOrThrow({
      where: { id: subjectId },
      select: { vatRateBp: true, supplier: { select: { nameTh: true, taxId: true, branchCode: true } }, lines: { orderBy: { lineNo: 'asc' }, select: { description: true, receivedQuantity: true, uom: true, unitPriceSatang: true } } },
    })
    const lines = po.lines
      .filter((l) => l.receivedQuantity.gt(0))
      .map((l) => {
        const qty = decimalText(l.receivedQuantity)
        return { description: l.description, qty, unit: l.uom, unitPrice: satangToAmount(l.unitPriceSatang), amount: satangToAmount(lineNet(qty, l.unitPriceSatang)) }
      })
    const net = lines.reduce((sum, l) => sum + amountToSatang(l.amount), 0n)
    const { vat, gross } = vatFromNet(net, po.vatRateBp ?? 0)
    const seller = { name: po.supplier.nameTh, taxId: po.supplier.taxId, branch: po.supplier.branchCode }
    return { ...base, seller, docType: 'TAX_INVOICE', docNo: 'INV-E2E-1', priceIncludesVat: false, lines, net: satangToAmount(net), vat: satangToAmount(vat), gross: satangToAmount(gross) }
  }
  return { ...base, docType: 'QUOTATION', priceIncludesVat: false, lines: [{ description: 'สินค้าตามใบเสนอราคา', qty: '1', unit: 'งาน', unitPrice: '5000.00', amount: '5000.00' }], net: '5000.00', vat: '350.00', gross: '5350.00' }
}

/** What the Intake Agent answers in the e2e: a title, one line and nothing else (FR-AI-302) */
const INTAKE_DRAFT = {
  requestTypeCode: 'BUY_GOODS',
  title: 'ปูนซีเมนต์สำหรับไซต์งาน',
  siteCode: null,
  neededBy: null,
  lines: [{ description: 'ปูนซีเมนต์ 50 กก.', itemCode: null, qty: '20', unit: 'ถุง', unitPrice: '150' }],
  supplier: { name: null, taxId: null, branch: null },
  confidence: [{ field: 'title', value: 96 }, { field: 'lines.0.description', value: 97 }, { field: 'lines.0.unit', value: 95 }],
}

/** The regulation of the e2e: the organization's DOA in force, each rule with its sentence on page 1 (FR-AI-308) */
async function regulationOf() {
  const version = await prisma.doaVersion.findFirstOrThrow({ where: { organizationId: org.id, status: 'PUBLISHED' }, include: { rules: true }, orderBy: { versionNo: 'desc' } })
  const baht = (s: unknown) => (typeof s === 'string' || typeof s === 'number' ? (Number(s) / 100).toFixed(2) : null)
  return {
    rules: version.rules.map((r) => {
      const amount = ((r.when ?? {}) as { amount?: { gt?: unknown; lte?: unknown } }).amount ?? {}
      const approver = ((r.steps as Array<{ approver: { kind: string; position?: string } }>)[0] ?? { approver: { kind: 'POSITION_OF_ORG' } }).approver
      return { code: r.code, documentType: r.documentType, gt: baht(amount.gt), lte: baht(amount.lte), approverKind: approver.kind, approverPosition: approver.position ?? null, sourceText: `ข้อ ${r.code} ของระเบียบอำนาจอนุมัติ`, page: 1 }
    }),
  }
}

if (mode === 'on') {
  await setModule(true)
  for (const agent of ['DOCUMENT', 'INTAKE', 'APPROVAL_BRIEF', 'INSIGHT', 'DOA_DRAFTER'] as const) {
    const setting = await prisma.aiAgentSetting.findFirst({ where: { organizationId: org.id, agent }, select: { id: true } })
    if (setting) await prisma.aiAgentSetting.update({ where: { id: setting.id }, data: { enabled: true } })
    else await prisma.aiAgentSetting.create({ data: { organizationId: org.id, agent, enabled: true, level: agent === 'APPROVAL_BRIEF' || agent === 'INSIGHT' ? 'L0' : 'L1', minConfidenceBp: 9000 } })
  }
  const grant = await runMonthlyGrant(org.id, now)
  if (!grant.ok) throw new Error(JSON.stringify(grant.error))
  console.log(JSON.stringify({ on: true }))
} else if (mode === 'off') {
  await setModule(false)
  console.log(JSON.stringify({ on: false }))
} else if (mode === 'run') {
  const pending = await prisma.agentAction.findMany({ where: { organizationId: org.id, agent: { in: ['DOCUMENT', 'INTAKE', 'DOA_DRAFTER'] }, status: 'PENDING' }, select: { id: true, purpose: true, subjectType: true, subjectId: true } })
  let drafted = 0
  for (const action of pending) {
    const output = action.purpose === 'INTAKE' ? INTAKE_DRAFT : action.purpose === 'DOA_DRAFT' ? await regulationOf() : await readingFor(action.purpose, action.subjectType, action.subjectId)
    const client: AiClient = {
      mode: 'fixture',
      extract: async (request) => ({ ok: true, promptVersion: PROMPT_VERSIONS[request.purpose], model: request.model, output: request.schema.parse(output), usage: { input: 2400, output: 500, cacheRead: 0, cacheWrite: 0 }, latencyMs: 900 }),
      write: async (request) => ({ ok: false, errorCode: 'FIXTURE_MISSING', promptVersion: PROMPT_VERSIONS[request.purpose], usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, latencyMs: 0 }),
    }
    setAiClientForTests(client)
    const run = action.purpose === 'INTAKE' ? runIntake : action.purpose === 'DOA_DRAFT' ? runDoaDraft : runDocumentRead
    if ((await run(org.id, action.id, now)) === 'DRAFT') drafted++
  }
  console.log(JSON.stringify({ drafted }))
} else if (mode === 'doa-cleanup') {
  // The drafter's version takes the next number of the demo DOA; other files import fixed numbers (tasks.spec.ts), so
  // the draft it made goes away again (e2e database only, a DRAFT never routed)
  const made = await prisma.agentAction.findMany({ where: { organizationId: org.id, purpose: 'DOA_DRAFT', subjectType: 'DOA_VERSION' }, select: { subjectId: true } })
  const ids = (await prisma.doaVersion.findMany({ where: { organizationId: org.id, status: 'DRAFT', id: { in: made.flatMap((a) => (a.subjectId ? [a.subjectId] : [])) } }, select: { id: true } })).map((v) => v.id)
  await prisma.$transaction([prisma.doaTestCase.deleteMany({ where: { doaVersionId: { in: ids } } }), prisma.doaRule.deleteMany({ where: { doaVersionId: { in: ids } } }), prisma.doaVersion.deleteMany({ where: { id: { in: ids } } })])
  console.log(JSON.stringify({ removed: ids.length }))
} else if (mode === 'brief') {
  // An open task of a request whose assignee signs in with a password and TOTP (every approver of the demo does)
  const task = await prisma.approvalTask.findFirstOrThrow({ where: { organizationId: org.id, status: 'OPEN', principalMemberId: null, step: { route: { subjectType: 'REQUEST' } } }, orderBy: { assignedAt: 'desc' }, select: { id: true, assignee: { select: { employeeCode: true } } } })
  const client: AiClient = {
    mode: 'fixture',
    extract: async (request) => ({ ok: false, errorCode: 'FIXTURE_MISSING', promptVersion: PROMPT_VERSIONS[request.purpose], usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, latencyMs: 0 }),
    write: async (request) => ({ ok: true, promptVersion: PROMPT_VERSIONS[request.purpose], model: request.model, output: request.schema.parse({ sentences: ['คำขอนี้ยอด {{v:amount}} บาท ตามข้อ {{v:doaRule}}', 'ยังไม่มีราคาอ้างอิงของรายการนี้'] }), usage: { input: 900, output: 120, cacheRead: 0, cacheWrite: 0 }, latencyMs: 400 }),
  }
  setAiClientForTests(client)
  const result = await runBrief(org.id, task.id, now, task.id)
  console.log(JSON.stringify({ taskId: task.id, assignee: task.assignee.employeeCode, result }))
} else {
  const id = process.env.SCENE_ACTION
  const action = await prisma.agentAction.findFirstOrThrow({ where: { organizationId: org.id, agent: { in: ['DOCUMENT', 'INTAKE'] }, ...(id ? { id } : {}) }, orderBy: { createdAt: 'desc' }, select: { id: true, status: true, review: true, subjectType: true } })
  console.log(JSON.stringify({ id: action.id, status: action.status, subjectType: action.subjectType, confirmed: (action.review as { confirmedPaths?: string[] } | null)?.confirmedPaths ?? [] }))
}
await prisma.$disconnect()
