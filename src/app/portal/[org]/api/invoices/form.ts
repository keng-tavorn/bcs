// What the portal's invoice forms send (S7-12 · BR-SUP ข้อ 15): the supplier's number, the date, the VAT it states and
// whether its prices include VAT; on the invoice's page, its lines too (line.<poLineId>.qty / .price, a line without a
// quantity is not on the invoice). The words are checked again by invoice.update; here only the shape.

const AMOUNT = /^\d{1,13}(\.\d{1,2})?$/
const QTY = /^\d{1,14}(\.\d{1,4})?$/
const DATE = /^\d{4}-\d{2}-\d{2}$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export interface InvoiceHeader {
  readonly supplierInvoiceNo: string
  readonly invoiceDate: string
  readonly statedVat: string
  readonly priceIncludesVat: boolean
  readonly discount?: string
  readonly lines?: Array<{ poLineId: string; quantity: string; unitPrice: string }>
}

const text = (form: FormData, name: string) => {
  const v = form.get(name)
  return typeof v === 'string' ? v.trim() : ''
}
/** "1,234.50" as typed → "1234.50" */
const amount = (v: string) => v.replace(/,/g, '')

export function headerOf(form: FormData, withLines = false): { ok: true; data: InvoiceHeader } | { ok: false; reason: string } {
  const supplierInvoiceNo = text(form, 'supplierInvoiceNo')
  const invoiceDate = text(form, 'invoiceDate')
  const statedVat = amount(text(form, 'statedVat')) || '0'
  const discount = amount(text(form, 'discount'))
  if (!supplierInvoiceNo || supplierInvoiceNo.length > 60) return { ok: false, reason: 'INVOICE_NO' }
  if (!DATE.test(invoiceDate)) return { ok: false, reason: 'INVOICE_DATE' }
  if (!AMOUNT.test(statedVat) || (discount && !AMOUNT.test(discount))) return { ok: false, reason: 'AMOUNT' }
  const data: InvoiceHeader = { supplierInvoiceNo, invoiceDate, statedVat, priceIncludesVat: form.get('priceIncludesVat') === 'on', ...(discount ? { discount } : {}) }
  if (!withLines) return { ok: true, data }
  const lines: Array<{ poLineId: string; quantity: string; unitPrice: string }> = []
  for (const name of form.keys()) {
    const m = /^line\.([^.]+)\.qty$/.exec(name)
    if (!m || !UUID.test(m[1]!)) continue
    const quantity = amount(text(form, name))
    if (!quantity || /^0*(\.0*)?$/.test(quantity)) continue
    const unitPrice = amount(text(form, `line.${m[1]}.price`))
    if (!QTY.test(quantity) || !AMOUNT.test(unitPrice)) return { ok: false, reason: 'LINE' }
    lines.push({ poLineId: m[1]!, quantity, unitPrice })
  }
  if (lines.length === 0) return { ok: false, reason: 'NO_LINES' }
  return { ok: true, data: { ...data, lines } }
}
