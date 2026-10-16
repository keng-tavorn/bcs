'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { systemClock } from '@/lib/clock'
import { CONFIG_PACKAGE_MAX_CHARS, REASON_MAX_LENGTH } from '@/lib/constants'
import { ctxFromSession } from '@/server/auth/session'
import { exportConfigPackage, importConfigPackage, readConfigPackage } from '@/server/services/config-packages'
import { exportFileName, toConfigFailure, type ConfigCreatedView, type ConfigFailure, type ExportOutcome, type ImportOutcome } from '@/ui/admin-config/present'
import { getSession } from '../../../_lib/session'

// Browser-facing adapters of /admin/config (S6-21 · FR-PLT-101 AC2 · BR-UAT-02 BR-UAT-03). Each builds ctx from the
// session and hands the browser's arguments to the service, which checks config.export or config.import, the package's
// checksum and schemaVersion and every reference of it every time (BR-AUTH-05): hiding the menu is never the guard. The
// import makes drafts only, each through its own draft command under the importer's rights; nothing is published here
// (NG-12). The idempotencyKey comes from the form (spec §4.3), so a double click exports or imports once (INV-PLT-01).

const NO_SESSION: ConfigFailure = { ok: false, code: 'UNAUTHENTICATED' }
const BAD_KEY: ConfigFailure = { ok: false, code: 'VALIDATION_FAILED', field: 'idempotencyKey' }
const submissionKey = z.uuid()
const Sections = z.array(z.string().max(20)).max(4)
const ImportShape = z.object({ file: z.string(), effectiveDate: z.string().max(20), changeReason: z.string().max(REASON_MAX_LENGTH) })

async function currentCtx() {
  return ctxFromSession(await getSession(), 'WEB', systemClock.now())
}

export async function exportConfigAction(sections: string[], idempotencyKey: string): Promise<ExportOutcome> {
  const ctx = await currentCtx()
  if (!ctx) return NO_SESSION
  if (!submissionKey.safeParse(idempotencyKey).success) return BAD_KEY
  const shape = Sections.safeParse(sections)
  if (!shape.success || shape.data.length === 0) return { ok: false, code: 'VALIDATION_FAILED', field: 'sections' }
  // The service's schema refuses a section it does not know
  const result = await exportConfigPackage(ctx, { sections: shape.data as never }, { idempotencyKey })
  if (!result.ok) return toConfigFailure(result.error)
  return { ok: true, file: result.data.file, checksum: result.data.checksum, fileName: exportFileName(result.data.file) }
}

/** What the package names each draft by, in the order the import made them (forms, workflows and the catalogue follow the package) */
function namedDrafts(file: string, created: Readonly<Record<string, readonly string[]>>): ConfigCreatedView {
  const read = readConfigPackage(file)
  const content = read.ok ? read.content : null
  const ids = (key: string) => created[key] ?? []
  return {
    forms: ids('forms').map((id, i) => ({ id, code: content?.forms?.[i]?.requestTypeCode ?? '' })),
    workflows: ids('workflows').map((id, i) => ({ id, code: content?.workflows?.[i]?.code ?? '' })),
    doa: ids('doa').map((id) => ({ id })),
    catalog: ids('catalog').map((id, i) => ({ id, code: content?.catalog?.[i]?.code ?? '' })),
  }
}

export async function importConfigAction(input: { file: string; effectiveDate: string; changeReason: string }, idempotencyKey: string): Promise<ImportOutcome> {
  const ctx = await currentCtx()
  if (!ctx) return NO_SESSION
  if (!submissionKey.safeParse(idempotencyKey).success) return BAD_KEY
  const shape = ImportShape.safeParse(input)
  if (!shape.success) return { ok: false, code: 'VALIDATION_FAILED', field: '(input)' }
  if (shape.data.file.length === 0) return { ok: false, code: 'VALIDATION_FAILED', field: 'file', reason: 'REQUIRED' }
  if (shape.data.file.length > CONFIG_PACKAGE_MAX_CHARS) return { ok: false, code: 'VALIDATION_FAILED', field: 'file', reason: 'TOO_LARGE' }
  const result = await importConfigPackage(ctx, shape.data, { idempotencyKey })
  if (!result.ok) return toConfigFailure(result.error)
  // The drafts show on the pages of the DOA, the workflow, the request types and the catalogue
  revalidatePath('/admin', 'layout')
  revalidatePath('/catalog', 'layout')
  return { ok: true, created: namedDrafts(shape.data.file, result.data.created) }
}
