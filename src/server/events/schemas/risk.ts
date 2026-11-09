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

defineEvents('RiskReview', {
  'risk_review.completed': { schema: z.object({ byAssessmentId: z.uuid() }) },
})

// S11-05 (BR-RSK-14): the supplier's risk projection, only when a value changes
const riskStatus = z.enum(['NOT_ASSESSED', 'IN_PROGRESS', 'CURRENT', 'EXPIRING', 'OVERDUE', 'REASSESS_REQUIRED'])
defineEvents('Supplier', {
  'supplier.risk_tier_changed': { schema: z.object({ from: tier.nullable(), to: tier.nullable(), assessmentId: z.uuid().nullable() }) },
  'supplier.risk_status_changed': { schema: z.object({ from: riskStatus, to: riskStatus }) },
})
