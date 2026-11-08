import { randomUUID } from 'node:crypto'
import { makeCtx } from '@/server/context'
import { prisma } from '@/server/db/client'
import { setDefaultOutboxSender } from '@/server/events/outbox'
import { portalCtx } from '@/server/portal/session'
import { closeRfxAt, createRfx, inviteToRfx, openRfx, setScorecard, submitBid, submitScores } from '@/server/services/sourcing'
import { E2E_DB } from '../support/e2e-env'

// Run by tests/e2e/score.spec.ts against the e2e database only (S10-08 · FR-SRC-203 AC2 AC3): the demo organization with
// SUPPLIER and SOURCING switched on while the spec runs (rows only, as a platform admin would leave them), and an RFQ of
// scene 9's shape — three suppliers' bids, a scorecard of price 60 · delivery 25 · quality 15 with dm_proc and dm_it as
// its evaluators, closed — where dm_proc has sent their scores already. Prints JSON on the last line.
//   open <tag>        the RFx above; prints its id and number
//   module off        SUPPLIER and SOURCING of the demo organization back off
if (new URL(process.env.DATABASE_URL ?? 'postgresql://x/none').pathname !== `/${E2E_DB}`) throw new Error('the score scene runs in the e2e database only')
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
      create: { organizationId: org.id, module: code, enabled, enabledAt: enabled ? at : null, contractRef: 'E2E-S10-08', reason: 'ทดสอบหน้าให้คะแนนใน e2e' },
      update: enabled ? { enabled, enabledAt: at, disabledAt: null } : { enabled, disabledAt: at },
    })
  }
}

async function open() {
  await modules(true)
  const now = new Date()
  const proc = await ctxOf('proc_officer', now)
  const { rfxEventId } = ok(
    await createRfx(proc, { kind: 'RFQ', title: `เหล็กข้ออ้อย DB12 ${tag}`, description: 'ขอราคาเหล็กข้ออ้อยสำหรับสองไซต์', source: { kind: 'NEED', categoryCode: 'STEEL', lines: [{ description: 'DB12 ไซต์ 1', quantity: '8', uom: 'ตัน', refUnitPrice: '23800.00' }, { description: 'DB12 ไซต์ 9', quantity: '5', uom: 'ตัน', refUnitPrice: '23800.00' }] } }, key()),
  )
  const version = async () => (await prisma.rfxEvent.findUniqueOrThrow({ where: { id: rfxEventId } })).version
  const parties = []
  for (const [name, unit] of [['ชลบุรีภัณฑ์', '23150.00'], ['สหมิตรเหล็ก', '23500.00'], ['เหล็กไทยค้าส่ง', '23364.49']] as const) {
    const supplier = await prisma.supplier.create({ data: { organizationId: org.id, code: `E2E-SC-${tag}-${parties.length}`, nameTh: `บริษัท ${name} จำกัด`, taxId: taxId(), isVatRegistered: true, branchCode: '00000', portalEnabled: true } })
    const contact = await prisma.supplierContact.create({ data: { organizationId: org.id, supplierId: supplier.id, nameTh: `ติดต่อ ${name}`, email: `score.${tag}.${parties.length}@supplier.test`, isPrimary: true } })
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
  ok(await submitScores(await ctxOf('dm_proc', after), { rfxEventId, entries: bids.flatMap((bidId, i) => [{ bidId, criterionCode: 'DELIVERY', score: first[i]![0]! }, { bidId, criterionCode: 'QUALITY', score: first[i]![1]! }]) }, key()))
  const rfx = await prisma.rfxEvent.findUniqueOrThrow({ where: { id: rfxEventId }, select: { number: true } })
  return { rfxEventId, number: rfx.number }
}

const out = command === 'open' && tag ? await open() : command === 'module' && tag === 'off' ? (await modules(false), { module: 'off' }) : null
if (!out) throw new Error('usage: score-scene.ts open <tag> | module off')
console.log(JSON.stringify(out))
await prisma.$disconnect()
