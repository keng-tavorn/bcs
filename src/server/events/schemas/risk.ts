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
