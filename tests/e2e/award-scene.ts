import { randomUUID } from 'node:crypto'
import { makeCtx } from '@/server/context'
import { prisma } from '@/server/db/client'
import { setDefaultOutboxSender } from '@/server/events/outbox'
import { portalCtx } from '@/server/portal/session'
import { decideTask } from '@/server/services/approvals/decide'
import { closeRfxAt, createAward, createRfx, inviteToRfx, openRfx, setScorecard, submitAward, submitBid, submitScores } from '@/server/services/sourcing'
import { E2E_DB } from '../support/e2e-env'
import { stepUpForTask } from '../support/pin'

// Run by tests/e2e/award.spec.ts against the e2e database only (S10-10 · FR-SRC-204 AC2): the demo organization with
// SUPPLIER and SOURCING switched on while the spec runs (rows only, as a platform admin would leave them), and an RFQ of
// scene 9's shape — three suppliers' bids, a scorecard of price 60 · delivery 25 · quality 15 scored by dm_proc and
// dm_it, closed and revealed — for procurement to award. Prints JSON on the last line.
//   open <tag>        the RFx above; prints its id and number
//   approved <tag>    S10-11: the RFx above (a need of two catalogue items) awarded to the first ranked and approved by the
//                     COO under a rule RA-E2E added to the demo DOA version for the run (the demo DOA has no RA rule), which
//                     makes the items' agreed prices; prints its award
//   module off        SUPPLIER and SOURCING of the demo organization back off, and the rule RA-E2E removed
if (new URL(process.env.DATABASE_URL ?? 'postgresql://x/none').pathname !== `/${E2E_DB}`) throw new Error('the award scene runs in the e2e database only')
setDefaultOutboxSender(null)
const [command, tag = ''] = process.argv.slice(2)
const org = await prisma.organization.findFirstOrThrow({ where: { code: 'DEMO' }, select: { id: true } })
const key = () => ({ idempotencyKey: randomUUID(), sender: null })
function ok<T>(r: { ok: true; data: T } | { ok: false; error: unknown }): T {
  if (!r.ok) throw new Error(JSON.stringify(r.error))
  return r.data
}
const memberOf = async (code: string) => (await prisma.member.findFirstOrThrow({ where: { organizationId: org.id, email: `${code}@demo.bcs.local` }, select: { id: true } })).id
const ctxOf = async (code: string, now: Date) => makeCtx({ organizationId: org.id, actor: { type: 'USER', memberId: await memberOf(code) }, channel: 'WEB', now })
let seq = Number.parseInt(tag.replace(/[^0-9a-f]/g, '').slice(0, 5) || '1', 16) % 90000
function taxId(): string {
  const body = `01075${String(seq++).padStart(7, '0')}`
  const sum = [...body].reduce((a, d, i) => a + Number(d) * (13 - i), 0)
  return body + String((11 - (sum % 11)) % 10)
}

async function modules(enabled: boolean) {
  const at = new Date()
  for (const code of ['SUPPLIER', 'SOURCING'] as const) {
    await prisma.orgModule.upsert({
      where: { organizationId_module: { organizationId: org.id, module: code } },
      create: { organizationId: org.id, module: code, enabled, enabledAt: enabled ? at : null, contractRef: 'E2E-S10-10', reason: 'ทดสอบหน้าผลมอบงานใน e2e' },
      update: enabled ? { enabled, enabledAt: at, disabledAt: null } : { enabled, disabledAt: at },
    })
  }
}

async function open(catalog = false) {
  await modules(true)
  const now = new Date()
  const proc = await ctxOf('proc_officer', now)
  // S10-11: lines of catalogue items, so an approved award makes their agreed prices
  const items = catalog ? await Promise.all(['DB12-1', 'DB12-9'].map((code) => prisma.catalogItem.create({ data: { organizationId: org.id, code: `E2E-${tag}-${code}`, nameTh: `เหล็กข้ออ้อย ${code}`, uom: 'ตัน', categoryCode: 'STEEL', refUnitPriceSatang: 2_380_000n }, select: { id: true } }))) : null
  const ref = (i: number) => (items ? { catalogItemId: items[i]!.id } : { refUnitPrice: '23800.00' })
  const { rfxEventId } = ok(
    await createRfx(proc, { kind: 'RFQ', title: `เหล็กข้ออ้อย DB12 ${tag}`, description: 'ขอราคาเหล็กข้ออ้อยสำหรับสองไซต์', source: { kind: 'NEED', categoryCode: 'STEEL', lines: [{ description: 'DB12 ไซต์ 1', quantity: '8', uom: 'ตัน', ...ref(0) }, { description: 'DB12 ไซต์ 9', quantity: '5', uom: 'ตัน', ...ref(1) }] } }, key()),
  )
  const version = async () => (await prisma.rfxEvent.findUniqueOrThrow({ where: { id: rfxEventId } })).version
  const parties: Array<{ supplier: { id: string }; contact: Parameters<typeof portalCtx>[1]; unit: string }> = []
  for (const [n, [name, unit]] of ([['ชลบุรีภัณฑ์', '23150.00'], ['สหมิตรเหล็ก', '23500.00'], ['เหล็กไทยค้าส่ง', '23364.49']] as const).entries()) {
    const supplier = await prisma.supplier.create({ data: { organizationId: org.id, code: `E2E-AW-${tag}-${n}`, nameTh: `บริษัท ${name} จำกัด`, taxId: taxId(), isVatRegistered: true, branchCode: '00000', portalEnabled: true } })
    const contact = await prisma.supplierContact.create({ data: { organizationId: org.id, supplierId: supplier.id, nameTh: `ติดต่อ ${name}`, email: `award.${tag}.${n}@supplier.test`, isPrimary: true } })
    parties.push({ supplier, contact, unit })
    ok(await inviteToRfx(proc, { rfxEventId, expectedVersion: await version(), supplierId: supplier.id }, key()))
  }
  const criteria = [
    { code: 'PRICE', nameTh: 'ราคา', nameEn: 'Price', weightBp: 6000, kind: 'PRICE' as const },
    { code: 'DELIVERY', nameTh: 'การส่งมอบ', nameEn: 'Delivery', weightBp: 2500, kind: 'QUALITY' as const },
    { code: 'QUALITY', nameTh: 'คุณภาพ', nameEn: 'Quality', weightBp: 1500, kind: 'QUALITY' as const },
  ]
  ok(await setScorecard(proc, { rfxEventId, expectedVersion: await version(), criteria, evaluatorMemberIds: [await memberOf('dm_proc'), await memberOf('dm_it')] }, key()))
  const closesAt = new Date(now.getTime() + 8 * 24 * 3600 * 1000).toISOString()
  ok(await openRfx(proc, { rfxEventId, expectedVersion: await version(), closesAt }, key()))
  const lines = (await prisma.rfxLine.findMany({ where: { rfxEventId }, orderBy: { lineNo: 'asc' } })).map((l) => l.id)
  const bids: string[] = []
  for (const p of parties) bids.push(ok(await submitBid(portalCtx(org.id, p.contact, now), { rfxEventId, lines: lines.map((rfxLineId) => ({ rfxLineId, offered: true, unitPrice: p.unit })) }, key())).bidId)
  // the close as its job would run it at closesAt
  await closeRfxAt(org.id, rfxEventId, closesAt, new Date(closesAt))
  const after = new Date(new Date(closesAt).getTime() + 60_000)
  const first = [
    [85, 90],
    [90, 90],
    [70, 80],
  ]
  const second = [
    [90, 90],
    [90, 90],
    [75, 80],
  ]
  ok(await submitScores(await ctxOf('dm_proc', after), { rfxEventId, entries: bids.flatMap((bidId, i) => [{ bidId, criterionCode: 'DELIVERY', score: first[i]![0]! }, { bidId, criterionCode: 'QUALITY', score: first[i]![1]! }]) }, key()))
  ok(await submitScores(await ctxOf('dm_it', after), { rfxEventId, entries: bids.flatMap((bidId, i) => [{ bidId, criterionCode: 'DELIVERY', score: second[i]![0]! }, { bidId, criterionCode: 'QUALITY', score: second[i]![1]! }]) }, key()))
  const rfx = await prisma.rfxEvent.findUniqueOrThrow({ where: { id: rfxEventId }, select: { number: true } })
  return { rfxEventId, number: rfx.number }
}

/** RA-E2E: awards of the demo organization go to its COO while the spec runs (the demo DOA has no RA rule · S10-02) */
async function awardRule(on: boolean) {
  const rule = await prisma.doaRule.findFirst({ where: { organizationId: org.id, code: 'RA-E2E' }, select: { id: true } })
  if (!on) {
    if (rule) await prisma.doaRule.delete({ where: { id: rule.id } })
    return
  }
  if (rule) return
  const now = new Date()
  const version = await prisma.doaVersion.findFirstOrThrow({ where: { organizationId: org.id, status: 'PUBLISHED', effectiveFrom: { lte: now } }, orderBy: { effectiveFrom: 'desc' }, select: { id: true } })
  await prisma.doaRule.create({ data: { organizationId: org.id, doaVersionId: version.id, code: 'RA-E2E', documentType: 'RFX_AWARD', priority: 100, when: {}, steps: [{ approver: { kind: 'POSITION_OF_ORG', position: 'COO' }, slaBusinessHours: 16 }] } })
}

/** The RFx of open() awarded line by line to the first ranked, sent and approved by its approver */
async function approved() {
  const opened = await open(true)
  await awardRule(true)
  const now = new Date(Date.now() + 9 * 24 * 3600 * 1000)
  const proc = await ctxOf('proc_officer', now)
  const bid = await prisma.bid.findFirstOrThrow({ where: { rfxEventId: opened.rfxEventId, supplier: { code: `E2E-AW-${tag}-0` } }, select: { id: true } })
  const lines = await prisma.rfxLine.findMany({ where: { rfxEventId: opened.rfxEventId }, orderBy: { lineNo: 'asc' }, select: { id: true } })
  const made = ok(await createAward(proc, { rfxEventId: opened.rfxEventId, lines: lines.map((l) => ({ rfxLineId: l.id, bidId: bid.id })) }, key()))
  const version = (await prisma.awardDecision.findUniqueOrThrow({ where: { id: made.awardDecisionId } })).version
  ok(await submitAward(proc, { awardDecisionId: made.awardDecisionId, version }, key()))
  const task = await prisma.approvalTask.findFirstOrThrow({ where: { status: 'OPEN', step: { route: { subjectType: 'AWARD_DECISION', subjectId: made.awardDecisionId } } } })
  await stepUpForTask(task.id, task.assigneeMemberId)
  ok(await decideTask(makeCtx({ organizationId: org.id, actor: { type: 'USER', memberId: task.assigneeMemberId }, channel: 'WEB', now }), { taskId: task.id, decision: 'APPROVE' }, key()))
  // the rule only for this award: the draft test of this file meets the demo DOA without an RA rule
  await awardRule(false)
  const award = await prisma.awardDecision.findUniqueOrThrow({ where: { id: made.awardDecisionId }, select: { number: true, poStatus: true, priceAgreementIds: true } })
  return { ...opened, awardDecisionId: made.awardDecisionId, awardNumber: award.number, poStatus: award.poStatus, priceAgreements: (award.priceAgreementIds as string[]).length }
}

const out =
  command === 'open' && tag
    ? await open()
    : command === 'approved' && tag
      ? await approved()
      : command === 'module' && tag === 'off'
        ? (await modules(false), await awardRule(false), { module: 'off' })
        : null
if (!out) throw new Error('usage: award-scene.ts open <tag> | approved <tag> | module off')
console.log(JSON.stringify(out))
await prisma.$disconnect()
