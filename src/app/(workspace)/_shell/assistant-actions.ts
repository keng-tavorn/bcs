'use server'

import { randomUUID } from 'node:crypto'
import { headers } from 'next/headers'
import { systemClock } from '@/lib/clock'
import { ctxFromSession, resolveSession } from '@/server/auth/session'
import { giveAgentFeedback } from '@/server/services/ai'
import { dismissSuggestion } from '@/server/services/assistants/suggestions'

// "ไม่ใช่เรื่องนี้" on a suggestion of an assistant (NEW-121 · ADR-078). POST only; the service sets aside the member's own
// suggestion and nobody else's, and only one they have now. A key that is not there any more (a second press, an old
// page, a situation that went away) is hidden all the same.

export async function dismissAssistantAction(key: string): Promise<{ readonly ok: boolean }> {
  const ctx = ctxFromSession(await resolveSession(await headers()), 'WEB', systemClock.now())
  if (!ctx) return { ok: false }
  const result = await dismissSuggestion(ctx, { key }, { idempotencyKey: randomUUID() })
  return { ok: result.ok || result.error.code === 'NOT_FOUND' || result.error.code === 'INVALID_STATE_TRANSITION' }
}

/**
 * "ช่วยได้" or "ไม่ช่วย" under words an AI wrote (NEW-122 · ADR-079): the Approval Brief of the panel "จากผู้ช่วย" or an
 * answer of "ถาม BCS AI". POST only; the service lets the member who asked, or the reader of the Brief, say so.
 */
export async function giveAiFeedbackAction(agentActionId: string, feedback: 'HELPFUL' | 'NOT_HELPFUL'): Promise<{ readonly ok: boolean }> {
  const ctx = ctxFromSession(await resolveSession(await headers()), 'WEB', systemClock.now())
  if (!ctx) return { ok: false }
  const result = await giveAgentFeedback(ctx, { agentActionId, feedback }, { idempotencyKey: randomUUID() })
  return { ok: result.ok }
}
