import { createHash } from 'node:crypto'
import { z } from 'zod'
import { amountToSatang } from '@/core/money/dto'
import { err, ok, type Result } from '@/core/result'
import { MAX_UPLOAD_BYTES } from '@/lib/constants'
import { newId } from '@/lib/ids'
import { putObject, readObject } from '@/integrations/storage'
import { authorize } from '@/server/authz'
import type { Ctx } from '@/server/context'
import { forTenant, type TenantTx } from '@/server/db/tenant'
import { defineCommand, runCommand, type CommandOutcome } from '../_pipeline'
import { invoiceFilePrefix, readEtaxContent, type EtaxContentReading } from '../invoices/etax'
import { requireModule } from '../modules'

// The file of a tier-2 invoice (BR-AP-01, BR-IVC-07): FINANCE uploads a PDF, XML, JPEG or PNG for one PO; it is kept
// under the same PO-bound storage key as the tier-1 e-Tax reader (invoiceFilePrefix), so the file stays with the PO it
// was uploaded for. An e-Tax file is read with the same reader as BR-IVC-05 (readEtaxContent); a picture is only paper.
// Where the invoice's values came from is decided again from the stored bytes when it is submitted, never on the word
// of the browser.

const ALLOWED: ReadonlyArray<{ readonly mime: string; readonly test: (b: Uint8Array) => boolean }> = [
  { mime: 'application/pdf', test: (b) => new TextDecoder('latin1').decode(b.subarray(0, 5)) === '%PDF-' },
  { mime: 'image/jpeg', test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { mime: 'image/png', test: (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 },
  { mime: 'application/xml', test: (b) => new TextDecoder('utf-8').decode(b.subarray(0, 64)).replace(/^﻿/, '').trimStart().startsWith('<') },
]

/** The kind of file by its first bytes (never by its name or the browser's type), or null when not allowed */
export function invoiceFileType(content: Uint8Array): string | null {
  return ALLOWED.find((a) => a.test(content))?.mime ?? null
}

const StoreInput = z.strictObject({
  poId: z.uuid(),
  key: z.string().min(1),
  fileName: z.string().min(1).max(200),
  mimeType: z.enum(['application/pdf', 'application/xml', 'image/jpeg', 'image/png']),
  sizeBytes: z.number().int().positive(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
})

export const storeInvoiceFileCommand = defineCommand({
  name: 'invoice.store_file',
  capability: 'invoice.record',
  input: StoreInput,
  async execute(tx, input, ctx): Promise<CommandOutcome<{ fileId: string }>> {
    const allowed = await authorize(tx, ctx, 'invoice.record')
    if (!allowed.ok) return { ok: false, error: allowed.error }
    if (allowed.data.kind !== 'member') return { ok: false, error: { code: 'FORBIDDEN', message: 'members only' } }
    const pay = await requireModule(ctx, 'PAY', tx)
    if (!pay.ok) return { ok: false, error: pay.error }
    if (!input.key.startsWith(invoiceFilePrefix(ctx.organizationId, input.poId))) return { ok: false, error: { code: 'VALIDATION_FAILED', message: 'the file key is not of this purchase order', details: { field: 'key' } } }
    const fileId = newId()
    await tx.fileObject.create({
      data: { id: fileId, organizationId: ctx.organizationId, storageKey: input.key, fileName: input.fileName, mimeType: input.mimeType, sizeBytes: input.sizeBytes, sha256: input.sha256, status: 'AVAILABLE', uploadedById: allowed.data.memberId, scanStatus: 'NOT_REQUIRED' },
    })
    return { ok: true, result: { fileId }, events: [{ type: 'file.uploaded', aggregateType: 'File', aggregateId: fileId, data: { fileId, mimeType: input.mimeType, sizeBytes: input.sizeBytes } }] }
  },
})

/** FR-AP-101 AC1: FINANCE uploads an invoice's file for a PO; the draft is made from it with invoice.create */
export async function uploadInvoiceFile(ctx: Ctx, input: { poId: string; fileName: string; content: Uint8Array }): Promise<Result<{ fileId: string }>> {
  const db = forTenant(ctx.organizationId)
  const allowed = await db.$transaction((tx) => authorize(tx, ctx, 'invoice.record'))
  if (!allowed.ok) return err(allowed.error.code, allowed.error.message, allowed.error.details)
  const pay = await requireModule(ctx, 'PAY')
  if (!pay.ok) return pay
  const po = await db.purchaseOrder.findFirst({ where: { id: input.poId }, select: { id: true } })
  if (!po) return err('NOT_FOUND', 'purchase order not found')
  if (input.content.length === 0 || input.content.length > MAX_UPLOAD_BYTES) return err('VALIDATION_FAILED', 'the file is empty or too large', { field: 'file', reason: input.content.length ? 'TOO_LARGE' : 'EMPTY' })
  const mimeType = invoiceFileType(input.content)
  if (!mimeType) return err('VALIDATION_FAILED', 'an invoice file is a PDF, XML, JPEG or PNG file', { field: 'file', reason: 'TYPE_NOT_ALLOWED' })
  const key = `${invoiceFilePrefix(ctx.organizationId, po.id)}${newId()}`
  await putObject(key, input.content, mimeType)
  const sha256 = createHash('sha256').update(input.content).digest('hex')
  const fileName = input.fileName.replace(/[\\/\u0000-\u001f]/g, ' ').trim().slice(0, 200) || 'invoice'
  const stored = await runCommand(ctx, storeInvoiceFileCommand, { poId: po.id, key, fileName, mimeType: mimeType as z.infer<typeof StoreInput>['mimeType'], sizeBytes: input.content.length, sha256 }, { idempotencyKey: `invoice-file:${key}` })
  if (!stored.ok) return stored
  return ok({ fileId: stored.data.fileId })
}

export type StoredFileRefusal = 'FILE' | 'FILE_OTHER_PO'

const notFound = (error: unknown): boolean => {
  const e = error as { name?: string; $metadata?: { httpStatusCode?: number } }
  return e.name === 'NoSuchKey' || e.name === 'NotFound' || e.$metadata?.httpStatusCode === 404
}

/**
 * The stored file of an invoice of `poId`, read again: refused when it is not available, belongs to another PO, is not
 * the bytes that were uploaded, or (with memberId) was uploaded by someone else. Reads storage.
 */
export async function readStoredInvoiceFile(
  tx: Pick<TenantTx, 'fileObject'>,
  input: { readonly organizationId: string; readonly memberId: string | null; readonly fileId: string; readonly poId: string },
): Promise<{ readonly ok: true; readonly file: { readonly fileId: string; readonly reading: EtaxContentReading } } | { readonly ok: false; readonly reason: StoredFileRefusal }> {
  const file = await tx.fileObject.findFirst({
    where: { id: input.fileId, status: 'AVAILABLE', ...(input.memberId ? { uploadedById: input.memberId } : {}) },
    select: { id: true, storageKey: true, sha256: true },
  })
  if (!file) return { ok: false, reason: 'FILE' }
  if (!file.storageKey.startsWith(invoiceFilePrefix(input.organizationId, input.poId))) return { ok: false, reason: 'FILE_OTHER_PO' }
  let bytes: Uint8Array
  try {
    bytes = await readObject(file.storageKey)
  } catch (error) {
    if (notFound(error)) return { ok: false, reason: 'FILE' }
    throw error
  }
  if (!file.sha256 || createHash('sha256').update(bytes).digest('hex') !== file.sha256) return { ok: false, reason: 'FILE' }
  return { ok: true, file: { fileId: file.id, reading: readEtaxContent(bytes)?.reading ?? { problem: 'NOT_AN_ETAX_INVOICE' } } }
}

/**
 * BR-IVC-07: the invoice is ETAX_XML only when the file is an e-Tax invoice of the PO's supplier and the number, date,
 * amount before VAT and VAT submitted are exactly the ones in it.
 */
export function sourceOfStoredFile(
  file: { readonly reading: EtaxContentReading },
  supplierTaxId: string | null,
  invoice: { readonly supplierInvoiceNo: string | null; readonly invoiceDate: Date | null; readonly netSatang: bigint; readonly statedVatSatang: bigint },
): boolean {
  if (!('prefill' in file.reading)) return false
  const p = file.reading.prefill
  return (
    p.sellerTaxId === supplierTaxId &&
    invoice.supplierInvoiceNo?.trim() === p.invoiceNo &&
    invoice.invoiceDate?.toISOString().slice(0, 10) === p.invoiceDate &&
    invoice.netSatang === amountToSatang(p.net) &&
    invoice.statedVatSatang === amountToSatang(p.vat)
  )
}
