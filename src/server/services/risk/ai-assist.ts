import { aiReadableEvidence, checkAiText, shouldDraftFor, type RiskCheckCode, type RiskDraftQuestion, type TextValue } from '@/core/ai-checks'
import { shouldReadDocument } from '@/core/ai-checks/supplier'
import { questionsInSet } from '@/core/risk'
import { dateIn } from '@/core/supplier-docs'
import { DECISION_ADVICE_WORDS, RISK_PROFILE } from '@/lib/ai-config'
import { riskSettingsOf } from '@/lib/org-settings'
import { authorize } from '@/server/authz'
import { systemCtx, type Ctx } from '@/server/context'
import { forTenant, type TenantTx } from '@/server/db/tenant'
import { openAssists, registerAssistSubject } from '../ai/assist-contract'
import { agentSwitchedOn } from '../ai/gate'
import { requireModule } from '../modules'
import { contextOf, questionDefOf, questionsOf, RISK_TIMEZONE, type AssessmentRow } from './assessments'
import { storedOptions } from './questionnaire'
import { riskReviewTask } from './reviews'

// A risk assessment as the Risk Agent sees it (S11-13 · FR-AI-306 · BR-AI-33 BR-AI-34 · ADR-228). This file never calls
// the AI (INV-AI-05: src/server/services/risk does not import src/integrations/ai); the agent of the AI module asks it.
//
// RISK_ANSWER_DRAFT (L1): an assessment is a subject of the AI-assist contract. What the agent proposes goes in only
// through riskAssessment.answer (the supplier's contact in the portal) or .fillOnBehalf (procurement) with aiAssist, one
// answer at a time (BR-AI-33): the path of an answer is answers.<questionCode>, its value the option code. A draft may keep
// answers waiting (final: false); riskAssessment.submit asks assertNoPendingAiReview (AI_REVIEW_PENDING).
//
// What the agent may read (BR-AI-34): nothing of a supplier who is a person (shouldDraftFor), and nothing while the
// organization's settings.risk.aiAssist is off; of the supplier's documents the VERIFIED ones of a type S7 lets the AI read
// for the supplier's payee type, never a sensitive type; of the RISK_EVIDENCE files only those of a question the
// organization opened to the AI (RiskQuestion.aiReadable) whose uploader ticked that the AI may read them; every file
// scanned CLEAN. Never a reviewer's answer or a reason of a return.
//
// RISK_FILE_SUMMARY (L0): for one reviewer's task, the questions of the slot's domains only (INV-RSK-05) as facts code
// built, and the files of those answers within the same scope.

export const RISK_ASSIST_TYPE = 'RISK_ASSESSMENT'
export const riskAnswerPath = (questionCode: string): string => `answers.${questionCode}`
const PATH = /^answers\.(RQ-[A-Z]{2,4}-\d{2})$/
export const questionOfPath = (path: string): string | null => PATH.exec(path)?.[1] ?? null

const OPEN_STATES = ['DRAFT', 'RETURNED'] as const
const OPEN: ReadonlySet<string> = new Set(OPEN_STATES)

/** The answers of an assessment by path, as the form holds them: an answer with an option chosen */
async function readAssessmentForAssist(tx: TenantTx, id: string): Promise<Readonly<Record<string, string>> | null> {
  const a = await tx.riskAssessment.findUnique({ where: { id }, select: { id: true } })
  if (!a) return null
  const answers = await tx.riskAnswer.findMany({ where: { assessmentId: id, optionCode: { not: null } }, select: { questionCode: true, optionCode: true } })
  return Object.fromEntries(answers.map((x) => [riskAnswerPath(x.questionCode), x.optionCode!]))
}

// the supplier's contact takes the values in on the portal too (BR-AI-30 · S7-14's option of the registry)
registerAssistSubject(RISK_ASSIST_TYPE, { purposes: ['RISK_ANSWER_DRAFT'], final: false, read: readAssessmentForAssist, supplierActor: true })

const loadForAi = (tx: TenantTx, id: string) =>
  tx.riskAssessment.findFirst({
    where: { id },
    include: { answers: true, supplier: { select: { id: true, code: true, status: true, payeeType: true, isForeign: true, registryFlag: true } }, questionnaire: { include: { questions: { orderBy: { sortOrder: 'asc' } } } } },
  })

/** A file the agent may read, by its label in the call (F1 …): a supplier document, or an answer's evidence file */
export interface RiskAiFile {
  readonly label: string
  readonly kind: 'DOCUMENT' | 'EVIDENCE'
  /** SupplierDocument.id, or the FileObject.id of an evidence file */
  readonly ref: string
  readonly fileId: string
  readonly storageKey: string
  readonly mimeType: string
  readonly sizeBytes: number
  /** What the file is, for the agent: the document type, or the question an evidence file was sent for */
  readonly about: string
  readonly questionCode: string | null
}

const MAX_FILES = 8

/** The files of the supplier the agent may read for the questions given (BR-AI-34), at most MAX_FILES, documents first */
async function filesFor(tx: TenantTx, a: NonNullable<Awaited<ReturnType<typeof loadForAi>>>, questionCodes: ReadonlySet<string>, today: string, documentTypes?: ReadonlySet<string>): Promise<RiskAiFile[]> {
  const docs = await tx.supplierDocument.findMany({
    where: { supplierId: a.supplierId, status: 'VERIFIED', expiresOn: { gte: new Date(`${today}T00:00:00Z`) }, documentType: { aiReadable: true, sensitive: false }, file: { status: 'AVAILABLE', scanStatus: 'CLEAN' } },
    select: { id: true, documentTypeCode: true, documentType: { select: { aiReadable: true, aiReadablePayeeTypes: true } }, file: { select: { id: true, storageKey: true, mimeType: true, sizeBytes: true } } },
    orderBy: [{ documentTypeCode: 'asc' }, { expiresOn: 'desc' }, { id: 'asc' }],
  })
  const out: Omit<RiskAiFile, 'label'>[] = []
  const seenTypes = new Set<string>()
  for (const d of docs) {
    // one of each type, the newest; a type the AI may not read for this payee is never sent (S7's rule · GC-AI-95)
    if (seenTypes.has(d.documentTypeCode) || !shouldReadDocument(d.documentType, a.payeeType).read) continue
    if (documentTypes && !documentTypes.has(d.documentTypeCode)) continue
    seenTypes.add(d.documentTypeCode)
    out.push({ kind: 'DOCUMENT', ref: d.id, fileId: d.file.id, storageKey: d.file.storageKey, mimeType: d.file.mimeType, sizeBytes: d.file.sizeBytes, about: d.documentTypeCode, questionCode: null })
  }
  const aiQuestions = new Set(a.questionnaire.questions.filter((q) => q.aiReadable).map((q) => q.code))
  const consented = a.answers.filter((x) => questionCodes.has(x.questionCode) && aiReadableEvidence({ questionAiReadable: aiQuestions.has(x.questionCode), evidenceAiReadable: x.evidenceAiReadable }).send)
  if (consented.length) {
    const links = await tx.fileLink.findMany({
      where: { kind: 'RISK_EVIDENCE', subjectType: 'RiskAnswer', subjectId: { in: consented.map((x) => x.id) }, file: { status: 'AVAILABLE', scanStatus: 'CLEAN' } },
      select: { subjectId: true, file: { select: { id: true, storageKey: true, mimeType: true, sizeBytes: true } } },
      orderBy: { createdAt: 'asc' },
    })
    for (const l of links) {
      const code = consented.find((x) => x.id === l.subjectId)!.questionCode
      out.push({ kind: 'EVIDENCE', ref: l.file.id, fileId: l.file.id, storageKey: l.file.storageKey, mimeType: l.file.mimeType, sizeBytes: l.file.sizeBytes, about: `evidence for ${code}`, questionCode: code })
    }
  }
  return out.slice(0, MAX_FILES).map((f, i) => ({ ...f, label: `F${i + 1}` }))
}

/** The question set of the assessment as the checks see it (ai-risk-verify) */
const draftQuestions = (a: AssessmentRow): RiskDraftQuestion[] => questionsOf(a).map((q) => ({ code: q.code, options: q.options.map((o) => ({ code: o.code, ...(o.evidence ? { evidence: true } : {}) })) }))

export interface RiskDraftSource {
  readonly assessmentId: string
  readonly reviewRound: number
  /** The supplier's contact the proposed answers are for (the one invited), when it has one */
  readonly contactId: string | null
  readonly questionSet: readonly RiskDraftQuestion[]
  /** The questions a supplier document answers (answers from evidence · BR-RSK-05) */
  readonly evidenceAvailable: readonly string[]
  /** The questions the agent is asked: in the set, with no option chosen yet */
  readonly ask: readonly { readonly code: string; readonly text: string; readonly options: readonly { readonly code: string; readonly label: string }[] }[]
  readonly files: readonly RiskAiFile[]
}

export type DraftSkip = 'NOT_FOUND' | 'CLOSED' | 'PAYEE_TYPE_EXCLUDED' | 'SETTING_OFF' | 'MODULE_DISABLED' | 'NOTHING_TO_ANSWER' | 'NO_FILES'

/**
 * For the job risk-ai-draft (a SYSTEM ctx of the organization): what the agent reads of an open assessment, or why it
 * reads nothing (BR-AI-33 BR-AI-34). Never calls the AI.
 */
export async function riskDraftSource(tx: TenantTx, ctx: Ctx, assessmentId: string): Promise<{ readonly ok: true; readonly data: RiskDraftSource } | { readonly ok: false; readonly skip: DraftSkip }> {
  if (!(await requireModule(ctx, 'RISK', tx)).ok) return { ok: false, skip: 'MODULE_DISABLED' }
  const a = await loadForAi(tx, assessmentId)
  if (!a) return { ok: false, skip: 'NOT_FOUND' }
  if (!OPEN.has(a.status) || a.supplier.status !== 'ACTIVE') return { ok: false, skip: 'CLOSED' }
  const org = await tx.organization.findUniqueOrThrow({ where: { id: ctx.organizationId }, select: { settings: true } })
  const decision = shouldDraftFor({ payeeType: a.payeeType, aiAssist: riskSettingsOf(org.settings).aiAssist })
  if (!decision.draft) return { ok: false, skip: decision.reason }
  const set = questionsOf(a)
  const chosen = new Set(a.answers.filter((x) => x.optionCode !== null).map((x) => x.questionCode))
  const stored = new Map(a.questionnaire.questions.map((q) => [q.code, q]))
  const ask = set
    .filter((q) => !chosen.has(q.code))
    .map((q) => ({ code: q.code, text: stored.get(q.code)!.textTh, options: storedOptions(stored.get(q.code)!.options).map((o) => ({ code: o.code, label: o.labelTh || o.code })) }))
  if (ask.length === 0) return { ok: false, skip: 'NOTHING_TO_ANSWER' }
  const files = await filesFor(tx, a, new Set(set.map((q) => q.code)), dateIn(ctx.now, RISK_TIMEZONE))
  if (files.length === 0) return { ok: false, skip: 'NO_FILES' }
  const contact = await tx.supplierContact.findFirst({ where: { supplierId: a.supplierId, status: 'ACTIVE' }, orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }], select: { id: true } })
  return {
    ok: true,
    data: {
      assessmentId: a.id,
      reviewRound: a.reviewRound,
      contactId: contact?.id ?? null,
      questionSet: draftQuestions(a),
      evidenceAvailable: a.answers.filter((x) => x.source === 'EVIDENCE' && x.optionCode !== null).map((x) => x.questionCode),
      ask,
      files,
    },
  }
}

/** Whether the assessment is still open for answers (the agent asks again before it records a draft) */
export async function riskAssessmentOpen(tx: TenantTx, assessmentId: string): Promise<boolean> {
  const a = await tx.riskAssessment.findUnique({ where: { id: assessmentId }, select: { status: true } })
  return a !== null && OPEN.has(a.status)
}

/** The open assessment of a supplier the agent may draft for again after one of its documents is verified (job risk-ai-draft) */
export async function openRiskAssessmentIdOf(organizationId: string, supplierId: string): Promise<string | null> {
  const a = await forTenant(organizationId).riskAssessment.findFirst({ where: { supplierId, status: { in: [...OPEN_STATES] } }, select: { id: true } })
  return a?.id ?? null
}

// ---------- RISK_FILE_SUMMARY: one reviewer's part ----------

export interface RiskSummaryQuestion {
  readonly code: string
  readonly domain: string
  /** The words of the option chosen, or null when unanswered */
  readonly answer: string | null
  readonly source: 'EXPLICIT' | 'EVIDENCE' | 'ON_BEHALF' | null
  readonly files: number
}

export interface RiskSummarySource {
  readonly taskId: string
  readonly assessmentId: string
  readonly number: string
  readonly supplierCode: string
  readonly domains: readonly string[]
  readonly questions: readonly RiskSummaryQuestion[]
  readonly files: readonly RiskAiFile[]
}

/**
 * For the job risk-ai-summary (SYSTEM ctx): an OPEN reviewer's task of an assessment in review, and of its assessment only
 * what the slot's domains show (INV-RSK-05 · BR-RSK-08); files within BR-AI-34's scope. null skip codes as for the draft.
 */
export async function riskSummarySource(tx: TenantTx, ctx: Ctx, taskId: string): Promise<{ readonly ok: true; readonly data: RiskSummarySource } | { readonly ok: false; readonly skip: DraftSkip }> {
  if (!(await requireModule(ctx, 'RISK', tx)).ok) return { ok: false, skip: 'MODULE_DISABLED' }
  const task = await tx.reviewTask.findFirst({ where: { id: taskId }, select: { id: true, status: true, assessmentId: true, reviewRound: true, riskDomains: true } })
  if (!task) return { ok: false, skip: 'NOT_FOUND' }
  const a = await loadForAi(tx, task.assessmentId)
  if (!a) return { ok: false, skip: 'NOT_FOUND' }
  if (task.status !== 'OPEN' || a.status !== 'IN_REVIEW' || a.reviewRound !== task.reviewRound) return { ok: false, skip: 'CLOSED' }
  const org = await tx.organization.findUniqueOrThrow({ where: { id: ctx.organizationId }, select: { settings: true } })
  const decision = shouldDraftFor({ payeeType: a.payeeType, aiAssist: riskSettingsOf(org.settings).aiAssist })
  if (!decision.draft) return { ok: false, skip: decision.reason }
  const domains = [...new Set(['GENERAL', ...task.riskDomains])]
  const set = questionsInSet(a.questionnaire.questions.map(questionDefOf), contextOf(a), a.inherentTier).filter((q) => domains.includes(q.domain))
  const codes = new Set(set.map((q) => q.code))
  const stored = new Map(a.questionnaire.questions.map((q) => [q.code, q]))
  const answers = a.answers.filter((x) => codes.has(x.questionCode) && x.optionCode !== null)
  const links = answers.length ? await tx.fileLink.groupBy({ by: ['subjectId'], where: { kind: 'RISK_EVIDENCE', subjectType: 'RiskAnswer', subjectId: { in: answers.map((x) => x.id) } }, _count: { _all: true } }) : []
  const questions = set.map((q) => {
    const answer = answers.find((x) => x.questionCode === q.code)
    const option = answer ? storedOptions(stored.get(q.code)!.options).find((o) => o.code === answer.optionCode) : undefined
    return {
      code: q.code,
      domain: q.domain,
      answer: answer ? option?.labelTh || answer.optionCode : null,
      source: answer ? answer.source : null,
      files: answer ? (links.find((l) => l.subjectId === answer.id)?._count._all ?? 0) : 0,
    }
  })
  // the certificates the slot's answers rest on, and the evidence files the uploader let the AI read
  const certificateTypes = answers.some((x) => x.evidenceDocumentId)
    ? new Set((await tx.supplierDocument.findMany({ where: { id: { in: answers.map((x) => x.evidenceDocumentId).filter((d): d is string => d !== null) } }, select: { documentTypeCode: true } })).map((d) => d.documentTypeCode))
    : new Set<string>()
  const files = await filesFor(tx, a, codes, dateIn(ctx.now, RISK_TIMEZONE), certificateTypes)
  return { ok: true, data: { taskId: task.id, assessmentId: a.id, number: a.number ?? '', supplierCode: a.supplier.code, domains, questions, files } }
}

// ---------- what the pages show ----------

/** AI is on for the Risk Agent here: the system, module AI, the agent (agentSwitchedOn), and settings.risk.aiAssist */
export async function riskAiOn(tx: TenantTx, ctx: Ctx): Promise<boolean> {
  const org = await tx.organization.findUniqueOrThrow({ where: { id: ctx.organizationId }, select: { settings: true } })
  if (!riskSettingsOf(org.settings).aiAssist) return false
  return (await agentSwitchedOn(ctx, 'RISK', tx)).ok
}

export interface RiskAiSuggestion {
  readonly questionCode: string
  readonly optionCode: string
  readonly confidenceBp: number
  /** The check that did not pass (ai-risk-verify), if any */
  readonly check: { readonly code: RiskCheckCode; readonly result: 'WARN' | 'FAIL' } | null
  readonly quote: string | null
  /** Where it was read: a document by its type, or an evidence file by its name */
  readonly source: { readonly kind: 'DOCUMENT' | 'EVIDENCE'; readonly name: string } | null
  readonly confirmed: boolean
  /** Saved as it was proposed and not confirmed yet: it holds the send back (AI_REVIEW_PENDING) */
  readonly pending: boolean
}

export interface RiskAiDraftView {
  readonly agentActionId: string
  /** Taken into the assessment once already (the person confirmed or saved one of its answers) */
  readonly applied: boolean
  readonly suggestions: readonly RiskAiSuggestion[]
}

interface StoredDraft {
  readonly answers?: ReadonlyArray<{ questionCode?: unknown; optionCode?: unknown; sourceRef?: unknown; quote?: unknown }>
}
interface StoredRefs {
  readonly files?: ReadonlyArray<{ label?: unknown; kind?: unknown; ref?: unknown }>
}

/**
 * The open draft of an assessment (BR-AI-17): a draft taken in whose answers still wait is shown even while AI is off
 * (the send waits for it); one nobody took in is the AI's alone and shows only while AI is on (EG-1 · AC6), the newest.
 */
async function draftView(tx: TenantTx, assessmentId: string, aiOn: boolean): Promise<RiskAiDraftView | null> {
  const open = (await openAssists(tx, { type: RISK_ASSIST_TYPE, id: assessmentId })).filter((x) => x.purpose === 'RISK_ANSWER_DRAFT')
  if (open.length === 0) return null
  const rows = await tx.agentAction.findMany({ where: { id: { in: open.map((x) => x.agentActionId) } }, select: { id: true, appliedAt: true, output: true, verification: true, fieldConfidence: true, inputRefs: true } })
  const taken = new Set(rows.filter((r) => r.appliedAt !== null).map((r) => r.id))
  const waiting = open.find((x) => taken.has(x.agentActionId) && x.pendingPaths.length > 0)
  const chosen = waiting ?? (aiOn ? (open.filter((x) => !taken.has(x.agentActionId)).at(-1) ?? open.at(-1)) : undefined)
  if (!chosen) return null
  const row = rows.find((r) => r.id === chosen.agentActionId)!
  const output = (row.output ?? {}) as StoredDraft
  const checks = (((row.verification ?? {}) as { checks?: unknown }).checks ?? []) as ReadonlyArray<{ questionCode: string; code: RiskCheckCode; result: 'WARN' | 'FAIL' }>
  const confidence = (row.fieldConfidence ?? {}) as Record<string, number>
  const refs = ((row.inputRefs ?? {}) as StoredRefs).files ?? []
  const docIds = refs.filter((f) => f.kind === 'DOCUMENT' && typeof f.ref === 'string').map((f) => f.ref as string)
  const fileIds = refs.filter((f) => f.kind === 'EVIDENCE' && typeof f.ref === 'string').map((f) => f.ref as string)
  const [docs, files] = await Promise.all([
    docIds.length ? tx.supplierDocument.findMany({ where: { id: { in: docIds } }, select: { id: true, documentTypeCode: true } }) : [],
    fileIds.length ? tx.fileObject.findMany({ where: { id: { in: fileIds } }, select: { id: true, fileName: true } }) : [],
  ])
  const sourceOf = (label: unknown): RiskAiSuggestion['source'] => {
    const ref = refs.find((f) => f.label === label)
    if (!ref || typeof ref.ref !== 'string') return null
    if (ref.kind === 'DOCUMENT') {
      const d = docs.find((x) => x.id === ref.ref)
      return d ? { kind: 'DOCUMENT', name: d.documentTypeCode } : null
    }
    const f = files.find((x) => x.id === ref.ref)
    return f ? { kind: 'EVIDENCE', name: f.fileName } : null
  }
  const pending = new Set(chosen.pendingPaths)
  const confirmed = new Set(chosen.confirmedPaths)
  const suggestions: RiskAiSuggestion[] = []
  // in the order the agent answered (a JSON column does not keep the order of its keys)
  const order = (output.answers ?? []).map((x) => x.questionCode)
  const at = (path: string) => {
    const i = order.indexOf(questionOfPath(path))
    return i < 0 ? order.length : i
  }
  for (const [path, optionCode] of Object.entries(chosen.proposed).sort(([a], [b]) => at(a) - at(b) || a.localeCompare(b))) {
    const code = questionOfPath(path)
    if (!code) continue
    const read = (output.answers ?? []).find((x) => x.questionCode === code)
    const check = checks.find((c) => c.questionCode === code)
    suggestions.push({
      questionCode: code,
      optionCode,
      confidenceBp: typeof confidence[path] === 'number' ? confidence[path]! : 0,
      check: check ? { code: check.code, result: check.result } : null,
      quote: typeof read?.quote === 'string' && read.quote.trim() !== '' ? read.quote.trim() : null,
      source: sourceOf(read?.sourceRef),
      confirmed: confirmed.has(path),
      pending: pending.has(path),
    })
  }
  return { agentActionId: chosen.agentActionId, applied: taken.has(chosen.agentActionId), suggestions }
}

/** The proposed answers for PROCUREMENT on /risk/assessments/[id] (risk.assessment.manage · RISK on) */
export async function riskAiDraftOf(ctx: Ctx, assessmentId: string): Promise<RiskAiDraftView | null> {
  if (ctx.actor.type !== 'USER') return null
  return forTenant(ctx.organizationId).$transaction(async (tx) => {
    if (!(await requireModule(ctx, 'RISK', tx)).ok) return null
    if (!(await authorize(tx, ctx, 'risk.assessment.manage')).ok) return null
    if (!(await riskAssessmentOpen(tx, assessmentId))) return null
    return draftView(tx, assessmentId, await riskAiOn(tx, ctx))
  })
}

/** The proposed answers for the supplier's contact on /portal/[org]/risk/[id]: its own supplier's open assessment only */
export async function portalRiskAiDraft(ctx: Ctx, assessmentId: string): Promise<RiskAiDraftView | null> {
  if (ctx.actor.type !== 'SUPPLIER' || ctx.channel !== 'PORTAL') return null
  const supplierId = ctx.actor.supplierId
  return forTenant(ctx.organizationId).$transaction(async (tx) => {
    if (!(await requireModule(ctx, 'RISK', tx)).ok) return null
    const a = await tx.riskAssessment.findFirst({ where: { id: assessmentId, supplierId }, select: { status: true } })
    if (!a || !OPEN.has(a.status)) return null
    return draftView(tx, assessmentId, await riskAiOn(tx, ctx))
  })
}

/** A path of the form answered, as the commands take it in aiAssist.confirmedPaths */
export function confirmedPathsOf(codes: readonly string[]): string[] {
  return [...new Set(codes)].map(riskAnswerPath)
}

// ---------- the summary a reviewer reads (written by the agent's job; read here without the AI) ----------

export type RiskFacts = Readonly<Record<string, TextValue>>

/** The facts of a reviewer's part, from code (BR-AI-03): codes, counts and the words of the options chosen */
export function riskFacts(s: RiskSummarySource): RiskFacts {
  const integer = (value: number): TextValue => ({ kind: 'integer', value })
  const out: Record<string, TextValue> = {
    assessment: { kind: 'ref', value: s.number },
    supplier: { kind: 'ref', value: s.supplierCode },
    questionCount: integer(s.questions.length),
    answeredCount: integer(s.questions.filter((q) => q.answer !== null).length),
    missingCount: integer(s.questions.filter((q) => q.answer === null).length),
    evidenceCount: integer(s.questions.filter((q) => q.source === 'EVIDENCE').length),
    fileCount: integer(s.questions.reduce((n, q) => n + q.files, 0)),
  }
  for (const q of s.questions) {
    out[`${q.code}.code`] = { kind: 'ref', value: q.code }
    out[`${q.code}.answer`] = { kind: 'text', value: q.answer ?? '-' }
    if (q.source) out[`${q.code}.source`] = { kind: 'enum', value: q.source }
  }
  return out
}

export interface RiskSummaryDto {
  readonly agentActionId: string
  readonly sentences: readonly string[]
  /** Codes of the slot's questions whose answer a file contradicts */
  readonly inconsistentQuestionCodes: readonly string[]
}

/**
 * The box "สรุปโดย AI" of a reviewer's task, for whoever reads the task (riskReviewTask checks it), while AI is on: the
 * summary of the task, filled in again from today's facts and checked again (BR-AI-27); null otherwise (EG-1 · AC6)
 */
export async function riskSummaryOf(ctx: Ctx, taskId: string): Promise<RiskSummaryDto | null> {
  const page = await riskReviewTask(ctx, taskId)
  if (!page.ok) return null
  const db = forTenant(ctx.organizationId)
  return db.$transaction(async (tx) => {
    if (!(await riskAiOn(tx, ctx))) return null
    const row = await tx.agentAction.findFirst({ where: { idempotencyKey: `risk_summary:${taskId}`, purpose: 'RISK_FILE_SUMMARY', status: 'DRAFT', contentPurgedAt: null }, select: { id: true, output: true } })
    if (!row) return null
    const o = (row.output ?? {}) as { sentences?: string[]; factKeys?: string[]; inconsistentQuestionCodes?: string[] }
    if (!o.sentences) return null
    const source = await riskSummarySource(tx, systemCtx(ctx.organizationId, ctx.now, 'risk-ai-summary'), taskId)
    // the task closed or the assessment moved on: the words were for the file as it was
    if (!source.ok) return null
    const facts = riskFacts(source.data)
    if (!(o.factKeys ?? []).every((k) => Object.hasOwn(facts, k))) return null
    const checked = checkAiText(o.sentences, facts, RISK_PROFILE, DECISION_ADVICE_WORDS)
    if (!checked.ok) return null
    const seen = new Set(page.data.questions.map((q) => q.code))
    return { agentActionId: row.id, sentences: checked.rendered, inconsistentQuestionCodes: (o.inconsistentQuestionCodes ?? []).filter((c) => seen.has(c)) }
  })
}
