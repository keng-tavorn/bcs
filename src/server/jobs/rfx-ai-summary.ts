import { z } from 'zod'
import { systemClock } from '@/lib/clock'
import { inngest } from '@/server/inngest'
import { writeSummaryAhead } from '@/server/services/ai'

// Job rfx-ai-summary (S10-16 · docs/sub-specs/S10.md "job Inngest ใหม่" · BR-AI-32): after rfx.closed and after
// scorecard.revealed, the Sourcing Agent writes the summary of the bids ahead (an L0 AgentAction DRAFT) so the button
// "สรุปข้อเสนอ" opens it at once. Only with every gate of BR-AI-11 and settings.sourcing.aiAssist on; with AI off it skips
// (EG-1). The key of the call is rfx_summary:<rfxEventId>:<trigger>, so a retry never writes twice; a summary of the
// same facts already written is used as it is.

const Closed = z.object({ organizationId: z.uuid(), aggregateId: z.uuid() })
const Revealed = z.object({ organizationId: z.uuid(), data: z.object({ rfxEventId: z.uuid() }).loose() })

export interface SummaryStep {
  run<T>(id: string, fn: () => Promise<T>): Promise<T>
}

/** One run, called directly by tests with their own step */
export async function rfxAiSummaryRun(event: { name?: string; data: unknown }, step: SummaryStep): Promise<string> {
  if (event.name === 'bcs/scorecard.revealed') {
    const p = Revealed.safeParse(event.data)
    if (!p.success) return 'IGNORED'
    return step.run('summary', () => writeSummaryAhead(p.data.organizationId, p.data.data.rfxEventId, 'REVEALED', systemClock.now()))
  }
  const p = Closed.safeParse(event.data)
  if (!p.success) return 'IGNORED'
  return step.run('summary', () => writeSummaryAhead(p.data.organizationId, p.data.aggregateId, 'CLOSED', systemClock.now()))
}

export const rfxAiSummary = inngest.createFunction(
  { id: 'rfx-ai-summary', concurrency: { limit: 1, key: 'event.data.organizationId' }, triggers: [{ event: 'bcs/rfx.closed' }, { event: 'bcs/scorecard.revealed' }] },
  async ({ event, step }) => rfxAiSummaryRun(event, { run: <T>(id: string, fn: () => Promise<T>) => step.run(id, fn) as Promise<T> }),
)
