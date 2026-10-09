import { z } from 'zod'
import { err, ok, type Result } from '@/core/result'
import { REASON_MAX_LENGTH } from '@/lib/constants'
import type { ExpressField } from '@/lib/org-settings'
import { authorize } from '@/server/authz'
import type { Ctx } from '@/server/context'
import { forTenant } from '@/server/db/tenant'
import { expressJobInvoiceIds, listExpressJobs, listPendingExport, readExpressSettings, type ExportJobDto, type HeldBackDto, type PendingGroupDto } from '@/server/queries/finance'
import type { RunOptions } from '../_pipeline'
import { exportExpress, pendingFingerprint } from './express'

// What the Express export screen shows (spec §9.1 /finance/exports, S4-09, FR-P2P-009, §7.13): the organization's file
// layout (BR-EXP-01), the invoices not exported yet that the next file takes (AC1) and those it keeps out because their
// supplier has no Express vendor code yet (AC4, BR-EXP-04), and the files made with their rows, total and checksum
// (AC2). Exporting the same invoices again takes the invoices of an earlier file and needs a reason (BR-EXP-02); the
// export.express command checks the permission and every rule again. Only FINANCE (export.express, §2.4) sees any of it.

export interface ExpressLayoutDto {
  readonly fileType: 'xlsx' | 'csv'
  readonly encoding: 'UTF-8-BOM' | 'WINDOWS-874'
  readonly dateFormat: 'BE' | 'CE'
  readonly columns: ReadonlyArray<{ readonly header: string; readonly field: ExpressField }>
  /** The layout has the vendor-code column: invoices of suppliers without one are kept out (BR-EXP-04) */
  readonly needsVendorCode: boolean
}

export interface ExportOverviewDto {
  /** null when the organization has no usable layout yet (the export is refused with MAPPING_NOT_SET) */
  readonly layout: ExpressLayoutDto | null
  readonly ready: PendingGroupDto
  /**
   * pendingFingerprint() of every invoice in `ready`: the screen sends it back with the confirmation, and the export
   * is refused when the list changed meanwhile (BR-EXP-02)
   */
  readonly readyFingerprint: string
  readonly heldBack: HeldBackDto
  /** The files made, last first */
  readonly jobs: readonly ExportJobDto[]
}

async function exporterOnly(ctx: Ctx): Promise<Result<true>> {
  const allowed = await forTenant(ctx.organizationId).$transaction((tx) => authorize(tx, ctx, 'export.express'))
  if (!allowed.ok) return err(allowed.error.code, allowed.error.message, allowed.error.details)
  if (allowed.data.kind !== 'member') return err('FORBIDDEN', 'members only')
  return ok(true)
}

async function layoutOf(ctx: Ctx): Promise<ExpressLayoutDto | null> {
  const settings = await readExpressSettings(ctx)
  return settings && settings.mapping.length > 0
    ? { fileType: settings.fileType, encoding: settings.encoding, dateFormat: settings.dateFormat, columns: settings.mapping, needsVendorCode: settings.mapping.some((c) => c.field === 'expressVendorCode') }
    : null
}

/** The home's row "พร้อมส่งออก Express" (§9.10): the invoices the next file takes, as /finance/exports counts them; null for a non-exporter */
export async function countReadyForExport(ctx: Ctx): Promise<number | null> {
  const allowed = await exporterOnly(ctx)
  if (!allowed.ok) return null
  const layout = await layoutOf(ctx)
  return (await listPendingExport(ctx, layout?.needsVendorCode ?? false)).ready.count
}

export async function getExportOverview(ctx: Ctx): Promise<Result<ExportOverviewDto>> {
  const allowed = await exporterOnly(ctx)
  if (!allowed.ok) return allowed
  const layout = await layoutOf(ctx)
  const [pending, jobs] = await Promise.all([listPendingExport(ctx, layout?.needsVendorCode ?? false), listExpressJobs(ctx)])
  return ok({ layout, ready: pending.ready, readyFingerprint: pendingFingerprint(pending.readyIds), heldBack: pending.heldBack, jobs })
}

const AgainInput = z.strictObject({ exportJobId: z.uuid(), reason: z.string().trim().max(REASON_MAX_LENGTH) })

/**
 * BR-EXP-02: the invoices of an earlier Express file, in a new file with a reason (a new ExportJob and its event). The
 * reason's length and everything else are checked by export.express itself.
 */
export async function exportJobAgain(ctx: Ctx, input: z.input<typeof AgainInput>, options: RunOptions): Promise<Awaited<ReturnType<typeof exportExpress>>> {
  const parsed = AgainInput.safeParse(input)
  if (!parsed.success) return err('VALIDATION_FAILED', 'an export job and a reason are needed', { field: String(parsed.error.issues[0]?.path[0] ?? 'input') })
  const allowed = await exporterOnly(ctx)
  if (!allowed.ok) return { ok: false, error: allowed.error }
  const invoiceIds = await expressJobInvoiceIds(ctx, parsed.data.exportJobId)
  if (!invoiceIds || invoiceIds.length === 0) return err('NOT_FOUND', 'export job not found')
  return exportExpress(ctx, { invoiceIds, reason: parsed.data.reason }, options)
}
