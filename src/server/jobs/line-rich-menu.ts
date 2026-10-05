import { z } from 'zod'
import { inngest } from '@/server/inngest'
import { runLineRichMenuSync, type LineRichMenuSyncOutcome } from '@/server/services/line-link'

// Job `line-rich-menu` (FR-LINE-004 AC3, §9.5): every line.linked and line.unlinked event sets the rich menu of that
// link's LINE user to what the link is now — LINKED while linked, the account's default (UNLINKED) otherwise. The link
// and unlink requests switch it at once already; this run is the retry when LINE failed there, and the only switch for
// an unlink that came with a deactivation (FR-AUTH-003 AC2), which must not call LINE inside its transaction. The
// outbox hands the event to Inngest right after the commit (the outbox-sweeper within a minute when Inngest was away),
// and Inngest retries a transient failure of LINE. The handler reads the link as it is now, so runs in any order end
// with the right menu (src/server/services/line-link/rich-menu.ts).

/** Retries of a run whose LINE call failed for a while (Inngest's backoff spreads them over a few minutes) */
export const LINE_RICH_MENU_JOB_RETRIES = 5

/** What the outbox sends for a line.linked / line.unlinked event (src/server/services/_pipeline.ts eventOutboxDraft) */
export const LineRichMenuJobPayload = z.object({ organizationId: z.uuid(), aggregateId: z.uuid() })

export interface LineRichMenuJobStep {
  run<T>(id: string, fn: () => Promise<T>): Promise<T>
}

/** One run, called directly by tests with their own step */
export async function lineRichMenuRun(event: { data: unknown }, step: LineRichMenuJobStep): Promise<LineRichMenuSyncOutcome | { readonly ignored: 'NOT_A_LINK_EVENT' }> {
  const payload = LineRichMenuJobPayload.safeParse(event.data)
  if (!payload.success) return { ignored: 'NOT_A_LINK_EVENT' }
  return step.run('switch', () => runLineRichMenuSync(payload.data.organizationId, payload.data.aggregateId))
}

export const lineRichMenu = inngest.createFunction(
  { id: 'line-rich-menu', retries: LINE_RICH_MENU_JOB_RETRIES, triggers: [{ event: 'bcs/line.linked' }, { event: 'bcs/line.unlinked' }] },
  async ({ event, step }) => lineRichMenuRun(event, { run: <T>(id: string, fn: () => Promise<T>) => step.run(id, fn) as Promise<T> }),
)
