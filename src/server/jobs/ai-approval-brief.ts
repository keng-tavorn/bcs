import { z } from 'zod'
import { systemClock } from '@/lib/clock'
import { inngest } from '@/server/inngest'
import { runBrief } from '@/server/services/ai/agents/brief'

// Job `ai-approval-brief` (docs/sub-specs/S13.md "งานเบื้องหลัง", BR-AI-20, ADR-145): a task assigned or reassigned on an
// approval step of a request or a PO gets its Brief once, written for its assignee's facts; a reassignment expires the
// Brief of the task it replaced. Nothing is written while the Brief agent may not run (no action, no credits). The run
// of a task that already has a Brief, or is no longer OPEN, does nothing, so a retry never calls the AI twice.

export const AI_APPROVAL_BRIEF_RETRIES = 2

/** What the outbox sends for approval_task.assigned and approval_task.reassigned (eventOutboxDraft) */
export const AiApprovalBriefPayload = z.object({ organizationId: z.uuid(), aggregateId: z.uuid(), data: z.object({ fromTaskId: z.uuid().optional() }).loose() })

export interface AiApprovalBriefStep {
  run<T>(id: string, fn: () => Promise<T>): Promise<T>
}

/** One run, called directly by tests with their own step */
export async function aiApprovalBriefRun(event: { data: unknown }, step: AiApprovalBriefStep): Promise<string> {
  const payload = AiApprovalBriefPayload.safeParse(event.data)
  if (!payload.success) return 'IGNORED'
  const { organizationId, aggregateId, data } = payload.data
  return step.run('brief', () => runBrief(organizationId, aggregateId, systemClock.now(), data.fromTaskId))
}

export const aiApprovalBrief = inngest.createFunction(
  { id: 'ai-approval-brief', retries: AI_APPROVAL_BRIEF_RETRIES, triggers: [{ event: 'bcs/approval_task.assigned' }, { event: 'bcs/approval_task.reassigned' }] },
  async ({ event, step }) => aiApprovalBriefRun(event, { run: <T>(id: string, fn: () => Promise<T>) => step.run(id, fn) as Promise<T> }),
)
