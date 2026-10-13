import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import type { EvalGate } from '@/lib/ai-config'
import { makeCtx, type Ctx } from '@/server/context'
import { prisma } from '@/server/db/client'
import {
  completeAgentAction,
  creditSummary,
  getAgentAction,
  giveAgentFeedback,
  grantCredits,
  isAgentAvailable,
  listAgentSettings,
  rejectAgentAction,
  requestAgentAction,
  runAgentActionSweep,
  runMonthlyGrant,
  setAiRuntimeForTests,
  updateAgentSetting,
  type AiRuntime,
} from '@/server/services/ai'
import { createP1Org, P1_MODULES } from '../support/p1-org'

// S13-02 (docs/sub-specs/S13.md "ฐานของโมดูล" AC1–AC4, BR-AI-04 BR-AI-05 BR-AI-09 BR-AI-11 BR-AI-18 BR-AI-23 BR-AI-24,
// INV-AI-01 INV-AI-02): AgentAction, agent settings, credits and the gates of every call, on a real database. Nothing
// here calls a model: the answer of a call is recorded the way an agent records it.

const NOW = new Date('2026-10-20T10:00:00+07:00')
const SONNET = 'claude-sonnet-5-5'
const run = { sender: null } as const
const key = () => ({ idempotencyKey: randomUUID(), ...run })
const FIXTURE: AiRuntime = { enabled: true, mode: 'fixture', appEnv: 'local', modelEnv: {}, gates: [] }

afterEach(() => setAiRuntimeForTests(null))

async function setup(options: { modules?: (typeof P1_MODULES)[number][]; agentsOn?: boolean; grant?: boolean } = {}) {
  setAiRuntimeForTests(FIXTURE)
  const org = await createP1Org(options.modules ? { modules: options.modules } : {})
  await prisma.roleAssignment.createMany({
    data: [
      { organizationId: org.organizationId, memberId: org.member.admin!, role: 'ORG_ADMIN', grantedAt: NOW },
      { organizationId: org.organizationId, memberId: org.member.auditor!, role: 'AUDITOR', grantedAt: NOW },
    ],
  })
  const platformAdmin = await prisma.platformAdmin.create({ data: { displayName: 'ทีม BCS', active: true } })
  const ctx = (code: string, now = NOW) => org.ctxOf(code, now)
  const platform = makeCtx({ organizationId: org.organizationId, actor: { type: 'PLATFORM_ADMIN', platformAdminId: platformAdmin.id }, channel: 'WEB', now: NOW })
  if (options.agentsOn !== false) {
    for (const agent of ["DOCUMENT", "INSIGHT"] as const) {
      const r = await updateAgentSetting(ctx("admin"), { agent, enabled: true }, key())
      expect(r.ok, JSON.stringify(r)).toBe(true)
    }
  }
  if (options.grant !== false && (options.modules ?? P1_MODULES).includes('AI')) expect((await runMonthlyGrant(org.organizationId, NOW)).ok).toBe(true)
  return { ...org, ctx, platform }
}

type Org = Awaited<ReturnType<typeof setup>>

async function ask(org: Org, code = 'req_con', purpose: 'QUOTATION_READ' | 'QUESTION' = 'QUOTATION_READ', now = NOW) {
  return requestAgentAction(org.ctx(code, now), { purpose, inputRefs: { fileId: randomUUID() }, inputText: 'ใบเสนอราคา' }, key())
}

async function answer(org: Org, agentActionId: string, tokens: { input: number; output: number }, now = NOW, model = SONNET) {
  const { promptVersion } = await prisma.agentAction.findUniqueOrThrow({ where: { id: agentActionId }, select: { promptVersion: true } })
  const r = await completeAgentAction(org.organizationId, now, promptVersion, {
    agentActionId,
    outcome: 'DRAFT',
    model,
    requestedModel: SONNET,
    output: { docNo: 'QT-1', gross: '129684.00' },
    fieldConfidence: { gross: 9500 },
    usage: { ...tokens, cacheRead: 0, cacheWrite: 0 },
    latencyMs: 1200,
  })
  expect(r.ok, JSON.stringify(r)).toBe(true)
  return r
}

describe('[BR-AI-11] every call passes the gates in order; the first that fails names the refusal', () => {
  it('[BR-AI-11] AI switched off for the system → AI_AGENT_DISABLED; the module off → MODULE_DISABLED', async () => {
    const org = await setup()
    setAiRuntimeForTests({ ...FIXTURE, enabled: false })
    const off = await ask(org)
    expect(off.ok ? null : off.error).toMatchObject({ code: 'AI_AGENT_DISABLED', details: { reason: 'AI_OFF' } })
    expect(await isAgentAvailable(org.ctx('req_con'), 'DOCUMENT')).toEqual({ available: false, reason: 'AI_AGENT_DISABLED' })

    const noModule = await setup({ modules: ['PAY', 'BCS_GO'], agentsOn: false })
    const r = await ask(noModule)
    expect(r.ok ? null : r.error.code).toBe('MODULE_DISABLED')
    expect(await isAgentAvailable(noModule.ctx('req_con'), 'DOCUMENT')).toEqual({ available: false, reason: 'MODULE_DISABLED' })
  })

  it('[BR-AI-24] an agent switched off by ORG_ADMIN refuses new calls at once; another agent still works', async () => {
    const org = await setup()
    expect((await updateAgentSetting(org.ctx('admin'), { agent: 'DOCUMENT', enabled: false }, key())).ok).toBe(true)
    const r = await ask(org)
    expect(r.ok ? null : r.error).toMatchObject({ code: 'AI_AGENT_DISABLED', details: { agent: 'DOCUMENT', reason: 'AGENT_OFF' } })
    expect((await ask(org, 'req_con', 'QUESTION')).ok).toBe(true)
    expect(await isAgentAvailable(org.ctx('req_con'), 'INTAKE')).toEqual({ available: false, reason: 'AI_AGENT_DISABLED' })
    expect(await isAgentAvailable(org.ctx('req_con'), 'INSIGHT')).toEqual({ available: true })
  })

  it('[BR-AI-11] live mode calls only an evaluated (agent, purpose, prompt, model) of the tier the environment needs', async () => {
    const org = await setup()
    setAiRuntimeForTests({ ...FIXTURE, mode: 'live' })
    const none = await ask(org)
    expect(none.ok ? null : none.error).toMatchObject({ code: 'AI_NOT_EVALUATED', details: { promptVersion: 'QUOTATION_READ@1', model: SONNET } })
    expect(await isAgentAvailable(org.ctx('req_con'), 'DOCUMENT')).toEqual({ available: false, reason: 'AI_NOT_EVALUATED' })
    const gate: EvalGate = { agent: 'DOCUMENT', purpose: 'QUOTATION_READ', promptVersion: 'QUOTATION_READ@1', model: SONNET, tier: 'SYNTHETIC', report: 'test' }
    setAiRuntimeForTests({ ...FIXTURE, mode: 'live', gates: [gate] })
    expect((await ask(org)).ok).toBe(true)
    expect(await isAgentAvailable(org.ctx('req_con'), 'DOCUMENT')).toEqual({ available: true })
    // Another model, or production (REAL only), is not the evaluated set
    setAiRuntimeForTests({ ...FIXTURE, mode: 'live', gates: [gate], modelEnv: { AI_MODEL_DOCUMENT: 'claude-opus-5-5' } })
    expect((await ask(org)).ok).toBe(false)
    setAiRuntimeForTests({ ...FIXTURE, mode: 'live', gates: [gate], appEnv: 'production' })
    const prod = await ask(org)
    expect(prod.ok ? null : prod.error.code).toBe('AI_NOT_EVALUATED')
    // Fixture mode skips the evaluation gate only (ADR-142)
    setAiRuntimeForTests(FIXTURE)
    expect((await ask(org)).ok).toBe(true)
  })

  it('[BR-AI-23] no credits this month → AI_CREDITS_EXHAUSTED; the last call may overdraw and finishes', async () => {
    const org = await setup({ grant: false })
    const none = await ask(org)
    expect(none.ok ? null : none.error.code).toBe('AI_CREDITS_EXHAUSTED')
    expect(await isAgentAvailable(org.ctx('req_con'), 'DOCUMENT')).toEqual({ available: false, reason: 'AI_CREDITS_EXHAUSTED' })
  })

  it('[BR-AI-11] at most 10 calls a minute per member → RATE_LIMITED reason AI; another member is not held back', async () => {
    const org = await setup()
    for (let i = 0; i < 10; i++) expect((await ask(org, 'req_con', 'QUESTION')).ok).toBe(true)
    const eleventh = await ask(org, 'req_con', 'QUESTION')
    expect(eleventh.ok ? null : eleventh.error).toMatchObject({ code: 'RATE_LIMITED', details: { reason: 'AI' } })
    expect((await ask(org, 'asst_con', 'QUESTION')).ok).toBe(true)
    expect((await ask(org, 'req_con', 'QUESTION', new Date(NOW.getTime() + 61_000))).ok).toBe(true)
  })

  it('[BR-AI-11] PLATFORM_ADMIN never starts a call; a member without ai.doaDraft cannot draft a DOA', async () => {
    const org = await setup()
    const platform = await requestAgentAction(org.platform, { purpose: 'QUESTION' }, key())
    expect(platform.ok ? null : platform.error.code).toBe('FORBIDDEN')
    const doa = await requestAgentAction(org.ctx('req_con'), { purpose: 'DOA_DRAFT' }, key())
    expect(doa.ok ? null : doa.error.code).toBe('FORBIDDEN')
    const brief = await requestAgentAction(org.ctx('req_con'), { purpose: 'BRIEF' }, key())
    expect(brief.ok ? null : brief.error.code).toBe('FORBIDDEN')
    expect(await isAgentAvailable(org.platform, 'INSIGHT')).toEqual({ available: false, reason: 'FORBIDDEN' })
  })
})

describe('[BR-AI-23] credits: one USE row per call that used tokens, the 80% notice and the exhausted notice once a month', () => {
  it('[INV-AI-02] the USE row equals costCredits, no tokens writes no row, and the action names its prompt and model', async () => {
    const org = await setup()
    const a = await ask(org)
    if (!a.ok) throw new Error(a.error.code)
    await answer(org, a.data.agentActionId, { input: 12_000, output: 800 })
    const row = await prisma.agentAction.findUniqueOrThrow({ where: { id: a.data.agentActionId } })
    expect(row).toMatchObject({ status: 'DRAFT', promptVersion: 'QUOTATION_READ@1', model: SONNET, costCredits: 32, inputTokens: 12_000, outputTokens: 800, latencyMs: 1200 })
    const uses = await prisma.aiCreditLedger.findMany({ where: { organizationId: org.organizationId, kind: 'USE' } })
    expect(uses).toEqual([expect.objectContaining({ agentActionId: row.id, credits: 32, source: 'CALL' })])

    const b = await ask(org)
    if (!b.ok) throw new Error(b.error.code)
    const failed = await completeAgentAction(org.organizationId, NOW, 'QUOTATION_READ@1', {
      agentActionId: b.data.agentActionId,
      outcome: 'FAILED',
      model: null,
      requestedModel: SONNET,
      errorCode: 'FIXTURE_MISSING',
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      latencyMs: 0,
    })
    expect(failed.ok && failed.data).toEqual({ status: 'FAILED', costCredits: 0 })
    expect(await prisma.aiCreditLedger.count({ where: { organizationId: org.organizationId, agentActionId: b.data.agentActionId } })).toBe(0)

    // INV-AI-02 over every action of the organization
    const actions = await prisma.agentAction.findMany({ where: { organizationId: org.organizationId }, include: { creditUses: true } })
    for (const x of actions) {
      expect(x.promptVersion).toMatch(/@\d+$/)
      expect(x.creditUses.reduce((n, u) => n + u.credits, 0)).toBe(x.costCredits)
      expect(x.creditUses.length).toBeLessThanOrEqual(1)
    }
  })

  it('[BR-AI-23] at 80% of the grant the ORG_ADMINs hear once; at zero once more, and new calls are refused', async () => {
    const org = await setup({ grant: false })
    expect(
      (await grantCredits(org.platform, { topUpCredits: 100, contractRef: 'CT-AI-01', reason: 'ทดลองใช้ AI', monthlyCredits: 100 }, key())).ok,
    ).toBe(true)
    const call = async (input: number) => {
      const a = await ask(org, 'req_con', 'QUESTION')
      if (!a.ok) return a.error.code
      await answer(org, a.data.agentActionId, { input, output: 0 })
      return 'ok'
    }
    // Sonnet input 2,000,000 micro-USD per million tokens: 500 tokens = 1 credit
    expect(await call(39_500)).toBe('ok') // 79 credits used
    expect(await call(500)).toBe('ok') // 80: the mark
    expect(await call(500)).toBe('ok') // 81: told already
    const notices = () => prisma.notification.findMany({ where: { organizationId: org.organizationId, templateKey: 'admin.ai_credits' }, select: { recipientMemberId: true, data: true } })
    expect((await notices()).map((n) => [n.recipientMemberId, (n.data as { kind: string }).kind])).toEqual([[org.member.admin, 'THRESHOLD']])
    expect(await call(10_000)).toBe('ok') // 101: overdrawn by the last call
    expect(await call(500)).toBe('AI_CREDITS_EXHAUSTED')
    expect((await notices()).map((n) => (n.data as { kind: string }).kind).sort()).toEqual(['EXHAUSTED', 'THRESHOLD'])
    const types = await prisma.event.findMany({ where: { organizationId: org.organizationId, aggregateType: 'AiCredit' }, select: { type: true }, orderBy: { seq: 'asc' } })
    expect(types.map((t) => t.type)).toEqual(['ai_credit.monthly_set', 'ai_credit.granted', 'ai_credit.threshold_reached', 'ai_credit.exhausted'])
    const summary = await creditSummary(org.ctx('admin'))
    expect(summary.ok && summary.data).toMatchObject({ granted: 100, used: 101, remaining: -1, monthlyCredits: 100 })
  })

  it('[BR-AI-23] the ledger refuses UPDATE and DELETE; the month is granted once', async () => {
    const org = await setup()
    const row = await prisma.aiCreditLedger.findFirstOrThrow({ where: { organizationId: org.organizationId } })
    await expect(prisma.aiCreditLedger.update({ where: { id: row.id }, data: { credits: 1 } })).rejects.toThrow()
    await expect(prisma.aiCreditLedger.delete({ where: { id: row.id } })).rejects.toThrow()
    expect((await runMonthlyGrant(org.organizationId, NOW)).ok).toBe(true) // the same key replays the first run
    const again = await runMonthlyGrant(org.organizationId, NOW, 'ai-credit-monthly-retry')
    expect(again.ok ? null : again.error.code).toBe('NOT_FOUND')
    expect(await prisma.aiCreditLedger.count({ where: { organizationId: org.organizationId, source: 'MONTHLY' } })).toBe(1)
  })

  it('[BR-AI-23] only the BCS team grants credits, with a contract reference; ORG_ADMIN and members are refused', async () => {
    const org = await setup()
    for (const code of ['admin', 'req_con']) {
      const r = await grantCredits(org.ctx(code), { topUpCredits: 10, contractRef: 'CT', reason: 'ขอเพิ่ม' }, key())
      expect(r.ok ? null : r.error.code, code).toBe('FORBIDDEN')
    }
    const missingRef = await grantCredits(org.platform, { topUpCredits: 10, contractRef: '', reason: 'ขอเพิ่ม' }, key())
    expect(missingRef.ok ? null : missingRef.error.code).toBe('VALIDATION_FAILED')
    const ok = await grantCredits(org.platform, { topUpCredits: 5000, contractRef: 'CT-AI-02', reason: 'เพิ่มตามสัญญา' }, key())
    expect(ok.ok).toBe(true)
    const row = await prisma.aiCreditLedger.findFirstOrThrow({ where: { organizationId: org.organizationId, source: 'TOPUP' } })
    expect(row).toMatchObject({ kind: 'GRANT', credits: 5000, contractRef: 'CT-AI-02' })
    expect(row.platformAdminId).not.toBeNull()
    const summaryForPlatform = await creditSummary(org.platform)
    expect(summaryForPlatform.ok && summaryForPlatform.data.granted).toBe(25_000)
    const summaryForMember = await creditSummary(org.ctx('req_con'))
    expect(summaryForMember.ok ? null : summaryForMember.error.code).toBe('FORBIDDEN')
  })
})

describe('[BR-AI-04] who reads an AgentAction: the member who asked and AUDITOR the content, ORG_ADMIN the metadata', () => {
  it('[BR-AI-04] content for the requester and AUDITOR, metadata only for ORG_ADMIN, FORBIDDEN for others and PLATFORM_ADMIN', async () => {
    const org = await setup()
    const a = await ask(org, 'req_con', 'QUESTION')
    if (!a.ok) throw new Error(a.error.code)
    await answer(org, a.data.agentActionId, { input: 100, output: 10 })
    const read = (ctx: Ctx) => getAgentAction(ctx, a.data.agentActionId)
    const own = await read(org.ctx('req_con'))
    expect(own.ok && own.data.content).toMatchObject({ inputText: 'ใบเสนอราคา', output: { docNo: 'QT-1' } })
    const auditor = await read(org.ctx('auditor'))
    expect(auditor.ok && auditor.data.content).toMatchObject({ inputText: 'ใบเสนอราคา' })
    const admin = await read(org.ctx('admin'))
    expect(admin.ok && admin.data).toMatchObject({ agent: 'INSIGHT', status: 'DRAFT', costCredits: 1, content: null })
    for (const ctx of [org.ctx('asst_con'), org.ctx('ceo'), org.platform]) {
      const r = await read(ctx)
      expect(r.ok ? null : r.error.code).toBe('FORBIDDEN')
    }
  })
})

describe('[BR-AI-05] ORG_ADMIN switches agents; everyone else is refused', () => {
  it('[BR-AI-05] the change has its event and tells every ORG_ADMIN; a member gets FORBIDDEN', async () => {
    const org = await setup({ agentsOn: false })
    const r = await updateAgentSetting(org.ctx('admin'), { agent: 'INTAKE', enabled: true, minConfidenceBp: 8500 }, key())
    expect(r.ok).toBe(true)
    const setting = await prisma.aiAgentSetting.findFirstOrThrow({ where: { organizationId: org.organizationId, agent: 'INTAKE' } })
    expect(setting).toMatchObject({ enabled: true, level: 'L1', minConfidenceBp: 8500 })
    expect(await prisma.notification.count({ where: { organizationId: org.organizationId, templateKey: 'admin.ai_agent_changed', recipientMemberId: org.member.admin } })).toBe(1)
    const tune = await updateAgentSetting(org.ctx('admin'), { agent: 'INTAKE', minConfidenceBp: 9000, expectedVersion: setting.version }, key())
    expect(tune.ok).toBe(true)
    const stale = await updateAgentSetting(org.ctx('admin'), { agent: 'INTAKE', minConfidenceBp: 9100, expectedVersion: setting.version }, key())
    expect(stale.ok ? null : stale.error.code).toBe('CONFLICT_VERSION')
    const events = await prisma.event.findMany({ where: { organizationId: org.organizationId, aggregateType: 'AiAgentSetting', aggregateId: setting.id }, select: { type: true }, orderBy: { seq: 'asc' } })
    expect(events.map((e) => e.type)).toEqual(['ai_agent.enabled', 'ai_agent.updated'])
    for (const ctx of [org.ctx('req_con'), org.ctx('auditor'), org.platform]) {
      const denied = await updateAgentSetting(ctx, { agent: 'INTAKE', enabled: false }, key())
      expect(denied.ok ? null : denied.error.code).toBe('FORBIDDEN')
      const list = await listAgentSettings(ctx)
      expect(list.ok ? null : list.error.code).toBe('FORBIDDEN')
    }
    const list = await listAgentSettings(org.ctx('admin'))
    expect(list.ok && list.data.find((s) => s.agent === 'INTAKE')).toMatchObject({ enabled: true, minConfidenceBp: 9000 })
  })
})

describe('[BR-AI-04] every transition of AgentAction has its event', () => {
  it('[BR-AI-04] request, complete, reject, feedback, timeout, stale and the clearing of content each write their event', async () => {
    const org = await setup()
    const draft = await ask(org)
    const insight = await ask(org, 'req_con', 'QUESTION')
    const pending = await ask(org)
    const stale = await ask(org)
    if (!draft.ok || !insight.ok || !pending.ok || !stale.ok) throw new Error('setup')
    await answer(org, draft.data.agentActionId, { input: 10, output: 1 })
    await answer(org, insight.data.agentActionId, { input: 10, output: 1 })
    await answer(org, stale.data.agentActionId, { input: 10, output: 1 })
    expect((await rejectAgentAction(org.ctx('req_con'), draft.data.agentActionId, key())).ok).toBe(true)
    // Only the member who asked decides; feedback is for L0 results
    const other = await rejectAgentAction(org.ctx('asst_con'), stale.data.agentActionId, key())
    expect(other.ok ? null : other.error.code).toBe('FORBIDDEN')
    const wrongLevel = await giveAgentFeedback(org.ctx('req_con'), { agentActionId: stale.data.agentActionId, feedback: 'HELPFUL' }, key())
    expect(wrongLevel.ok ? null : wrongLevel.error.code).toBe('INVALID_STATE_TRANSITION')
    expect((await giveAgentFeedback(org.ctx('req_con'), { agentActionId: insight.data.agentActionId, feedback: 'HELPFUL' }, key())).ok).toBe(true)

    // One day later: the PENDING call timed out, the unapplied L1 draft is STALE
    const later = new Date(NOW.getTime() + 25 * 3600_000)
    await runAgentActionSweep(org.organizationId, later)
    const status = async (id: string) => (await prisma.agentAction.findUniqueOrThrow({ where: { id } })).status
    expect(await status(pending.data.agentActionId)).toBe('FAILED')
    expect(await status(stale.data.agentActionId)).toBe('EXPIRED')
    expect(await status(insight.data.agentActionId)).toBe('DRAFT')

    // 91 days later the content of what nobody used is cleared; the metadata and credits stay (BR-AI-18)
    await runAgentActionSweep(org.organizationId, new Date(NOW.getTime() + 91 * 86_400_000))
    const cleared = await prisma.agentAction.findUniqueOrThrow({ where: { id: insight.data.agentActionId } })
    expect(cleared).toMatchObject({ inputText: null, costCredits: 1, output: { purged: true }, fieldConfidence: { purged: true }, review: { purged: true } })
    expect(cleared.contentPurgedAt).not.toBeNull()
    expect(JSON.stringify(cleared)).not.toMatch(/QT-1|129684/)

    const byAction = async (id: string) => (await prisma.event.findMany({ where: { aggregateType: 'AgentAction', aggregateId: id }, orderBy: { seq: 'asc' }, select: { type: true } })).map((e) => e.type)
    expect(await byAction(draft.data.agentActionId)).toEqual(['agent_action.requested', 'agent_action.drafted', 'agent_action.rejected', 'agent_action.content_purged'])
    expect(await byAction(insight.data.agentActionId)).toEqual(['agent_action.requested', 'agent_action.drafted', 'agent_action.feedback_given', 'agent_action.content_purged'])
    expect(await byAction(pending.data.agentActionId)).toEqual(['agent_action.requested', 'agent_action.failed', 'agent_action.content_purged'])
    expect(await byAction(stale.data.agentActionId)).toEqual(['agent_action.requested', 'agent_action.drafted', 'agent_action.expired', 'agent_action.content_purged'])

    // INV-AI-01: whatever the actor AI_AGENT wrote belongs to AgentAction
    const byAgent = await prisma.event.findMany({ where: { organizationId: org.organizationId, actorType: 'AI_AGENT' }, select: { aggregateType: true, agentId: true } })
    expect(byAgent.length).toBeGreaterThan(0)
    expect(new Set(byAgent.map((e) => e.aggregateType))).toEqual(new Set(['AgentAction']))
    // Event data never carries what was typed or answered (NFR-SEC-09)
    const data = await prisma.event.findMany({ where: { organizationId: org.organizationId, aggregateType: 'AgentAction' }, select: { data: true } })
    expect(JSON.stringify(data)).not.toMatch(/ใบเสนอราคา|QT-1/)
  })

  it('[BR-AI-04] only the agent of the action records its answer, once', async () => {
    const org = await setup()
    const a = await ask(org)
    if (!a.ok) throw new Error(a.error.code)
    const asOther = await completeAgentAction(org.organizationId, NOW, 'QUESTION@1', {
      agentActionId: a.data.agentActionId,
      outcome: 'DRAFT',
      model: SONNET,
      requestedModel: SONNET,
      output: {},
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
      latencyMs: 1,
    })
    expect(asOther.ok ? null : asOther.error.code).toBe('FORBIDDEN')
    await answer(org, a.data.agentActionId, { input: 1, output: 1 })
    const twice = await completeAgentAction(org.organizationId, NOW, 'QUOTATION_READ@1', {
      agentActionId: a.data.agentActionId,
      outcome: 'FAILED',
      model: null,
      requestedModel: SONNET,
      errorCode: 'X',
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      latencyMs: 0,
    })
    // The answer is recorded once: a second answer is refused and the first stays
    expect(twice.ok ? null : twice.error.code).toBe('IDEMPOTENCY_CONFLICT')
    expect((await prisma.agentAction.findUniqueOrThrow({ where: { id: a.data.agentActionId } })).status).toBe('DRAFT')
  })

  it('[BR-AI-23] an answer that comes after the call timed out is not used, but its tokens are charged once', async () => {
    const org = await setup()
    const a = await ask(org)
    if (!a.ok) throw new Error(a.error.code)
    await runAgentActionSweep(org.organizationId, new Date(NOW.getTime() + 16 * 60_000))
    const late = await completeAgentAction(org.organizationId, new Date(NOW.getTime() + 17 * 60_000), 'QUOTATION_READ@1', {
      agentActionId: a.data.agentActionId,
      outcome: 'DRAFT',
      model: SONNET,
      requestedModel: SONNET,
      output: { docNo: 'QT-1' },
      usage: { input: 12_000, output: 800, cacheRead: 0, cacheWrite: 0 },
      latencyMs: 1_020_000,
    })
    expect(late.ok && late.data).toEqual({ status: 'FAILED', costCredits: 32 })
    const row = await prisma.agentAction.findUniqueOrThrow({ where: { id: a.data.agentActionId } })
    expect(row).toMatchObject({ status: 'FAILED', errorCode: 'TIMEOUT', costCredits: 32, output: null })
    expect(await prisma.aiCreditLedger.count({ where: { agentActionId: row.id, kind: 'USE', credits: 32 } })).toBe(1)
  })

  it('[BR-AI-18] what a member typed is redacted before it is kept, and an idempotency key returns the same action', async () => {
    const org = await setup()
    const first = await requestAgentAction(org.ctx('req_con'), { purpose: 'QUESTION', inputText: 'โอนเข้าบัญชี 1234567890 ให้ผู้ขาย', idempotencyKey: 'chat_intake:x:1' }, key())
    if (!first.ok) throw new Error(first.error.code)
    const row = await prisma.agentAction.findUniqueOrThrow({ where: { id: first.data.agentActionId } })
    expect(row.inputText).toBe('โอนเข้าบัญชี [ปิดบัง] ให้ผู้ขาย')
    const again = await requestAgentAction(org.ctx('req_con'), { purpose: 'QUESTION', inputText: 'อีกครั้ง', idempotencyKey: 'chat_intake:x:1' }, key())
    expect(again.ok && again.data).toMatchObject({ agentActionId: first.data.agentActionId, existing: true, minConfidenceBp: 9000, model: '' })
    const otherPurpose = await requestAgentAction(org.ctx('req_con'), { purpose: 'QUOTATION_READ', idempotencyKey: 'chat_intake:x:1' }, key())
    expect(otherPurpose.ok ? null : otherPurpose.error.code).toBe('IDEMPOTENCY_CONFLICT')
    expect(await prisma.agentAction.count({ where: { organizationId: org.organizationId } })).toBe(1)
    const stranger = await requestAgentAction(org.ctx('asst_con'), { purpose: 'QUESTION', idempotencyKey: 'chat_intake:x:1' }, key())
    expect(stranger.ok ? null : stranger.error.code).toBe('FORBIDDEN')
  })
})

describe('[BR-AI-05] the phase-1 seed switches every agent on and grants the month once', () => {
  it('[BR-AI-05] five agents on at their phase-1 level and one monthly grant; a second run changes nothing', async () => {
    const { seedP1Ai } = await import('@/server/seed/p1-ai')
    const org = await createP1Org()
    expect(await seedP1Ai(org.organizationId, NOW)).toEqual({ agents: 5, granted: 20_000 })
    expect(await seedP1Ai(org.organizationId, NOW)).toEqual({ agents: 0, granted: 0 })
    const settings = await prisma.aiAgentSetting.findMany({ where: { organizationId: org.organizationId }, orderBy: { agent: 'asc' }, select: { agent: true, enabled: true, level: true } })
    expect(settings).toEqual([
      { agent: 'DOCUMENT', enabled: true, level: 'L1' },
      { agent: 'INTAKE', enabled: true, level: 'L1' },
      { agent: 'APPROVAL_BRIEF', enabled: true, level: 'L0' },
      { agent: 'INSIGHT', enabled: true, level: 'L0' },
      { agent: 'DOA_DRAFTER', enabled: true, level: 'L1' },
    ])
    expect(await prisma.aiCreditLedger.count({ where: { organizationId: org.organizationId, source: 'MONTHLY' } })).toBe(1)
  })
})
