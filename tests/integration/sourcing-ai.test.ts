import { randomUUID } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { setAiClientForTests, type AiClient, type AiRequest } from '@/integrations/ai'
import { PROMPT_VERSIONS, type AiPurposeName } from '@/lib/ai-config'
import { prisma } from '@/server/db/client'
import { setDefaultOutboxSender } from '@/server/events/outbox'
import { rfxAiSummaryRun } from '@/server/jobs/rfx-ai-summary'
import { portalCtx } from '@/server/portal/session'
import { systemCtx } from '@/server/context'
import { draftRfx, giveAgentFeedback, requestAgentAction, rfxDraftAiOf, rfxSummariesOf, runMonthlyGrant, setAiRuntimeForTests, summarizeRfx, updateAgentSetting, writeSummaryAhead, type AiRuntime } from '@/server/services/ai'
import { closeRfxAt, createRfx, inviteToRfx, openRfx, setScorecard, submitBid, updateRfx } from '@/server/services/sourcing'
import type { DoaOrg } from '../support/doa-org'
import { createP2Org } from '../support/p2-org'

// S10-16 (FR-AI-305 · ADR-209 · BR-AI-31 BR-AI-32) on real Postgres, with a fake client that records what it was sent:
// RFX_DRAFT puts the words of a draft RFx into it through rfx.update + aiAssist, the kind by code and each line's English
// confirmed one by one, rfx.open waiting until then (AC1); BID_SUMMARY and NEGOTIATION_POINTS after the close only, for a
// reader of the prices, from facts with numbers and codes only, checked by BR-AI-27 profile SOURCING (AC2 AC3); the
// AgentAction, credits, feedback and the summary written ahead by the job (AC4); with the AI off nothing shows (AC6).

const MON = new Date('2026-11-02T02:00:00Z')
const CLOSES = '2026-11-05T10:00:00Z'
const AFTER = new Date('2026-11-05T10:00:00Z')
const FIXTURE: AiRuntime = { enabled: true, mode: 'fixture', appEnv: 'local', modelEnv: {}, gates: [] }
const key = () => ({ idempotencyKey: randomUUID(), sender: null })
const ok = <T,>(r: { ok: true; data: T } | { ok: false; error: unknown }): T => {
  if (!r.ok) throw new Error(JSON.stringify(r.error))
  return r.data
}

/** What the AI was sent, and what it answers per purpose (null: it refuses) */
const sent: Array<{ purpose: AiPurposeName; text: string }> = []
let reply: (purpose: AiPurposeName, text: string) => unknown = () => null
const fake: AiClient = {
  mode: 'fixture',
  extract: (r) => call(r),
  write: (r) => call(r),
}
async function call<T>(r: AiRequest<T>) {
  sent.push({ purpose: r.purpose, text: r.text ?? '' })
  const base = { promptVersion: PROMPT_VERSIONS[r.purpose], model: r.model, usage: { input: 1200, output: 300, cacheRead: 0, cacheWrite: 0 }, latencyMs: 5 }
  const out = reply(r.purpose, r.text ?? '')
  if (out === null) return { ...base, ok: false as const, errorCode: 'AI_REFUSED' as const }
  const parsed = r.schema.safeParse(out)
  return parsed.success ? { ...base, ok: true as const, output: parsed.data } : { ...base, ok: false as const, errorCode: 'AI_OUTPUT_INVALID' as const }
}

const DRAFT = {
  title: 'จัดซื้อเหล็กข้ออ้อย DB12',
  titleEn: 'Deformed bar DB12',
  description: 'ขอใบเสนอราคาเหล็กข้ออ้อย DB12 ตามบรรทัด เสนอราคาเป็นบาทต่อบรรทัด',
  descriptionEn: 'Quotation for deformed bar DB12 per line, in Thai baht',
  lines: [
    { lineNo: 1, descriptionEn: 'Deformed bar DB12, site 1', uomEn: 'tonne' },
    { lineNo: 2, descriptionEn: 'Deformed bar DB12, site 9', uomEn: 'tonne' },
  ],
}
const SUMMARY = { sentences: ['ยื่น {{v:bidCount}} ราย ต่ำสุด {{v:lowest.supplierName}} ที่ {{v:lowest.net}} บาท สูงสุดห่าง {{v:spreadBp}} bp', 'มีใบรวม VAT {{v:vatInclusiveCount}} ใบ ระบบปรับเป็นก่อน VAT แล้ว'] }
const POINTS = { sentences: ['สอบถาม {{v:highest.supplierName}} ว่ายืนราคาที่ {{v:lowest.net}} บาทได้หรือไม่'] }

let org: DoaOrg
let seq = 900
function taxId(): string {
  const body = `01055${String(seq++).padStart(7, '0')}`
  const sum = [...body].reduce((a, d, i) => a + Number(d) * (13 - i), 0)
  return body + String((11 - (sum % 11)) % 10)
}

beforeAll(async () => {
  setDefaultOutboxSender(null)
  org = await createP2Org()
  await prisma.orgModule.create({ data: { organizationId: org.organizationId, module: 'SOURCING', enabled: true, enabledAt: new Date('2026-01-01T00:00:00Z'), contractRef: 'TEST-S10', reason: 'องค์กรทดสอบจัดหา' } })
  await prisma.roleAssignment.createMany({
    data: [
      { organizationId: org.organizationId, memberId: org.member.admin!, role: 'ORG_ADMIN', grantedAt: MON },
      { organizationId: org.organizationId, memberId: org.member.auditor!, role: 'AUDITOR', grantedAt: MON },
    ],
    skipDuplicates: true,
  })
  const settings = (await prisma.organization.findUniqueOrThrow({ where: { id: org.organizationId } })).settings as Record<string, unknown>
  await prisma.organization.update({ where: { id: org.organizationId }, data: { settings: { ...settings, sourcing: { allowVatInclusiveBids: true } } } })
  setAiRuntimeForTests(FIXTURE)
  expect(await updateAgentSetting(org.ctxOf('admin', MON), { agent: 'SOURCING', enabled: true }, key())).toMatchObject({ ok: true })
  expect((await runMonthlyGrant(org.organizationId, MON)).ok).toBe(true)
  setAiClientForTests(fake)
})

afterEach(() => {
  setAiRuntimeForTests(FIXTURE)
  sent.length = 0
})

const proc = (now = MON) => org.ctxOf('proc_officer', now)
const version = async (id: string) => (await prisma.rfxEvent.findUniqueOrThrow({ where: { id } })).version

async function party(name: string, opts: { individual?: boolean } = {}) {
  const s = await prisma.supplier.create({ data: { organizationId: org.organizationId, code: `C-${randomUUID().slice(0, 6)}`, nameTh: name, taxId: taxId(), isVatRegistered: true, branchCode: '00000', portalEnabled: true, payeeType: opts.individual ? 'INDIVIDUAL' : 'JURISTIC' } })
  const contact = await prisma.supplierContact.create({ data: { organizationId: org.organizationId, supplierId: s.id, nameTh: `ติดต่อ ${name}`, email: `c-${randomUUID().slice(0, 8)}@supplier.test`, isPrimary: true } })
  return { supplier: s, contact, ctx: () => portalCtx(org.organizationId, contact, MON) }
}

/** A draft RFQ of 8 and 5 tonnes at a typed 23,800.00 (scene 9's lines), with nothing else yet */
async function draftRfq(kind: 'RFQ' | 'RFI' = 'RFQ') {
  const lines = [
    { description: 'DB12 ไซต์ 1', quantity: '8', uom: 'ตัน', refUnitPrice: '23800.00' },
    { description: 'DB12 ไซต์ 9', quantity: '5', uom: 'ตัน', refUnitPrice: '23800.00' },
  ]
  return ok(await createRfx(proc(), { kind, title: 'เหล็ก', description: 'ขอราคา', allowVatInclusiveBids: kind !== 'RFI', source: { kind: 'NEED', categoryCode: 'STEEL', lines } }, key())).rfxEventId
}

async function inviteAndScore(rfxEventId: string, parties: Array<Awaited<ReturnType<typeof party>>>) {
  for (const p of parties) ok(await inviteToRfx(proc(), { rfxEventId, expectedVersion: await version(rfxEventId), supplierId: p.supplier.id }, key()))
  ok(await setScorecard(proc(), { rfxEventId, expectedVersion: await version(rfxEventId), criteria: [{ code: 'PRICE', nameTh: 'ราคา', weightBp: 10000, kind: 'PRICE' }], evaluatorMemberIds: [] }, key()))
}
const open = async (rfxEventId: string, invites: number) =>
  openRfx(proc(), { rfxEventId, expectedVersion: await version(rfxEventId), closesAt: CLOSES, ...(invites < 3 ? { fewerInvitesReason: 'ผู้ขายในตลาดมีน้อยราย' } : {}) }, key())

/** Scene 9 closed: 23,150.00 · 23,500.00 · 25,000.00 with VAT, the brand and the note of a supplier, an individual */
async function closedScene() {
  const ps = [await party('บริษัท ชลบุรีภัณฑ์สตีล จำกัด'), await party('บริษัท สหมิตรเหล็ก จำกัด'), await party('นายสมชาย ใจดี', { individual: true })]
  const rfxEventId = await draftRfq()
  await inviteAndScore(rfxEventId, ps)
  ok(await open(rfxEventId, 3))
  const lines = (await prisma.rfxLine.findMany({ where: { rfxEventId }, orderBy: { lineNo: 'asc' } })).map((l) => l.id)
  const bid = (i: number, unit: string, vat = false, extra: { brand?: string; note?: string } = {}) =>
    submitBid(ps[i]!.ctx(), { rfxEventId, priceIncludesVat: vat, ...(extra.note ? { note: extra.note } : {}), lines: lines.map((rfxLineId) => ({ rfxLineId, offered: true, unitPrice: unit, ...(extra.brand ? { brand: extra.brand } : {}) })) }, key())
  ok(await bid(0, '23150.00', false, { brand: 'ตราช้างพิเศษ', note: 'โทรหาผม 081-234-5678' }))
  ok(await bid(1, '23500.00'))
  ok(await bid(2, '25000.00', true))
  return { rfxEventId, ps }
}

describe('[FR-AI-305/AC1] [BR-AI-31] the Sourcing Agent drafts the words of an RFx; procurement takes them in one by one', () => {
  it('the words go to the form only: kind by code, each line\'s English; no price, quantity or supplier is sent; rfx.open waits until every one is confirmed', async () => {
    const rfxEventId = await draftRfq()
    reply = (purpose) => (purpose === 'RFX_DRAFT' ? DRAFT : null)
    const d = ok(await draftRfx(proc(), { rfxEventId }, key()))
    expect(d.status).toBe('READY')
    // GC-AI-99's rule: goods with a reference price → RFQ; 13 × 23,800 + VAT > 100,000 → minInvites 3 (code, not the AI)
    expect(d.proposed).toEqual({
      kind: 'RFQ',
      title: DRAFT.title,
      titleEn: DRAFT.titleEn,
      description: DRAFT.description,
      descriptionEn: DRAFT.descriptionEn,
      'lines.1.descriptionEn': 'Deformed bar DB12, site 1',
      'lines.1.uomEn': 'tonne',
      'lines.2.descriptionEn': 'Deformed bar DB12, site 9',
      'lines.2.uomEn': 'tonne',
    })
    expect(d.requiredPaths).toEqual(['kind', 'lines.1.descriptionEn', 'lines.2.descriptionEn'])
    const text = sent.find((s) => s.purpose === 'RFX_DRAFT')!.text
    expect(text).toContain('DB12 ไซต์ 1')
    for (const hidden of ['23800', '23,800', ' 8 ', 'ตัน · 8']) expect(text).not.toContain(hidden)
    // nothing in the RFx yet: an L1 DRAFT on it, the form shows it again after a reload
    expect((await prisma.rfxEvent.findUniqueOrThrow({ where: { id: rfxEventId } })).title).toBe('เหล็ก')
    const shown = await rfxDraftAiOf(proc(), rfxEventId)
    expect(shown).toMatchObject({ available: true, applied: false, open: { agentActionId: d.agentActionId, purpose: 'RFX_DRAFT' } })

    // procurement saves the form: the words in, the kind and the lines' English not confirmed yet
    const lines = await prisma.rfxLine.findMany({ where: { rfxEventId }, orderBy: { lineNo: 'asc' } })
    ok(
      await updateRfx(
        proc(),
        {
          rfxEventId,
          expectedVersion: await version(rfxEventId),
          title: DRAFT.title,
          titleEn: DRAFT.titleEn,
          description: DRAFT.description,
          descriptionEn: DRAFT.descriptionEn,
          kind: 'RFQ',
          lines: lines.map((l, i) => ({ rfxLineId: l.id, descriptionEn: DRAFT.lines[i]!.descriptionEn, uomEn: 'tonne' })),
          aiAssist: { agentActionId: d.agentActionId, confirmedPaths: ['title', 'titleEn', 'description', 'descriptionEn', 'lines.1.uomEn', 'lines.2.uomEn'] },
        },
        key(),
      ),
    )
    expect(await prisma.agentAction.findUniqueOrThrow({ where: { id: d.agentActionId } })).toMatchObject({ status: 'DRAFT', subjectType: 'RFX_EVENT', subjectId: rfxEventId, appliedById: org.member.proc_officer })
    expect(await prisma.rfxLine.findMany({ where: { rfxEventId }, orderBy: { lineNo: 'asc' }, select: { descriptionEn: true, uomEn: true } })).toEqual(DRAFT.lines.map((l) => ({ descriptionEn: l.descriptionEn, uomEn: 'tonne' })))
    const ps = [await party('ผู้ขาย ก'), await party('ผู้ขาย ข'), await party('ผู้ขาย ค')]
    await inviteAndScore(rfxEventId, ps)
    expect(await open(rfxEventId, 3)).toMatchObject({ ok: false, error: { code: 'AI_REVIEW_PENDING', details: { count: 3 } } })

    // confirming one by one, nothing changed: the action is ACCEPTED and the RFx opens
    ok(await updateRfx(proc(), { rfxEventId, expectedVersion: await version(rfxEventId), aiAssist: { agentActionId: d.agentActionId, confirmedPaths: ['kind', 'lines.1.descriptionEn', 'lines.2.descriptionEn'] } }, key()))
    expect((await prisma.agentAction.findUniqueOrThrow({ where: { id: d.agentActionId } })).status).toBe('ACCEPTED')
    expect(await open(rfxEventId, 3)).toMatchObject({ ok: true })
  })

  it('an answer with a price in it is not the schema (AI_OUTPUT_INVALID): nothing is proposed; an RFI keeps its kind', async () => {
    const rfxEventId = await draftRfq()
    reply = () => ({ ...DRAFT, unitPrice: '23800.00' })
    const d = ok(await draftRfx(proc(), { rfxEventId }, key()))
    expect(d).toMatchObject({ status: 'FAILED', proposed: {} })
    expect((await prisma.agentAction.findUniqueOrThrow({ where: { id: d.agentActionId } })).errorCode).toBe('AI_OUTPUT_INVALID')

    const rfi = await draftRfq('RFI')
    reply = () => DRAFT
    const r = ok(await draftRfx(proc(), { rfxEventId: rfi }, key()))
    expect(Object.keys(r.proposed)).not.toContain('kind')
    expect(await updateRfx(proc(), { rfxEventId: rfi, expectedVersion: await version(rfi), kind: 'RFQ' }, key())).toMatchObject({ ok: false, error: { details: { reason: 'RFI_KIND_FIXED' } } })
  })

  it('[sourcing.manage] a requester may not draft an RFx; an open RFx is not drafted', async () => {
    const rfxEventId = await draftRfq()
    reply = () => DRAFT
    expect(await draftRfx(org.ctxOf('req_con', MON), { rfxEventId }, key())).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    expect(sent).toHaveLength(0)
  })
})

describe('[FR-AI-305/AC2] [BR-AI-32] [GC-AI-96] the summary of the bids, after the close, from code\'s facts', () => {
  it('sealed before the close (no call); after it the sentences come back with the facts\' values; the facts carry no supplier text, contact or individual\'s name', async () => {
    const { rfxEventId, ps } = await closedScene()
    reply = (purpose) => (purpose === 'BID_SUMMARY' ? SUMMARY : null)
    expect(await summarizeRfx(proc(MON), { rfxEventId, purpose: 'BID_SUMMARY' }, key())).toMatchObject({ ok: false, error: { code: 'INVALID_STATE_TRANSITION', details: { reason: 'NOT_CLOSED' } } })
    expect(await rfxSummariesOf(proc(MON), { id: rfxEventId, kind: 'RFQ', status: 'OPEN' })).toEqual({ available: false, summary: null, negotiation: null })
    expect(sent).toHaveLength(0)

    await closeRfxAt(org.organizationId, rfxEventId, CLOSES, AFTER)
    const s = ok(await summarizeRfx(proc(AFTER), { rfxEventId, purpose: 'BID_SUMMARY' }, key()))
    expect(s).toMatchObject({ status: 'READY', sentences: ['ยื่น 3 ราย ต่ำสุด บริษัท ชลบุรีภัณฑ์สตีล จำกัด ที่ 300,950.00 บาท สูงสุดห่าง 151 bp', 'มีใบรวม VAT 1 ใบ ระบบปรับเป็นก่อน VAT แล้ว'] })
    const text = sent.find((x) => x.purpose === 'BID_SUMMARY')!.text
    expect(text).toContain('spreadBp = 151')
    expect(text).toContain(`ผู้ขายบุคคลธรรมดา ${ps[2]!.supplier.code}`)
    for (const hidden of ['นายสมชาย', 'ตราช้างพิเศษ', '081-234-5678', 'DB12 ไซต์', ...ps.map((p) => p.contact.email)]) expect(text).not.toContain(hidden)
  })

  it('[GC-AI-97] [GC-AI-98] a number typed by the AI, or advice to award, throws the text away (FAILED); a requester is refused', async () => {
    const { rfxEventId } = await closedScene()
    await closeRfxAt(org.organizationId, rfxEventId, CLOSES, AFTER)
    reply = () => ({ sentences: ['รายเดิมสูงกว่าต่ำสุดราว 4,550 บาท'] })
    const a = ok(await summarizeRfx(proc(AFTER), { rfxEventId, purpose: 'BID_SUMMARY' }, key()))
    expect(a.status).toBe('FAILED')
    expect((await prisma.agentAction.findUniqueOrThrow({ where: { id: a.agentActionId } })).errorCode).toBe('AI_TEXT_DIGIT_OUTSIDE_PLACEHOLDER')
    reply = () => ({ sentences: ['ควรมอบงานให้ {{v:lowest.supplierName}}'] })
    const b = ok(await summarizeRfx(proc(AFTER), { rfxEventId, purpose: 'NEGOTIATION_POINTS' }, key()))
    expect(b.status).toBe('FAILED')
    expect((await prisma.agentAction.findUniqueOrThrow({ where: { id: b.agentActionId } })).errorCode).toBe('AI_TEXT_DECISION_ADVICE')
    expect(await summarizeRfx(org.ctxOf('req_con', AFTER), { rfxEventId, purpose: 'BID_SUMMARY' }, key())).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
  })
})

describe('[FR-AI-305/AC3] [BR-AI-01] points to negotiate are words only: nothing reaches a supplier, a bid, a score or an award', () => {
  it('the points come back; bids, scores, awards and the outbox to suppliers are as they were', async () => {
    const { rfxEventId } = await closedScene()
    await closeRfxAt(org.organizationId, rfxEventId, CLOSES, AFTER)
    const cardId = (await prisma.rfxEvent.findUniqueOrThrow({ where: { id: rfxEventId } })).scorecardId!
    const before = {
      bids: await prisma.bid.findMany({ where: { rfxEventId }, select: { id: true, status: true, netSatang: true, version: true } }),
      scores: await prisma.scoreEntry.count({ where: { scorecardId: cardId } }),
      awards: await prisma.awardDecision.count({ where: { rfxEventId } }),
      notices: await prisma.supplierNotice.count({ where: { organizationId: org.organizationId } }),
    }
    reply = () => POINTS
    const p = ok(await summarizeRfx(proc(AFTER), { rfxEventId, purpose: 'NEGOTIATION_POINTS' }, key()))
    // the highest complete bid is 305,500.00 (the one with VAT is 303,738.32 before VAT)
    expect(p).toMatchObject({ status: 'READY', sentences: ['สอบถาม บริษัท สหมิตรเหล็ก จำกัด ว่ายืนราคาที่ 300,950.00 บาทได้หรือไม่'] })
    expect({
      bids: await prisma.bid.findMany({ where: { rfxEventId }, select: { id: true, status: true, netSatang: true, version: true } }),
      scores: await prisma.scoreEntry.count({ where: { scorecardId: cardId } }),
      awards: await prisma.awardDecision.count({ where: { rfxEventId } }),
      notices: await prisma.supplierNotice.count({ where: { organizationId: org.organizationId } }),
    }).toEqual(before)
  })

  it('[INV-AI-05] the sourcing services never import the AI adapter or an agent', () => {
    const dir = path.resolve(import.meta.dirname, '..', '..', 'src', 'server', 'services', 'sourcing')
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.ts'))) {
      const source = readFileSync(path.join(dir, f), 'utf8')
      expect(source, f).not.toMatch(/@\/integrations\/ai|services\/ai\/agents|from '\.\.\/ai'|from '\.\.\/ai\/index'/)
    }
  })
})

describe('[FR-AI-305/AC4] AgentAction, credits, feedback and the summary written ahead', () => {
  it('ids as inputRefs, no copied text, credits of the organization; the job writes ahead and the button uses it without a new call; feedback from another reader of the prices', async () => {
    const { rfxEventId } = await closedScene()
    await closeRfxAt(org.organizationId, rfxEventId, CLOSES, AFTER)
    reply = (purpose) => (purpose === 'BID_SUMMARY' ? SUMMARY : null)
    expect(await rfxAiSummaryRun({ name: 'bcs/rfx.closed', data: { organizationId: org.organizationId, aggregateId: rfxEventId } }, { run: (_id, fn) => fn() })).toBe('WRITTEN')
    expect(await writeSummaryAhead(org.organizationId, rfxEventId, 'CLOSED', AFTER)).toBe('SKIPPED_WRITTEN')
    const ahead = await prisma.agentAction.findFirstOrThrow({ where: { subjectId: rfxEventId, purpose: 'BID_SUMMARY' } })
    expect(ahead).toMatchObject({ agent: 'SOURCING', level: 'L0', status: 'DRAFT', subjectType: 'RFX_EVENT', requestedById: null, inputText: null, inputRefs: { rfxEventId, trigger: 'CLOSED' } })
    expect(ahead.costCredits).toBeGreaterThan(0)
    expect(await prisma.aiCreditLedger.count({ where: { agentActionId: ahead.id, kind: 'USE' } })).toBe(1)

    const calls = sent.length
    const s = ok(await summarizeRfx(proc(AFTER), { rfxEventId, purpose: 'BID_SUMMARY' }, key()))
    expect(s.agentActionId).toBe(ahead.id)
    expect(sent).toHaveLength(calls)
    expect(await rfxSummariesOf(org.ctxOf('auditor', AFTER), { id: rfxEventId, kind: 'RFQ', status: 'CLOSED' })).toMatchObject({ available: true, summary: { agentActionId: ahead.id }, negotiation: null })

    ok(await giveAgentFeedback(org.ctxOf('auditor', AFTER), { agentActionId: ahead.id, feedback: 'HELPFUL' }, key()))
    expect((await prisma.agentAction.findUniqueOrThrow({ where: { id: ahead.id } })).feedback).toBe('HELPFUL')
    expect(await giveAgentFeedback(org.ctxOf('req_con', AFTER), { agentActionId: ahead.id, feedback: 'HELPFUL' }, key())).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    expect(await rfxSummariesOf(org.ctxOf('auditor', AFTER), { id: rfxEventId, kind: 'RFQ', status: 'CLOSED' })).toMatchObject({ summary: { feedback: 'HELPFUL' } })
  })
})

describe('[FR-AI-305/AC6] [EG-1] with the AI off, no button and nothing written before; sourcing works as before', () => {
  it('AI_ENABLED false, the agent off, or sourcing.aiAssist N: nothing shown, no call; the RFx opens and closes by hand', async () => {
    const { rfxEventId } = await closedScene()
    await closeRfxAt(org.organizationId, rfxEventId, CLOSES, AFTER)
    reply = () => SUMMARY
    ok(await summarizeRfx(proc(AFTER), { rfxEventId, purpose: 'BID_SUMMARY' }, key()))
    const calls = sent.length

    setAiRuntimeForTests({ ...FIXTURE, enabled: false })
    expect(await rfxSummariesOf(proc(AFTER), { id: rfxEventId, kind: 'RFQ', status: 'CLOSED' })).toEqual({ available: false, summary: null, negotiation: null })
    expect(await summarizeRfx(proc(AFTER), { rfxEventId, purpose: 'NEGOTIATION_POINTS' }, key())).toMatchObject({ ok: false, error: { code: 'AI_AGENT_DISABLED' } })
    const draft = await draftRfq()
    expect(await rfxDraftAiOf(proc(), draft)).toEqual({ available: false, open: null, applied: false })
    expect(await draftRfx(proc(), { rfxEventId: draft }, key())).toMatchObject({ ok: false, error: { code: 'AI_AGENT_DISABLED' } })
    expect(await writeSummaryAhead(org.organizationId, rfxEventId, 'REVEALED', AFTER)).toMatch(/^SKIPPED_/)
    setAiRuntimeForTests(FIXTURE)

    const settings = (await prisma.organization.findUniqueOrThrow({ where: { id: org.organizationId } })).settings as Record<string, Record<string, unknown>>
    await prisma.organization.update({ where: { id: org.organizationId }, data: { settings: { ...settings, sourcing: { ...settings.sourcing, aiAssist: false } } as object } })
    try {
      expect(await rfxSummariesOf(proc(AFTER), { id: rfxEventId, kind: 'RFQ', status: 'CLOSED' })).toEqual({ available: false, summary: null, negotiation: null })
      expect((await rfxDraftAiOf(proc(), draft)).available).toBe(false)
      expect(await draftRfx(proc(), { rfxEventId: draft }, key())).toMatchObject({ ok: false, error: { code: 'AI_AGENT_DISABLED', details: { reason: 'AI_ASSIST_OFF' } } })
    } finally {
      await prisma.organization.update({ where: { id: org.organizationId }, data: { settings: settings as object } })
    }
    expect(sent).toHaveLength(calls)

    // by hand: the draft opens with nothing of the AI in it
    const ps = [await party('มือ ก'), await party('มือ ข'), await party('มือ ค')]
    await inviteAndScore(draft, ps)
    expect(await open(draft, 3)).toMatchObject({ ok: true })
  })
})

/** An hour after every row the tests above wrote: the limit of 10 calls a minute counts each test's own calls only */
const LATE = (hour: number) => new Date(Date.UTC(2026, 10, 20, hour))

describe('[FR-AI-305/AC1] [FR-AI-305/AC6] review of S10-16: the draft in the form', () => {
  /** Saves the AI's words without confirming the kind or the lines' English: the draft is taken in, three fields wait */
  async function takeInWaiting(rfxEventId: string, agentActionId: string) {
    const lines = await prisma.rfxLine.findMany({ where: { rfxEventId }, orderBy: { lineNo: 'asc' } })
    ok(
      await updateRfx(
        proc(),
        {
          rfxEventId,
          expectedVersion: await version(rfxEventId),
          title: DRAFT.title,
          titleEn: DRAFT.titleEn,
          description: DRAFT.description,
          descriptionEn: DRAFT.descriptionEn,
          kind: 'RFQ',
          lines: lines.map((l, i) => ({ rfxLineId: l.id, descriptionEn: DRAFT.lines[i]!.descriptionEn, uomEn: 'tonne' })),
          aiAssist: { agentActionId, confirmedPaths: ['title', 'titleEn', 'description', 'descriptionEn', 'lines.1.uomEn', 'lines.2.uomEn'] },
        },
        key(),
      ),
    )
  }

  it('[EG-1] a draft nobody took in is not shown while AI is off; one taken in whose fields wait still is (rfx.open counts it)', async () => {
    const rfxEventId = await draftRfq()
    reply = (purpose) => (purpose === 'RFX_DRAFT' ? DRAFT : null)
    const d = ok(await draftRfx(proc(LATE(1)), { rfxEventId }, key()))
    setAiRuntimeForTests({ ...FIXTURE, enabled: false })
    expect(await rfxDraftAiOf(proc(LATE(1)), rfxEventId)).toEqual({ available: false, open: null, applied: false })
    setAiRuntimeForTests(FIXTURE)
    await takeInWaiting(rfxEventId, d.agentActionId)
    setAiRuntimeForTests({ ...FIXTURE, enabled: false })
    expect(await rfxDraftAiOf(proc(LATE(1)), rfxEventId)).toMatchObject({ available: false, applied: true, open: { agentActionId: d.agentActionId, pendingPaths: ['kind', 'lines.1.descriptionEn', 'lines.2.descriptionEn'] } })
  })

  it('[BR-AI-17] a new draft waits until the fields of the one taken in are confirmed: no call, no credits (AI_REVIEW_PENDING)', async () => {
    const rfxEventId = await draftRfq()
    reply = (purpose) => (purpose === 'RFX_DRAFT' ? DRAFT : null)
    const d = ok(await draftRfx(proc(LATE(2)), { rfxEventId }, key()))
    await takeInWaiting(rfxEventId, d.agentActionId)
    const calls = sent.length
    expect(await draftRfx(proc(LATE(2)), { rfxEventId }, key())).toMatchObject({ ok: false, error: { code: 'AI_REVIEW_PENDING', details: { count: 3 } } })
    expect(sent).toHaveLength(calls)
    expect(await rfxDraftAiOf(proc(LATE(2)), rfxEventId)).toMatchObject({ applied: true, open: { agentActionId: d.agentActionId } })
  })

  it('a draft that failed leaves the earlier one in the form; a ready one replaces it', async () => {
    const rfxEventId = await draftRfq()
    reply = (purpose) => (purpose === 'RFX_DRAFT' ? DRAFT : null)
    const a = ok(await draftRfx(proc(LATE(3)), { rfxEventId }, key()))
    reply = () => null
    expect(ok(await draftRfx(proc(LATE(3)), { rfxEventId }, key())).status).toBe('FAILED')
    expect((await prisma.agentAction.findUniqueOrThrow({ where: { id: a.agentActionId } })).status).toBe('DRAFT')
    expect(await rfxDraftAiOf(proc(LATE(3)), rfxEventId)).toMatchObject({ applied: false, open: { agentActionId: a.agentActionId } })
    reply = (purpose) => (purpose === 'RFX_DRAFT' ? DRAFT : null)
    const c = ok(await draftRfx(proc(LATE(3)), { rfxEventId }, key()))
    expect((await prisma.agentAction.findUniqueOrThrow({ where: { id: a.agentActionId } })).status).toBe('EXPIRED')
    expect(await rfxDraftAiOf(proc(LATE(3)), rfxEventId)).toMatchObject({ applied: false, open: { agentActionId: c.agentActionId } })
  })
})

describe('[FR-AI-305/AC2] [FR-AI-305/AC4] [FR-AI-305/AC6] review of S10-16: the summary', () => {
  it('[EG-1] a summary written before is not given back while AI or the agent is off', async () => {
    const { rfxEventId } = await closedScene()
    await closeRfxAt(org.organizationId, rfxEventId, CLOSES, AFTER)
    reply = (purpose) => (purpose === 'BID_SUMMARY' ? SUMMARY : null)
    ok(await summarizeRfx(proc(LATE(4)), { rfxEventId, purpose: 'BID_SUMMARY' }, key()))
    setAiRuntimeForTests({ ...FIXTURE, enabled: false })
    expect(await summarizeRfx(proc(LATE(4)), { rfxEventId, purpose: 'BID_SUMMARY' }, key())).toMatchObject({ ok: false, error: { code: 'AI_AGENT_DISABLED' } })
    setAiRuntimeForTests(FIXTURE)
    ok(await updateAgentSetting(org.ctxOf('admin', AFTER), { agent: 'SOURCING', enabled: false }, key()))
    try {
      expect(await summarizeRfx(proc(LATE(4)), { rfxEventId, purpose: 'BID_SUMMARY' }, key())).toMatchObject({ ok: false, error: { code: 'AI_AGENT_DISABLED' } })
    } finally {
      ok(await updateAgentSetting(org.ctxOf('admin', AFTER), { agent: 'SOURCING', enabled: true }, key()))
    }
  })

  it('fresh (the button over a text) calls again for the same facts; without it the text there comes back with what this member said of it', async () => {
    const { rfxEventId } = await closedScene()
    await closeRfxAt(org.organizationId, rfxEventId, CLOSES, AFTER)
    reply = (purpose) => (purpose === 'BID_SUMMARY' ? SUMMARY : null)
    const first = ok(await summarizeRfx(proc(LATE(5)), { rfxEventId, purpose: 'BID_SUMMARY' }, key()))
    ok(await giveAgentFeedback(proc(LATE(5)), { agentActionId: first.agentActionId, feedback: 'NOT_HELPFUL' }, key()))
    const calls = sent.length
    expect(ok(await summarizeRfx(proc(LATE(5)), { rfxEventId, purpose: 'BID_SUMMARY' }, key()))).toMatchObject({ agentActionId: first.agentActionId, feedback: 'NOT_HELPFUL' })
    expect(sent).toHaveLength(calls)
    const again = ok(await summarizeRfx(proc(LATE(5)), { rfxEventId, purpose: 'BID_SUMMARY', fresh: true }, key()))
    expect(again).toMatchObject({ status: 'READY', feedback: null })
    expect(again.agentActionId).not.toBe(first.agentActionId)
    expect(sent).toHaveLength(calls + 1)
  })

  it('the job finishes a call its earlier run started (PENDING); a run that failed stays FAILED without a second call', async () => {
    const one = await closedScene()
    await closeRfxAt(org.organizationId, one.rfxEventId, CLOSES, AFTER)
    reply = (purpose) => (purpose === 'BID_SUMMARY' ? SUMMARY : null)
    const ctx = systemCtx(org.organizationId, AFTER, 'rfx-ai-summary')
    const stopped = ok(await requestAgentAction(ctx, { purpose: 'BID_SUMMARY', subjectType: 'RFX_EVENT', subjectId: one.rfxEventId, inputRefs: { rfxEventId: one.rfxEventId, trigger: 'CLOSED' }, idempotencyKey: 'rfx_summary:' + one.rfxEventId + ':CLOSED' }, { idempotencyKey: 'rfx_summary:' + one.rfxEventId + ':CLOSED' }))
    expect(await writeSummaryAhead(org.organizationId, one.rfxEventId, 'CLOSED', AFTER)).toBe('WRITTEN')
    expect((await prisma.agentAction.findUniqueOrThrow({ where: { id: stopped.agentActionId } })).status).toBe('DRAFT')
    expect(await prisma.agentAction.count({ where: { subjectId: one.rfxEventId, purpose: 'BID_SUMMARY' } })).toBe(1)

    const two = await closedScene()
    await closeRfxAt(org.organizationId, two.rfxEventId, CLOSES, AFTER)
    reply = () => null
    expect(await writeSummaryAhead(org.organizationId, two.rfxEventId, 'CLOSED', AFTER)).toBe('FAILED')
    const calls = sent.length
    expect(await writeSummaryAhead(org.organizationId, two.rfxEventId, 'CLOSED', AFTER)).toBe('FAILED')
    expect(sent).toHaveLength(calls)
  })
})
