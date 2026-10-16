'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { systemClock } from '@/lib/clock'
import { ctxFromSession } from '@/server/auth/session'
import { cancelBudgetTransfer, createBudgetTransfer, submitBudgetTransfer } from '@/server/services/budget/transfers'
import type { TransferInput } from '@/ui/budgets/transfer-model'
import { toTransferFailure, type TransferFailure, type TransferOutcome } from '@/ui/budgets/transfer-outcome'
import { getSession } from '../../../_lib/session'

// Browser-facing adapters of /budgets/transfers (S6-15 · FR-BUD-103). Each builds ctx from the session and hands the
// browser's arguments to a service, which parses them and checks budget.transfer.submit, the sender, the lines and the
// DOA in effect every time (BR-AUTH-05): hiding a button is never the guard. Each call carries its own idempotencyKey
// from the form (spec §4.3), so a double click or a retry runs the command once (INV-PLT-01) — "ส่งขออนุมัติ" on the
// new-transfer form is two commands, the draft and the send, each with its own key.

const NO_SESSION: TransferFailure = { ok: false, code: 'UNAUTHENTICATED' }
const BAD_KEY: TransferFailure = { ok: false, code: 'VALIDATION_FAILED', field: 'idempotencyKey' }
const submissionKey = z.uuid()

async function currentCtx() {
  return ctxFromSession(await getSession(), 'WEB', systemClock.now())
}

function refresh() {
  // The dashboard's figures and the lists of transfers change with every command (a send reserves the source)
  revalidatePath('/budgets', 'layout')
}

export async function createBudgetTransferAction(input: TransferInput, idempotencyKey: string): Promise<TransferOutcome<{ transferId: string }>> {
  const ctx = await currentCtx()
  if (!ctx) return NO_SESSION
  if (!submissionKey.safeParse(idempotencyKey).success) return BAD_KEY
  const r = await createBudgetTransfer(ctx, input, { idempotencyKey })
  if (!r.ok) return toTransferFailure(r.error)
  refresh()
  return { ok: true, transferId: r.data.transferId }
}

export async function submitBudgetTransferAction(transferId: string, idempotencyKey: string): Promise<TransferOutcome<{ transferId: string; number: string }>> {
  const ctx = await currentCtx()
  if (!ctx) return NO_SESSION
  if (!submissionKey.safeParse(idempotencyKey).success) return BAD_KEY
  if (!z.uuid().safeParse(transferId).success) return { ok: false, code: 'NOT_FOUND' }
  const r = await submitBudgetTransfer(ctx, { transferId }, { idempotencyKey })
  if (!r.ok) return toTransferFailure(r.error)
  refresh()
  return { ok: true, transferId: r.data.transferId, number: r.data.number }
}

export async function cancelBudgetTransferAction(transferId: string, idempotencyKey: string): Promise<TransferOutcome<{ transferId: string }>> {
  const ctx = await currentCtx()
  if (!ctx) return NO_SESSION
  if (!submissionKey.safeParse(idempotencyKey).success) return BAD_KEY
  if (!z.uuid().safeParse(transferId).success) return { ok: false, code: 'NOT_FOUND' }
  const r = await cancelBudgetTransfer(ctx, { transferId }, { idempotencyKey })
  if (!r.ok) return toTransferFailure(r.error)
  refresh()
  return { ok: true, transferId: r.data.transferId }
}
