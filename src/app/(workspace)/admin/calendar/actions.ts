'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { systemClock } from '@/lib/clock'
import { MEMBER_IMPORT_MAX_BYTES } from '@/lib/constants'
import { ctxFromSession } from '@/server/auth/session'
import { checkHolidayImport, importHolidayRows, saveBusinessHours } from '@/server/services/calendar'
import type { HolidayCheckView } from '@/ui/admin-settings/holidays'
import { toSettingsFailure, type SettingsFailure, type SettingsOutcome } from '@/ui/admin-settings/outcome'
import { getSession } from '../../../_lib/session'

// Browser-facing adapters for /admin/calendar (FR-ADM-003). Each checks the session; the services check
// admin.calendar and every rule (BR-AUTH-05). The idempotencyKey comes from the form (spec §4.3). Checking a holiday
// file only reads (a POST that changes nothing); adding its dates is the command, after the admin confirmed them.

const NO_SESSION: SettingsFailure = { ok: false, code: 'UNAUTHENTICATED' }
const BAD_KEY: SettingsFailure = { ok: false, code: 'VALIDATION_FAILED', field: 'idempotencyKey' }
const submissionKey = z.uuid()

async function currentCtx() {
  return ctxFromSession(await getSession(), 'WEB', systemClock.now())
}

export async function saveBusinessHoursAction(input: { workdays: string[]; start: string; end: string }, idempotencyKey: string): Promise<SettingsOutcome> {
  const ctx = await currentCtx()
  if (!ctx) return NO_SESSION
  if (!submissionKey.safeParse(idempotencyKey).success) return BAD_KEY
  const result = await saveBusinessHours(ctx, input, { idempotencyKey })
  if (!result.ok) return toSettingsFailure(result.error)
  revalidatePath('/admin/calendar')
  return { ok: true }
}

export async function checkHolidayImportAction(formData: FormData): Promise<{ ok: true; check: HolidayCheckView } | SettingsFailure> {
  const ctx = await currentCtx()
  if (!ctx) return NO_SESSION
  const file = formData.get('file')
  if (!(file instanceof File) || file.size === 0) return { ok: false, code: 'VALIDATION_FAILED', field: 'file', reason: 'FILE_MISSING' }
  if (file.size > MEMBER_IMPORT_MAX_BYTES) return { ok: false, code: 'VALIDATION_FAILED', field: 'file', reason: 'FILE_TOO_LARGE' }
  const result = await checkHolidayImport(ctx, await file.arrayBuffer())
  if (!result.ok) return toSettingsFailure(result.error)
  return { ok: true, check: result.data }
}

export async function importHolidaysAction(input: { rows: Array<{ date: string; nameTh: string }> }, idempotencyKey: string): Promise<SettingsOutcome> {
  const ctx = await currentCtx()
  if (!ctx) return NO_SESSION
  if (!submissionKey.safeParse(idempotencyKey).success) return BAD_KEY
  const result = await importHolidayRows(ctx, input, { idempotencyKey })
  if (!result.ok) return toSettingsFailure(result.error)
  revalidatePath('/admin/calendar')
  return { ok: true, added: result.data.added, skipped: result.data.skipped }
}
