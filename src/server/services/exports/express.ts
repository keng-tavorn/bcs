import { createHash } from 'node:crypto'
import ExcelJS from 'exceljs'
import { z } from 'zod'
import { satangToAmount } from '@/core/money/dto'
import { csv, utf8WithBom, windows874 } from '@/lib/encoding'
import { newId } from '@/lib/ids'
import { OrgSettingsSchema, type ExpressField } from '@/lib/org-settings'
import { AP_EXPORTABLE_STATUSES, EXPORT_MAX_INVOICES, REASON_MAX_LENGTH } from '@/lib/constants'
import { putObject } from '@/integrations/storage'
import { authorize } from '@/server/authz'
import type { Ctx } from '@/server/context'
import type { TenantTx } from '@/server/db/tenant'
import { defineCommand, runCommand, type CommandOutcome, type RunOptions } from '../_pipeline'
import './file-policy'

// The AP file for Express (spec §7.13, BR-EXP-01 to BR-EXP-04, FR-P2P-009 AC1 AC2 AC4): FINANCE exports the confirmed
// invoices not exported yet, in the organization's layout (settings.express: columns, xlsx or csv, UTF-8 with BOM or
// Windows-874, Buddhist or Christian years). When the layout has the vendor-code column, invoices of suppliers without
// an Express vendor code are kept out and listed so they can be filled before the next file (BR-EXP-04). Every file
// shows its rows, its total (the sum of the invoices with VAT, as the file's rows add up) and its sha256; exporting the
// same invoices again needs a reason and makes a new ExportJob. Amounts are written as baht text with two decimals,
// never as floating-point numbers. The layout is never guessed: until the customer's sample import file arrives (OQ-10,
// P0-10, S4-14) the organization has no columns and the export is refused with MAPPING_NOT_SET.
// A first export claims its invoices (exportedAt still empty) before it writes anything, so two exports at the same
// moment never put one invoice into two files: the second finds them taken and is refused (BR-EXP-02). The screen sends
// the fingerprint of the list it showed; a list that changed since (an invoice recorded or exported meanwhile) is
// refused too, so nothing goes into a file that nobody saw.

type FailCode = 'VALIDATION_FAILED' | 'NOT_FOUND' | 'CONFLICT_VERSION'
const fail = (code: FailCode, message: string, details?: Record<string, unknown>) => ({ ok: false, error: { code, message, ...(details ? { details } : {}) } }) as const

const MIN_REASON_LENGTH = 3
const MIME = { xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', csv: 'text/csv' } as const
const BUDDHIST_ERA_OFFSET = 543
const SHA256_HEX = /^[0-9a-f]{64}$/

/**
 * The fingerprint of the invoices a first export takes: sha256 of their ids, sorted. The export screen shows the list
 * with this value and sends it back with the confirmation; the command compares it with what it is about to take.
 */
export function pendingFingerprint(invoiceIds: readonly string[]): string {
  return createHash('sha256')
    .update([...invoiceIds].sort().join(','))
    .digest('hex')
}

/** S8-11 (FR-AP-108 AC4): tier-2 invoices go into the file once they are ready for payment, coded as confirmed */
const EXPORTABLE_AP_INVOICE = { status: { in: [...AP_EXPORTABLE_STATUSES] } }

interface Row {
  readonly invoiceId: string
  /** 1: an InvoiceConfirmation, 2: an Invoice of module PAY */
  readonly tier: 1 | 2
  /** When it was recorded (tier 1) or became ready (tier 2): the order of the file */
  readonly at: Date
  readonly gross: bigint
  readonly values: Readonly<Record<ExpressField, string>>
}

/** YYYY-MM-DD of the instant in the organization's time zone */
function localDay(at: Date, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at)
  } catch {
    return at.toISOString().slice(0, 10)
  }
}

function dateText(day: Date, format: 'BE' | 'CE'): string {
  const year = day.getUTCFullYear() + (format === 'BE' ? BUDDHIST_ERA_OFFSET : 0)
  return `${String(day.getUTCDate()).padStart(2, '0')}/${String(day.getUTCMonth() + 1).padStart(2, '0')}/${year}`
}

async function invoiceRows(tx: TenantTx, where: object, dateFormat: 'BE' | 'CE'): Promise<Row[]> {
  const invoices = await tx.invoiceConfirmation.findMany({
    where,
    orderBy: [{ recordedAt: 'asc' }, { id: 'asc' }],
    include: {
      supplier: true,
      po: { select: { number: true } },
      lines: { orderBy: { netSatang: 'desc' }, take: 1, include: { poLine: { include: { budgetLine: { include: { costCenter: true } } } } } },
    },
  })
  return invoices.map((inv) => {
    // An invoice spread over several budget lines is coded to the line that takes most of it
    const budgetLine = inv.lines[0]?.poLine.budgetLine
    return {
      invoiceId: inv.id,
      tier: 1 as const,
      at: inv.recordedAt,
      gross: inv.grossSatang,
      values: {
        invoiceNo: inv.invoiceNo,
        invoiceDate: dateText(inv.invoiceDate, dateFormat),
        supplierCode: inv.supplier.code,
        supplierName: inv.supplier.nameTh,
        supplierTaxId: inv.supplier.taxId ?? '',
        supplierBranch: inv.supplier.branchCode,
        expressVendorCode: inv.supplier.expressVendorCode ?? '',
        poNumber: inv.po.number ?? '',
        net: satangToAmount(inv.netSatang),
        vat: satangToAmount(inv.vatSatang),
        gross: satangToAmount(inv.grossSatang),
        budgetLineCode: budgetLine?.code ?? '',
        costCenterCode: budgetLine?.costCenter?.code ?? '',
        accountCode: budgetLine?.accountCode ?? '',
      },
    }
  })
}

async function fileBytes(header: string[], rows: string[][], fileType: 'xlsx' | 'csv', encoding: 'UTF-8-BOM' | 'WINDOWS-874'): Promise<Uint8Array> {
  if (fileType === 'csv') {
    const text = csv([header, ...rows])
    return encoding === 'WINDOWS-874' ? windows874(text) : utf8WithBom(text)
  }
  const workbook = new ExcelJS.Workbook()
  const sheet = workbook.addWorksheet('Express')
  sheet.addRow(header)
  // Every cell is text: amounts stay exact (no floating point) and codes keep their leading zeros
  for (const row of rows) sheet.addRow(row).eachCell((cell) => (cell.numFmt = '@'))
  return new Uint8Array(await workbook.xlsx.writeBuffer())
}

/** The tier-2 invoices as rows: the supplier's number, the amounts, and the account code and cost center confirmed on the line that takes most of it */
async function apInvoiceRows(tx: TenantTx, where: object, dateFormat: 'BE' | 'CE'): Promise<Row[]> {
  const invoices = await tx.invoice.findMany({
    where: { ...EXPORTABLE_AP_INVOICE, ...where },
    orderBy: [{ readyAt: 'asc' }, { id: 'asc' }],
    include: {
      supplier: true,
      po: { select: { number: true } },
      lines: { orderBy: [{ netSatang: 'desc' }, { lineNo: 'asc' }], take: 1, include: { costCenter: true, poLine: { include: { budgetLine: true } } } },
    },
  })
  return invoices.map((inv) => {
    const line = inv.lines[0]
    return {
      invoiceId: inv.id,
      tier: 2 as const,
      at: inv.readyAt ?? inv.createdAt,
      gross: inv.grossSatang,
      values: {
        invoiceNo: inv.supplierInvoiceNo ?? '',
        invoiceDate: inv.invoiceDate ? dateText(inv.invoiceDate, dateFormat) : '',
        supplierCode: inv.supplier.code,
        supplierName: inv.supplier.nameTh,
        supplierTaxId: inv.supplier.taxId ?? '',
        supplierBranch: inv.supplier.branchCode,
        expressVendorCode: inv.supplier.expressVendorCode ?? '',
        poNumber: inv.po.number ?? '',
        net: satangToAmount(inv.netSatang),
        vat: satangToAmount(inv.statedVatSatang),
        gross: satangToAmount(inv.grossSatang),
        budgetLineCode: line?.poLine.budgetLine.code ?? '',
        costCenterCode: line?.costCenter?.code ?? '',
        accountCode: line?.accountCode ?? '',
      },
    }
  })
}

/** Both tiers in the order of the file: recorded or ready first, first */
async function allRows(tx: TenantTx, where: object, dateFormat: 'BE' | 'CE'): Promise<Row[]> {
  const [one, two] = await Promise.all([invoiceRows(tx, where, dateFormat), apInvoiceRows(tx, where, dateFormat)])
  return [...one, ...two].sort((a, b) => a.at.getTime() - b.at.getTime() || (a.invoiceId < b.invoiceId ? -1 : 1))
}

const ExportInput = z.strictObject({
  /** Invoices to export again (BR-EXP-02); left out: every invoice not exported yet */
  invoiceIds: z.array(z.uuid()).min(1).max(EXPORT_MAX_INVOICES).optional(),
  reason: z.string().trim().max(REASON_MAX_LENGTH).optional(),
  /** A first export only: pendingFingerprint() of the list the person confirmed; another list is refused */
  pendingFingerprint: z.string().regex(SHA256_HEX).optional(),
})

export const exportExpressCommand = defineCommand({
  name: 'export.express',
  capability: 'export.express',
  input: ExportInput,
  async execute(tx, input, ctx): Promise<CommandOutcome<{ exportJobId: string; fileId: string; rowCount: number; total: string; checksum: string; excluded: Array<{ invoiceId: string; supplierCode: string }> }>> {
    const allowed = await authorize(tx, ctx, 'export.express')
    if (!allowed.ok) return { ok: false, error: allowed.error }
    const actor = ctx.actor.type === 'USER' ? ctx.actor.memberId : null
    if (!actor) return { ok: false, error: { code: 'FORBIDDEN', message: 'only a member exports' } }
    const org = await tx.organization.findUniqueOrThrow({ where: { id: ctx.organizationId }, select: { settings: true, timezone: true } })
    const settings = OrgSettingsSchema.shape.express.parse((org.settings as { express?: unknown } | null)?.express)
    if (settings.mapping.length === 0) return fail('VALIDATION_FAILED', 'the Express file layout is not set yet: it waits for a sample file that Express imports, from the customer’s accounting team (OQ-10)', { reason: 'MAPPING_NOT_SET' })

    const again = input.invoiceIds !== undefined
    if (again && (input.reason ?? '').length < MIN_REASON_LENGTH) return fail('VALIDATION_FAILED', 'exporting again needs a reason', { field: 'reason', reason: 'REASON_REQUIRED' })
    const rows = await allRows(tx, again ? { id: { in: input.invoiceIds } } : { exportedAt: null }, settings.dateFormat)
    if (again && rows.length !== new Set(input.invoiceIds).size) return fail('NOT_FOUND', 'invoice not found')
    // BR-EXP-04: a layout with the vendor code leaves out invoices of suppliers that have none yet
    const needsVendorCode = settings.mapping.some((c) => c.field === 'expressVendorCode')
    const excluded = needsVendorCode ? rows.filter((r) => r.values.expressVendorCode === '') : []
    const included = rows.filter((r) => !excluded.includes(r))
    if (included.length === 0) return fail('VALIDATION_FAILED', 'no invoice to export', { reason: 'NOTHING_TO_EXPORT', excluded: excluded.length })
    const includedIds = included.map((r) => r.invoiceId)

    if (!again) {
      // The list the person confirmed must be the one exported: nothing recorded or exported by someone else since
      if (input.pendingFingerprint !== undefined && pendingFingerprint(includedIds) !== input.pendingFingerprint) {
        return fail('CONFLICT_VERSION', 'the invoices waiting for export changed since the list was shown', { reason: 'PENDING_CHANGED' })
      }
      // BR-EXP-02: claim the invoices while they are still not exported. An export running at the same moment holds
      // their rows until it ends; once it commits, they no longer match and this export is refused (rolled back).
      const tier2 = included.filter((r) => r.tier === 2).map((r) => r.invoiceId)
      const claimed = await tx.invoiceConfirmation.updateMany({ where: { id: { in: includedIds.filter((id) => !tier2.includes(id)) }, exportedAt: null }, data: { exportedAt: ctx.now } })
      const claimed2 = await tx.invoice.updateMany({ where: { id: { in: tier2 }, exportedAt: null }, data: { exportedAt: ctx.now } })
      if (claimed.count + claimed2.count !== includedIds.length) return fail('CONFLICT_VERSION', 'some invoices were exported by another file meanwhile', { reason: 'PENDING_CHANGED' })
    }

    const header = settings.mapping.map((c) => c.header)
    const body = included.map((r) => settings.mapping.map((c) => r.values[c.field]))
    let bytes: Uint8Array
    try {
      bytes = await fileBytes(header, body, settings.fileType, settings.encoding)
    } catch (error) {
      if (error instanceof RangeError) return fail('VALIDATION_FAILED', 'a character cannot be written in the chosen encoding', { reason: 'ENCODING' })
      throw error
    }
    const checksum = createHash('sha256').update(bytes).digest('hex')
    const total = included.reduce((sum, r) => sum + r.gross, 0n)
    const fileId = newId()
    const exportJobId = newId()
    const key = `org/${ctx.organizationId}/exports/${exportJobId}.${settings.fileType}`
    await putObject(key, bytes, MIME[settings.fileType])
    // Named by the organization's own date (a file made at 01:00 in Bangkok is not named after the day before in UTC)
    const fileName = `express-${localDay(ctx.now, org.timezone)}-${exportJobId.slice(-6)}.${settings.fileType}`
    await tx.fileObject.create({ data: { id: fileId, organizationId: ctx.organizationId, storageKey: key, fileName, mimeType: MIME[settings.fileType], sizeBytes: bytes.length, sha256: checksum, status: 'AVAILABLE', uploadedById: actor } })
    await tx.exportJob.create({
      data: {
        id: exportJobId,
        organizationId: ctx.organizationId,
        kind: 'EXPRESS_AP',
        params: { invoiceIds: includedIds, fileType: settings.fileType, encoding: settings.encoding, dateFormat: settings.dateFormat, again },
        status: 'COMPLETED',
        fileId,
        rowCount: included.length,
        totalSatang: total,
        checksum,
        reason: again ? input.reason! : null,
        requestedById: actor,
        completedAt: ctx.now,
      },
    })
    await tx.fileLink.create({ data: { organizationId: ctx.organizationId, fileId, subjectType: 'ExportJob', subjectId: exportJobId, kind: 'OTHER' } })
    await tx.invoiceConfirmation.updateMany({ where: { id: { in: includedIds } }, data: { exportedAt: ctx.now, exportJobId } })
    await tx.invoice.updateMany({ where: { id: { in: includedIds } }, data: { exportedAt: ctx.now, exportJobId } })
    const excludedList = excluded.map((r) => ({ invoiceId: r.invoiceId, supplierCode: r.values.supplierCode }))
    return {
      ok: true,
      result: { exportJobId, fileId, rowCount: included.length, total: satangToAmount(total), checksum, excluded: excludedList },
      events: [
        {
          type: 'export.generated',
          aggregateType: 'ExportJob',
          aggregateId: exportJobId,
          data: { kind: 'EXPRESS_AP', rowCount: included.length, totalSatang: total.toString(), checksum, fileId, invoiceIds: includedIds, excludedInvoiceIds: excluded.map((r) => r.invoiceId), again },
        },
      ],
      notifications: [
        { recipientMemberId: actor, templateKey: 'export.ready', data: { exportJobId, fileId, rowCount: included.length, kind: 'EXPRESS_AP' }, urgency: 'IMMEDIATE', dedupeKey: `export.ready:${exportJobId}`, subjectType: 'EXPORT_JOB', subjectId: exportJobId },
      ],
    }
  },
})

export function exportExpress(ctx: Ctx, input: z.input<typeof ExportInput>, options: RunOptions) {
  return runCommand(ctx, exportExpressCommand, input, options)
}
