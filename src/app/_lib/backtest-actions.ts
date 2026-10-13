'use server'

import { z } from 'zod'
import { systemClock } from '@/lib/clock'
import { ctxFromSession } from '@/server/auth/session'
import { backtestDraft, getBacktestRun } from '@/server/services/backtest'
import { toActionFailure, type ActionFailure } from '@/ui/admin-org/outcome'
import type { BacktestActionResult } from '@/ui/backtest/panel'
import { getSession } from './session'

// Browser-facing adapters of the 90-day backtest (FR-DOA-103 · BR-WF-13 · BR-DOA-14, S6-07), for the DOA and workflow
// version pages and the decision page of their approver. Each checks the session and the shape of what arrives (server
// actions are public endpoints, BR-AUTH-05); the service checks admin.doa.simulate or admin.workflow.simulate, or that
// the member holds the version's approval task, and writes no business data. Reading a run again changes nothing.

const NO_SESSION: ActionFailure = { ok: false, code: 'UNAUTHENTICATED' }
const BAD_KEY: ActionFailure = { ok: false, code: 'VALIDATION_FAILED', field: 'idempotencyKey' }
const BAD_INPUT: ActionFailure = { ok: false, code: 'VALIDATION_FAILED', field: '(input)' }
const RUN_GONE: ActionFailure = { ok: false, code: 'NOT_FOUND', reason: 'RUN_GONE' }
const submissionKey = z.uuid()
const RunShape = z.strictObject({ kind: z.enum(['DOA_VERSION', 'WORKFLOW_VERSION']), versionId: z.string().max(100) })

async function currentCtx() {
  return ctxFromSession(await getSession(), 'WEB', systemClock.now())
}

export async function runBacktestAction(input: { kind: 'DOA_VERSION' | 'WORKFLOW_VERSION'; versionId: string }, idempotencyKey: string): Promise<BacktestActionResult> {
  const ctx = await currentCtx()
  if (!ctx) return NO_SESSION
  if (!submissionKey.safeParse(idempotencyKey).success) return BAD_KEY
  const shape = RunShape.safeParse(input)
  if (!shape.success) return BAD_INPUT
  const result = await backtestDraft(ctx, shape.data, { idempotencyKey })
  return result.ok ? { ok: true, view: result.data } : toActionFailure(result.error)
}

/** A run the job fills, read again (the same rights as asking for it); one the reader may not see reads as gone */
export async function readBacktestRunAction(runId: string): Promise<BacktestActionResult> {
  const ctx = await currentCtx()
  if (!ctx) return NO_SESSION
  if (!z.uuid().safeParse(runId).success) return BAD_INPUT
  const view = await getBacktestRun(ctx, runId)
  return view ? { ok: true, view } : RUN_GONE
}
