import { z } from 'zod'
import { defineEvents } from '../registry'

// Supplier risk (S11 · docs/sub-specs/S11.md "สิทธิ์ event error และการแจ้งเตือน" · §10.2): codes, ids, numbers and dates
// only — never the text of an answer or of a question (BR-RSK-20 · NFR-SEC-09).

const tier = z.enum(['LOW', 'MEDIUM', 'HIGH'])
const tierChange = z.strictObject({
  minPoints: z.int().optional(),
  reviewMonths: z.int().optional(),
  reminderDaysBefore: z.int().optional(),
  blocksPo: z.boolean().optional(),
  requiresExplicitAnswers: z.boolean().optional(),
})

// S11-04 (BR-RSK-02 · ADR-229): a proposal waits in pending*; someone else confirms it, or it is discarded
defineEvents('RiskTier', {
  'risk_tier.proposed': { schema: z.object({ code: tier, pendingChange: tierChange }) },
  'risk_tier.confirmed': {
    schema: z.object({ code: tier, changed: z.array(z.object({ field: z.string(), from: z.union([z.number(), z.boolean()]), to: z.union([z.number(), z.boolean()]) })), proposedById: z.uuid(), confirmedById: z.uuid() }),
  },
  'risk_tier.discarded': { schema: z.object({ code: tier, proposedById: z.uuid() }) },
})

defineEvents('RiskPolicy', {
  'risk_policy.proposed': { schema: z.object({ fields: z.array(z.string()), pendingChange: z.record(z.string(), z.unknown()) }) },
  'risk_policy.confirmed': { schema: z.object({ changed: z.array(z.object({ field: z.string(), from: z.unknown(), to: z.unknown() })), proposedById: z.uuid(), confirmedById: z.uuid() }) },
  'risk_policy.discarded': { schema: z.object({ fields: z.array(z.string()), proposedById: z.uuid() }) },
})

// S11-04 (BR-RSK-01 · BR-RSK-02): the versions of the questionnaire; an update names the question, not its words
defineEvents('RiskQuestionnaire', {
  'risk_questionnaire.drafted': { schema: z.object({ code: z.string(), versionNo: z.int(), copiedFromVersionNo: z.int().nullable(), questions: z.int() }) },
  'risk_questionnaire.updated': { schema: z.object({ questionCode: z.string().nullable(), action: z.enum(['ADDED', 'CHANGED', 'REMOVED', 'REORDERED']) }) },
  'risk_questionnaire.submitted': { schema: z.object({ code: z.string(), versionNo: z.int(), effectiveFrom: z.string(), questions: z.int(), warnings: z.int() }) },
  'risk_questionnaire.rejected': { schema: z.object({ code: z.string(), versionNo: z.int(), submittedById: z.uuid(), reason: z.string() }) },
  'risk_questionnaire.published': { schema: z.object({ code: z.string(), versionNo: z.int(), effectiveFrom: z.string(), submittedById: z.uuid(), publishedById: z.uuid() }) },
  'risk_questionnaire.superseded': { schema: z.object({ code: z.string(), versionNo: z.int(), supersededById: z.uuid() }) },
})

// S11-05 (FR-RSK-201 · BR-RSK-05 · BR-RSK-18): an assessment's life; question codes and ids only (BR-RSK-20)
defineEvents('RiskAssessment', {
  'risk_assessment.opened': {
    schema: z.object({ supplierId: z.uuid(), number: z.string(), inherentTier: tier, questionCount: z.int(), evidenceAnswers: z.array(z.string()), triggerRequestId: z.uuid().nullable(), triggerPoId: z.uuid().nullable() }),
  },
  'risk_assessment.answered': { schema: z.object({ questionCodes: z.array(z.string()), source: z.enum(['EXPLICIT', 'ON_BEHALF', 'EVIDENCE_REVOKED']), onBehalf: z.boolean() }) },
  'risk_assessment.evidence_uploaded': { schema: z.object({ questionCode: z.string(), fileId: z.uuid(), aiReadable: z.boolean().nullable(), by: z.enum(['CONTACT', 'MEMBER']) }) },
  'risk_assessment.evidence_rejected': { schema: z.object({ questionCode: z.string(), fileId: z.uuid() }) },
  // S11-10 (BR-RSK-18 · OQ-230): the evidence files past their keeping lost their links and bytes; FileObject stays
  'risk_assessment.evidence_purged': { schema: z.object({ fileIds: z.array(z.uuid()), reason: z.enum(['RETENTION', 'CANCELLED']) }) },
  'risk_assessment.submitted': { schema: z.object({ points: z.int(), tier, reviewRound: z.int() }) },
  'risk_assessment.completed': { schema: z.object({ tier, validUntil: z.string() }) },
  'risk_assessment.superseded': { schema: z.object({ byAssessmentId: z.uuid() }) },
  'risk_assessment.cancelled': { schema: z.object({ reason: z.string(), cancelledTasks: z.int() }) },
  'risk_assessment.reminded': { schema: z.object({ lastActivityAt: z.string(), emailed: z.boolean() }) },
  // S11-06 (BR-RSK-07 · FR-RSK-202): the round of reviewers, its return, and a send refused for a missing reviewer
  'risk_assessment.reviewers_assigned': { schema: z.object({ workflowVersionId: z.uuid(), reviewRound: z.int(), tasks: z.int() }) },
  'risk_assessment.returned': { schema: z.object({ reviewRound: z.int(), byTaskId: z.uuid(), reasonShared: z.boolean() }) },
  'risk_assessment.reviewer_gap_reported': { schema: z.object({ ruleCode: z.string().nullable(), position: z.string().nullable(), department: z.string().nullable(), notifiedAdmins: z.int() }) },
})

const domain = z.enum(['GENERAL', 'PRIVACY', 'INFOSEC', 'PREMISES', 'FINANCE'])
// S11-06 (INV-RSK-04): every decision names the workflow version, the rules and the slot it answers for
defineEvents('ReviewTask', {
  'review_task.assigned': {
    schema: z.object({
      assessmentId: z.uuid(),
      reviewRound: z.int(),
      workflowVersionId: z.uuid(),
      ruleCodes: z.array(z.string()).min(1),
      slotNo: z.int(),
      riskDomains: z.array(domain),
      assigneeMemberId: z.uuid(),
      delegatorMemberId: z.uuid().nullable(),
      fallbackUsed: z.enum(['NONE', 'VACANT', 'CONFLICT']),
      dueAt: z.string(),
      reassigned: z.boolean(),
    }),
  },
  'review_task.decided': {
    schema: z.object({
      assessmentId: z.uuid(),
      decision: z.enum(['PASS', 'RETURN']),
      workflowVersionId: z.uuid(),
      ruleCodes: z.array(z.string()).min(1),
      slotNo: z.int(),
      reviewRound: z.int(),
      decidedById: z.uuid(),
      onBehalfOf: z.uuid().nullable(),
      shareWithSupplier: z.boolean(),
    }),
  },
  'review_task.cancelled': { schema: z.object({ assessmentId: z.uuid(), why: z.enum(['STEP_DECIDED', 'ASSESSMENT_CANCELLED', 'REASSIGNED']) }) },
  // an org change moved the slot to its new holder; the task keeps its row (one per slot of a round · ADR-108)
  'review_task.reassigned': { schema: z.object({ assessmentId: z.uuid(), fromMemberId: z.uuid(), toMemberId: z.uuid(), why: z.enum(['ORG_AUTHORITY_CHANGE']) }) },
  'review_task.reminded': { schema: z.object({ assessmentId: z.uuid() }) },
  'review_task.overdue': { schema: z.object({ assessmentId: z.uuid(), dueAt: z.string() }) },
  'review_task.escalated': { schema: z.object({ assessmentId: z.uuid(), notifiedMemberIds: z.array(z.uuid()), toFallback: z.boolean() }) },
})

const reviewReason = z.enum(['SCHEDULED', 'STATUS_CHANGED', 'OVERRIDE_EXPIRED'])
defineEvents('RiskReview', {
  'risk_review.completed': { schema: z.object({ byAssessmentId: z.uuid() }) },
  // S11-09 (FR-RSK-205 · BR-RSK-12 BR-RSK-13): a reassessment due — at remindOn (with the assessment the job opened for it),
  // after a registry flag, or after an override expired with no valid assessment behind the supplier
  'risk_review.scheduled': {
    schema: z.object({
      supplierId: z.uuid(),
      reason: reviewReason,
      tier: tier.nullable(),
      dueAt: z.string(),
      sourceAssessmentId: z.uuid().nullable(),
      sourceOverrideId: z.uuid().nullable(),
      registryFlag: z.enum(['CEASED', 'VAT_CANCELLED', 'NOT_FOUND']).nullable(),
      openedAssessmentId: z.uuid().nullable(),
    }),
  },
  // past its dueAt (the job, the day the supplier turns OVERDUE): the state stays OPEN
  'risk_review.overdue': { schema: z.object({ dueAt: z.string() }) },
  'risk_review.cancelled': { schema: z.object({ reason: z.enum(['SUPPLIER_INACTIVE', 'REGISTRY_CLEARED']) }) },
})

// S11-05 (BR-RSK-14): the supplier's risk projection, only when a value changes
const riskStatus = z.enum(['NOT_ASSESSED', 'IN_PROGRESS', 'CURRENT', 'EXPIRING', 'OVERDUE', 'REASSESS_REQUIRED'])
defineEvents('Supplier', {
  'supplier.risk_tier_changed': { schema: z.object({ from: tier.nullable(), to: tier.nullable(), assessmentId: z.uuid().nullable() }) },
  'supplier.risk_status_changed': { schema: z.object({ from: riskStatus, to: riskStatus }) },
})

// S11-07 (BR-RSK-09 · FR-RSK-203 · INV-RSK-01): the gate a PO passed, and an override's use by POs — counted once per PO,
// its share moved with the PO's gross, released when the PO no longer draws on it. No event when the gate refuses.
const gateTrigger = z.enum(['SUBMIT', 'SEND', 'PO_CHANGE'])
const gateWarning = z.enum(['REGISTRY_FLAGGED', 'REASSESSMENT_OVERDUE', 'OVERRIDE_USED'])
const satang = z.string().regex(/^\d+$/)
defineEvents('PurchaseOrder', {
  'po.risk_gate_passed': {
    schema: z.object({
      tier,
      inherentTier: tier,
      source: z.enum(['NOT_REQUIRED', 'ASSESSMENT', 'OVERRIDE']),
      trigger: gateTrigger,
      assessmentId: z.uuid().nullable(),
      overrideId: z.uuid().nullable(),
      warnings: z.array(gateWarning),
      grossSatang: satang,
      reasonCommentId: z.uuid().nullable(),
    }),
  },
})
// S11-08 (BR-RSK-10 BR-RSK-11 · ADR-226): an override asked, edited, sent under DOA RISK_OVERRIDE and decided — its cap, last
// day and the PO it names; never the reason's text (it stays on the row and in the Comment of a return or a rejection)
const overrideFields = z.enum(['reason', 'capGrossSatang', 'expiresOn', 'poId'])
const day = z.iso.date()
defineEvents('RiskOverride', {
  'risk_override.used': { schema: z.object({ poId: z.uuid(), grossSatang: satang, trigger: gateTrigger }) },
  'risk_override.released': { schema: z.object({ poId: z.uuid(), grossSatang: satang, trigger: gateTrigger }) },
  'risk_override.drafted': { schema: z.object({ supplierId: z.uuid(), capGrossSatang: satang, expiresOn: day, poId: z.uuid().nullable(), assessmentId: z.uuid().nullable() }) },
  'risk_override.updated': { schema: z.object({ fields: z.array(overrideFields), from: z.enum(['DRAFT', 'RETURNED']) }) },
  'risk_override.submitted': {
    schema: z.object({ number: z.string(), capGrossSatang: satang, expiresOn: day, poId: z.uuid().nullable(), assessmentId: z.uuid().nullable(), routeId: z.uuid(), resubmitted: z.boolean() }),
  },
  'risk_override.approved': { schema: z.object({ number: z.string(), capGrossSatang: satang, expiresOn: day }) },
  'risk_override.rejected': { schema: z.object({ number: z.string(), reasonCommentId: z.uuid().nullable() }) },
  'risk_override.returned': { schema: z.object({ number: z.string(), reasonCommentId: z.uuid().nullable() }) },
  'risk_override.cancelled': { schema: z.object({ from: z.enum(['DRAFT', 'RETURNED']) }) },
  // S11-09 (job risk-review-daily · BR-RSK-10): its last day within seven days (told once), and past it — EXPIRED
  'risk_override.expiring': { schema: z.object({ number: z.string().nullable(), expiresOn: day, daysLeft: z.int().min(0) }) },
  'risk_override.expired': { schema: z.object({ number: z.string().nullable(), expiresOn: day, usedCount: z.int(), usedGrossSatang: satang, reviewScheduled: z.boolean() }) },
})
