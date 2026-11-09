import { randomUUID } from 'node:crypto'
import { beforeAll, describe, expect, it } from 'vitest'
import { prisma } from '@/server/db/client'
import { portalCtx } from '@/server/portal/session'
import { listPool } from '@/server/services/procurement'
import { createRfx, inviteToRfx, openRfx, setScorecard, submitBid } from '@/server/services/sourcing'
import { newRfxContext, rfxList, rfxSetup } from '@/server/services/sourcing/rfx-setup'
import { bidFileUrl, rfxDetail } from '@/server/services/sourcing/rfx-view'
import { createDoaOrg, type DoaOrg } from '../support/doa-org'
import { p2p } from '../support/p2p'

// S10-12 (FR-SRC-201 AC1 · BR-RFX-06 · BR-RFX-16 · BR-SOD-14 · BR-AUTH-05): what the internal sourcing screens read, on
// real Postgres — the list of RFx by who reads which (every RFx for sourcing.view at ORG; the RFx a member evaluates or
// holds a line of; nothing for anyone else), the new RFx from pool lines and the setup form for sourcing.manage only (with
// who may not score it · BR-SOD-14 and whether a close is too soon), the RFx page by reading (STATE for a requester:
// no invite, bid or price; PRICES before the close of a sealed RFx: who sent and no price), the pool's lines held by an
// RFx, and every refusal: a member who reads none, a requester asking the setup or a bid file, SOURCING off.

const MON = new Date('2026-11-02T02:00:00Z') // Monday 09:00 Bangkok
const key = () => ({ idempotencyKey: randomUUID(), sender: null })
const ok = <T,>(r: { ok: true; data: T } | { ok: false; error: unknown }): T => {
  if (!r.ok) throw new Error(JSON.stringify(r.error))
  return r.data
}
const CRITERIA = [
  { code: 'PRICE', nameTh: 'ราคา', weightBp: 6000, kind: 'PRICE' as const },
  { code: 'DELIVERY', nameTh: 'ส่งมอบ', weightBp: 4000, kind: 'QUALITY' as const },
]

let org: DoaOrg
let flow: ReturnType<typeof p2p>
let budgetLineId: string
let fromPool: string
let fromNeed: string
let poolLineIds: string[]

const proc = () => org.ctxOf('proc_officer', MON)
const version = async (id: string) => (await prisma.rfxEvent.findUniqueOrThrow({ where: { id } })).version

async function supplier(name: string) {
  const s = await prisma.supplier.create({ data: { organizationId: org.organizationId, code: `S12-${randomUUID().slice(0, 6)}`, nameTh: name, taxId: null, isForeign: true, branchCode: '00000', portalEnabled: true, category: 'STEEL' } })
  const contact = await prisma.supplierContact.create({ data: { organizationId: org.organizationId, supplierId: s.id, nameTh: `ผู้ติดต่อ ${name}`, email: `c-${randomUUID().slice(0, 8)}@supplier.test`, isPrimary: true } })
  return { supplier: s, contact }
}

beforeAll(async () => {
  org = await createDoaOrg()
  for (const module of ['SUPPLIER', 'SOURCING'] as const) {
    await prisma.orgModule.create({ data: { organizationId: org.organizationId, module, enabled: true, enabledAt: new Date('2026-01-01T00:00:00Z'), contractRef: 'TEST-S10-12', reason: 'องค์กรทดสอบหน้าจัดหา' } })
  }
  await prisma.roleAssignment.create({ data: { organizationId: org.organizationId, memberId: org.member.dm_proc!, role: 'PROCUREMENT', grantedAt: new Date('2026-01-01T00:00:00Z') } })
  // a reader of every RFx who does not manage them (sourcing.view ORG · not sourcing.manage)
  await prisma.roleAssignment.create({ data: { organizationId: org.organizationId, memberId: org.member.fin_officer!, role: 'FINANCE', grantedAt: new Date('2026-01-01T00:00:00Z') } })
  flow = p2p(org, MON)
  budgetLineId = await flow.fundedLine(2_000_000n)
  poolLineIds = []
  for (const quantity of ['8', '5']) {
    const request = await flow.approvedRequest(budgetLineId, [{ quantity, unitPrice: '23800.00' }])
    await prisma.requestLine.updateMany({ where: { requestId: request.id }, data: { categoryCode: 'STEEL' } })
    poolLineIds.push(request.lines[0]!.id)
  }
  // RFx 1: from the pool, req_con's lines, opened with one supplier who bids (sealed until its close)
  fromPool = ok(await createRfx(proc(), { kind: 'RFQ', title: 'เหล็กจากกอง', description: 'ขอราคา', source: { kind: 'REQUEST_LINES', requestLineIds: poolLineIds } }, key())).rfxEventId
  const bidder = await supplier('ผู้ยื่นซองปิด')
  ok(await inviteToRfx(proc(), { rfxEventId: fromPool, expectedVersion: await version(fromPool), supplierId: bidder.supplier.id }, key()))
  ok(await setScorecard(proc(), { rfxEventId: fromPool, expectedVersion: await version(fromPool), criteria: CRITERIA, evaluatorMemberIds: [org.member.dm_proc!, org.member.dm_con!] }, key()))
  ok(await openRfx(proc(), { rfxEventId: fromPool, expectedVersion: await version(fromPool), closesAt: '2026-11-12T10:00:00.000Z', fewerInvitesReason: 'ทดสอบหน้าจอมีผู้ขายรายเดียว' }, key()))
  const lines = await prisma.rfxLine.findMany({ where: { rfxEventId: fromPool }, select: { id: true } })
  ok(await submitBid(portalCtx(org.organizationId, bidder.contact, MON), { rfxEventId: fromPool, lines: lines.map((l) => ({ rfxLineId: l.id, offered: true, unitPrice: '23000.00' })) }, key()))
  // RFx 2: from a need, a draft scored by dm_it
  fromNeed = ok(await createRfx(proc(), { kind: 'RFQ', title: 'ความต้องการ', description: 'สำรวจราคา', source: { kind: 'NEED', categoryCode: 'IT', lines: [{ description: 'ไฟร์วอลล์', quantity: '2', uom: 'เครื่อง', refUnitPrice: '86000.00' }] } }, key())).rfxEventId
  ok(await setScorecard(proc(), { rfxEventId: fromNeed, expectedVersion: await version(fromNeed), criteria: CRITERIA, evaluatorMemberIds: [org.member.dm_it!] }, key()))
}, 180_000)

describe('[FR-SRC-201/AC1] [BR-RFX-16] /sourcing lists the RFx each reader may open, and never a price', () => {
  it('procurement and finance (sourcing.view ORG) see both; the requester sees the RFx of their lines; an evaluator theirs; anyone else none', async () => {
    const ids = async (code: string) => ok(await rfxList(org.ctxOf(code, MON))).rows.map((r) => r.id).sort()
    expect(await ids('proc_officer')).toEqual([fromPool, fromNeed].sort())
    expect(await ids('fin_officer')).toEqual([fromPool, fromNeed].sort())
    // an evaluator without a role reads the RFx they score
    expect(await ids('dm_con')).toEqual([fromPool])
    expect(await ids('req_con')).toEqual([fromPool])
    expect(await ids('dm_it')).toEqual([fromNeed])
    expect(await ids('asst_con')).toEqual([])
    const row = ok(await rfxList(proc())).rows.find((r) => r.id === fromPool)!
    expect(row).toMatchObject({ status: 'OPEN', inviteCount: 1, bidCount: 1, categoryCode: 'STEEL' })
    expect(Object.keys(row).some((k) => /price|net|gross|amount/i.test(k))).toBe(false)
    expect(ok(await rfxList(proc(), { status: 'DRAFT' })).rows.map((r) => r.id)).toEqual([fromNeed])
    expect(ok(await rfxList(proc())).canManage).toBe(true)
    expect(ok(await rfxList(org.ctxOf('fin_officer', MON))).canManage).toBe(false)
  })

  it('the pool says which of its lines an RFx holds (INV-RFX-03), with the RFx number', async () => {
    const pool = ok(await listPool(proc()))
    const held = pool.filter((l) => poolLineIds.includes(l.requestLineId))
    const number = (await prisma.rfxEvent.findUniqueOrThrow({ where: { id: fromPool } })).number
    expect(held.map((l) => l.rfx)).toEqual([
      { id: fromPool, number },
      { id: fromPool, number },
    ])
    expect(held.every((l) => l.categoryCode === 'STEEL')).toBe(true)
  })
})

describe('[BR-AUTH-05] /sourcing/new and /sourcing/[id]/edit are procurement’s (sourcing.manage)', () => {
  it('a requester is refused both; procurement reads the pool lines asked for and counts the ones no longer free', async () => {
    expect(await newRfxContext(org.ctxOf('req_con', MON), [])).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    expect(await rfxSetup(org.ctxOf('req_con', MON), fromNeed)).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    // the lines in RFx 1 still sit in the pool, with nothing ordered; an unknown id is not a pool line
    const asked = ok(await newRfxContext(proc(), [...poolLineIds, randomUUID()]))
    expect(asked.lines.map((l) => l.requestLineId).sort()).toEqual([...poolLineIds].sort())
    expect(asked.missing).toBe(1)
  })

  it('[BR-SOD-14] the setup names who may not score — the creator and the requesters of the lines — and says when a close is too soon', async () => {
    const s = ok(await rfxSetup(proc(), fromPool, { closesAt: '2026-11-02T03:00:00.000Z' }))
    const conflict = (code: string) => s.memberChoices.find((m) => m.id === org.member[code])?.conflict
    expect(conflict('proc_officer')).toBe('CREATOR')
    expect(conflict('req_con')).toBe('REQUESTER')
    expect(conflict('dm_it')).toBeNull()
    expect(s.schedule).toMatchObject({ tooSoon: true })
    expect(s.invites).toHaveLength(1)
    expect(s.lines.map((l) => l.quantity)).toEqual(['8', '5'])
    const later = ok(await rfxSetup(proc(), fromNeed, { closesAt: '2026-12-01T10:00:00.000Z' }))
    expect(later.schedule).toMatchObject({ tooSoon: false })
    expect(later.scorecard?.evaluatorIds).toEqual([org.member.dm_it])
    expect(later.defaultWeights).toMatchObject({ PRICE: expect.any(Number) })
  })
})

describe('[BR-RFX-06] [BR-RFX-16] the RFx page by reading', () => {
  it('procurement before the close of a sealed RFx: who sent a bid, no amount, no terms; a bid file is refused', async () => {
    const d = ok(await rfxDetail(proc(), fromPool))
    expect(d.reading).toBe('PRICES')
    expect(d.bids).toMatchObject({ sealed: true, comparison: null, details: [] })
    expect(d.bids!.submitters.map((s) => s.name)).toEqual(['ผู้ยื่นซองปิด'])
    expect(await bidFileUrl(proc(), fromPool, randomUUID())).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
  })

  it('the requester of its lines reads its state only: no invite, no bid, no question; a member who reads nothing is refused', async () => {
    const d = ok(await rfxDetail(org.ctxOf('req_con', MON), fromPool))
    expect(d.reading).toBe('STATE')
    expect(d.bids).toBeNull()
    expect(d.invites).toEqual([])
    expect(d.questions).toEqual([])
    expect(await bidFileUrl(org.ctxOf('req_con', MON), fromPool, randomUUID())).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    expect(await rfxDetail(org.ctxOf('asst_con', MON), fromPool)).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
  })

  it('with SOURCING off every screen is refused MODULE_DISABLED', async () => {
    await prisma.orgModule.update({ where: { organizationId_module: { organizationId: org.organizationId, module: 'SOURCING' } }, data: { enabled: false, disabledAt: MON } })
    try {
      for (const r of [await rfxList(proc()), await newRfxContext(proc(), []), await rfxSetup(proc(), fromNeed), await rfxDetail(proc(), fromNeed)]) expect(r).toMatchObject({ ok: false, error: { code: 'MODULE_DISABLED' } })
    } finally {
      await prisma.orgModule.update({ where: { organizationId_module: { organizationId: org.organizationId, module: 'SOURCING' } }, data: { enabled: true, disabledAt: null } })
    }
  })
})
