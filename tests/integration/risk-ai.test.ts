import { randomUUID } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { setAiClientForTests, type AiClient, type AiRequest } from '@/integrations/ai'
import { putObject } from '@/integrations/storage'
import { PROMPT_VERSIONS, type AiPurposeName } from '@/lib/ai-config'
import { PORTAL_PRIVACY_NOTICE_VERSION } from '@/lib/portal-limits'
import { prisma } from '@/server/db/client'
import { setDefaultOutboxSender } from '@/server/events/outbox'
import { riskAiDraftRun, riskAiSummaryRun } from '@/server/jobs/risk-ai'
import { portalCtx } from '@/server/portal/session'
import { runMonthlyGrant, setAiRuntimeForTests, updateAgentSetting, type AiRuntime } from '@/server/services/ai'
import { answerRiskAssessment, cancelRiskAssessment, fillRiskAssessmentOnBehalf, openRiskAssessment, portalRiskAiDraft, riskAiDraftOf, riskSummaryOf, submitRiskAssessment, uploadRiskEvidence } from '@/server/services/risk'
import { draftForSave } from '@/server/services/risk/ai-assist'
import type { DoaOrg } from '../support/doa-org'
import { createP2Org } from '../support/p2-org'

// S11-13 (FR-AI-306 AC1 to AC4 AC6 · BR-AI-33 BR-AI-34 · ADR-228) on real Postgres and the real bucket, with a fake client
// that records what it was sent: the Risk Agent proposes answers from the files BR-AI-34 lets it read (AC1), each checked
// by ai-risk-verify and confirmed one by one through riskAssessment.answer / .fillOnBehalf + aiAssist, the send waiting
// meanwhile (AC2); a reviewer's summary of the slot's own part, placeholders only (AC3); the agent writes AgentAction only
// and drafts nobody took in expire when the assessment closes (AC4); with the AI off nothing is called or shown (AC6).

const NOW = new Date('2026-11-12T03:00:00Z')
const FIXTURE: AiRuntime = { enabled: true, mode: 'fixture', appEnv: 'local', modelEnv: {}, gates: [] }
const OFF: AiRuntime = { ...FIXTURE, enabled: false }
const key = () => ({ idempotencyKey: randomUUID(), sender: null })
const PDF = (text: string) => new TextEncoder().encode(`%PDF-1.7\n${text}\n%%EOF`)
const ok = <T,>(r: { ok: true; data: T } | { ok: false; error: unknown }): T => {
  if (!r.ok) throw new Error(JSON.stringify(r.error))
  return r.data
}
const step = { run: <T,>(_id: string, fn: () => Promise<T>) => fn() }

/** What the AI was sent, and what it answers per purpose (null: it refuses) */
const sent: Array<{ purpose: AiPurposeName; text: string; files: string[] }> = []
let reply: (purpose: AiPurposeName, text: string) => unknown = () => null
const decoder = new TextDecoder()
const fake: AiClient = { mode: 'fixture', extract: (r) => call(r), write: (r) => call(r) }
async function call<T>(r: AiRequest<T>) {
  sent.push({ purpose: r.purpose, text: r.text ?? '', files: (r.files ?? []).map((f) => decoder.decode(f.bytes)) })
  const base = { promptVersion: PROMPT_VERSIONS[r.purpose], model: r.model, usage: { input: 2000, output: 400, cacheRead: 0, cacheWrite: 0 }, latencyMs: 5 }
  const out = reply(r.purpose, r.text ?? '')
  if (out === null) return { ...base, ok: false as const, errorCode: 'AI_REFUSED' as const }
  const parsed = r.schema.safeParse(out)
  return parsed.success ? { ...base, ok: true as const, output: parsed.data } : { ...base, ok: false as const, errorCode: 'AI_OUTPUT_INVALID' as const }
}

const yn = (no: number, evidence = false) => [
  { code: 'Y', labelTh: 'มี', labelEn: 'Yes', points: 0, ...(evidence ? { evidence: true } : {}) },
  { code: 'N', labelTh: 'ไม่มี', labelEn: 'No', points: no },
]
const QUESTIONS = [
  { code: 'RQ-GEN-01', domain: 'GENERAL' as const, options: [{ code: 'A', labelTh: 'ไม่น้อยกว่า 5 ปี', labelEn: '5 years or more', points: 0 }, { code: 'B', labelTh: '2 ถึง 5 ปี', labelEn: '2 to 5 years', points: 5 }, { code: 'C', labelTh: 'น้อยกว่า 2 ปี', labelEn: 'Under 2 years', points: 10 }], sortOrder: 10 },
  { code: 'RQ-GEN-03', domain: 'GENERAL' as const, options: yn(8), sortOrder: 20 },
  { code: 'RQ-PRV-02', domain: 'PRIVACY' as const, options: yn(12), appliesWhen: { field: 'processesPersonalData', op: 'eq', value: 'Y' }, sortOrder: 30, aiReadable: true },
  { code: 'RQ-IS-01', domain: 'INFOSEC' as const, options: yn(12, true), appliesWhen: { field: 'accessesSystems', op: 'eq', value: 'Y' }, evidenceScopeRequired: true, evidenceScope: 'ISO 27001', sortOrder: 40 },
  { code: 'RQ-IS-02', domain: 'INFOSEC' as const, options: yn(8), appliesWhen: { field: 'accessesSystems', op: 'eq', value: 'Y' }, sortOrder: 50, aiReadable: true },
]
const SCREEN = { processesPersonalData: 'Y' as const, accessesSystems: 'Y' as const, accessesPremises: 'N' as const }
const position = (p: string, d: string) => ({ kind: 'POSITION_AT', position: p, department: d })

let org: DoaOrg
const as = (code: string, now = NOW) => org.ctxOf(code, now)

async function riskOrg(o: DoaOrg) {
  const id = o.organizationId
  await prisma.orgModule.create({ data: { organizationId: id, module: 'RISK', enabled: true, enabledAt: new Date('2026-01-01T00:00:00+07:00'), contractRef: 'TEST-P2', reason: 'องค์กรทดสอบระยะ 2' } })
  await prisma.roleAssignment.createMany({ data: [{ organizationId: id, memberId: o.member.admin!, role: 'ORG_ADMIN', grantedAt: NOW }], skipDuplicates: true })
  for (const t of [
    { code: 'LOW' as const, minPoints: 0, reviewMonths: 36, blocksPo: false, requiresExplicitAnswers: false },
    { code: 'MEDIUM' as const, minPoints: 20, reviewMonths: 24, blocksPo: false, requiresExplicitAnswers: false },
    { code: 'HIGH' as const, minPoints: 40, reviewMonths: 12, blocksPo: true, requiresExplicitAnswers: true },
  ]) {
    await prisma.riskTier.create({ data: { organizationId: id, ...t, nameTh: t.code, nameEn: t.code, reminderDaysBefore: 30, updatedById: o.member.admin!, confirmedById: o.member.admin2!, confirmedAt: NOW } })
  }
  await prisma.riskPolicy.create({
    data: { organizationId: id, screeningTierMap: { processesPersonalData: 'MEDIUM', accessesSystems: 'MEDIUM', accessesPremises: 'MEDIUM' }, highRiskCategories: [], registryFlagBlocks: true, mediumOverdueBlocks: false, overrideChatButton: false, updatedById: o.member.admin!, confirmedById: o.member.admin2!, confirmedAt: NOW },
  })
  const q = await prisma.riskQuestionnaire.create({ data: { organizationId: id, code: 'RQ-T', versionNo: 1, status: 'PUBLISHED', effectiveFrom: new Date('2026-11-01T00:00:00+07:00'), submittedById: o.member.admin!, submittedAt: NOW, publishedById: o.member.admin2!, publishedAt: NOW, checksum: 'test' } })
  for (const question of QUESTIONS) await prisma.riskQuestion.create({ data: { organizationId: id, questionnaireId: q.id, textTh: `ข้อ ${question.code}`, textEn: `Question ${question.code}`, ...question } })
  // one reviewer: INFOSEC when the work reaches systems (RR-02 of the SIMEC defaults · OQ-223)
  const wf = await prisma.workflowVersion.create({ data: { organizationId: id, code: 'WF-T', versionNo: 1, status: 'PUBLISHED', effectiveFrom: new Date('2026-10-01T00:00:00+07:00'), publishedAt: NOW } })
  await prisma.workflowRule.create({
    data: { organizationId: id, workflowVersionId: wf.id, code: 'RR-02', requestTypeCodes: [], when: { field: 'accessesSystems', op: 'eq', value: 'Y' }, reviewers: [position('DM', 'IT')], fallback: position('VP', 'SUP'), mode: 'ALL', slaBusinessMinutes: 960, sortOrder: 1, scope: 'RISK_ASSESSMENT', riskDomains: ['INFOSEC'] },
  })
  await prisma.supplierDocumentType.createMany({
    data: [
      // S7's company certificate the AI may read for a juristic person; an ISO certificate it may not; an ID card never (sensitive)
      { organizationId: id, code: 'COMPANY_CERT', nameTh: 'หนังสือรับรอง', nameEn: 'Company certificate', appliesTo: ['JURISTIC'], singleInstance: true, aiReadable: true, aiReadablePayeeTypes: ['JURISTIC'] },
      { organizationId: id, code: 'ISO_CERT', nameTh: 'ใบรับรอง ISO', nameEn: 'ISO certificate', appliesTo: ['JURISTIC'], singleInstance: false, linkedRiskQuestionCodes: ['RQ-IS-01'] },
      { organizationId: id, code: 'ID_CARD', nameTh: 'บัตรประชาชน', nameEn: 'ID card', appliesTo: ['JURISTIC', 'INDIVIDUAL'], sensitive: true, aiReadable: true },
    ],
  })
}

let seq = 0
async function supplierWithContact(payeeType: 'JURISTIC' | 'INDIVIDUAL' = 'JURISTIC') {
  const code = `RAI-${++seq}-${randomUUID().slice(0, 4)}`
  const supplier = await prisma.supplier.create({ data: { organizationId: org.organizationId, code, nameTh: `ผู้ขาย ${code}`, isForeign: true, portalEnabled: true, payeeType, email: `${code.toLowerCase()}@supplier.test` } })
  const contact = await prisma.supplierContact.create({ data: { organizationId: org.organizationId, supplierId: supplier.id, nameTh: `ผู้ติดต่อ ${code}`, email: `c-${randomUUID().slice(0, 6)}@supplier.test`, isPrimary: true, privacyNoticeVersion: PORTAL_PRIVACY_NOTICE_VERSION } })
  return { supplierId: supplier.id, contactId: contact.id, portal: (now = NOW) => portalCtx(org.organizationId, contact, now) }
}

/** A VERIFIED document of the supplier whose file is in the bucket, scanned clean */
async function document(supplierId: string, documentTypeCode: string, text: string, scope: string | null = null) {
  const storageKey = `test/${randomUUID()}.pdf`
  const bytes = PDF(text)
  await putObject(storageKey, bytes, 'application/pdf')
  const file = await prisma.fileObject.create({ data: { organizationId: org.organizationId, storageKey, fileName: `${documentTypeCode}.pdf`, mimeType: 'application/pdf', sizeBytes: bytes.byteLength, status: 'AVAILABLE', uploadedById: org.member.proc_officer!, scanStatus: 'CLEAN' } })
  return prisma.supplierDocument.create({
    data: { organizationId: org.organizationId, supplierId, documentTypeCode, fileId: file.id, ...(scope ? { scope, scopeKey: scope.toLowerCase() } : {}), issuedOn: new Date('2026-01-01'), expiresOn: new Date('2027-06-30'), status: 'VERIFIED', verifiedById: org.member.proc_officer!, verifiedAt: NOW },
  })
}

const version = async (id: string) => (await prisma.riskAssessment.findUniqueOrThrow({ where: { id } })).version
const opened = (assessmentId: string) => ({ name: 'bcs/risk_assessment.opened', data: { organizationId: org.organizationId, aggregateId: assessmentId } })
const draftsOf = (assessmentId: string) => prisma.agentAction.findMany({ where: { subjectType: 'RISK_ASSESSMENT', subjectId: assessmentId, purpose: 'RISK_ANSWER_DRAFT' }, orderBy: { createdAt: 'asc' } })

/** The answers of scene 22: founded in 2012 (≥ 5 years), a security policy, and a certificate claimed with none sent */
const ANSWERS = {
  answers: [
    { questionCode: 'RQ-GEN-01', optionCode: 'A', sourceRef: 'F1', quote: 'จดทะเบียนเมื่อวันที่ 3 พฤษภาคม 2555', confidence: 96 },
    { questionCode: 'RQ-IS-01', optionCode: 'Y', sourceRef: 'F1', quote: 'ISO 27001', confidence: 87 },
    { questionCode: 'RQ-GEN-03', optionCode: 'D', sourceRef: 'F1', quote: '', confidence: 90 },
    { questionCode: 'RQ-PRM-01', optionCode: 'Y', sourceRef: 'F9', quote: '', confidence: 80 },
  ],
}

beforeAll(async () => {
  setDefaultOutboxSender(null)
  org = await createP2Org()
  await riskOrg(org)
  setAiRuntimeForTests(FIXTURE)
  expect(await updateAgentSetting(org.ctxOf('admin', NOW), { agent: 'RISK', enabled: true }, key())).toMatchObject({ ok: true })
  expect((await runMonthlyGrant(org.organizationId, NOW)).ok).toBe(true)
  setAiClientForTests(fake)
})

afterEach(async () => {
  setAiRuntimeForTests(FIXTURE)
  sent.length = 0
  reply = () => null
  const settings = (await prisma.organization.findUniqueOrThrow({ where: { id: org.organizationId } })).settings as Record<string, unknown>
  await prisma.organization.update({ where: { id: org.organizationId }, data: { settings: { ...settings, risk: { aiAssist: true } } } })
})

async function scene(options: { payeeType?: 'JURISTIC' | 'INDIVIDUAL'; workScopes?: string[] } = {}) {
  const s = await supplierWithContact(options.payeeType)
  const cert = await document(s.supplierId, 'COMPANY_CERT', 'company certificate founded 2012')
  await document(s.supplierId, 'ISO_CERT', 'iso 9001 certificate', 'ISO 9001')
  await document(s.supplierId, 'ID_CARD', 'id card of the director')
  const a = ok(await openRiskAssessment(as('proc_officer'), { supplierId: s.supplierId, screening: SCREEN, ...(options.workScopes ? { workScopes: options.workScopes } : {}) }, key()))
  return { ...s, ...a, cert }
}

describe('[FR-AI-306/AC1] [BR-AI-34] the agent reads only what BR-AI-34 lets it, once the assessment opens', () => {
  it('a juristic supplier: the company certificate only (never an ID card or a type the AI may not read), for the open questions, on behalf of the contact', async () => {
    const s = await scene()
    reply = (p) => (p === 'RISK_ANSWER_DRAFT' ? ANSWERS : null)
    expect(await riskAiDraftRun(opened(s.assessmentId), step)).toBe('DRAFTED')
    expect(sent).toHaveLength(1)
    expect(sent[0]!.files).toEqual([expect.stringContaining('company certificate founded 2012')])
    expect(sent[0]!.text).toContain('RQ-GEN-01: ข้อ RQ-GEN-01 — A = ไม่น้อยกว่า 5 ปี')
    expect(sent[0]!.text).toContain('F1: COMPANY_CERT')
    expect(sent[0]!.text).not.toMatch(/ID_CARD|ISO_CERT/)
    const [draft] = await draftsOf(s.assessmentId)
    expect(draft).toMatchObject({ agent: 'RISK', level: 'L1', status: 'DRAFT', requestedByContactId: s.contactId, requestedById: null, appliedAt: null })
    // ids only, never a copy of a document (BR-AI-04)
    expect(draft!.inputRefs).toEqual({ assessmentId: s.assessmentId, reviewRound: 0, questions: ['RQ-GEN-01', 'RQ-GEN-03', 'RQ-PRV-02', 'RQ-IS-01', 'RQ-IS-02'], files: [{ label: 'F1', kind: 'DOCUMENT', ref: s.cert.id }] })
    // the same run again (a retry of the job) calls nothing
    expect(await riskAiDraftRun(opened(s.assessmentId), step)).toBe('SKIPPED_DRAFTED')
    expect(sent).toHaveLength(1)
  })

  it('[GC-AI-103] an individual, the organization\'s switch off, or AI off: no call, the assessment goes on by hand', async () => {
    const person = await scene({ payeeType: 'INDIVIDUAL' })
    expect(await riskAiDraftRun(opened(person.assessmentId), step)).toBe('SKIPPED_PAYEE_TYPE_EXCLUDED')
    const s = await scene()
    const settings = (await prisma.organization.findUniqueOrThrow({ where: { id: org.organizationId } })).settings as Record<string, unknown>
    await prisma.organization.update({ where: { id: org.organizationId }, data: { settings: { ...settings, risk: { aiAssist: false } } } })
    expect(await riskAiDraftRun(opened(s.assessmentId), step)).toBe('SKIPPED_SETTING_OFF')
    await prisma.organization.update({ where: { id: org.organizationId }, data: { settings: { ...settings, risk: { aiAssist: true } } } })
    setAiRuntimeForTests(OFF)
    expect(await riskAiDraftRun(opened(s.assessmentId), step)).toBe('SKIPPED_AI_AGENT_DISABLED')
    expect(sent).toHaveLength(0)
    expect(await draftsOf(s.assessmentId)).toHaveLength(0)
  })

  it('[GC-AI-103] an evidence file goes only when its question is open to the AI and its uploader ticked it; a verified document asks again', async () => {
    const s = await scene()
    ok(await answerRiskAssessment(s.portal(), { assessmentId: s.assessmentId, expectedVersion: await version(s.assessmentId), answers: [{ questionCode: 'RQ-IS-02', optionCode: 'Y' }, { questionCode: 'RQ-GEN-03', optionCode: 'Y' }] }, key()))
    const upload = async (questionCode: string, text: string, aiReadable: boolean) => {
      const f = ok(await uploadRiskEvidence(s.portal(), { assessmentId: s.assessmentId, questionCode, fileName: `${questionCode}.pdf`, bytes: PDF(text), aiReadable }, key()))
      await prisma.fileObject.update({ where: { id: f.fileId }, data: { scanStatus: 'CLEAN' } })
      return f.fileId
    }
    const policy = await upload('RQ-IS-02', 'information security policy MFA', true)
    // RQ-GEN-03 is not open to the AI: its file stays out though the uploader ticked it
    await upload('RQ-GEN-03', 'general file', true)
    reply = () => ({ answers: [{ questionCode: 'RQ-GEN-01', optionCode: 'A', sourceRef: 'F1', quote: '2555', confidence: 96 }] })
    expect(await riskAiDraftRun({ name: 'bcs/supplier_document.verified', data: { organizationId: org.organizationId, aggregateId: s.cert.id, data: { supplierId: s.supplierId, applicationId: null } } }, step)).toBe('DRAFTED')
    expect(sent[0]!.files).toEqual([expect.stringContaining('company certificate'), expect.stringContaining('information security policy MFA')])
    expect(sent[0]!.text).toContain('F2: evidence for RQ-IS-02')
    const drafts = await draftsOf(s.assessmentId)
    expect(drafts.at(-1)!.inputRefs).toMatchObject({ questions: ['RQ-GEN-01', 'RQ-PRV-02', 'RQ-IS-01'], files: [{ kind: 'DOCUMENT' }, { label: 'F2', kind: 'EVIDENCE', ref: policy }] })
    // the uploader withdraws the AI's reading: a new draft reads the certificate only
    await prisma.riskAnswer.updateMany({ where: { assessmentId: s.assessmentId, questionCode: 'RQ-IS-02' }, data: { evidenceAiReadable: false } })
    expect(await riskAiDraftRun({ name: 'bcs/risk_assessment.returned', data: { organizationId: org.organizationId, aggregateId: s.assessmentId } }, step)).toBe('DRAFTED')
    expect(sent[1]!.files).toEqual([expect.stringContaining('company certificate')])
    // the draft before it, nobody took in, gives way (the form shows one at a time)
    expect((await draftsOf(s.assessmentId)).map((d) => [d.status, d.expireReason])).toEqual([
      ['EXPIRED', 'SUPERSEDED'],
      ['DRAFT', null],
    ])
  })
})

describe('[FR-AI-306/AC2] [BR-AI-33] the proposed answers are checked, shown and confirmed one by one; the send waits', () => {
  it('ai-risk-verify on the draft, the box beside each question in the portal, then the contact confirms one by one', async () => {
    const s = await scene()
    reply = () => ANSWERS
    expect(await riskAiDraftRun(opened(s.assessmentId), step)).toBe('DRAFTED')
    const [draft] = await draftsOf(s.assessmentId)
    // GC-AI-100 to 102 on a real draft: an unknown option and a question not in the set fail, a certificate claimed with
    // none sent warns; only answers the commands take are proposed, never points or a tier
    expect(draft!.verification).toEqual({
      checks: [
        { questionCode: 'RQ-IS-01', code: 'EVIDENCE_MISSING', result: 'WARN' },
        { questionCode: 'RQ-GEN-03', code: 'OPTION_UNKNOWN', result: 'FAIL' },
        { questionCode: 'RQ-PRM-01', code: 'QUESTION_NOT_IN_SET', result: 'FAIL' },
      ],
    })
    expect(draft!.fieldConfidence).toEqual({ 'answers.RQ-GEN-01': 9600, 'answers.RQ-IS-01': 5000, 'answers.RQ-GEN-03': 0, 'answers.RQ-PRM-01': 0 })
    expect(draft!.review).toEqual({ requiredPaths: ['answers.RQ-GEN-01', 'answers.RQ-IS-01'], confirmedPaths: [], proposed: { 'answers.RQ-GEN-01': 'A', 'answers.RQ-IS-01': 'Y' } })
    expect(JSON.stringify(draft!.output)).not.toMatch(/"(points|tier|score)"/)

    const view = (await portalRiskAiDraft(s.portal(), s.assessmentId))!
    expect(view).toMatchObject({ agentActionId: draft!.id, applied: false })
    expect(view.suggestions).toEqual([
      { questionCode: 'RQ-GEN-01', optionCode: 'A', confidenceBp: 9600, check: null, quote: 'จดทะเบียนเมื่อวันที่ 3 พฤษภาคม 2555', source: { kind: 'DOCUMENT', name: 'COMPANY_CERT' }, confirmed: false, pending: false },
      { questionCode: 'RQ-IS-01', optionCode: 'Y', confidenceBp: 5000, check: { code: 'EVIDENCE_MISSING', result: 'WARN' }, quote: 'ISO 27001', source: { kind: 'DOCUMENT', name: 'COMPANY_CERT' }, confirmed: false, pending: false },
    ])
    // another supplier's contact sees nothing of it
    const other = await supplierWithContact()
    expect(await portalRiskAiDraft(other.portal(), s.assessmentId)).toBeNull()

    // the page saved with both values the AI put in, the contact confirmed only RQ-GEN-01: RQ-IS-01 waits
    const aiAssist = (codes: string[]) => ({ agentActionId: draft!.id, confirmedPaths: codes.map((c) => `answers.${c}`) })
    const both = [
      { questionCode: 'RQ-GEN-01', optionCode: 'A' },
      { questionCode: 'RQ-IS-01', optionCode: 'Y' },
    ]
    ok(await answerRiskAssessment(s.portal(), { assessmentId: s.assessmentId, expectedVersion: await version(s.assessmentId), answers: both, aiAssist: aiAssist(['RQ-GEN-01']) }, key()))
    expect(await prisma.agentAction.findUniqueOrThrow({ where: { id: draft!.id } })).toMatchObject({ status: 'DRAFT', appliedByContactId: s.contactId, appliedById: null })
    expect((await portalRiskAiDraft(s.portal(), s.assessmentId))!.suggestions.map((x) => [x.questionCode, x.confirmed, x.pending])).toEqual([
      ['RQ-GEN-01', true, false],
      ['RQ-IS-01', false, true],
    ])
    const rest = [
      { questionCode: 'RQ-GEN-03', optionCode: 'Y' },
      { questionCode: 'RQ-PRV-02', optionCode: 'Y' },
      { questionCode: 'RQ-IS-02', optionCode: 'Y' },
    ]
    ok(await answerRiskAssessment(s.portal(), { assessmentId: s.assessmentId, expectedVersion: await version(s.assessmentId), answers: rest }, key()))
    expect(await submitRiskAssessment(s.portal(), { assessmentId: s.assessmentId, expectedVersion: await version(s.assessmentId) }, key())).toMatchObject({ ok: false, error: { code: 'AI_REVIEW_PENDING', details: { count: 1 } } })
    // confirmed one by one: the action closes ACCEPTED by the contact, and the send goes on
    ok(await answerRiskAssessment(s.portal(), { assessmentId: s.assessmentId, expectedVersion: await version(s.assessmentId), answers: [{ questionCode: 'RQ-IS-01', optionCode: 'Y' }], aiAssist: aiAssist(['RQ-IS-01']) }, key()))
    expect(await prisma.agentAction.findUniqueOrThrow({ where: { id: draft!.id } })).toMatchObject({ status: 'ACCEPTED', appliedByContactId: s.contactId })
    expect(await prisma.event.count({ where: { aggregateId: draft!.id, type: 'agent_action.accepted' } })).toBe(1)
    expect(await submitRiskAssessment(s.portal(), { assessmentId: s.assessmentId, expectedVersion: await version(s.assessmentId) }, key())).toMatchObject({ ok: true })
  })

  it('procurement fills in for the supplier with the draft; FINANCE sees no draft; a draft of another assessment is refused', async () => {
    const s = await scene()
    reply = () => ANSWERS
    expect(await riskAiDraftRun(opened(s.assessmentId), step)).toBe('DRAFTED')
    const [draft] = await draftsOf(s.assessmentId)
    expect((await riskAiDraftOf(as('proc_officer'), s.assessmentId))!.suggestions).toHaveLength(2)
    expect(await riskAiDraftOf(as('fin_officer'), s.assessmentId)).toBeNull()
    const other = await scene()
    expect(
      await fillRiskAssessmentOnBehalf(as('proc_officer'), { assessmentId: other.assessmentId, expectedVersion: await version(other.assessmentId), answers: [{ questionCode: 'RQ-GEN-01', optionCode: 'A' }], aiAssist: { agentActionId: draft!.id, confirmedPaths: ['answers.RQ-GEN-01'] } }, key()),
    ).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED', details: { reason: 'SUBJECT_MISMATCH' } } })
    ok(await fillRiskAssessmentOnBehalf(as('proc_officer'), { assessmentId: s.assessmentId, expectedVersion: await version(s.assessmentId), answers: [{ questionCode: 'RQ-GEN-01', optionCode: 'B' }], aiAssist: { agentActionId: draft!.id, confirmedPaths: [] } }, key()))
    // procurement chose B over the AI's A: the AI's value is no longer there to wait, RQ-IS-01 was never put in
    expect(await prisma.agentAction.findUniqueOrThrow({ where: { id: draft!.id } })).toMatchObject({ status: 'EDITED', appliedById: org.member.proc_officer, diff: { 'answers.RQ-GEN-01': { ai: 'A', final: 'B' }, 'answers.RQ-IS-01': { ai: 'Y', final: null } } })
  })
})

describe('[FR-AI-306/AC3] [BR-AI-27] a reviewer reads a summary of the slot\'s own part, values from code', () => {
  async function inReview() {
    const s = await scene()
    ok(
      await answerRiskAssessment(
        s.portal(),
        { assessmentId: s.assessmentId, expectedVersion: await version(s.assessmentId), answers: ['RQ-GEN-01', 'RQ-GEN-03', 'RQ-PRV-02', 'RQ-IS-01', 'RQ-IS-02'].map((questionCode) => ({ questionCode, optionCode: questionCode === 'RQ-GEN-01' ? 'A' : 'Y' })) },
        key(),
      ),
    )
    ok(await submitRiskAssessment(s.portal(), { assessmentId: s.assessmentId, expectedVersion: await version(s.assessmentId) }, key()))
    const task = await prisma.reviewTask.findFirstOrThrow({ where: { assessmentId: s.assessmentId } })
    return { ...s, task }
  }

  it('INFOSEC slot: facts of GENERAL and INFOSEC only, the sentences filled in, the contradicted question kept; nobody else reads it', async () => {
    const s = await inReview()
    expect(s.task).toMatchObject({ assigneeMemberId: org.member.dm_it, riskDomains: ['INFOSEC'] })
    reply = (p) =>
      p === 'RISK_FILE_SUMMARY'
        ? { sentences: ['ใบ {{v:assessment}} ตอบครบ {{v:answeredCount}} จาก {{v:questionCount}} ข้อ', 'ข้อ {{v:RQ-IS-01.code}} ตอบว่า {{v:RQ-IS-01.answer}} แต่ไม่มีใบรับรองแนบ'], inconsistentQuestionCodes: ['RQ-IS-01', 'RQ-PRV-02', 'RQ-ZZ-99'] }
        : null
    const run = { data: { organizationId: org.organizationId, aggregateId: s.task.id } }
    expect(await riskAiSummaryRun(run, step)).toBe('WRITTEN')
    expect(sent[0]!.text).toContain('RQ-IS-02.answer = มี')
    expect(sent[0]!.text).not.toContain('RQ-PRV-02')
    expect(await riskAiSummaryRun(run, step)).toBe('SKIPPED_WRITTEN')
    const summary = await riskSummaryOf(as('dm_it'), s.task.id)
    expect(summary).toMatchObject({ sentences: [`ใบ ${(await prisma.riskAssessment.findUniqueOrThrow({ where: { id: s.assessmentId } })).number} ตอบครบ 4 จาก 4 ข้อ`, 'ข้อ RQ-IS-01 ตอบว่า มี แต่ไม่มีใบรับรองแนบ'], inconsistentQuestionCodes: ['RQ-IS-01'] })
    expect(await riskSummaryOf(as('dm_proc'), s.task.id)).toBeNull()
    // with the AI off the reviewer reads the file without it (EG-1)
    setAiRuntimeForTests(OFF)
    expect(await riskSummaryOf(as('dm_it'), s.task.id)).toBeNull()
  })

  it('a digit typed outside the placeholders throws the summary away whole', async () => {
    const s = await inReview()
    reply = () => ({ sentences: ['ตอบครบ 4 ข้อ'], inconsistentQuestionCodes: [] })
    expect(await riskAiSummaryRun({ data: { organizationId: org.organizationId, aggregateId: s.task.id } }, step)).toBe('FAILED')
    expect(await prisma.agentAction.findFirstOrThrow({ where: { idempotencyKey: `risk_summary:${s.task.id}` } })).toMatchObject({ status: 'FAILED', errorCode: 'AI_TEXT_DIGIT_OUTSIDE_PLACEHOLDER', level: 'L0' })
    expect(await riskSummaryOf(as('dm_it'), s.task.id)).toBeNull()
  })
})

describe('[FR-AI-306/AC4] [INV-AI-05] the agent writes AgentAction only; drafts nobody took in end with the assessment', () => {
  it('the risk services and the portal\'s risk reads never import the AI adapter or an agent', () => {
    const root = path.resolve(import.meta.dirname, '..', '..', 'src', 'server')
    const files = [...readdirSync(path.join(root, 'services', 'risk')).filter((x) => x.endsWith('.ts')).map((f) => path.join(root, 'services', 'risk', f)), path.join(root, 'portal', 'queries-risk.ts')]
    for (const f of files) expect(readFileSync(f, 'utf8'), f).not.toMatch(/@\/integrations\/ai|services\/ai\/agents|from '\.\.\/ai'|from '\.\.\/ai\/index'|@\/server\/services\/ai'/)
  })

  it('a draft nobody took in expires SUBJECT_CLOSED once the assessment is sent; the tier is the engine\'s', async () => {
    const s = await scene()
    reply = () => ANSWERS
    expect(await riskAiDraftRun(opened(s.assessmentId), step)).toBe('DRAFTED')
    const [draft] = await draftsOf(s.assessmentId)
    expect(await prisma.event.findMany({ where: { aggregateId: draft!.id }, select: { type: true }, orderBy: { seq: 'asc' } })).toEqual([{ type: 'agent_action.requested' }, { type: 'agent_action.drafted' }])
    ok(
      await answerRiskAssessment(
        s.portal(),
        { assessmentId: s.assessmentId, expectedVersion: await version(s.assessmentId), answers: ['RQ-GEN-01', 'RQ-GEN-03', 'RQ-PRV-02', 'RQ-IS-01', 'RQ-IS-02'].map((questionCode) => ({ questionCode, optionCode: 'N' })).map((x) => (x.questionCode === 'RQ-GEN-01' ? { ...x, optionCode: 'C' } : x)) },
        key(),
      ),
    )
    const sentResult = ok(await submitRiskAssessment(s.portal(), { assessmentId: s.assessmentId, expectedVersion: await version(s.assessmentId) }, key()))
    expect(sentResult.tier).toBe('HIGH')
    expect(await riskAiDraftRun({ name: 'bcs/risk_assessment.submitted', data: { organizationId: org.organizationId, aggregateId: s.assessmentId } }, step)).toBe('CLOSED_1')
    expect(await prisma.agentAction.findUniqueOrThrow({ where: { id: draft!.id } })).toMatchObject({ status: 'EXPIRED', expireReason: 'SUBJECT_CLOSED' })
  })
})

describe('[FR-AI-306/AC6] [EG-1] with the AI off nothing of the agent shows, and the assessment works by hand', () => {
  it('a draft nobody took in is hidden while AI is off; one taken in whose answers wait stays, so the send can be explained', async () => {
    const s = await scene()
    reply = () => ANSWERS
    expect(await riskAiDraftRun(opened(s.assessmentId), step)).toBe('DRAFTED')
    setAiRuntimeForTests(OFF)
    expect(await portalRiskAiDraft(s.portal(), s.assessmentId)).toBeNull()
    expect(await riskAiDraftOf(as('proc_officer'), s.assessmentId)).toBeNull()
    setAiRuntimeForTests(FIXTURE)
    const [draft] = await draftsOf(s.assessmentId)
    ok(await answerRiskAssessment(s.portal(), { assessmentId: s.assessmentId, expectedVersion: await version(s.assessmentId), answers: [{ questionCode: 'RQ-GEN-01', optionCode: 'A' }], aiAssist: { agentActionId: draft!.id, confirmedPaths: [] } }, key()))
    setAiRuntimeForTests(OFF)
    expect((await portalRiskAiDraft(s.portal(), s.assessmentId))!.suggestions.find((x) => x.questionCode === 'RQ-GEN-01')).toMatchObject({ pending: true })
  })

  it('AI off from the start: no call, the contact answers every question and sends', async () => {
    setAiRuntimeForTests(OFF)
    const s = await scene()
    expect(await riskAiDraftRun(opened(s.assessmentId), step)).toBe('SKIPPED_AI_AGENT_DISABLED')
    ok(
      await answerRiskAssessment(
        s.portal(),
        { assessmentId: s.assessmentId, expectedVersion: await version(s.assessmentId), answers: ['RQ-GEN-01', 'RQ-GEN-03', 'RQ-PRV-02', 'RQ-IS-01', 'RQ-IS-02'].map((questionCode) => ({ questionCode, optionCode: questionCode === 'RQ-GEN-01' ? 'A' : 'Y' })) },
        key(),
      ),
    )
    expect(await submitRiskAssessment(s.portal(), { assessmentId: s.assessmentId, expectedVersion: await version(s.assessmentId) }, key())).toMatchObject({ ok: true })
    expect(sent).toHaveLength(0)
  })
})

// the review of S11-13 (/code-review high 6cd834dd...HEAD): what a save does with a draft that changed, leaving a proposed
// question unanswered, a draft taken in when the assessment is cancelled, a certificate verified late, and the file limit
describe('[FR-AI-306/AC2] [BR-AI-17] what the person saves is theirs or the AI\'s, never mixed up', () => {
  it('a portal save whose draft was replaced or hidden since the page opened saves nothing; a page with no draft saves the contact\'s own', async () => {
    const s = await scene()
    reply = () => ANSWERS
    expect(await riskAiDraftRun(opened(s.assessmentId), step)).toBe('DRAFTED')
    const shown = (await portalRiskAiDraft(s.portal(), s.assessmentId))!
    expect(draftForSave(shown.agentActionId, shown)).toEqual({ ok: true, draft: shown })
    expect(draftForSave('', shown)).toEqual({ ok: true, draft: null })
    // the contact answers another question by hand, then the assessment comes back: a newer draft replaces the one shown
    ok(await answerRiskAssessment(s.portal(), { assessmentId: s.assessmentId, expectedVersion: await version(s.assessmentId), answers: [{ questionCode: 'RQ-GEN-03', optionCode: 'Y' }] }, key()))
    expect(await riskAiDraftRun({ name: 'bcs/risk_assessment.returned', data: { organizationId: org.organizationId, aggregateId: s.assessmentId } }, step)).toBe('DRAFTED')
    const now = await portalRiskAiDraft(s.portal(), s.assessmentId)
    expect(now!.agentActionId).not.toBe(shown.agentActionId)
    expect(draftForSave(shown.agentActionId, now)).toEqual({ ok: false })
    // AI switched off while the page was open: the draft nobody took in is hidden, the save is refused the same way
    setAiRuntimeForTests(OFF)
    expect(draftForSave(now!.agentActionId, await portalRiskAiDraft(s.portal(), s.assessmentId))).toEqual({ ok: false })
  })

  it('"leave unanswered" clears an answer saved from the AI and not confirmed: nothing waits, the draft closes EDITED', async () => {
    const s = await scene()
    reply = () => ANSWERS
    expect(await riskAiDraftRun(opened(s.assessmentId), step)).toBe('DRAFTED')
    const [draft] = await draftsOf(s.assessmentId)
    const both = [
      { questionCode: 'RQ-GEN-01', optionCode: 'A' },
      { questionCode: 'RQ-IS-01', optionCode: 'Y' },
    ]
    ok(await answerRiskAssessment(s.portal(), { assessmentId: s.assessmentId, expectedVersion: await version(s.assessmentId), answers: both, aiAssist: { agentActionId: draft!.id, confirmedPaths: ['answers.RQ-GEN-01'] } }, key()))
    expect((await portalRiskAiDraft(s.portal(), s.assessmentId))!.suggestions.find((x) => x.questionCode === 'RQ-IS-01')).toMatchObject({ pending: true })
    ok(await answerRiskAssessment(s.portal(), { assessmentId: s.assessmentId, expectedVersion: await version(s.assessmentId), answers: [{ questionCode: 'RQ-IS-01', optionCode: null }], aiAssist: { agentActionId: draft!.id, confirmedPaths: [] } }, key()))
    expect(await prisma.riskAnswer.count({ where: { assessmentId: s.assessmentId, questionCode: 'RQ-IS-01', optionCode: { not: null } } })).toBe(0)
    expect(await prisma.agentAction.findUniqueOrThrow({ where: { id: draft!.id } })).toMatchObject({ status: 'EDITED', diff: { 'answers.RQ-IS-01': { ai: 'Y', final: null } } })
  })
})

describe('[FR-AI-306/AC4] [BR-AI-18] a draft taken in ends with the assessment too', () => {
  it('cancelled while an answer from the AI still waits: the draft expires SUBJECT_CLOSED', async () => {
    const s = await scene()
    reply = () => ANSWERS
    expect(await riskAiDraftRun(opened(s.assessmentId), step)).toBe('DRAFTED')
    const [draft] = await draftsOf(s.assessmentId)
    ok(await answerRiskAssessment(s.portal(), { assessmentId: s.assessmentId, expectedVersion: await version(s.assessmentId), answers: [{ questionCode: 'RQ-GEN-01', optionCode: 'A' }], aiAssist: { agentActionId: draft!.id, confirmedPaths: [] } }, key()))
    expect(await prisma.agentAction.findUniqueOrThrow({ where: { id: draft!.id } })).toMatchObject({ status: 'DRAFT', appliedAt: expect.any(Date) })
    ok(await cancelRiskAssessment(as('proc_officer'), { assessmentId: s.assessmentId, expectedVersion: await version(s.assessmentId), reason: 'ยกเลิกงาน' }, key()))
    expect(await riskAiDraftRun({ name: 'bcs/risk_assessment.cancelled', data: { organizationId: org.organizationId, aggregateId: s.assessmentId } }, step)).toBe('CLOSED_1')
    expect(await prisma.agentAction.findUniqueOrThrow({ where: { id: draft!.id } })).toMatchObject({ status: 'EXPIRED', expireReason: 'SUBJECT_CLOSED' })
  })
})

describe('[FR-AI-306/AC1] [BR-AI-34] [BR-RSK-05] what the agent reads, and what counts as evidence', () => {
  it('a certificate verified after the assessment opened counts as evidence: its option is no EVIDENCE_MISSING', async () => {
    // the work reaches systems under ISO 27001 (BR-RSK-05: the scope of the certificate must be one of the work's)
    const s = await scene({ workScopes: ['ISO 27001'] })
    expect(await prisma.riskAnswer.count({ where: { assessmentId: s.assessmentId, source: 'EVIDENCE' } })).toBe(0)
    await document(s.supplierId, 'ISO_CERT', 'iso 27001 certificate', 'ISO 27001')
    reply = () => ANSWERS
    expect(await riskAiDraftRun({ name: 'bcs/supplier_document.verified', data: { organizationId: org.organizationId, aggregateId: s.cert.id, data: { supplierId: s.supplierId, applicationId: null } } }, step)).toBe('DRAFTED')
    const [draft] = await draftsOf(s.assessmentId)
    expect(draft!.verification).toEqual({
      checks: [
        { questionCode: 'RQ-GEN-03', code: 'OPTION_UNKNOWN', result: 'FAIL' },
        { questionCode: 'RQ-PRM-01', code: 'QUESTION_NOT_IN_SET', result: 'FAIL' },
      ],
    })
    expect(draft!.fieldConfidence).toMatchObject({ 'answers.RQ-IS-01': 8700 })
  })

  it('a file the adapter cannot take never takes the place of one it can (the cut to 8 files comes after)', async () => {
    const s = await scene()
    const types = Array.from({ length: 8 }, (_, i) => `WORD_DOC_${i + 1}`)
    await prisma.supplierDocumentType.createMany({ data: types.map((code) => ({ organizationId: org.organizationId, code, nameTh: code, nameEn: code, appliesTo: ['JURISTIC'], singleInstance: true, aiReadable: true, aiReadablePayeeTypes: ['JURISTIC'] })), skipDuplicates: true })
    for (const code of types) {
      const file = await prisma.fileObject.create({ data: { organizationId: org.organizationId, storageKey: `test/${randomUUID()}.doc`, fileName: `${code}.doc`, mimeType: 'application/msword', sizeBytes: 100, status: 'AVAILABLE', uploadedById: org.member.proc_officer!, scanStatus: 'CLEAN' } })
      await prisma.supplierDocument.create({ data: { organizationId: org.organizationId, supplierId: s.supplierId, documentTypeCode: code, fileId: file.id, issuedOn: new Date('2026-01-01'), expiresOn: new Date('2027-06-30'), status: 'VERIFIED', verifiedById: org.member.proc_officer!, verifiedAt: NOW } })
    }
    ok(await answerRiskAssessment(s.portal(), { assessmentId: s.assessmentId, expectedVersion: await version(s.assessmentId), answers: [{ questionCode: 'RQ-IS-02', optionCode: 'Y' }] }, key()))
    const f = ok(await uploadRiskEvidence(s.portal(), { assessmentId: s.assessmentId, questionCode: 'RQ-IS-02', fileName: 'policy.pdf', bytes: PDF('information security policy'), aiReadable: true }, key()))
    await prisma.fileObject.update({ where: { id: f.fileId }, data: { scanStatus: 'CLEAN' } })
    reply = () => ({ answers: [] })
    expect(await riskAiDraftRun(opened(s.assessmentId), step)).toBe('DRAFTED')
    expect(sent[0]!.files).toEqual([expect.stringContaining('company certificate'), expect.stringContaining('information security policy')])
    expect((await draftsOf(s.assessmentId))[0]!.inputRefs).toMatchObject({ files: [{ label: 'F1', kind: 'DOCUMENT' }, { label: 'F2', kind: 'EVIDENCE', ref: f.fileId }] })
  })
})
