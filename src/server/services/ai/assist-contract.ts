import { z } from 'zod'
import { err, ok, type Result } from '@/core/result'
import type { Ctx } from '@/server/context'
import type { TenantTx } from '@/server/db/tenant'
import type { EventDraft } from '@/server/events/append'

// The contract between the documents and the AI that fills them (P1-07, docs/sub-specs/P1.md "สัญญากลางอื่น", BR-AI-17
// of S13). A document's own command takes `aiAssist` and calls applyAiAssist in its transaction, with a person as the
// actor; a command that sends a document on calls assertNoPendingAiReview first. These are the empty versions every
// lane builds against: no input → nothing happens; an input before S13 → MODULE_DISABLED; nothing is ever pending.
// S13-03 writes the real ones here, which answer AI_REVIEW_PENDING (§14.2). This file never calls the AI.

/** What the person confirmed of the values an AI action put into the form (BR-AI-17) */
export const AiAssistInput = z.strictObject({
  agentActionId: z.uuid(),
  /** The form paths the person looked at and kept, e.g. "lines.0.unitPrice" */
  confirmedPaths: z.array(z.string().min(1).max(200)).max(500),
})
export type AiAssist = z.infer<typeof AiAssistInput>

/** The document the AI helped with, e.g. { type: 'GOODS_RECEIPT', id } or an invoice of S8 */
export interface AssistSubject {
  readonly type: string
  readonly id: string
}

/** AI_REVIEW_PENDING while values the AI filled in wait for the person to confirm them; nothing waits before S13 */
export async function assertNoPendingAiReview(_tx: TenantTx, _ctx: Ctx, _subject: AssistSubject): Promise<Result<true>> {
  return ok(true)
}

/** Records what the person confirmed of an AI action, in the command's transaction; the events go with the command's */
export async function applyAiAssist(_tx: TenantTx, _ctx: Ctx, _subject: AssistSubject, input?: AiAssist): Promise<Result<readonly EventDraft[]>> {
  if (!input) return ok([])
  return err('MODULE_DISABLED', 'AI assistance arrives with S13', { module: 'AI' })
}
