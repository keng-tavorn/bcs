'use server'

import { systemClock } from '@/lib/clock'
import { ctxFromSession } from '@/server/auth/session'
import { getAgentAction, readDocument } from '@/server/services/ai'
import type { AiReadActions, AiResultOutcome, AiStartOutcome } from '@/ui/ai/types'
import { presentAiResult } from './ai-present'
import { getSession } from './session'

// Browser-facing adapters of the Document Agent (FR-AI-303 AC1 AC4): start reading a file, then follow its result.
// Every call checks the session; the service checks the gates, the file and the document it is read for.

async function currentCtx() {
  return ctxFromSession(await getSession(), 'WEB', systemClock.now())
}

export async function readDocumentAction(input: Parameters<AiReadActions['start']>[0], idempotencyKey: string): Promise<AiStartOutcome> {
  const ctx = await currentCtx()
  if (!ctx) return { ok: false, code: 'UNAUTHENTICATED' }
  const r = await readDocument(ctx, input, { idempotencyKey })
  if (r.ok) return { ok: true, agentActionId: r.data.agentActionId }
  const reason = r.error.details?.reason
  return { ok: false, code: r.error.code, ...(typeof reason === 'string' ? { reason } : {}) }
}

export async function aiResultAction(agentActionId: string): Promise<AiResultOutcome> {
  const ctx = await currentCtx()
  if (!ctx) return { ok: false, code: 'UNAUTHENTICATED' }
  const r = await getAgentAction(ctx, agentActionId)
  return r.ok ? { ok: true, result: presentAiResult(r.data) } : { ok: false, code: r.error.code }
}
