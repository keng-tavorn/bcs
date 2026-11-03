import { z } from 'zod'
import { BP_WHOLE } from '@/lib/constants'
import { defineEvents } from '../registry'

// AI module events (spec §10.2 rows agent_action ai_agent ai_credit, docs/sub-specs/S13.md). AgentAction events never
// carry what the member typed or what the model answered (NFR-SEC-09): the content stays on the row, where BR-AI-18
// clears it. Events whose actor is AI_AGENT belong to AgentAction only (INV-AI-01).

const agent = z.enum(['DOCUMENT', 'INTAKE', 'APPROVAL_BRIEF', 'INSIGHT', 'DOA_DRAFTER'])
const purpose = z.enum(['QUOTATION_READ', 'DELIVERY_NOTE_READ', 'INVOICE_READ', 'INTAKE', 'BRIEF', 'QUESTION', 'DOA_DRAFT'])
const level = z.enum(['L0', 'L1'])
const subject = { subjectType: z.string().min(1), subjectId: z.uuid() }
const tokens = {
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  cacheReadTokens: z.number().int().nonnegative(),
  cacheWriteTokens: z.number().int().nonnegative(),
  costCredits: z.number().int().nonnegative(),
}
const periodMonth = z.iso.date()

defineEvents('AgentAction', {
  'agent_action.requested': {
    schema: z.object({ agent, purpose, level, promptVersion: z.string().min(1), subjectType: z.string().min(1).nullable(), subjectId: z.uuid().nullable() }),
  },
  // The model that answered (BR-AI-04) and what the call cost
  'agent_action.drafted': { schema: z.object({ model: z.string().min(1), latencyMs: z.number().int().nonnegative().nullable(), ...tokens }) },
  // errorCode: AI_MODEL_MISMATCH AI_OUTPUT_INVALID AI_REFUSED AI_FILE_TOO_LONG FIXTURE_MISSING EXTERNAL_SERVICE_ERROR TIMEOUT
  'agent_action.failed': { schema: z.object({ errorCode: z.string().min(1), model: z.string().min(1).nullable(), ...tokens }) },
  // A document command took the values in (BR-AI-17): pending = fields still to confirm
  'agent_action.applied': { schema: z.object({ ...subject, pending: z.number().int().positive() }) },
  'agent_action.accepted': { schema: z.object(subject) },
  'agent_action.edited': { schema: z.object({ ...subject, changedPaths: z.array(z.string().min(1)).min(1) }) },
  'agent_action.rejected': { schema: z.object({}) },
  'agent_action.expired': { schema: z.object({ reason: z.enum(['SUPERSEDED', 'SUBJECT_CLOSED', 'STALE']) }) },
  'agent_action.feedback_given': { schema: z.object({ feedback: z.enum(['HELPFUL', 'NOT_HELPFUL']) }) },
  // BR-AI-18: inputText and output cleared; the row keeps its metadata, credits and diff
  'agent_action.content_purged': { schema: z.object({ reason: z.enum(['CHAT_INTAKE_UNUSED', 'UNUSED_AFTER_RETENTION']) }) },
})

const setting = { agent, level, minConfidenceBp: z.number().int().min(0).max(BP_WHOLE) }
defineEvents('AiAgentSetting', {
  'ai_agent.enabled': { schema: z.object(setting) },
  'ai_agent.disabled': { schema: z.object(setting) },
  'ai_agent.updated': { schema: z.object(setting) },
})

// aggregateId = the organization: the credits of an organization are one account per month
defineEvents('AiCredit', {
  'ai_credit.granted': {
    schema: z.object({
      ledgerEntryId: z.uuid(),
      source: z.enum(['MONTHLY', 'TOPUP']),
      credits: z.number().int().positive(),
      periodMonth,
      contractRef: z.string().min(1).nullable(),
    }),
  },
  // The BCS team set the monthly amount or the alert share (settings.ai, platform.ai.credits)
  'ai_credit.monthly_set': { schema: z.object({ monthlyCredits: z.number().int().positive(), alertAtBp: z.number().int().min(1).max(BP_WHOLE), contractRef: z.string().min(1) }) },
  'ai_credit.threshold_reached': { schema: z.object({ periodMonth, granted: z.number().int().nonnegative(), used: z.number().int().nonnegative(), alertAtBp: z.number().int() }) },
  'ai_credit.exhausted': { schema: z.object({ periodMonth, granted: z.number().int().nonnegative(), used: z.number().int().nonnegative() }) },
})
