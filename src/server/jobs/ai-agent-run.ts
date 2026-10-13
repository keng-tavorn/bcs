import { z } from 'zod'
import { systemClock } from '@/lib/clock'
import { inngest } from '@/server/inngest'
import { DOCUMENT_PURPOSES, runDocumentRead } from '@/server/services/ai/agents/document'

// Job `ai-agent-run` (docs/sub-specs/S13.md "งานเบื้องหลัง", ADR-145): every agent_action.requested of an agent that
// works in the background — the Document Agent now, Intake and the DOA drafter as they come — calls the AI outside any
// transaction and records the answer on the action. The outbox hands the event over after the commit (the
// outbox-sweeper within a minute when Inngest was away). A run of an action that is no longer PENDING does nothing, so a
// retry never calls the AI twice for one answer; a call that never comes back fails by the hourly sweep (TIMEOUT).

/** Retries of a run that failed before it recorded the answer (the AI's own errors are recorded as FAILED, not retried) */
export const AI_AGENT_RUN_RETRIES = 2

/** What the outbox sends for agent_action.requested (src/server/services/_pipeline.ts eventOutboxDraft) */
export const AiAgentRunPayload = z.object({ organizationId: z.uuid(), aggregateId: z.uuid(), data: z.object({ purpose: z.string() }) })

export interface AiAgentRunStep {
  run<T>(id: string, fn: () => Promise<T>): Promise<T>
}

/** One run, called directly by tests with their own step */
export async function aiAgentRunRun(event: { data: unknown }, step: AiAgentRunStep): Promise<string> {
  const payload = AiAgentRunPayload.safeParse(event.data)
  if (!payload.success) return 'IGNORED'
  const { organizationId, aggregateId, data } = payload.data
  if (DOCUMENT_PURPOSES.includes(data.purpose as never)) return step.run('read-document', () => runDocumentRead(organizationId, aggregateId, systemClock.now()))
  return 'IGNORED'
}

export const aiAgentRun = inngest.createFunction(
  { id: 'ai-agent-run', retries: AI_AGENT_RUN_RETRIES, triggers: [{ event: 'bcs/agent_action.requested' }] },
  async ({ event, step }) => aiAgentRunRun(event, { run: <T>(id: string, fn: () => Promise<T>) => step.run(id, fn) as Promise<T> }),
)
