import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fixtureKey } from '@/integrations/ai'
import { modelForPurpose, PROMPT_VERSIONS } from '@/lib/ai-config'
import { systemClock } from '@/lib/clock'
import { makeCtx, systemCtx } from '@/server/context'
import { prisma } from '@/server/db/client'
import { forTenant } from '@/server/db/tenant'
import { setDefaultOutboxSender } from '@/server/events/outbox'
import { portalCtx } from '@/server/portal/session'
import { sourcingFacts, sourcingFactsText } from '@/server/services/ai/agents/sourcing-facts'
import { aiRuntime } from '@/server/services/ai/gate'
import { closeRfxAt, createRfx, rfxBidFacts, setScorecard, submitBid } from '@/server/services/sourcing'
import { INPUT_WORKBOOKS, loadInputWorkbook } from '@/server/seed/workbook'
import { E2E_DB, E2E_P2DEMO } from '../../../support/e2e-env'

// Run by the scenes of S10 (tests/e2e/p2demo, through ../support.ts s10) against the p2demo e2e database only, on SIMEC
// of the phase-1 workbook. Prints JSON on its last line; amounts are baht text.
//   foreign-rfp <memberEmail> <contactEmail>
//                         scene 13 (S10-17 · FR-INT-201): a new RFP DRAFT for the need of scene 10 — its kind, category
//                         and lines copied from the RFP the seed played (title, description and lines in Thai only, so
//                         the scene types the English), made by the member as procurement does on /sourcing/new, with a
//                         price-only scorecard; and the supplier of the contact (the foreign one of RFx_Suppliers)
//   bid <rfxEventId> <supplierId>
//                         the supplier's bid on the RFx: status and amounts (baht text)
//   rfx <ref>             the RFx the seed made for a row of RFx_Scenarios (found by its kind and title, never by its
//                         number): id, number, status, close, its lines, and each invite with its supplier (code and Thai
//                         name) or application, and the contacts the portal knows for it (e-mail, locale, primary)
//   close <rfxEventId>    the close as job rfx-close runs it at closesAt (S10-18: the clock of the day moved to the close;
//                         the e2e app has no Inngest)
//   late-bid <rfxEventId> <supplierCode>
//                         the supplier's primary contact sends its bid again a second after closesAt: the refusal's code
//   app-bid <rfxEventId> <email>
//                         the contact of an application (not yet a supplier) sends a bid now: the refusal's code
//   award <rfxEventId>    the RFx's award that is not returned, rejected or cancelled: number, status, amounts, reasons,
//                         its route (rule, approvers by code, the open task), the POs it drafted (site, amount, status),
//                         the agreed prices and preferred suppliers it made, and what the suppliers were e-mailed
//   po <poId>             a PO: number, status, amounts, its route (rule, approvers by code, the open task)
//   invites <rfxEventId>  the RFx's invites (supplier code or application id, status) and the invitations e-mailed
//   supplier <code>       the supplier's id
//   application <email>   the application whose primary contact has that e-mail: id, status, Thai name
//   ai-answers <rfxEventId>
//                         scene 14: the recorded answers of BID_SUMMARY and NEGOTIATION_POINTS for the RFx's facts as
//                         played (tests/fixtures/ai/<purpose>/<key>.json, AI_MODE=fixture). The sentences below are the
//                         recording: placeholders of the facts' keys, which code fills in and checks (BR-AI-27), so one
//                         recording fits the facts of every run; the key is the facts' text, which holds the RFx's number
//                         (its Buddhist year), so a run of another year files the same recording under its own key
//   ai-draft-rfx <memberEmail>
//                         scene 14: a new RFQ DRAFT of the steel of scene 9 (a need: two lines, no supplier), made by the
//                         member as /sourcing/new does, for the button "ร่าง RFx ด้วย AI" (RFX_DRAFT, recorded answer
//                         tests/fixtures/ai/RFX_DRAFT/<key>.json · the key is its kind, category and lines only)
//   ai-module <on|off>    module AI of SIMEC switched on or off (EG-1: what the scenes see without AI)

if (new URL(process.env.DATABASE_URL ?? 'postgresql://x/none').pathname !== `/${E2E_DB}`) throw new Error('the scene script of phase 2 runs in its e2e database only')
if (!E2E_P2DEMO) throw new Error('the scene script of phase 2 runs in p2demo mode only (E2E_P2DEMO=1)')
setDefaultOutboxSender(null)
const [mode, ...args] = process.argv.slice(2)
const org = await prisma.organization.findFirstOrThrow({ where: { code: 'SIMEC' }, select: { id: true } })
const organizationId = org.id
const out = (v: unknown) => console.log(JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x)))
const baht = (satang: bigint | null) => (satang === null ? null : `${satang / 100n}.${String(satang % 100n).padStart(2, '0')}`)
const fail = (r: { ok: boolean; error?: unknown }) => {
  if (!r.ok) throw new Error(JSON.stringify(r.error))
}

/**
 * The recording of scene 14 (BR-AI-32 · docs/sub-specs/S10.md "Demo ของขั้น" 6): what the Sourcing Agent writes of the
 * RFQ of scene 9 once its bids are open and scored, in placeholders of sourcingFacts' keys only (no digit outside them ·
 * no advice to award). The summary: the bids, the VAT-inclusive one, the lowest and highest before VAT, the spread in bp
 * of the lowest, no price flag. The points: the incumbent nearest the lowest (S10-09's tag "รายเดิม": SP0024) above the
 * lowest by its gap, what procurement may ask of it, and the VAT-inclusive bid — words for procurement, sent to no one.
 */
const SCENE_9_ANSWERS = {
  BID_SUMMARY: [
    'RFx {{v:rfx.number}} มีผู้ยื่น {{v:bidCount}} ราย ยื่นราคารวม VAT {{v:vatInclusiveCount}} ราย ซึ่งตารางปรับเป็นก่อน VAT แล้ว',
    'ยอดก่อน VAT ต่ำสุด {{v:lowest.net}} บาท ของ {{v:lowest.supplierName}} และสูงสุด {{v:highest.net}} บาท ของ {{v:highest.supplierName}}',
    'ยอดต่ำสุดกับสูงสุดห่างกัน {{v:spreadBp}} bp ของยอดต่ำสุด',
    'ราคาที่ระบบติดธงผิดปกติ {{v:flagCount}} รายการ',
  ],
  NEGOTIATION_POINTS: [
    '{{v:incumbent.supplierName}} ผู้ขายรายเดิมเสนอ {{v:incumbent.net}} บาทก่อน VAT สูงกว่ายอดต่ำสุด {{v:incumbent.gap}} บาท หรือ {{v:gapBp}} bp',
    'จัดซื้ออาจขอให้ {{v:incumbent.supplierName}} พิจารณายืนราคาเท่ายอดต่ำสุด {{v:lowest.net}} บาท',
    'ใบที่ยื่นราคารวม VAT มี {{v:vatInclusiveCount}} ใบ จัดซื้ออาจขอให้ผู้ยื่นยืนยันราคาก่อน VAT ต่อบรรทัด',
  ],
} as const

if (mode === 'foreign-rfp') {
  const [memberEmail, contactEmail] = args as [string, string]
  const member = await prisma.member.findFirstOrThrow({ where: { organizationId, email: memberEmail.toLowerCase() }, select: { id: true } })
  const contact = await prisma.supplierContact.findFirstOrThrow({ where: { organizationId, email: contactEmail.toLowerCase(), supplierId: { not: null } }, select: { supplierId: true } })
  // the RFP of scene 10 the seed played: the need of IT (the RFP of a need the seed made first)
  const played = await prisma.rfxEvent.findFirstOrThrow({
    where: { organizationId, kind: 'RFP', sourceKind: 'NEED', categoryCode: 'IT' },
    orderBy: { createdAt: 'asc' },
    select: { title: true, description: true, categoryCode: true, lines: { orderBy: { lineNo: 'asc' }, select: { description: true, quantity: true, uom: true, catalogItemId: true, refUnitPriceSatang: true, refSource: true } } },
  })
  const ctx = makeCtx({ organizationId, actor: { type: 'USER', memberId: member.id }, channel: 'WEB', now: systemClock.now() })
  const made = await createRfx(
    ctx,
    {
      kind: 'RFP',
      title: played.title,
      description: played.description,
      source: {
        kind: 'NEED',
        categoryCode: played.categoryCode,
        lines: played.lines.map((l) => ({
          description: l.description,
          quantity: l.quantity.toString(),
          uom: l.uom,
          ...(l.catalogItemId ? { catalogItemId: l.catalogItemId } : {}),
          ...(l.refSource === 'MANUAL' && l.refUnitPriceSatang !== null ? { refUnitPrice: baht(l.refUnitPriceSatang)! } : {}),
        })),
      },
    },
    { idempotencyKey: `scene13:${Date.now()}`, sender: null },
  )
  fail(made)
  const rfxEventId = (made as { data: { rfxEventId: string } }).data.rfxEventId
  const version = (await prisma.rfxEvent.findUniqueOrThrow({ where: { id: rfxEventId }, select: { version: true } })).version
  fail(await setScorecard(ctx, { rfxEventId, expectedVersion: version, criteria: [{ code: 'PRICE', nameTh: 'ราคา', nameEn: 'Price', weightBp: 10000, kind: 'PRICE' }], evaluatorMemberIds: [] }, { idempotencyKey: `scene13-card:${rfxEventId}`, sender: null }))
  out({ rfxEventId, supplierId: contact.supplierId })
} else if (mode === 'bid') {
  const [rfxEventId, supplierId] = args as [string, string]
  const bid = await prisma.bid.findFirstOrThrow({ where: { organizationId, rfxEventId, supplierId }, select: { status: true, netSatang: true, vatSatang: true, grossSatang: true } })
  const rfx = await prisma.rfxEvent.findUniqueOrThrow({ where: { id: rfxEventId }, select: { locale: true, currency: true, status: true } })
  out({ status: bid.status, net: baht(bid.netSatang), vat: baht(bid.vatSatang), gross: baht(bid.grossSatang), locale: rfx.locale, currency: rfx.currency, rfxStatus: rfx.status })
} else if (mode === 'rfx') {
  const [ref] = args as [string]
  const workbook = await loadInputWorkbook(INPUT_WORKBOOKS.p1)
  const row = workbook.table('RFx_Scenarios').find((r) => String(r.values.ref ?? '').trim() === ref)
  if (!row) throw new Error(`RFx_Scenarios has no ${ref}`)
  // the seed's own RFx of the row: the first of its kind and title (scene 13 makes a second RFP of the same title)
  const rfx = await prisma.rfxEvent.findFirstOrThrow({
    where: { organizationId, kind: String(row.values.kind) as 'RFQ', title: String(row.values.title).trim() },
    orderBy: { createdAt: 'asc' },
    select: { id: true, number: true, status: true, closesAt: true, lines: { orderBy: { lineNo: 'asc' }, select: { lineNo: true, description: true, quantity: true, uom: true } } },
  })
  const invites = await prisma.rfxInvite.findMany({ where: { organizationId, rfxEventId: rfx.id }, orderBy: { createdAt: 'asc' }, select: { supplierId: true, applicationId: true, status: true } })
  const listed = []
  for (const i of invites) {
    const supplier = i.supplierId ? await prisma.supplier.findUniqueOrThrow({ where: { id: i.supplierId }, select: { code: true, nameTh: true } }) : null
    const contacts = await prisma.supplierContact.findMany({
      where: { organizationId, status: 'ACTIVE', ...(i.supplierId ? { supplierId: i.supplierId } : { applicationId: i.applicationId! }) },
      orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
      select: { email: true, locale: true, isPrimary: true },
    })
    listed.push({ supplierCode: supplier?.code ?? null, supplierName: supplier?.nameTh ?? null, applicationId: i.applicationId, status: i.status, contacts })
  }
  out({ id: rfx.id, number: rfx.number, status: rfx.status, closesAt: rfx.closesAt?.toISOString() ?? null, lines: rfx.lines.map((l) => ({ ...l, quantity: l.quantity.toString() })), invites: listed })
} else if (mode === 'close') {
  const [rfxEventId] = args as [string]
  const rfx = await prisma.rfxEvent.findUniqueOrThrow({ where: { id: rfxEventId }, select: { closesAt: true } })
  if (!rfx.closesAt) throw new Error('the RFx has no close')
  const closed = await closeRfxAt(organizationId, rfxEventId, rfx.closesAt.toISOString(), rfx.closesAt)
  const after = await prisma.rfxEvent.findUniqueOrThrow({ where: { id: rfxEventId }, select: { status: true } })
  out({ ...closed, status: after.status })
} else if (mode === 'late-bid') {
  const [rfxEventId, supplierCode] = args as [string, string]
  const rfx = await prisma.rfxEvent.findUniqueOrThrow({ where: { id: rfxEventId }, select: { closesAt: true, lines: { orderBy: { lineNo: 'asc' }, select: { id: true } } } })
  const contact = await prisma.supplierContact.findFirstOrThrow({
    where: { organizationId, status: 'ACTIVE', supplier: { code: supplierCode } },
    orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
    select: { id: true, supplierId: true, applicationId: true },
  })
  const late = new Date(rfx.closesAt!.getTime() + 1000)
  const r = await submitBid(portalCtx(organizationId, contact, late), { rfxEventId, lines: rfx.lines.map((l) => ({ rfxLineId: l.id, offered: true, unitPrice: '23000.00' })) }, { idempotencyKey: `scene9-late:${rfxEventId}:${Date.now()}`, sender: null })
  out(r.ok ? { code: null } : { code: r.error.code })
} else if (mode === 'app-bid') {
  const [rfxEventId, email] = args as [string, string]
  const rfx = await prisma.rfxEvent.findUniqueOrThrow({ where: { id: rfxEventId }, select: { lines: { orderBy: { lineNo: 'asc' }, select: { id: true } } } })
  const contact = await prisma.supplierContact.findFirstOrThrow({ where: { organizationId, status: 'ACTIVE', email: email.toLowerCase(), applicationId: { not: null } }, orderBy: { createdAt: 'desc' }, select: { id: true, supplierId: true, applicationId: true } })
  const r = await submitBid(portalCtx(organizationId, contact, systemClock.now()), { rfxEventId, lines: rfx.lines.map((l) => ({ rfxLineId: l.id, offered: true, unitPrice: '23000.00' })) }, { idempotencyKey: `scene12-bid:${rfxEventId}:${Date.now()}`, sender: null })
  out(r.ok ? { code: null } : { code: r.error.code })
} else if (mode === 'award') {
  const [rfxEventId] = args as [string]
  const award = await prisma.awardDecision.findFirstOrThrow({
    where: { organizationId, rfxEventId, status: { notIn: ['RETURNED', 'REJECTED', 'CANCELLED'] } },
    orderBy: { createdAt: 'desc' },
    select: { id: true, number: true, status: true, netSatang: true, vatSatang: true, grossSatang: true, reason: true, reasonCodes: true },
  })
  const pos = await prisma.purchaseOrder.findMany({ where: { organizationId, awardDecisionId: award.id }, orderBy: { netSatang: 'desc' }, select: { id: true, number: true, status: true, netSatang: true, deliverySite: { select: { code: true } } } })
  const agreements = award.number ? await prisma.priceAgreement.findMany({ where: { organizationId, sourceRef: award.number }, select: { unitPriceSatang: true, catalogItem: { select: { code: true } }, supplier: { select: { code: true } } } }) : []
  const preferred = await prisma.preferredSupplier.findMany({ where: { organizationId, awardDecisionId: award.id }, select: { categoryCode: true, validFrom: true, validTo: true, supplier: { select: { code: true } } } })
  const notices = await prisma.supplierNotice.findMany({ where: { organizationId, subjectId: { in: [award.id, rfxEventId] }, templateKey: { in: ['rfx.awarded', 'rfx.not_awarded'] } }, select: { templateKey: true, supplierId: true } })
  const codeOfSupplier = new Map((await prisma.supplier.findMany({ where: { id: { in: notices.map((n) => n.supplierId).filter((x): x is string => x !== null) } }, select: { id: true, code: true } })).map((s) => [s.id, s.code]))
  out({
    number: award.number,
    status: award.status,
    net: baht(award.netSatang),
    vat: baht(award.vatSatang),
    gross: baht(award.grossSatang),
    reason: award.reason,
    reasonCodes: award.reasonCodes,
    route: await routeOf(award.id),
    pos: pos.map((p) => ({ id: p.id, number: p.number, status: p.status, net: baht(p.netSatang), site: p.deliverySite?.code ?? null })),
    agreements: agreements.map((a) => ({ item: a.catalogItem.code, supplier: a.supplier.code, unitPrice: baht(a.unitPriceSatang) })),
    preferred: preferred.map((p) => ({ category: p.categoryCode, supplier: p.supplier.code, validFrom: p.validFrom.toISOString().slice(0, 10), validTo: p.validTo.toISOString().slice(0, 10) })),
    notices: notices.map((n) => ({ template: n.templateKey, supplier: n.supplierId ? (codeOfSupplier.get(n.supplierId) ?? null) : null })).sort((a, b) => `${a.template}${a.supplier}`.localeCompare(`${b.template}${b.supplier}`)),
  })
} else if (mode === 'po') {
  const [poId] = args as [string]
  const po = await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: poId }, select: { number: true, status: true, netSatang: true, grossSatang: true } })
  out({ number: po.number, status: po.status, net: baht(po.netSatang), gross: baht(po.grossSatang), route: await routeOf(poId) })
} else if (mode === 'invites') {
  const [rfxEventId] = args as [string]
  const invites = await prisma.rfxInvite.findMany({ where: { organizationId, rfxEventId }, orderBy: { createdAt: 'asc' }, select: { id: true, applicationId: true, status: true, supplier: { select: { code: true } } } })
  const mailed = await prisma.supplierNotice.findMany({ where: { organizationId, subjectId: rfxEventId, templateKey: 'rfx.invited' }, select: { toEmail: true } })
  out({ invites: invites.map((i) => ({ supplier: i.supplier?.code ?? null, applicationId: i.applicationId, status: i.status })), invitedTo: mailed.map((m) => m.toEmail?.toLowerCase() ?? null) })
} else if (mode === 'supplier') {
  const [code] = args as [string]
  out({ id: (await prisma.supplier.findFirst({ where: { organizationId, code }, select: { id: true } }))?.id ?? null })
} else if (mode === 'application') {
  const [email] = args as [string]
  const contact = await prisma.supplierContact.findFirstOrThrow({ where: { organizationId, email: email.toLowerCase(), applicationId: { not: null } }, orderBy: { createdAt: 'desc' }, select: { applicationId: true } })
  const app = await prisma.supplierApplication.findUniqueOrThrow({ where: { id: contact.applicationId! }, select: { id: true, status: true, nameTh: true } })
  out(app)
} else if (mode === 'ai-answers') {
  const [rfxEventId] = args as [string]
  const ctx = systemCtx(organizationId, systemClock.now(), 'scene-14')
  const facts = await forTenant(organizationId).$transaction(async (tx) => rfxBidFacts(tx, ctx, rfxEventId, { system: true }))
  if (!facts.ok) throw new Error(JSON.stringify(facts.error))
  const text = sourcingFactsText(sourcingFacts(facts.data))
  const filed: Array<{ key: string; written: boolean }> = []
  for (const [purpose, sentences] of Object.entries(SCENE_9_ANSWERS) as Array<[keyof typeof SCENE_9_ANSWERS, readonly string[]]>) {
    const key = fixtureKey({ purpose, text })
    const file = path.join(process.cwd(), 'tests', 'fixtures', 'ai', `${key}.json`)
    const written = !existsSync(file)
    if (written) {
      mkdirSync(path.dirname(file), { recursive: true })
      const answer = { promptVersion: PROMPT_VERSIONS[purpose], model: modelForPurpose(purpose, aiRuntime().modelEnv), recorded: 'SCENE', output: { sentences }, usage: { input: 0, output: 0 } }
      writeFileSync(file, `${JSON.stringify(answer, null, 2)}\n`)
    }
    filed.push({ key, written })
  }
  out({ filed })
} else if (mode === 'ai-draft-rfx') {
  const [memberEmail] = args as [string]
  const member = await prisma.member.findFirstOrThrow({ where: { organizationId, email: memberEmail.toLowerCase() }, select: { id: true } })
  const ctx = makeCtx({ organizationId, actor: { type: 'USER', memberId: member.id }, channel: 'WEB', now: systemClock.now() })
  const made = await createRfx(
    ctx,
    {
      kind: 'RFQ',
      title: 'เหล็กข้ออ้อย DB12 SD40 รอบเติมสต็อก',
      description: 'เหล็กข้ออ้อย DB12 SD40 สำหรับสองไซต์',
      source: {
        kind: 'NEED',
        categoryCode: 'STEEL',
        lines: [
          { description: 'เหล็กข้ออ้อย DB12 SD40', quantity: '8', uom: 'ตัน', refUnitPrice: '23800.00' },
          { description: 'เหล็กข้ออ้อย DB12 SD40', quantity: '5', uom: 'ตัน', refUnitPrice: '23800.00' },
        ],
      },
    },
    { idempotencyKey: `scene14:${Date.now()}`, sender: null },
  )
  fail(made)
  out({ rfxEventId: (made as { data: { rfxEventId: string } }).data.rfxEventId })
} else if (mode === 'ai-module') {
  const [state] = args as ['on' | 'off']
  const at = new Date()
  const on = state === 'on'
  await prisma.orgModule.update({ where: { organizationId_module: { organizationId, module: 'AI' } }, data: on ? { enabled: true, enabledAt: at, disabledAt: null } : { enabled: false, disabledAt: at } })
  out({ module: 'AI', enabled: on })
} else {
  throw new Error(`unknown mode ${mode ?? ''}`)
}

/** The route of a document: its DOA rule, who holds its tasks (by code, in order) and the task still open */
async function routeOf(subjectId: string) {
  const route = await prisma.approvalRoute.findFirst({ where: { organizationId, subjectId }, orderBy: { createdAt: 'desc' }, select: { id: true, ruleCode: true } })
  if (!route) return null
  const tasks = await prisma.approvalTask.findMany({ where: { organizationId, step: { routeId: route.id } }, orderBy: { assignedAt: 'asc' }, select: { id: true, status: true, assignee: { select: { employeeCode: true } } } })
  return { rule: route.ruleCode, approvers: tasks.map((t) => t.assignee.employeeCode), openTaskId: tasks.find((t) => t.status === 'OPEN')?.id ?? null }
}
