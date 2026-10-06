'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { toMoneyDto } from '@/core/money/dto'
import { systemClock } from '@/lib/clock'
import { MEMBER_IMPORT_MAX_BYTES } from '@/lib/constants'
import { ctxFromSession } from '@/server/auth/session'
import { importBudget, previewBudgetImport } from '@/server/services/budget/import'
import { toBudgetFailure, type BudgetFailure, type ImportCheckOutcome, type ImportOutcome } from '@/ui/budgets/outcome'
import { getSession } from '../../../_lib/session'

// Browser-facing adapters of /budgets/import (FR-BUD-001). Each checks the session; the services check budget.import
// (BUDGET_ADMIN) and every row again (BR-AUTH-05), so a hidden link is never the guard. The file goes through a server
// action like the member import, so it has the same size limit. The import's idempotencyKey comes from the form (spec
// §4.3): the same submission sent twice imports once; the same file sent again on purpose is AC3's confirmation. The
// import carries the checksum of the file that was checked, so the confirmation always covers the file imported.

const NO_SESSION: BudgetFailure = { ok: false, code: 'UNAUTHENTICATED' }
const BAD_KEY: BudgetFailure = { ok: false, code: 'VALIDATION_FAILED', field: 'idempotencyKey' }
const submissionKey = z.uuid()

async function currentCtx() {
  return ctxFromSession(await getSession(), 'WEB', systemClock.now())
}

/** The Excel file of the form, or why it cannot be read */
async function fileOf(formData: FormData): Promise<{ bytes: ArrayBuffer; fileName: string } | BudgetFailure> {
  const file = formData.get('file')
  if (!(file instanceof File) || file.size === 0) return { ok: false, code: 'VALIDATION_FAILED', field: 'file', reason: 'FILE_MISSING' }
  if (file.size > MEMBER_IMPORT_MAX_BYTES) return { ok: false, code: 'VALIDATION_FAILED', field: 'file', reason: 'FILE_TOO_LARGE' }
  return { bytes: await file.arrayBuffer(), fileName: file.name }
}

/** Step 1: check the file and save nothing (AC1, AC3) */
export async function checkBudgetFileAction(formData: FormData): Promise<ImportCheckOutcome> {
  const ctx = await currentCtx()
  if (!ctx) return NO_SESSION
  const file = await fileOf(formData)
  if ('ok' in file) return file
  const result = await previewBudgetImport(ctx, file)
  return result.ok ? { ok: true, check: result.data } : toBudgetFailure(result.error)
}

/** Step 2: import every row of the file, or nothing (AC1, AC2); the same file again only when confirmed (AC3) */
export async function importBudgetFileAction(formData: FormData): Promise<ImportOutcome> {
  const ctx = await currentCtx()
  if (!ctx) return NO_SESSION
  const idempotencyKey = String(formData.get('idempotencyKey') ?? '')
  if (!submissionKey.safeParse(idempotencyKey).success) return BAD_KEY
  const file = await fileOf(formData)
  if ('ok' in file) return file
  // The checksum of the file the member checked and confirmed: the service refuses any other file (RECHECK)
  const expectedChecksum = String(formData.get('checksum') ?? '')
  const result = await importBudget(ctx, file, { idempotencyKey, confirmDuplicate: formData.get('confirmDuplicate') === 'yes', expectedChecksum })
  if (!result.ok) return toBudgetFailure(result.error)
  revalidatePath('/budgets', 'layout')
  return { ok: true, rows: result.data.rows, linesCreated: result.data.linesCreated, total: toMoneyDto(BigInt(result.data.totalSatang)) }
}
