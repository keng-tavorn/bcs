import { randomUUID } from 'node:crypto'
import { beforeAll, describe, expect, it } from 'vitest'
import { prisma } from '@/server/db/client'
import { portalCtx } from '@/server/portal/session'
import {
  assignEvaluators,
  bidForMember,
  closeRfxAt,
  createRfx,
  disqualifyBid,
  inviteToRfx,
  openRfx,
  recuseEvaluator,
  saveScores,
  scoreEntriesOf,
  scoreSheet,
  setScorecard,
  submitBid,
  submitScores,
} from '@/server/services/sourcing'
import { createDoaOrg, type DoaOrg } from '../support/doa-org'

// S10-08 (FR-SRC-203 AC1 AC2 AC3 AC5 AC6 · BR-RFX-09 10 18 · BR-SOD-14 · GC-SRC-08 · GC-SOD-20): scoring an RFx on real
// Postgres — scene 9's three bids (300,950.00 · 305,500.00 · 303,738.32 before VAT, the last quoted with VAT) and its two
// evaluators give the totals of GC-SRC-08 (95.38 · 95.11 · 89.57); scores are given on their own and read across once
// revealed; the last send reveals in its own transaction, once when two send at once; an evaluator steps aside; one is
// added after the close with a reason; the requester of a source line or the RFx's creator may not score; a price-only
// RFQ reveals at its close; a bid disqualified after the reveal recomputes the ranking and the first stays in its event.

const MON = new Date('2026-11-02T02:00:00Z') // Monday 09:00 Bangkok
const CLOSES = '2026-11-05T10:00:00Z' // Thursday 17:00
const AFTER = new Date('2026-11-05T10:00:00Z')
const key = () => ({ idempotencyKey: randomUUID(), sender: null })
const ok = <T,>(r: { ok: true; data: T } | { ok: false; error: unknown }): T => {
  if (!r.ok) throw new Error(JSON.stringify(r.error))
  return r.data
}
let seq = 500
function taxId(): string {
  const body = `01055${String(seq++).padStart(7, '0')}`
  const sum = [...body].reduce((a, d, i) => a + Number(d) * (13 - i), 0)
  return body + String((11 - (sum % 11)) % 10)
}
const SCENE_9 = [
  { name: 'SP0023 ชลบุรีภัณฑ์', priceIncludesVat: false, unit: '23150.00', DELIVERY: [85, 90], QUALITY: [90, 90] },
  { name: 'SP0029 สหมิตร', priceIncludesVat: false, unit: '23500.00', DELIVERY: [90, 90], QUALITY: [90, 90] },
  // 13 × 25,000.00 = 325,000.00 with VAT → 303,738.32 before VAT (BR-RFX-08)
  { name: 'SP0024 เหล็กไทย', priceIncludesVat: true, unit: '25000.00', DELIVERY: [70, 75], QUALITY: [80, 80] },
] as const
const CRITERIA = [
  { code: 'PRICE', nameTh: 'ราคา', weightBp: 6000, kind: 'PRICE' as const },
  { code: 'DELIVERY', nameTh: 'การส่งมอบ', weightBp: 2500, kind: 'QUALITY' as const },
  { code: 'QUALITY', nameTh: 'คุณภาพ', weightBp: 1500, kind: 'QUALITY' as const },
]

let org: DoaOrg
beforeAll(async () => {
  org = await createDoaOrg()
  for (const m of ['SUPPLIER', 'SOURCING'] as const) {
    await prisma.orgModule.create({ data: { organizationId: org.organizationId, module: m, enabled: true, enabledAt: new Date('2026-01-01T00:00:00Z'), contractRef: 'TEST-S10', reason: 'องค์กรทดสอบจัดหา' } })
  }
  // the member "auditor" holds AUDITOR: sourcing.view at ORG (the shared test organization gives roles to procurement only)
  await prisma.roleAssignment.create({ data: { organizationId: org.organizationId, memberId: org.member.auditor!, role: 'AUDITOR', grantedAt: new Date('2026-01-01T00:00:00Z') } })
  const settings = (await prisma.organization.findUniqueOrThrow({ where: { id: org.organizationId } })).settings as Record<string, unknown>
  await prisma.organization.update({ where: { id: org.organizationId }, data: { settings: { ...settings, sourcing: { allowVatInclusiveBids: true } } } })
}, 120_000)

const as = (code: string, now = AFTER) => org.ctxOf(code, now)
const proc = (now = MON) => as('proc_officer', now)
const version = async (id: string) => (await prisma.rfxEvent.findUniqueOrThrow({ where: { id } })).version
const cardOf = async (rfxEventId: string) => prisma.scorecard.findFirstOrThrow({ where: { rfxEventId } })

async function party(name: string) {
  const s = await prisma.supplier.create({ data: { organizationId: org.organizationId, code: `S-${randomUUID().slice(0, 6)}`, nameTh: name, taxId: taxId(), isVatRegistered: true, branchCode: '00000', portalEnabled: true } })
  const contact = await prisma.supplierContact.create({ data: { organizationId: org.organizationId, supplierId: s.id, nameTh: `ติดต่อ ${name}`, email: `s-${randomUUID().slice(0, 8)}@supplier.test`, isPrimary: true } })
  return { supplier: s, ctx: () => portalCtx(org.organizationId, contact, MON) }
}

/** Scene 9: an RFQ of 8 and 5 tonnes, three bids sent, closed; evaluators as given (default dm_proc and dm_it) */
async function scene(options: { evaluators?: string[]; criteria?: typeof CRITERIA; close?: boolean } = {}) {
  const { rfxEventId } = ok(
    await createRfx(proc(), { kind: 'RFQ', title: 'เหล็กข้ออ้อย DB12', description: 'ขอราคา', allowVatInclusiveBids: true, source: { kind: 'NEED', categoryCode: 'STEEL', lines: [{ description: 'DB12 ไซต์ 1', quantity: '8', uom: 'ตัน', refUnitPrice: '23800.00' }, { description: 'DB12 ไซต์ 9', quantity: '5', uom: 'ตัน', refUnitPrice: '23800.00' }] } }, key()),
  )
  const parties = []
  for (const s of SCENE_9) parties.push({ ...s, ...(await party(s.name)) })
  for (const p of parties) ok(await inviteToRfx(proc(), { rfxEventId, expectedVersion: await version(rfxEventId), supplierId: p.supplier.id }, key()))
  const evaluators = (options.evaluators ?? ['dm_proc', 'dm_it']).map((c) => org.member[c]!)
  ok(await setScorecard(proc(), { rfxEventId, expectedVersion: await version(rfxEventId), criteria: options.criteria ?? CRITERIA, evaluatorMemberIds: evaluators }, key()))
  ok(await openRfx(proc(), { rfxEventId, expectedVersion: await version(rfxEventId), closesAt: CLOSES }, key()))
  const lines = (await prisma.rfxLine.findMany({ where: { rfxEventId }, orderBy: { lineNo: 'asc' } })).map((l) => l.id)
  const bids: string[] = []
  for (const p of parties) {
    bids.push(ok(await submitBid(p.ctx(), { rfxEventId, priceIncludesVat: p.priceIncludesVat, lines: lines.map((rfxLineId) => ({ rfxLineId, offered: true, unitPrice: p.unit })) }, key())).bidId)
  }
  if (options.close !== false) await closeRfxAt(org.organizationId, rfxEventId, CLOSES, AFTER)
  return { rfxEventId, bids, parties }
}

/** The scores of one evaluator (index 0 or 1 of each pair of scene 9) on every bid */
const scoresOf = (bids: string[], i: 0 | 1) => bids.flatMap((bidId, b) => (['DELIVERY', 'QUALITY'] as const).map((criterionCode) => ({ bidId, criterionCode, score: SCENE_9[b]![criterionCode][i] })))

describe('[FR-SRC-203/AC3] [GC-SRC-08] scene 9 scored by two evaluators reveals 95.38 · 95.11 · 89.57 at the last send', () => {
  it('the amounts of the bids are those of the golden; the first save moves the RFx to EVALUATING; the last send reveals and tells procurement', async () => {
    const { rfxEventId, bids } = await scene()
    expect((await prisma.bid.findMany({ where: { id: { in: bids } } })).map((b) => [bids.indexOf(b.id), b.netSatang]).sort()).toEqual([
      [0, 30095000n],
      [1, 30550000n],
      [2, 30373832n],
    ])
    ok(await saveScores(as('dm_proc'), { rfxEventId, entries: scoresOf(bids, 0) }, key()))
    expect((await prisma.rfxEvent.findUniqueOrThrow({ where: { id: rfxEventId } })).status).toBe('EVALUATING')
    expect(ok(await submitScores(as('dm_proc'), { rfxEventId }, key()))).toEqual({ revealed: false })
    expect(ok(await submitScores(as('dm_it'), { rfxEventId, entries: scoresOf(bids, 1) }, key()))).toEqual({ revealed: true })
    const card = await cardOf(rfxEventId)
    expect(card).toMatchObject({ status: 'REVEALED', revealedAt: AFTER })
    const revealed = await prisma.event.findFirstOrThrow({ where: { organizationId: org.organizationId, aggregateId: card.id, type: 'scorecard.revealed' } })
    expect(revealed.data).toMatchObject({ rfxEventId, priceOnly: false, ranking: [{ bidId: bids[0], totalBp: 9538 }, { bidId: bids[1], totalBp: 9511 }, { bidId: bids[2], totalBp: 8957 }] })
    const sheet = ok(await scoreSheet(as('proc_officer'), rfxEventId))
    expect(sheet.ranking!.map((r) => [r.rank, r.priceBp, r.criteria, r.totalBp])).toEqual([
      [1, 10000, { DELIVERY: 8750, QUALITY: 9000 }, 9538],
      [2, 9851, { DELIVERY: 9000, QUALITY: 9000 }, 9511],
      [3, 9908, { DELIVERY: 7250, QUALITY: 8000 }, 8957],
    ])
    expect(await prisma.notification.count({ where: { organizationId: org.organizationId, recipientMemberId: org.member.proc_officer!, templateKey: 'rfx.scored' } })).toBe(1)
    // the events of a score carry no score before the reveal
    const sent = await prisma.event.findMany({ where: { organizationId: org.organizationId, aggregateId: card.id, type: { in: ['score.saved', 'score.submitted'] } } })
    expect(sent.every((e) => !JSON.stringify(e.data).includes('"score"'))).toBe(true)
  })

  it('two evaluators who send at once reveal once (the Scorecard row is locked before the count)', async () => {
    const { rfxEventId, bids } = await scene()
    const [a, b] = await Promise.all([submitScores(as('dm_proc'), { rfxEventId, entries: scoresOf(bids, 0) }, key()), submitScores(as('dm_it'), { rfxEventId, entries: scoresOf(bids, 1) }, key())])
    expect([ok(a).revealed, ok(b).revealed].sort()).toEqual([false, true])
    const card = await cardOf(rfxEventId)
    expect(await prisma.event.count({ where: { organizationId: org.organizationId, aggregateId: card.id, type: 'scorecard.revealed' } })).toBe(1)
  })
})

describe('[FR-SRC-203/AC2] scores are given on their own, complete, once', () => {
  it('nothing before the close; the price is computed; another evaluator\'s scores are read only once revealed; incomplete is refused; a sent score never changes', async () => {
    const open = await scene({ close: false })
    expect(await saveScores(as('dm_proc', MON), { rfxEventId: open.rfxEventId, entries: [] }, key())).toMatchObject({ ok: false, error: { code: 'INVALID_STATE_TRANSITION' } })
    const { rfxEventId, bids } = await scene()
    expect(await saveScores(as('dm_proc'), { rfxEventId, entries: [{ bidId: bids[0]!, criterionCode: 'PRICE', score: 90 }] }, key())).toMatchObject({ ok: false, error: { details: { reason: 'PRICE_IS_COMPUTED' } } })
    expect(await saveScores(as('dm_proc'), { rfxEventId, entries: [{ bidId: bids[0]!, criterionCode: 'DELIVERY', score: 101 }] }, key())).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED' } })
    ok(await saveScores(as('dm_proc'), { rfxEventId, entries: scoresOf(bids, 0).slice(0, 4) }, key()))
    expect(await submitScores(as('dm_proc'), { rfxEventId }, key())).toMatchObject({ ok: false, error: { code: 'SCORES_INCOMPLETE', details: { missing: 2 } } })
    // the evaluator reads their own draft; another evaluator, and an auditor, may not before the reveal
    expect(ok(await scoreEntriesOf(as('dm_proc'), { rfxEventId, evaluatorMemberId: org.member.dm_proc! }))).toHaveLength(4)
    expect(await scoreEntriesOf(as('dm_it'), { rfxEventId, evaluatorMemberId: org.member.dm_proc! })).toMatchObject({ ok: false, error: { code: 'FORBIDDEN', details: { reason: 'NOT_REVEALED' } } })
    expect(await scoreEntriesOf(as('auditor'), { rfxEventId, evaluatorMemberId: org.member.dm_proc! })).toMatchObject({ ok: false, error: { code: 'FORBIDDEN', details: { reason: 'NOT_REVEALED' } } })
    const sheet = ok(await scoreSheet(as('dm_it'), rfxEventId))
    expect(sheet).toMatchObject({ me: { status: 'ASSIGNED', entries: [] }, ranking: null })
    ok(await submitScores(as('dm_proc'), { rfxEventId, entries: scoresOf(bids, 0) }, key()))
    expect(await saveScores(as('dm_proc'), { rfxEventId, entries: scoresOf(bids, 1) }, key())).toMatchObject({ ok: false, error: { code: 'INVALID_STATE_TRANSITION', details: { from: 'SUBMITTED' } } })
    ok(await submitScores(as('dm_it'), { rfxEventId, entries: scoresOf(bids, 1) }, key()))
    expect(ok(await scoreEntriesOf(as('dm_it'), { rfxEventId, evaluatorMemberId: org.member.dm_proc! }))).toHaveLength(6)
  })

  it('[sourcing.score] a member who is not an evaluator of the scorecard is refused, whatever else they may do', async () => {
    const { rfxEventId, bids } = await scene()
    for (const code of ['auditor', 'proc_officer', 'vp_sup']) {
      expect(await saveScores(as(code), { rfxEventId, entries: scoresOf(bids, 0) }, key())).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
      expect(await recuseEvaluator(as(code), { rfxEventId, reason: 'ไม่เกี่ยวข้อง' }, key())).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    }
    expect(await assignEvaluators(as('dm_proc'), { rfxEventId, expectedVersion: (await cardOf(rfxEventId)).version, memberIds: [org.member.vp_sup!], reason: 'เพิ่มผู้ประเมิน' }, key())).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    // a save of nothing records nothing (review 4)
    expect(await saveScores(as('dm_proc'), { rfxEventId, entries: [] }, key())).toMatchObject({ ok: false, error: { details: { reason: 'EMPTY' } } })
    expect((await prisma.rfxEvent.findUniqueOrThrow({ where: { id: rfxEventId } })).status).toBe('CLOSED')
  })

  it('[sourcing.view] a member who neither runs, audits nor evaluates the RFx reads none of its bids, scores or ranking (review 1 2)', async () => {
    const { rfxEventId, bids } = await scene()
    ok(await submitScores(as('dm_proc'), { rfxEventId, entries: scoresOf(bids, 0) }, key()))
    ok(await submitScores(as('dm_it'), { rfxEventId, entries: scoresOf(bids, 1) }, key()))
    expect((await cardOf(rfxEventId)).status).toBe('REVEALED')
    // req_con: an employee, no ORG role of sourcing.view, not an evaluator, not a requester of this RFx's lines
    expect(await scoreSheet(as('req_con'), rfxEventId)).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    expect(await scoreEntriesOf(as('req_con'), { rfxEventId, evaluatorMemberId: org.member.dm_proc! })).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    expect(await bidForMember(as('req_con'), bids[0]!)).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    // the auditor (ORG) and an evaluator (ASSIGNED) still read them
    expect(ok(await scoreSheet(as('auditor'), rfxEventId)).ranking).toHaveLength(3)
    expect(ok(await bidForMember(as('dm_it'), bids[0]!)).net).toBe('300950.00')
  })
})

describe('[FR-SRC-203/AC1] [BR-SOD-14] [GC-SOD-20] who may score, evaluators added after the close and one who steps aside', () => {
  it('the RFx\'s creator and the requester of a source line may not be added (the refusal kept); after the close a reason is needed and kept', async () => {
    const { rfxEventId, bids } = await scene()
    const card = await cardOf(rfxEventId)
    const creator = await assignEvaluators(proc(AFTER), { rfxEventId, expectedVersion: card.version, memberIds: [org.member.proc_officer!], reason: 'จัดซื้อให้คะแนนเอง' }, key())
    expect(creator).toMatchObject({ ok: false, error: { code: 'SOD_VIOLATION', details: { rule: 'BR-SOD-14' } } })
    expect(await prisma.event.count({ where: { organizationId: org.organizationId, type: 'security.sod_blocked', aggregateId: rfxEventId, data: { path: ['action'], equals: 'scorecard.assignEvaluators' } } })).toBe(1)
    expect(await assignEvaluators(proc(AFTER), { rfxEventId, expectedVersion: card.version, memberIds: [org.member.vp_sup!] }, key())).toMatchObject({ ok: false, error: { details: { reason: 'REASON_REQUIRED' } } })
    expect(await assignEvaluators(proc(AFTER), { rfxEventId, expectedVersion: card.version, memberIds: [org.member.dm_it!], reason: 'ซ้ำ' }, key())).toMatchObject({ ok: false, error: { details: { reason: 'ALREADY_EVALUATOR' } } })
    ok(await assignEvaluators(proc(AFTER), { rfxEventId, expectedVersion: card.version, memberIds: [org.member.vp_sup!], reason: 'ผู้ใช้งานหน้างานช่วยประเมินคุณภาพ' }, key()))
    const added = await prisma.event.findFirstOrThrow({ where: { organizationId: org.organizationId, aggregateId: card.id, type: 'scorecard.evaluator_added' } })
    expect(added.data).toMatchObject({ rfxEventId, memberIds: [org.member.vp_sup], afterClose: true, reasonCommentId: expect.any(String) })
    expect(await prisma.notification.count({ where: { organizationId: org.organizationId, recipientMemberId: org.member.vp_sup!, templateKey: 'rfx.closed_internal' } })).toBe(1)
    // three evaluators: the first two send, the third steps aside with a reason → the scores of two reveal
    ok(await submitScores(as('dm_proc'), { rfxEventId, entries: scoresOf(bids, 0) }, key()))
    ok(await submitScores(as('dm_it'), { rfxEventId, entries: scoresOf(bids, 1) }, key()))
    expect((await cardOf(rfxEventId)).status).toBe('LOCKED')
    expect(await recuseEvaluator(as('vp_sup'), { rfxEventId, reason: 'ab' }, key())).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED' } })
    expect(ok(await recuseEvaluator(as('vp_sup'), { rfxEventId, reason: 'เคยทำงานกับผู้ขายรายหนึ่ง' }, key()))).toEqual({ revealed: true })
    expect(await prisma.scorecardEvaluator.findFirstOrThrow({ where: { scorecardId: card.id, memberId: org.member.vp_sup! } })).toMatchObject({ status: 'RECUSED', declaredInterest: true })
  })

  it('one evaluator stepping aside below minEvaluators keeps the scorecard closed until procurement adds another', async () => {
    const { rfxEventId, bids } = await scene()
    ok(await recuseEvaluator(as('dm_it'), { rfxEventId, reason: 'ญาติเป็นพนักงานผู้ขาย' }, key()))
    expect(ok(await submitScores(as('dm_proc'), { rfxEventId, entries: scoresOf(bids, 0) }, key()))).toEqual({ revealed: false })
    ok(await assignEvaluators(proc(AFTER), { rfxEventId, expectedVersion: (await cardOf(rfxEventId)).version, memberIds: [org.member.vp_sup!], reason: 'แทนผู้ประเมินที่ถอนตัว' }, key()))
    expect(ok(await submitScores(as('vp_sup'), { rfxEventId, entries: scoresOf(bids, 1) }, key()))).toEqual({ revealed: true })
  })
})

describe('[FR-SRC-203/AC5] [FR-SRC-203/AC6] a price-only RFQ at its close; a disqualification after the reveal', () => {
  it('price only: revealed at the close with its ranking, no evaluator', async () => {
    const { rfxEventId, bids } = await scene({ evaluators: [], criteria: [{ code: 'PRICE', nameTh: 'ราคา', weightBp: 10000, kind: 'PRICE' }] as never })
    const card = await cardOf(rfxEventId)
    expect(card.status).toBe('REVEALED')
    const e = await prisma.event.findFirstOrThrow({ where: { organizationId: org.organizationId, aggregateId: card.id, type: 'scorecard.revealed' } })
    expect(e.data).toMatchObject({ priceOnly: true, ranking: [{ bidId: bids[0], totalBp: 10000 }, { bidId: bids[2], totalBp: 9908 }, { bidId: bids[1], totalBp: 9851 }] })
  })

  it('disqualified after the reveal: the ranking is computed again without it, and the first stays in the event of the reveal', async () => {
    const { rfxEventId, bids } = await scene()
    ok(await submitScores(as('dm_proc'), { rfxEventId, entries: scoresOf(bids, 0) }, key()))
    ok(await submitScores(as('dm_it'), { rfxEventId, entries: scoresOf(bids, 1) }, key()))
    ok(await disqualifyBid(proc(AFTER), { bidId: bids[0]!, reason: 'เอกสารประกอบไม่ครบตามเงื่อนไข' }, key()))
    const card = await cardOf(rfxEventId)
    const recomputed = await prisma.event.findFirstOrThrow({ where: { organizationId: org.organizationId, aggregateId: card.id, type: 'scorecard.recomputed' } })
    // without SP0023 the lowest is SP0024 (303,738.32): SP0029 price 9942 → 9565 · SP0024 10000 → 9012.5 → 9013
    expect(recomputed.data).toMatchObject({ bidId: bids[0], reason: 'DISQUALIFIED', ranking: [{ bidId: bids[1] }, { bidId: bids[2] }] })
    expect((recomputed.data as { ranking: Array<{ totalBp: number }> }).ranking.map((r) => r.totalBp)).toEqual([9565, 9013])
    const revealed = await prisma.event.findFirstOrThrow({ where: { organizationId: org.organizationId, aggregateId: card.id, type: 'scorecard.revealed' } })
    expect((revealed.data as { ranking: unknown[] }).ranking).toHaveLength(3)
    expect(ok(await scoreSheet(as('auditor'), rfxEventId)).ranking!.map((r) => r.bidId)).toEqual([bids[1], bids[2]])
  })
})
