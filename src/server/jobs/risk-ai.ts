import { z } from 'zod'
import { systemClock } from '@/lib/clock'
import { inngest } from '@/server/inngest'
import { closeRiskDrafts, draftRiskAnswers, writeRiskSummary } from '@/server/services/ai'
import { openRiskAssessmentIdOf } from '@/server/services/risk'

// The Risk Agent's jobs (S11-13 · FR-AI-306 · BR-AI-33 · docs/sub-specs/S11.md "job Inngest ใหม่"):
//  - risk-ai-draft: after risk_assessment.opened or .returned, and after supplier_document.verified of a supplier with an
//    assessment open, the agent proposes answers (a DRAFT the contact or procurement confirms one by one). A debounce of
//    20 seconds per subject and one run at a time per subject; every gate of BR-AI-11, settings.risk.aiAssist and
//    shouldDraftFor are checked inside (a refusal is a skip · EG-1). After .submitted or .cancelled the drafts nobody took
//    in expire SUBJECT_CLOSED (BR-AI-18).
//  - risk-ai-summary: after review_task.assigned, the summary of the slot's own part, key risk_summary:<taskId>; never in a
//    LINE card (BR-NOTI-01): the reviewer's page and LIFF show it in a box of its own.

const Payload = z.object({ organizationId: z.uuid(), aggregateId: z.uuid() })
const Verified = z.object({ organizationId: z.uuid(), data: z.object({ supplierId: z.uuid().nullable() }).loose() })

export const RISK_AI_DRAFT_DEBOUNCE = '20s'

export interface RiskAiStep {
  run<T>(id: string, fn: () => Promise<T>): Promise<T>
}

/** One run of risk-ai-draft, called directly by tests with their own step */
export async function riskAiDraftRun(event: { name?: string; data: unknown }, step: RiskAiStep): Promise<string> {
  if (event.name === 'bcs/supplier_document.verified') {
    const p = Verified.safeParse(event.data)
    if (!p.success || !p.data.data.supplierId) return 'IGNORED'
    const { organizationId } = p.data
    const supplierId = p.data.data.supplierId
    const open = await step.run('find', () => openRiskAssessmentIdOf(organizationId, supplierId))
    if (!open) return 'SKIPPED_NO_OPEN_ASSESSMENT'
    return step.run('draft', () => draftRiskAnswers(organizationId, open, systemClock.now()))
  }
  const p = Payload.safeParse(event.data)
  if (!p.success) return 'IGNORED'
  const { organizationId, aggregateId } = p.data
  if (event.name === 'bcs/risk_assessment.submitted' || event.name === 'bcs/risk_assessment.cancelled') {
    const closed = await step.run('close', () => closeRiskDrafts(organizationId, aggregateId, systemClock.now()))
    return `CLOSED_${closed}`
  }
  return step.run('draft', () => draftRiskAnswers(organizationId, aggregateId, systemClock.now()))
}

export const riskAiDraft = inngest.createFunction(
  {
    id: 'risk-ai-draft',
    debounce: { key: 'event.data.aggregateId', period: RISK_AI_DRAFT_DEBOUNCE },
    concurrency: { limit: 1, key: 'event.data.organizationId' },
    triggers: [
      { event: 'bcs/risk_assessment.opened' },
      { event: 'bcs/risk_assessment.returned' },
      { event: 'bcs/supplier_document.verified' },
      { event: 'bcs/risk_assessment.submitted' },
      { event: 'bcs/risk_assessment.cancelled' },
    ],
  },
  async ({ event, step }) => riskAiDraftRun(event, { run: <T>(id: string, fn: () => Promise<T>) => step.run(id, fn) as Promise<T> }),
)

/** One run of risk-ai-summary, called directly by tests with their own step */
export async function riskAiSummaryRun(event: { data: unknown }, step: RiskAiStep): Promise<string> {
  const p = Payload.safeParse(event.data)
  if (!p.success) return 'IGNORED'
  return step.run('summary', () => writeRiskSummary(p.data.organizationId, p.data.aggregateId, systemClock.now()))
}

export const riskAiSummary = inngest.createFunction(
  { id: 'risk-ai-summary', concurrency: { limit: 1, key: 'event.data.organizationId' }, triggers: [{ event: 'bcs/review_task.assigned' }] },
  async ({ event, step }) => riskAiSummaryRun(event, { run: <T>(id: string, fn: () => Promise<T>) => step.run(id, fn) as Promise<T> }),
)
