import { z } from 'zod'
import type { AppError } from '@/core/result'
import {
  assessmentCompleteness,
  evidenceSource,
  inherentTier,
  questionsInSet,
  reviewDates,
  riskStatusAt,
  scoreAssessment,
  type AnswerSource,
  type RiskContext,
  type RiskQuestionDef,
  type RiskTierCode,
  type Screening,
} from '@/core/risk'
import { RISK_ASSESSMENT_MACHINE, transition, type RiskAssessmentCommand, type RiskAssessmentState } from '@/core/state-machines'
import { addBusinessMinutes } from '@/core/sla'
import { dateIn } from '@/core/supplier-docs'
import { BUSINESS_DAY_MINUTES, RISK_TEXT_MAX } from '@/lib/constants'
import { riskSettingsOf, supplierSettingsOf } from '@/lib/org-settings'
import { authorize } from '@/server/authz'
import { systemCtx, type Ctx } from '@/server/context'
import { lockRowsForUpdate } from '@/server/db/sql/locks'
import { forTenant, type TenantTx } from '@/server/db/tenant'
import { loadBusinessCalendar } from '@/server/doa/policy'
import type { EventDraft } from '@/server/events/append'
import type { OutboxDraft } from '@/server/events/outbox'
import type { NotificationDraft } from '@/server/notifications/create'
import { enqueueSupplierNotice } from '@/server/notifications/supplier-notices'
import { applyAiAssist, assertNoPendingAiReview, type AiAssist } from '../ai/assist-contract'
import { defineCommand, runCommand, type CommandOutcome, type RunOptions } from '../_pipeline'
import { requireModule } from '../modules'
import { issueDocumentNumber } from '../numbering'
import { issuePortalLink } from '../suppliers/links'
import { storedOptions, questionnaireInEffect } from './questionnaire'
import { RISK_SUPPLIER_TEMPLATES } from './templates'
import { riskPolicyInEffect, riskTiersInEffect } from './tiers'
import { reviewSlotsFor, withReviewerGapReport } from './reviewers'

// Risk assessments (S11-05 · FR-RSK-201 · BR-RSK-01 BR-RSK-03 to 06 BR-RSK-13 BR-RSK-14 · ADR-221 ADR-224): PROCUREMENT
// opens one for a supplier (from a PO, a request, or the supplier's page) with the questionnaire version in effect and
// the screening of the work; questions a verified certificate answers are filled from evidence; the supplier's contact
// answers in the portal (or PROCUREMENT fills in for it) and sends; the points and the tier are frozen at the send, with
// the thresholds of the moment (scoringSnapshot). With no reviewer rule matching it completes at once and becomes the
// supplier's current assessment (the one before it SUPERSEDED, open reassessments DONE). Every command needs RISK on.

type Fail = { readonly ok: false; readonly error: AppError }
const fail = (code: AppError['code'], message: string, details?: Record<string, unknown>): Fail => ({ ok: false, error: { code, message, ...(details ? { details } : {}) } })

export const RISK_TIMEZONE = 'Asia/Bangkok'
const YN = z.enum(['Y', 'N'])
const ScreeningInput = z.strictObject({ processesPersonalData: YN, accessesSystems: YN, accessesPremises: YN })
const SCREENING_KEYS = ['processesPersonalData', 'accessesSystems', 'accessesPremises'] as const
const CATEGORY = z.string().trim().min(1).max(30)
const OPEN_STATUSES = ['DRAFT', 'IN_REVIEW', 'RETURNED'] as const

// ---------- who acts ----------

type Actor = { readonly kind: 'MEMBER'; readonly memberId: string } | { readonly kind: 'CONTACT'; readonly contactId: string; readonly supplierId: string }

/** PROCUREMENT with risk.assessment.manage (a member) — RISK on */
async function managerOf(tx: TenantTx, ctx: Ctx): Promise<{ ok: true; memberId: string } | Fail> {
  const on = await requireModule(ctx, 'RISK', tx)
  if (!on.ok) return { ok: false, error: on.error }
  const may = await authorize(tx, ctx, 'risk.assessment.manage')
  if (!may.ok) return { ok: false, error: may.error }
  if (may.data.kind !== 'member') return fail('FORBIDDEN', 'members only')
  return { ok: true, memberId: may.data.memberId }
}

/**
 * What a contact may do with an assessment (the rules of portal.risk.* in src/server/portal/authz.ts, which services do not
 * import): a portal request of the contact of an ACTIVE supplier, on its own supplier's assessment while DRAFT or
 * RETURNED. Another supplier's assessment is answered as if it did not exist (INV-RSK-05).
 */
export async function contactMay(tx: TenantTx, ctx: Ctx, assessment: { supplierId: string; status: string }, action: string): Promise<{ ok: true } | Fail> {
  if (ctx.actor.type !== 'SUPPLIER' || ctx.channel !== 'PORTAL') return fail('FORBIDDEN', 'not a portal request', { action })
  if (ctx.actor.supplierId !== assessment.supplierId) return fail('NOT_FOUND', 'assessment not found')
  const supplier = await tx.supplier.findUniqueOrThrow({ where: { id: assessment.supplierId }, select: { status: true } })
  if (supplier.status !== 'ACTIVE' || (assessment.status !== 'DRAFT' && assessment.status !== 'RETURNED')) return fail('FORBIDDEN', `the contact may not ${action}`, { action })
  return { ok: true }
}

/** The contact of the assessment's supplier in the portal (BR-RSK-17), or PROCUREMENT filling in for it */
async function answererOf(tx: TenantTx, ctx: Ctx, assessment: { supplierId: string; status: string }, action: 'portal.risk.answer' | 'portal.risk.submit'): Promise<{ ok: true; actor: Actor } | Fail> {
  const on = await requireModule(ctx, 'RISK', tx)
  if (!on.ok) return { ok: false, error: on.error }
  if (ctx.actor.type === 'SUPPLIER') {
    const may = await contactMay(tx, ctx, assessment, action)
    if (!may.ok) return may
    const org = await tx.organization.findUniqueOrThrow({ where: { id: ctx.organizationId }, select: { settings: true } })
    if (!riskSettingsOf(org.settings).portalAnswering) return fail('FORBIDDEN', 'the organization answers for its suppliers', { reason: 'PORTAL_ANSWERING_OFF' })
    return { ok: true, actor: { kind: 'CONTACT', contactId: ctx.actor.supplierContactId, supplierId: assessment.supplierId } }
  }
  const m = await managerOf(tx, ctx)
  if (!m.ok) return m
  return { ok: true, actor: { kind: 'MEMBER', memberId: m.memberId } }
}

// ---------- the context of an assessment and its questions ----------

type AssessmentRow = NonNullable<Awaited<ReturnType<typeof loadAssessment>>>
const loadAssessment = (tx: TenantTx, id: string) =>
  tx.riskAssessment.findFirst({
    where: { id },
    include: { answers: true, supplier: { select: { id: true, status: true, payeeType: true, isForeign: true, registryFlag: true } }, questionnaire: { include: { questions: { orderBy: { sortOrder: 'asc' } } } } },
  })

async function lockedAssessment(tx: TenantTx, ctx: Ctx, id: string): Promise<AssessmentRow | null> {
  await lockRowsForUpdate(tx, 'RiskAssessment', ctx.organizationId, [id])
  return loadAssessment(tx, id)
}

export const questionDefOf = (q: AssessmentRow['questionnaire']['questions'][number]): RiskQuestionDef => ({
  code: q.code,
  domain: q.domain,
  options: storedOptions(q.options),
  appliesWhen: (q.appliesWhen as RiskQuestionDef['appliesWhen']) ?? null,
  required: q.required,
  sortOrder: q.sortOrder,
  evidenceScopeRequired: q.evidenceScopeRequired,
  evidenceScope: q.evidenceScope,
})

export const contextOf = (a: Pick<AssessmentRow, 'screening' | 'categoryCodes' | 'payeeType'> & { supplier: { isForeign: boolean } }): RiskContext => ({
  screening: ScreeningInput.parse(a.screening),
  categoryCodes: a.categoryCodes,
  payeeType: a.payeeType,
  isForeign: a.supplier.isForeign,
})

/** The questions of the assessment's set: its own version, its own context and the inherent tier frozen at open */
export const questionsOf = (a: AssessmentRow): RiskQuestionDef[] => [...questionsInSet(a.questionnaire.questions.map(questionDefOf), contextOf(a), a.inherentTier)]

// ---------- evidence (BR-RSK-05) ----------

interface EvidenceDoc {
  readonly id: string
  readonly status: string
  readonly expiresOn: string
  readonly scope: string | null
  readonly documentTypeCode: string
}

/** The supplier's documents of every type linked to a question, by question code (S7's SupplierDocument, read only) */
async function evidenceDocuments(tx: TenantTx, supplierId: string): Promise<Map<string, EvidenceDoc[]>> {
  const types = await tx.supplierDocumentType.findMany({ where: { active: true, linkedRiskQuestionCodes: { isEmpty: false } }, select: { code: true, linkedRiskQuestionCodes: true } })
  const docs = await tx.supplierDocument.findMany({
    where: { supplierId, documentTypeCode: { in: types.map((t) => t.code) }, status: { in: ['VERIFIED', 'EXPIRED'] } },
    select: { id: true, status: true, expiresOn: true, scope: true, documentTypeCode: true },
    orderBy: [{ expiresOn: 'desc' }, { id: 'asc' }],
  })
  const byQuestion = new Map<string, EvidenceDoc[]>()
  for (const t of types) {
    for (const code of t.linkedRiskQuestionCodes) {
      const mine = docs.filter((d) => d.documentTypeCode === t.code).map((d) => ({ ...d, expiresOn: d.expiresOn.toISOString().slice(0, 10) }))
      byQuestion.set(code, [...(byQuestion.get(code) ?? []), ...mine])
    }
  }
  return byQuestion
}

/** The first of the documents that answers the question today (a VERIFIED one, not expired, of the right scope) */
function evidenceFor(q: RiskQuestionDef, docs: readonly EvidenceDoc[], workScopes: readonly string[], today: string): { doc: EvidenceDoc; optionCode: string } | null {
  for (const doc of docs) {
    const r = evidenceSource(q, { workScopes, document: doc, today })
    if (r.source === 'EVIDENCE') return { doc, optionCode: r.optionCode }
  }
  return null
}

/**
 * An answer cleared — by its person, or as evidence gone stale: a row with the supplier's files behind it keeps them (a
 * FileLink names its answer by id only) and loses its choice; any other row goes. An answer from a certificate cannot
 * lose its document and stay (risk_answer_shape), so its files lose their link, the files kept for the audit.
 */
async function clearAnswer(tx: TenantTx, answer: { readonly id: string; readonly source: string }): Promise<void> {
  const files = { subjectType: 'RiskAnswer', subjectId: answer.id, kind: 'RISK_EVIDENCE' } as const
  if (answer.source !== 'EVIDENCE' && (await tx.fileLink.count({ where: files })) > 0) {
    await tx.riskAnswer.update({ where: { id: answer.id }, data: { optionCode: null, points: 0, evidenceDocumentId: null } })
    return
  }
  await tx.fileLink.deleteMany({ where: files })
  await tx.riskAnswer.delete({ where: { id: answer.id } })
}

/**
 * BR-RSK-05 on save and on send: every answer that rests on a document — from evidence, or confirmed from it — is checked
 * against the document as it is today; one whose document no longer answers it is cleared (event source EVIDENCE_REVOKED).
 */
async function revokeStaleEvidence(tx: TenantTx, ctx: Ctx, a: AssessmentRow, questions: readonly RiskQuestionDef[]): Promise<{ revoked: string[]; events: EventDraft[] }> {
  const held = a.answers.filter((x) => x.evidenceDocumentId)
  if (held.length === 0) return { revoked: [], events: [] }
  const docs = await tx.supplierDocument.findMany({ where: { id: { in: held.map((x) => x.evidenceDocumentId!) } }, select: { id: true, status: true, expiresOn: true, scope: true, documentTypeCode: true } })
  const today = dateIn(ctx.now, RISK_TIMEZONE)
  const revoked: string[] = []
  for (const answer of held) {
    const q = questions.find((x) => x.code === answer.questionCode)
    const doc = docs.find((d) => d.id === answer.evidenceDocumentId)
    const current = { source: answer.source as AnswerSource, optionCode: answer.optionCode, evidenceDocumentId: answer.evidenceDocumentId }
    const r = q && doc ? evidenceSource(q, { workScopes: a.workScopes, document: { ...doc, expiresOn: doc.expiresOn.toISOString().slice(0, 10) }, current, today }) : null
    // the document still answers it (from evidence, or confirmed from it and kept as the person's own)
    if (r && r.source !== 'NONE') continue
    await clearAnswer(tx, answer)
    revoked.push(answer.questionCode)
  }
  return {
    revoked,
    events: revoked.length ? [{ type: 'risk_assessment.answered', aggregateType: 'RiskAssessment', aggregateId: a.id, data: { questionCodes: revoked, source: 'EVIDENCE_REVOKED', onBehalf: false } }] : [],
  }
}

// ---------- the supplier's projection (BR-RSK-14) ----------

/**
 * Supplier.riskTier riskStatus riskAssessedAt riskValidUntil currentRiskAssessmentId from its COMPLETED assessment, its
 * open assessment and its open reassessments, on the day of `now`; the events of what changed.
 */
export async function refreshSupplierRisk(tx: TenantTx, ctx: Ctx, supplierId: string): Promise<EventDraft[]> {
  const supplier = await tx.supplier.findUniqueOrThrow({ where: { id: supplierId }, select: { riskTier: true, riskStatus: true } })
  const current = await tx.riskAssessment.findFirst({ where: { supplierId, status: 'COMPLETED' }, select: { id: true, tier: true, completedAt: true, validUntil: true, remindOn: true } })
  const open = await tx.riskAssessment.count({ where: { supplierId, status: { in: [...OPEN_STATUSES] } } })
  const statusChanged = await tx.riskReview.count({ where: { supplierId, status: 'OPEN', reason: 'STATUS_CHANGED' } })
  const today = dateIn(ctx.now, RISK_TIMEZONE)
  let status: 'NOT_ASSESSED' | 'IN_PROGRESS' | 'CURRENT' | 'EXPIRING' | 'OVERDUE' | 'REASSESS_REQUIRED' = 'NOT_ASSESSED'
  if (current?.validUntil && current.remindOn) {
    const s = riskStatusAt({ validUntil: current.validUntil.toISOString().slice(0, 10), remindOn: current.remindOn.toISOString().slice(0, 10), today })
    status = s === 'OVERDUE' && open > 0 ? 'IN_PROGRESS' : s
  } else if (open > 0) status = 'IN_PROGRESS'
  if (statusChanged > 0) status = 'REASSESS_REQUIRED'
  const tier = (current?.tier ?? null) as RiskTierCode | null
  await tx.supplier.update({
    where: { id: supplierId },
    data: { riskTier: tier, riskStatus: status, riskAssessedAt: current?.completedAt ?? null, riskValidUntil: current?.validUntil ?? null, currentRiskAssessmentId: current?.id ?? null },
  })
  const events: EventDraft[] = []
  if (supplier.riskTier !== tier) events.push({ type: 'supplier.risk_tier_changed', aggregateType: 'Supplier', aggregateId: supplierId, data: { from: supplier.riskTier, to: tier, assessmentId: current?.id ?? null } })
  if (supplier.riskStatus !== status) events.push({ type: 'supplier.risk_status_changed', aggregateType: 'Supplier', aggregateId: supplierId, data: { from: supplier.riskStatus, to: status } })
  return events
}

// ---------- riskAssessment.open ----------

const OpenInput = z.strictObject({
  supplierId: z.uuid(),
  /** The PO that met the gate, or the request the work comes from: their screening and categories are copied */
  poId: z.uuid().optional(),
  requestId: z.uuid().optional(),
  /** From the supplier's page (or to complete what the request left out): the three answers of the work */
  screening: ScreeningInput.optional(),
  categoryCodes: z.array(CATEGORY).max(20).optional(),
  /** The standards the work asks for, compared with a certificate's scope (BR-RSK-05) */
  workScopes: z.array(z.string().trim().min(1).max(100)).max(10).default([]),
})

/** Y wins: a screening field asked of several requests is Y when any of them says Y (FR-RSK-201 AC1) */
function mergeScreening(forms: readonly unknown[]): Partial<Screening> {
  const out: Partial<Record<(typeof SCREENING_KEYS)[number], 'Y' | 'N'>> = {}
  for (const form of forms) {
    const f = (form && typeof form === 'object' ? form : {}) as Record<string, unknown>
    for (const k of SCREENING_KEYS) {
      if (f[k] === 'Y') out[k] = 'Y'
      else if (f[k] === 'N' && out[k] !== 'Y') out[k] = 'N'
    }
  }
  return out
}

async function workOf(tx: TenantTx, input: z.infer<typeof OpenInput>): Promise<{ ok: true; screening: Partial<Screening>; categories: string[] } | Fail> {
  if (input.poId) {
    const po = await tx.purchaseOrder.findFirst({ where: { id: input.poId }, select: { supplierId: true, lines: { select: { categoryCode: true, sources: { select: { requestLine: { select: { request: { select: { formData: true } } } } } } } } } })
    if (!po || po.supplierId !== input.supplierId) return fail('NOT_FOUND', 'PO not found for this supplier')
    const forms = po.lines.flatMap((l) => l.sources.map((s) => s.requestLine.request.formData))
    return { ok: true, screening: mergeScreening(forms), categories: [...new Set(po.lines.map((l) => l.categoryCode).filter((c): c is string => Boolean(c)))] }
  }
  if (input.requestId) {
    const request = await tx.request.findFirst({ where: { id: input.requestId }, select: { formData: true, lines: { select: { categoryCode: true } } } })
    if (!request) return fail('NOT_FOUND', 'request not found')
    return { ok: true, screening: mergeScreening([request.formData]), categories: [...new Set(request.lines.map((l) => l.categoryCode).filter((c): c is string => Boolean(c)))] }
  }
  return { ok: true, screening: {}, categories: [] }
}

const openCommand = defineCommand({
  name: 'riskAssessment.open',
  capability: 'risk.assessment.manage',
  input: OpenInput,
  async execute(tx, input, ctx): Promise<CommandOutcome<{ assessmentId: string; number: string; inherentTier: RiskTierCode; questions: number }>> {
    const who = await managerOf(tx, ctx)
    if (!who.ok) return who
    // one open assessment per supplier (INV-RSK-02): opens of one supplier one at a time
    const [locked] = await lockRowsForUpdate(tx, 'Supplier', ctx.organizationId, [input.supplierId])
    if (!locked) return fail('NOT_FOUND', 'supplier not found')
    const supplier = await tx.supplier.findUniqueOrThrow({ where: { id: input.supplierId }, select: { id: true, status: true, payeeType: true, isForeign: true, portalEnabled: true } })
    if (supplier.status !== 'ACTIVE') return fail('VALIDATION_FAILED', 'the supplier is not active', { reason: 'SUPPLIER_INACTIVE' })
    const open = await tx.riskAssessment.findFirst({ where: { supplierId: supplier.id, status: { in: [...OPEN_STATUSES] } }, select: { id: true, number: true } })
    if (open) return fail('RISK_ASSESSMENT_OPEN', 'the supplier has an open risk assessment', { assessmentId: open.id, number: open.number })
    const questionnaire = await questionnaireInEffect(tx, ctx.now)
    if (!questionnaire) return fail('RISK_QUESTIONNAIRE_NOT_PUBLISHED', 'no risk questionnaire is in effect')
    const policy = await riskPolicyInEffect(tx)
    if (!policy.ok) return policy
    const work = await workOf(tx, input)
    if (!work.ok) return work
    // what procurement typed completes what the requests left out; a request's Y is never turned into N
    const screening: Partial<Record<(typeof SCREENING_KEYS)[number], 'Y' | 'N'>> = { ...input.screening, ...Object.fromEntries(Object.entries(work.screening).filter(([, v]) => v === 'Y')) }
    for (const k of SCREENING_KEYS) if (screening[k] === undefined && work.screening[k] !== undefined) screening[k] = work.screening[k]
    if (SCREENING_KEYS.some((k) => screening[k] === undefined)) return fail('VALIDATION_FAILED', 'the three screening answers of the work are needed', { reason: 'SCREENING_REQUIRED', field: 'screening' })
    const context: RiskContext = { screening: screening as Screening, categoryCodes: [...new Set([...work.categories, ...(input.categoryCodes ?? [])])], payeeType: supplier.payeeType, isForeign: supplier.isForeign }
    const definitions = questionnaire.questions.map(questionDefOf)
    const inherent = inherentTier(context, policy.data)
    const set = questionsInSet(definitions, context, inherent)
    const number = await issueDocumentNumber(tx, ctx, { document: 'RSA' })
    const created = await tx.riskAssessment.create({
      data: {
        organizationId: ctx.organizationId,
        number,
        supplierId: supplier.id,
        questionnaireId: questionnaire.id,
        triggerRequestId: input.requestId ?? null,
        triggerPoId: input.poId ?? null,
        screening: context.screening,
        categoryCodes: [...context.categoryCodes],
        payeeType: supplier.payeeType,
        workScopes: input.workScopes,
        inherentTier: inherent,
        lastActivityAt: ctx.now,
        openedById: who.memberId,
      },
      select: { id: true },
    })
    // questions a certificate answers today are filled from it (BR-RSK-05 · FR-RSK-201 AC2)
    const today = dateIn(ctx.now, RISK_TIMEZONE)
    const byQuestion = await evidenceDocuments(tx, supplier.id)
    const filled: string[] = []
    for (const q of set) {
      const hit = evidenceFor(q, byQuestion.get(q.code) ?? [], input.workScopes, today)
      if (!hit) continue
      const option = q.options.find((o) => o.code === hit.optionCode)!
      await tx.riskAnswer.create({ data: { organizationId: ctx.organizationId, assessmentId: created.id, questionCode: q.code, optionCode: hit.optionCode, source: 'EVIDENCE', evidenceDocumentId: hit.doc.id, points: option.points, answeredAt: ctx.now } })
      filled.push(q.code)
    }
    const invite = await inviteToAnswer(tx, ctx, { assessmentId: created.id, number, supplierId: supplier.id, portalEnabled: supplier.portalEnabled, memberId: who.memberId })
    const projection = await refreshSupplierRisk(tx, ctx, supplier.id)
    return {
      ok: true,
      result: { assessmentId: created.id, number, inherentTier: inherent, questions: set.length },
      events: [
        { type: 'risk_assessment.opened', aggregateType: 'RiskAssessment', aggregateId: created.id, data: { supplierId: supplier.id, number, inherentTier: inherent, questionCount: set.length, evidenceAnswers: filled, triggerRequestId: input.requestId ?? null, triggerPoId: input.poId ?? null } },
        ...invite.events,
        ...projection,
      ],
      notifications: invite.notifications,
      outbox: invite.outbox,
    }
  },
})

/**
 * The e-mail with a link to answer in the portal (BR-RSK-17): to the supplier's primary active contact, when the portal
 * answers for it (risk.portalAnswering) and the supplier uses the portal; the link lives supplier.inviteLinkDays
 */
async function inviteToAnswer(
  tx: TenantTx,
  ctx: Ctx,
  input: { assessmentId: string; number: string; supplierId: string; portalEnabled: boolean; memberId: string | null; reminder?: boolean },
): Promise<{ events: EventDraft[]; notifications: NotificationDraft[]; outbox: OutboxDraft[] }> {
  const none = { events: [] as EventDraft[], notifications: [] as NotificationDraft[], outbox: [] as OutboxDraft[] }
  const org = await tx.organization.findUniqueOrThrow({ where: { id: ctx.organizationId }, select: { code: true, settings: true } })
  if (!riskSettingsOf(org.settings).portalAnswering || !input.portalEnabled) return none
  const contact = await tx.supplierContact.findFirst({ where: { supplierId: input.supplierId, status: 'ACTIVE' }, orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }], select: { id: true } })
  if (!contact) return none
  const link = await issuePortalLink(tx, { organizationId: ctx.organizationId, orgCode: org.code, contactId: contact.id, purpose: 'RISK_QUESTIONNAIRE', now: ctx.now, supplierId: input.supplierId, createdById: input.memberId })
  const notice = await enqueueSupplierNotice(tx, ctx, {
    templateKey: input.reminder ? RISK_SUPPLIER_TEMPLATES.reminder : RISK_SUPPLIER_TEMPLATES.questionnaire,
    supplierId: input.supplierId,
    contactId: contact.id,
    subjectType: 'RiskAssessment',
    subjectId: input.assessmentId,
    dedupeKey: `${input.reminder ? 'risk_reminder' : 'risk_questionnaire'}:${input.assessmentId}:${link.linkId}`,
    data: { number: input.number, url: link.url, expiresAt: link.expiresAt.toISOString() },
  })
  return { events: [{ type: 'portal_session.link_requested', aggregateType: 'SupplierContact', aggregateId: contact.id, data: { contactId: contact.id, linkId: link.linkId, purpose: 'RISK_QUESTIONNAIRE' } }, ...notice.events], notifications: notice.notifications, outbox: notice.outbox }
}

export { inviteToAnswer }

// ---------- riskAssessment.answer (the contact) · .fillOnBehalf (PROCUREMENT) ----------

const AnswerItem = z.strictObject({
  questionCode: z.string().trim().min(1).max(20),
  /** null clears the answer */
  optionCode: z.string().trim().min(1).max(20).nullable(),
  note: z.string().trim().max(500).nullable().optional(),
  /** The person confirms the answer a certificate gave: it becomes theirs and keeps the document (BR-RSK-05) */
  confirmEvidence: z.boolean().optional(),
  /** The uploader allows the AI to read the files of this answer (BR-AI-34) */
  evidenceAiReadable: z.boolean().optional(),
})
const AnswerInput = z.strictObject({
  assessmentId: z.uuid(),
  expectedVersion: z.int().min(0),
  answers: z.array(AnswerItem).min(1).max(100),
  aiAssist: z.custom<AiAssist>((v) => v === undefined || (typeof v === 'object' && v !== null)).optional(),
})

function moveOf(a: AssessmentRow, command: RiskAssessmentCommand): { ok: true; to: RiskAssessmentState } | Fail {
  const t = transition(RISK_ASSESSMENT_MACHINE, a.status, command)
  return t.ok ? { ok: true, to: t.to } : fail('INVALID_STATE_TRANSITION', `${command} is not allowed from ${a.status}`, { from: a.status, command })
}

async function saveAnswers(tx: TenantTx, ctx: Ctx, input: z.infer<typeof AnswerInput>, command: 'riskAssessment.answer' | 'riskAssessment.fillOnBehalf'): Promise<CommandOutcome<{ version: number; revoked: string[] }>> {
  const a = await lockedAssessment(tx, ctx, input.assessmentId)
  if (!a) return fail('NOT_FOUND', 'assessment not found')
  const who = await answererOf(tx, ctx, a, 'portal.risk.answer')
  if (!who.ok) return who
  if ((command === 'riskAssessment.fillOnBehalf') !== (who.actor.kind === 'MEMBER')) return fail('FORBIDDEN', 'the contact answers, procurement fills in for it')
  const move = moveOf(a, command)
  if (!move.ok) return move
  if (a.version !== input.expectedVersion) return fail('CONFLICT_VERSION', 'the assessment changed since it was opened', { currentVersion: a.version })
  const questions = questionsOf(a)
  const changed: string[] = []
  for (const item of input.answers) {
    const q = questions.find((x) => x.code === item.questionCode)
    if (!q) return fail('VALIDATION_FAILED', `${item.questionCode} is not a question of this assessment`, { reason: 'QUESTION_NOT_IN_SET', questionCode: item.questionCode })
    const existing = a.answers.find((x) => x.questionCode === item.questionCode)
    if (existing?.source === 'EVIDENCE') {
      // an answer from evidence is not changed by hand; the person may confirm it (it becomes theirs, the document kept)
      if (!item.confirmEvidence || item.optionCode !== existing.optionCode) return fail('VALIDATION_FAILED', 'an answer from a certificate is confirmed, not changed', { reason: 'EVIDENCE_LOCKED', questionCode: item.questionCode })
    }
    if (item.optionCode === null) {
      if (existing?.optionCode != null) changed.push(item.questionCode)
      if (existing) await clearAnswer(tx, existing)
      continue
    }
    const option = q.options.find((o) => o.code === item.optionCode)
    if (!option) return fail('VALIDATION_FAILED', `${item.optionCode} is not an option of ${item.questionCode}`, { reason: 'OPTION_UNKNOWN', questionCode: item.questionCode })
    const by = who.actor.kind === 'MEMBER' ? { answeredByMemberId: who.actor.memberId, answeredByContactId: null } : { answeredByContactId: who.actor.contactId, answeredByMemberId: null }
    const values = {
      optionCode: option.code,
      source: (who.actor.kind === 'MEMBER' ? 'ON_BEHALF' : 'EXPLICIT') as 'ON_BEHALF' | 'EXPLICIT',
      points: option.points,
      answeredAt: ctx.now,
      note: item.note ?? existing?.note ?? null,
      // a confirmed evidence answer keeps its document (BR-RSK-05: it is checked again on every save and send)
      evidenceDocumentId: existing?.source === 'EVIDENCE' || (existing?.evidenceDocumentId && existing.optionCode === option.code) ? existing.evidenceDocumentId : null,
      evidenceAiReadable: item.evidenceAiReadable ?? existing?.evidenceAiReadable ?? false,
      ...by,
    }
    if (existing) await tx.riskAnswer.update({ where: { id: existing.id }, data: values })
    else await tx.riskAnswer.create({ data: { organizationId: ctx.organizationId, assessmentId: a.id, questionCode: q.code, ...values } })
    changed.push(item.questionCode)
  }
  const reloaded = (await loadAssessment(tx, a.id))!
  const stale = await revokeStaleEvidence(tx, ctx, reloaded, questions)
  const ai = await applyAiAssist(tx, ctx, { type: 'RISK_ASSESSMENT', id: a.id }, input.aiAssist)
  if (!ai.ok) return ai
  const row = await tx.riskAssessment.update({
    where: { id: a.id },
    data: { lastActivityAt: ctx.now, version: { increment: 1 }, ...(who.actor.kind === 'MEMBER' ? { filledOnBehalfById: who.actor.memberId } : {}) },
    select: { version: true },
  })
  return {
    ok: true,
    result: { version: row.version, revoked: stale.revoked },
    events: [
      { type: 'risk_assessment.answered', aggregateType: 'RiskAssessment', aggregateId: a.id, data: { questionCodes: changed, source: who.actor.kind === 'MEMBER' ? 'ON_BEHALF' : 'EXPLICIT', onBehalf: who.actor.kind === 'MEMBER' } },
      ...stale.events,
      ...ai.data,
    ],
  }
}

const answerCommand = defineCommand({ name: 'riskAssessment.answer', capability: 'portal.risk.answer', input: AnswerInput, execute: (tx, input, ctx) => saveAnswers(tx, ctx, input, 'riskAssessment.answer') })
const fillOnBehalfCommand = defineCommand({ name: 'riskAssessment.fillOnBehalf', capability: 'risk.assessment.manage', input: AnswerInput, execute: (tx, input, ctx) => saveAnswers(tx, ctx, input, 'riskAssessment.fillOnBehalf') })

// ---------- riskAssessment.submit ----------

const SubmitInput = z.strictObject({ assessmentId: z.uuid(), expectedVersion: z.int().min(0) })

export interface SubmitResult {
  readonly status: 'IN_REVIEW' | 'COMPLETED'
  readonly points: number
  readonly tier: RiskTierCode
}

const submitCommand = defineCommand({
  name: 'riskAssessment.submit',
  capability: 'portal.risk.submit',
  input: SubmitInput,
  async execute(tx, input, ctx): Promise<CommandOutcome<SubmitResult>> {
    const a = await lockedAssessment(tx, ctx, input.assessmentId)
    if (!a) return fail('NOT_FOUND', 'assessment not found')
    const who = await answererOf(tx, ctx, a, 'portal.risk.submit')
    if (!who.ok) return who
    const sendable = moveOf(a, 'riskAssessment.submit')
    if (!sendable.ok) return sendable
    if (a.version !== input.expectedVersion) return fail('CONFLICT_VERSION', 'the assessment changed since it was opened', { currentVersion: a.version })
    const questions = questionsOf(a)
    // an answer whose certificate expired or was replaced is cleared before anything is counted (GC-RSK-23)
    const stale = await revokeStaleEvidence(tx, ctx, a, questions)
    const tiers = await riskTiersInEffect(tx)
    if (!tiers.ok) return tiers
    const policy = await riskPolicyInEffect(tx)
    if (!policy.ok) return policy
    const answers = (await tx.riskAnswer.findMany({ where: { assessmentId: a.id } })).filter((x) => x.optionCode !== null)
    const context = contextOf(a)
    const definitions = a.questionnaire.questions.map(questionDefOf)
    const score = scoreAssessment(definitions, tiers.data, policy.data, context, Object.fromEntries(answers.map((x) => [x.questionCode, x.optionCode!])))
    // a tier that needs the supplier's own answers does not count one from evidence (BR-RSK-06 · GC-RSK-20); the refusal
    // rolls the clearing of stale evidence back with it, so the next save clears it again
    const completeness = assessmentCompleteness(definitions, tiers.data, policy.data, context, score.tier, Object.fromEntries(answers.map((x) => [x.questionCode, x.source as AnswerSource])))
    if (!completeness.complete) return fail('RISK_ANSWERS_INCOMPLETE', 'the assessment lacks answers', { missing: completeness.missing, tier: score.tier })
    const pending = await assertNoPendingAiReview(tx, ctx, { type: 'RISK_ASSESSMENT', id: a.id })
    if (!pending.ok) return pending
    const scoringSnapshot = {
      tiers: tiers.data.map((t) => ({ code: t.code, minPoints: t.minPoints, reviewMonths: t.reviewMonths, reminderDaysBefore: t.reminderDaysBefore, requiresExplicitAnswers: t.requiresExplicitAnswers })),
      screeningTierMap: policy.data.screeningTierMap,
      highRiskCategories: [...policy.data.highRiskCategories],
    }
    const round = a.reviewRound + 1
    const slots = await reviewSlotsFor(tx, ctx, a, score.tier, round, questions)
    if (!slots.ok) return slots
    const events: EventDraft[] = [...stale.events]
    const base = { pointsTotal: score.points, tier: score.tier, scoringSnapshot, submittedAt: ctx.now, submittedByContactId: who.actor.kind === 'CONTACT' ? who.actor.contactId : null, lastActivityAt: ctx.now, reviewRound: round, version: { increment: 1 } }
    events.push({ type: 'risk_assessment.submitted', aggregateType: 'RiskAssessment', aggregateId: a.id, data: { points: score.points, tier: score.tier, reviewRound: round } })
    if (slots.data.tasks > 0) {
      await tx.riskAssessment.update({ where: { id: a.id }, data: { ...base, status: sendable.to, workflowVersionId: slots.data.workflowVersionId } })
      events.push(...slots.data.events)
      return { ok: true, result: { status: 'IN_REVIEW', points: score.points, tier: score.tier }, events, notifications: slots.data.notifications, outbox: slots.data.outbox }
    }
    const done = moveOf(a, 'riskAssessment.submit_completed')
    if (!done.ok) return done
    await tx.riskAssessment.update({ where: { id: a.id }, data: base })
    events.push(...(await completeAssessment(tx, ctx, a.id)))
    return { ok: true, result: { status: 'COMPLETED', points: score.points, tier: score.tier }, events }
  },
})

/**
 * The assessment becomes COMPLETED (from a send with no reviewer, or when every reviewer passed it · BR-RSK-07): its dates
 * from the tier in effect (BR-RSK-13), the supplier's COMPLETED one before it SUPERSEDED, the open reassessments DONE,
 * and the supplier's projection (BR-RSK-14). The assessment's tier and points are already frozen.
 */
export async function completeAssessment(tx: TenantTx, ctx: Ctx, assessmentId: string): Promise<EventDraft[]> {
  const a = await tx.riskAssessment.findUniqueOrThrow({ where: { id: assessmentId }, select: { id: true, supplierId: true, tier: true, scoringSnapshot: true } })
  const snapshot = (a.scoringSnapshot ?? {}) as { tiers?: { code: string; reviewMonths: number; reminderDaysBefore: number }[] }
  const tierDef = snapshot.tiers?.find((t) => t.code === a.tier)
  if (!tierDef) throw new Error(`the assessment ${assessmentId} has no thresholds of its tier`)
  const dates = reviewDates(ctx.now, tierDef, RISK_TIMEZONE)
  const events: EventDraft[] = []
  const before = await tx.riskAssessment.findMany({ where: { supplierId: a.supplierId, status: 'COMPLETED', id: { not: a.id } }, select: { id: true } })
  for (const old of before) {
    await tx.riskAssessment.update({ where: { id: old.id }, data: { status: 'SUPERSEDED', supersededById: a.id, version: { increment: 1 } } })
    events.push({ type: 'risk_assessment.superseded', aggregateType: 'RiskAssessment', aggregateId: old.id, data: { byAssessmentId: a.id } })
  }
  const day = (d: string) => new Date(`${d}T00:00:00Z`)
  await tx.riskAssessment.update({ where: { id: a.id }, data: { status: 'COMPLETED', completedAt: ctx.now, completedOn: day(dates.completedOn), validUntil: day(dates.validUntil), remindOn: day(dates.remindOn) } })
  events.push({ type: 'risk_assessment.completed', aggregateType: 'RiskAssessment', aggregateId: a.id, data: { tier: a.tier, validUntil: dates.validUntil } })
  const reviews = await tx.riskReview.findMany({ where: { supplierId: a.supplierId, status: 'OPEN' }, select: { id: true } })
  for (const r of reviews) {
    await tx.riskReview.update({ where: { id: r.id }, data: { status: 'DONE', completedAt: ctx.now, completedByAssessmentId: a.id } })
    events.push({ type: 'risk_review.completed', aggregateType: 'RiskReview', aggregateId: r.id, data: { byAssessmentId: a.id } })
  }
  events.push(...(await refreshSupplierRisk(tx, ctx, a.supplierId)))
  return events
}

// ---------- riskAssessment.cancel ----------

const cancelCommand = defineCommand({
  name: 'riskAssessment.cancel',
  capability: 'risk.assessment.manage',
  input: z.strictObject({ assessmentId: z.uuid(), expectedVersion: z.int().min(0), reason: z.string().trim().min(1).max(RISK_TEXT_MAX) }),
  async execute(tx, input, ctx): Promise<CommandOutcome<{ cancelledTasks: number }>> {
    const who = await managerOf(tx, ctx)
    if (!who.ok) return who
    const a = await lockedAssessment(tx, ctx, input.assessmentId)
    if (!a) return fail('NOT_FOUND', 'assessment not found')
    const move = moveOf(a, 'riskAssessment.cancel')
    if (!move.ok) return move
    if (a.version !== input.expectedVersion) return fail('CONFLICT_VERSION', 'the assessment changed since it was opened', { currentVersion: a.version })
    const tasks = await tx.reviewTask.findMany({ where: { assessmentId: a.id, status: 'OPEN' }, select: { id: true } })
    const events: EventDraft[] = []
    for (const t of tasks) {
      await tx.reviewTask.update({ where: { id: t.id }, data: { status: 'CANCELLED', cancelledWhy: 'ASSESSMENT_CANCELLED', version: { increment: 1 } } })
      events.push({ type: 'review_task.cancelled', aggregateType: 'ReviewTask', aggregateId: t.id, data: { assessmentId: a.id, why: 'ASSESSMENT_CANCELLED' } })
    }
    await tx.riskAssessment.update({ where: { id: a.id }, data: { status: move.to, version: { increment: 1 } } })
    events.unshift({ type: 'risk_assessment.cancelled', aggregateType: 'RiskAssessment', aggregateId: a.id, data: { reason: input.reason, cancelledTasks: tasks.length } })
    events.push(...(await refreshSupplierRisk(tx, ctx, a.supplierId)))
    return { ok: true, result: { cancelledTasks: tasks.length }, events }
  },
})

export const openRiskAssessment = (ctx: Ctx, input: z.input<typeof OpenInput>, options: RunOptions) => runCommand(ctx, openCommand, input, options)
export const answerRiskAssessment = (ctx: Ctx, input: z.input<typeof AnswerInput>, options: RunOptions) => runCommand(ctx, answerCommand, input, options)
export const fillRiskAssessmentOnBehalf = (ctx: Ctx, input: z.input<typeof AnswerInput>, options: RunOptions) => runCommand(ctx, fillOnBehalfCommand, input, options)
// FR-RSK-202 AC1: a send refused for a missing reviewer is told to the administrators (reviewers.ts)
export const submitRiskAssessment = async (ctx: Ctx, input: z.input<typeof SubmitInput>, options: RunOptions) =>
  withReviewerGapReport(ctx, input.assessmentId, await runCommand(ctx, submitCommand, input, options), options)
export const cancelRiskAssessment = (ctx: Ctx, input: z.input<typeof cancelCommand.input>, options: RunOptions) => runCommand(ctx, cancelCommand, input, options)

// ---------- reads ----------

export type { AssessmentRow }
export { loadAssessment }

/** For a caller's transaction: the open assessment of a supplier, if any (the PO gate and the pages) */
export async function openAssessmentOf(tx: TenantTx, supplierId: string) {
  return tx.riskAssessment.findFirst({ where: { supplierId, status: { in: [...OPEN_STATUSES] } }, select: { id: true, number: true, status: true } })
}

// ---------- the reminder of an assessment nobody touches (job risk-assessment-sla · SEAM-S7xS11-X-16) ----------

/**
 * When the reminder of an open assessment is due: supplier.applicationReminderBusinessDays business days of the
 * organization's calendar after its last activity (the setting of S7's applications, not a new one); null when the
 * assessment is no longer DRAFT or RETURNED
 */
export async function riskReminderDue(organizationId: string, assessmentId: string): Promise<{ readonly at: string; readonly lastActivityAt: string } | null> {
  return forTenant(organizationId).$transaction(async (tx) => {
    const a = await tx.riskAssessment.findFirst({ where: { id: assessmentId }, select: { status: true, lastActivityAt: true } })
    if (!a || (a.status !== 'DRAFT' && a.status !== 'RETURNED')) return null
    const org = await tx.organization.findUniqueOrThrow({ where: { id: organizationId }, select: { settings: true } })
    const days = supplierSettingsOf(org.settings).applicationReminderBusinessDays
    const calendar = await loadBusinessCalendar(tx, organizationId)
    return { at: addBusinessMinutes(a.lastActivityAt, days * BUSINESS_DAY_MINUTES, calendar).toISOString(), lastActivityAt: a.lastActivityAt.toISOString() }
  })
}

const remindCommand = defineCommand({
  name: 'riskAssessment.remind',
  capability: 'system.risk',
  input: z.strictObject({ assessmentId: z.uuid(), lastActivityAt: z.iso.datetime() }),
  async execute(tx, input, ctx): Promise<CommandOutcome<{ reminded: boolean }>> {
    const on = await requireModule(ctx, 'RISK', tx)
    if (!on.ok) return { ok: false, error: on.error }
    const a = await lockedAssessment(tx, ctx, input.assessmentId)
    if (!a) return fail('NOT_FOUND', 'assessment not found')
    const move = moveOf(a, 'riskAssessment.remind')
    if (!move.ok) return move
    // someone acted since the plan: that activity has its own run
    if (a.lastActivityAt.toISOString() !== input.lastActivityAt) return fail('VALIDATION_FAILED', 'the assessment moved since', { reason: 'ACTIVITY_SINCE' })
    const supplier = await tx.supplier.findUniqueOrThrow({ where: { id: a.supplierId }, select: { portalEnabled: true } })
    const invite = await inviteToAnswer(tx, ctx, { assessmentId: a.id, number: a.number ?? '', supplierId: a.supplierId, portalEnabled: supplier.portalEnabled, memberId: null, reminder: true })
    return {
      ok: true,
      result: { reminded: true },
      events: [{ type: 'risk_assessment.reminded', aggregateType: 'RiskAssessment', aggregateId: a.id, data: { lastActivityAt: input.lastActivityAt, emailed: invite.outbox.length > 0 } }, ...invite.events],
      notifications: invite.notifications,
      outbox: invite.outbox,
    }
  },
})

/** The reminder itself, once due: a new link by e-mail to the supplier's contact, the state kept (BR-RSK-17) */
export async function remindRiskAssessment(organizationId: string, assessmentId: string, lastActivityAt: string, now: Date): Promise<'REMINDED' | 'SKIPPED'> {
  const done = await runCommand(systemCtx(organizationId, now, 'risk-assessment-sla'), remindCommand, { assessmentId, lastActivityAt }, { idempotencyKey: `risk-assessment-sla:${assessmentId}:${lastActivityAt}` })
  return done.ok ? 'REMINDED' : 'SKIPPED'
}
