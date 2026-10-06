import { createHash } from 'node:crypto'
import { amountToSatang } from '@/core/money/dto'
import { readObject } from '@/integrations/storage'
import type { TenantTx } from '@/server/db/tenant'
import { invoiceFilePrefix, readEtaxContent, type EtaxContentReading } from './etax'

// Where an invoice's values came from (spec BR-IVC-05, FR-P2P-008 AC4), decided by the server from the stored file and
// never on the word of the browser. The file attached to an invoice must be one the member uploaded through the e-Tax
// reader for this very PO (the PO is part of its storage key, invoiceFileKey), not yet the file of another invoice, and
// unchanged since it was uploaded (its sha256). It is read again: a file whose seller tax id is not the PO supplier's is
// never attached; the invoice is ETAX_XML only when the file reads as an e-Tax invoice and the values recorded are
// exactly the ones in it — otherwise MANUAL, with the file kept as the invoice's paper (FileLink INVOICE). Used by
// invoice_confirmation.record and by the check before it (./view.ts), so both decide the same way.

export type InvoiceFileRefusal = 'FILE' | 'FILE_OTHER_PO' | 'FILE_IN_USE' | 'TAX_ID_MISMATCH'

export interface InvoiceSource {
  readonly parsedFrom: 'MANUAL' | 'ETAX_XML'
  /** The FileLink kind of the invoice's file */
  readonly kind: 'ETAX' | 'INVOICE'
}

/** The values an invoice is recorded with, as the command takes them (invoice number trimmed, baht text) */
export interface RecordedValues {
  readonly invoiceNo: string
  readonly invoiceDate: string
  readonly net: string
  readonly vat: string
}

export interface StoredInvoiceFile {
  readonly fileId: string
  readonly reading: EtaxContentReading
}

type FileDb = Pick<TenantTx, 'fileObject'>
type InvoiceDb = Pick<TenantTx, 'invoiceConfirmation'>

const notFound = (error: unknown): boolean => {
  const e = error as { name?: string; $metadata?: { httpStatusCode?: number } }
  return e.name === 'NoSuchKey' || e.name === 'NotFound' || e.$metadata?.httpStatusCode === 404
}

/**
 * The member's file uploaded for the invoices of `poId`, read again from storage: refused when it is someone else's,
 * no longer available, uploaded for another PO, or not the bytes that were uploaded. Reads storage, so callers run it
 * before they lock anything.
 */
export async function loadInvoiceFile(
  db: FileDb,
  input: { readonly organizationId: string; readonly memberId: string; readonly fileId: string; readonly poId: string },
): Promise<{ readonly ok: true; readonly file: StoredInvoiceFile } | { readonly ok: false; readonly reason: InvoiceFileRefusal }> {
  const file = await db.fileObject.findFirst({ where: { id: input.fileId, uploadedById: input.memberId, status: 'AVAILABLE' }, select: { id: true, storageKey: true, sha256: true } })
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
  const read = readEtaxContent(bytes)
  return { ok: true, file: { fileId: file.id, reading: read?.reading ?? { problem: 'NOT_AN_ETAX_INVOICE' } } }
}

/** A file is the paper of one invoice only; run under the PO's lock, so two invoices of the PO never share one */
export async function invoiceFileInUse(db: InvoiceDb, fileId: string): Promise<boolean> {
  return (await db.invoiceConfirmation.count({ where: { sourceFileId: fileId } })) > 0
}

/** BR-IVC-05: what the file makes of the invoice — refused when its seller is not the PO's supplier */
export function sourceOf(file: StoredInvoiceFile, supplierTaxId: string | null, values: RecordedValues): { readonly ok: true; readonly source: InvoiceSource } | { readonly ok: false; readonly reason: InvoiceFileRefusal } {
  if (!('prefill' in file.reading)) return { ok: true, source: { parsedFrom: 'MANUAL', kind: 'INVOICE' } }
  const p = file.reading.prefill
  if (p.sellerTaxId !== supplierTaxId) return { ok: false, reason: 'TAX_ID_MISMATCH' }
  const asRead = values.invoiceNo.trim() === p.invoiceNo && values.invoiceDate === p.invoiceDate && amountToSatang(values.net) === amountToSatang(p.net) && amountToSatang(values.vat) === amountToSatang(p.vat)
  return { ok: true, source: asRead ? { parsedFrom: 'ETAX_XML', kind: 'ETAX' } : { parsedFrom: 'MANUAL', kind: 'INVOICE' } }
}
