import { createHash } from 'node:crypto'
import { z } from 'zod'
import { amountToSatang, satangToAmount } from '@/core/money/dto'
import { err, ok, type Result } from '@/core/result'
import { normalizeTaxId } from '@/core/thai/taxid'
import { MAX_UPLOAD_BYTES } from '@/lib/constants'
import { newId } from '@/lib/ids'
import { embeddedFiles } from '@/lib/pdf-embedded'
import { find, findDeep, parseXml, XmlError, type XmlElement } from '@/lib/xml'
import { putObject } from '@/integrations/storage'
import { authorize } from '@/server/authz'
import type { Ctx } from '@/server/context'
import { forTenant } from '@/server/db/tenant'
import { defineCommand, runCommand, type CommandOutcome } from '../_pipeline'

// Reading an e-Tax invoice to fill the confirmation form (spec BR-IVC-05, FR-P2P-008 AC4) — without AI: an e-Tax
// Invoice by Email is a PDF/A-3 that embeds its XML (ขมธอ. 3-2560, after UN/CEFACT Cross Industry Invoice); the full
// e-Tax system sends the XML itself. The XML is found among the PDF's embedded files by its content, not its name;
// the number, date, seller tax id and branch, amount before VAT, VAT and total are read and offered for FINANCE to
// confirm. A seller tax id that is not the PO's supplier, or no readable XML, is reported with the reason so the form
// is filled by hand. The file is kept under a storage key that names the PO it was read for (invoiceFileKey), and
// what the invoice says it came from is decided again from the stored file when it is recorded (./source.ts) — never
// on the word of the browser; what is read still goes through BR-IVC-01 to BR-IVC-04 when the invoice is recorded.

export interface EtaxPrefill {
  readonly invoiceNo: string
  /** YYYY-MM-DD */
  readonly invoiceDate: string
  readonly net: string
  readonly vat: string
  readonly gross: string
  readonly sellerTaxId: string
  /** The 5-digit branch when the file states it (with the tax id, as ขมธอ. 3-2560 writes it), otherwise null */
  readonly sellerBranch: string | null
}

export type EtaxProblem = 'XML_UNREADABLE' | 'NOT_AN_ETAX_INVOICE' | 'VALUE_MISSING' | 'TAX_ID_MISMATCH'

export interface EtaxReading {
  /** The stored file, to be the invoice's sourceFileId */
  readonly fileId: string
  readonly prefill: EtaxPrefill | null
  readonly problems: readonly EtaxProblem[]
}

const PDF_MIME = 'application/pdf'
const XML_MIME = 'application/xml'
/** Baht with at most two decimals that count; "1500.5000" is 1500.50, "1500.005" cannot be satang and is refused */
const AMOUNT = /^(\d+)(?:\.(\d{1,2})0*)?$/
/** A debit note (80) or credit note (81) changes earlier invoices; it is not read as an invoice of its own */
const NOT_INVOICES = new Set(['80', '81'])

/** "1500" "1500.5" "1500.50" → baht text with two decimals; anything else is null */
function amountText(element: XmlElement | null): string | null {
  const m = AMOUNT.exec(element?.text.trim() ?? '')
  if (!m) return null
  return satangToAmount(amountToSatang(m[2] ? `${m[1]}.${m[2]}` : m[1]!))
}

/** ISO date-time or the "20261005" form → YYYY-MM-DD, only for a day that exists */
function dateText(element: XmlElement | null): string | null {
  const value = element?.text.trim() ?? ''
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ]|$)/.exec(value) ?? /^(\d{4})(\d{2})(\d{2})$/.exec(value)
  if (!m) return null
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]
  const day = new Date(Date.UTC(y, mo - 1, d))
  return day.getUTCFullYear() === y && day.getUTCMonth() === mo - 1 && day.getUTCDate() === d ? `${m[1]}-${m[2]}-${m[3]}` : null
}

/** The invoice's values, or why they cannot be read */
export function readEtaxXml(xml: string): { prefill: EtaxPrefill } | { problem: Exclude<EtaxProblem, 'TAX_ID_MISMATCH'> } {
  let root: XmlElement
  try {
    root = parseXml(xml)
  } catch (error) {
    if (error instanceof XmlError) return { problem: 'XML_UNREADABLE' }
    throw error
  }
  const document = findDeep(root, 'ExchangedDocument')
  const seller = findDeep(root, 'SellerTradeParty')
  const summation = findDeep(root, 'SpecifiedTradeSettlementHeaderMonetarySummation')
  if (!document || !seller || !summation) return { problem: 'NOT_AN_ETAX_INVOICE' }
  if (NOT_INVOICES.has(find(document, 'TypeCode')?.text.trim() ?? '')) return { problem: 'NOT_AN_ETAX_INVOICE' }
  // The seller's registration: the 13-digit tax id, or the tax id and the 5-digit branch written together
  const registration = normalizeTaxId(find(seller, 'SpecifiedTaxRegistration', 'ID')?.text ?? '')
  const prefill = {
    invoiceNo: find(document, 'ID')?.text.trim() ?? '',
    invoiceDate: dateText(find(document, 'IssueDateTime', 'DateTimeString') ?? find(document, 'IssueDateTime')) ?? '',
    net: amountText(find(summation, 'TaxBasisTotalAmount') ?? find(summation, 'LineTotalAmount')) ?? '',
    vat: amountText(find(summation, 'TaxTotalAmount')) ?? '',
    gross: amountText(find(summation, 'GrandTotalAmount')) ?? '',
    sellerTaxId: registration.slice(0, 13),
    sellerBranch: registration.length === 18 ? registration.slice(13) : null,
  }
  if (!prefill.invoiceNo || !prefill.invoiceDate || !prefill.net || !prefill.vat || !prefill.gross || !/^\d{13}(\d{5})?$/.test(registration)) return { problem: 'VALUE_MISSING' }
  return { prefill }
}

/** The e-Tax file kept in the bucket, recorded like any upload (file.uploaded) so the invoice can link it as ETAX */
const StoreInput = z.strictObject({
  key: z.string().min(1),
  fileName: z.string().min(1).max(200),
  mimeType: z.enum([PDF_MIME, XML_MIME]),
  sizeBytes: z.number().int().positive(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
})

export const storeEtaxFileCommand = defineCommand({
  name: 'invoice_confirmation.store_etax',
  capability: 'invoiceConfirmation.record',
  input: StoreInput,
  async execute(tx, input, ctx): Promise<CommandOutcome<{ fileId: string }>> {
    const allowed = await authorize(tx, ctx, 'invoiceConfirmation.record')
    if (!allowed.ok) return { ok: false, error: allowed.error }
    if (allowed.data.kind !== 'member') return { ok: false, error: { code: 'FORBIDDEN', message: 'members only' } }
    const fileId = newId()
    await tx.fileObject.create({
      data: { id: fileId, organizationId: ctx.organizationId, storageKey: input.key, fileName: input.fileName, mimeType: input.mimeType, sizeBytes: input.sizeBytes, sha256: input.sha256, status: 'AVAILABLE', uploadedById: allowed.data.memberId, scanStatus: 'NOT_REQUIRED' },
    })
    return { ok: true, result: { fileId }, events: [{ type: 'file.uploaded', aggregateType: 'File', aggregateId: fileId, data: { fileId, mimeType: input.mimeType, sizeBytes: input.sizeBytes } }] }
  },
})

function looksLikeXml(bytes: Uint8Array): boolean {
  const head = new TextDecoder('utf-8').decode(bytes.subarray(0, 64)).replace(/^\uFEFF/, '').trimStart()
  return head.startsWith('<')
}

/** What a file's bytes say, nothing else: an e-Tax invoice's values or why there are none */
export type EtaxContentReading = { readonly prefill: EtaxPrefill } | { readonly problem: Exclude<EtaxProblem, 'TAX_ID_MISMATCH'> }

/**
 * Reads a PDF or an XML file (null for any other file): the XML is the file itself, or the embedded file of the PDF
 * that reads as an e-Tax invoice. Pure: the same bytes always give the same reading, at upload and when recorded.
 */
export function readEtaxContent(content: Uint8Array): { readonly type: 'PDF' | 'XML'; readonly reading: EtaxContentReading } | null {
  const isPdf = new TextDecoder('latin1').decode(content.subarray(0, 5)) === '%PDF-'
  if (!isPdf && !looksLikeXml(content)) return null
  const candidates = isPdf ? embeddedFiles(content) : [content]
  let reading: EtaxContentReading = { problem: isPdf && candidates.length === 0 ? 'NOT_AN_ETAX_INVOICE' : 'XML_UNREADABLE' }
  for (const candidate of candidates) {
    const result = readEtaxXml(new TextDecoder('utf-8').decode(candidate))
    if ('prefill' in result) {
      reading = result
      break
    }
    // keep the most telling problem: a readable XML that is not an invoice beats a broken one
    if (!('prefill' in reading) && reading.problem === 'XML_UNREADABLE') reading = result
  }
  return { type: isPdf ? 'PDF' : 'XML', reading }
}

/**
 * The storage key of a file FINANCE uploads for the invoices of one PO. The PO is part of the key, which the server
 * chooses and never changes, so the file stays bound to the PO it was read for (BR-IVC-05, ./source.ts).
 */
export function invoiceFileKey(organizationId: string, poId: string): string {
  return `${invoiceFilePrefix(organizationId, poId)}${newId()}`
}

export const invoiceFilePrefix = (organizationId: string, poId: string): string => `org/${organizationId}/invoice-files/${poId}/`

/** FR-P2P-008 AC4: FINANCE uploads the e-Tax file of a PO's invoice; returns what to fill in and any problem */
export async function readEtaxFile(ctx: Ctx, input: { poId: string; fileName: string; content: Uint8Array }): Promise<Result<EtaxReading>> {
  const db = forTenant(ctx.organizationId)
  const allowed = await db.$transaction((tx) => authorize(tx, ctx, 'invoiceConfirmation.record'))
  if (!allowed.ok) return err(allowed.error.code, allowed.error.message, allowed.error.details)
  if (allowed.data.kind !== 'member') return err('FORBIDDEN', 'members only')
  const po = await db.purchaseOrder.findFirst({ where: { id: input.poId }, select: { id: true, supplier: { select: { taxId: true, branchCode: true } } } })
  if (!po) return err('NOT_FOUND', 'purchase order not found')
  if (input.content.length === 0 || input.content.length > MAX_UPLOAD_BYTES) return err('VALIDATION_FAILED', 'the file is empty or too large', { field: 'file', reason: input.content.length ? 'TOO_LARGE' : 'EMPTY' })
  const read = readEtaxContent(input.content)
  if (!read) return err('VALIDATION_FAILED', 'an e-Tax file is a PDF or an XML file', { field: 'file', reason: 'TYPE_NOT_ALLOWED' })
  const { reading } = read

  const isPdf = read.type === 'PDF'
  const mime = isPdf ? PDF_MIME : XML_MIME
  const key = invoiceFileKey(ctx.organizationId, po.id)
  await putObject(key, input.content, mime)
  const sha256 = createHash('sha256').update(input.content).digest('hex')
  const fileName = input.fileName.replace(/[\\/\u0000-\u001f]/g, ' ').trim().slice(0, 200) || (isPdf ? 'etax.pdf' : 'etax.xml')
  const stored = await runCommand(ctx, storeEtaxFileCommand, { key, fileName, mimeType: mime, sizeBytes: input.content.length, sha256 }, { idempotencyKey: `etax:${key}` })
  if (!stored.ok) return stored
  const fileId = stored.data.fileId

  if (!('prefill' in reading)) return ok({ fileId, prefill: null, problems: [reading.problem] })
  const problems: EtaxProblem[] = []
  // BR-IVC-05: the seller must be the PO's supplier
  if (reading.prefill.sellerTaxId !== po.supplier.taxId) problems.push('TAX_ID_MISMATCH')
  return ok({ fileId, prefill: problems.length ? null : reading.prefill, problems })
}
