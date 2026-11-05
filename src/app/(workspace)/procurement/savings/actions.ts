'use server'

import { randomUUID } from 'node:crypto'
import { headers } from 'next/headers'
import { systemClock } from '@/lib/clock'
import { ctxFromSession, resolveSession } from '@/server/auth/session'
import { explainSaving } from '@/server/services/ai'

// "ให้ผู้ช่วยอธิบาย" on a saving (NEW-136 · FR-VIS-008 AC3 · ADR-084). POST only; the service reads the saving through the
// member's own list (who may not see it is refused before any call) and checks the AI's words before they come back.

export type ExplainOutcome =
  | { readonly kind: 'READY'; readonly agentActionId: string; readonly sentences: readonly string[] }
  | { readonly kind: 'FAILED' }
  /** The saving is no longer on the member's list */
  | { readonly kind: 'GONE' }

export async function explainSavingAction(key: string): Promise<ExplainOutcome> {
  const ctx = ctxFromSession(await resolveSession(await headers()), 'WEB', systemClock.now())
  if (!ctx) return { kind: 'FAILED' }
  const result = await explainSaving(ctx, { key }, { idempotencyKey: randomUUID() })
  if (!result.ok) return result.error.code === 'NOT_FOUND' ? { kind: 'GONE' } : { kind: 'FAILED' }
  return result.data.status === 'READY' ? { kind: 'READY', agentActionId: result.data.agentActionId, sentences: result.data.sentences } : { kind: 'FAILED' }
}
