// Synthetic e-Tax invoices for the invoice inbox of the phase-1 seed (S8-12): the XML after ขมธอ. 3-2560 (UN/CEFACT Cross
// Industry Invoice) with the parts the BR-IVC-05 reader uses — number, issue date, the seller's tax id and branch, the
// amount before VAT, VAT and total. Made from the history's own numbers, never a real supplier's file.

const escape = (text: string) => text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]!)

export interface EtaxSample {
  readonly invoiceNo: string
  /** "YYYY-MM-DD" */
  readonly issueDate: string
  readonly sellerName: string
  readonly sellerTaxId: string
  readonly sellerBranch: string
  /** Baht text with two decimals */
  readonly net: string
  readonly vat: string
  readonly gross: string
}

export function etaxSampleXml(s: EtaxSample): Uint8Array {
  const xml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<rsm:TaxInvoice_CrossIndustryInvoice xmlns:rsm="urn:etda:uncefact:data:standard:TaxInvoice_CrossIndustryInvoice:2" xmlns:ram="urn:etda:uncefact:data:standard:TaxInvoice_ReusableAggregateBusinessInformationEntity:2">',
    '  <rsm:ExchangedDocumentContext><ram:GuidelineSpecifiedDocumentContextParameter><ram:ID schemeAgencyID="ETDA">ER3-2560</ram:ID></ram:GuidelineSpecifiedDocumentContextParameter></rsm:ExchangedDocumentContext>',
    '  <rsm:ExchangedDocument>',
    `    <ram:ID>${escape(s.invoiceNo)}</ram:ID>`,
    '    <ram:Name>ใบกำกับภาษี</ram:Name>',
    '    <ram:TypeCode>388</ram:TypeCode>',
    `    <ram:IssueDateTime>${s.issueDate}T00:00:00</ram:IssueDateTime>`,
    '  </rsm:ExchangedDocument>',
    '  <rsm:SupplyChainTradeTransaction>',
    '    <ram:ApplicableHeaderTradeAgreement>',
    '      <ram:SellerTradeParty>',
    `        <ram:Name>${escape(s.sellerName)}</ram:Name>`,
    `        <ram:SpecifiedTaxRegistration><ram:ID schemeID="TXID">${s.sellerTaxId}${s.sellerBranch}</ram:ID></ram:SpecifiedTaxRegistration>`,
    '      </ram:SellerTradeParty>',
    '    </ram:ApplicableHeaderTradeAgreement>',
    '    <ram:ApplicableHeaderTradeSettlement>',
    '      <ram:InvoiceCurrencyCode listID="ISO 4217 3A">THB</ram:InvoiceCurrencyCode>',
    '      <ram:SpecifiedTradeSettlementHeaderMonetarySummation>',
    `        <ram:LineTotalAmount>${s.net}</ram:LineTotalAmount>`,
    `        <ram:TaxBasisTotalAmount>${s.net}</ram:TaxBasisTotalAmount>`,
    `        <ram:TaxTotalAmount>${s.vat}</ram:TaxTotalAmount>`,
    `        <ram:GrandTotalAmount>${s.gross}</ram:GrandTotalAmount>`,
    '      </ram:SpecifiedTradeSettlementHeaderMonetarySummation>',
    '    </ram:ApplicableHeaderTradeSettlement>',
    '  </rsm:SupplyChainTradeTransaction>',
    '</rsm:TaxInvoice_CrossIndustryInvoice>',
  ].join('\n')
  return new TextEncoder().encode(xml)
}

/**
 * A one-page scanned invoice stand-in (a supplier without e-Tax): a PDF the reader does not read, typed in by FINANCE.
 * Well formed, because the invoice's page opens it beside the values (NEW-115). Without a font of its own its page draws
 * Latin letters and digits only; the comment on its second line keeps every word, Thai too.
 */
export function scannedInvoicePdf(lines: readonly string[]): Uint8Array {
  const encoder = new TextEncoder()
  const words = lines.map((l) => l.replace(/[()\\]/g, ' '))
  const drawn = words.map((l) => l.replace(/[^\x20-\x7e]/g, '').trim()).filter(Boolean)
  const content = ['BT /F1 14 Tf 72 760 Td 22 TL', ...['SAMPLE INVOICE', ...drawn, 'Synthetic document for the demo'].map((l) => `(${l}) Tj T*`), 'ET'].join('\n')
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${encoder.encode(content).length} >>\nstream\n${content}\nendstream`,
  ]
  let body = `%PDF-1.4\n% BCS synthetic invoice: ${words.join(' / ')}\n`
  const at: number[] = []
  objects.forEach((object, i) => {
    at.push(encoder.encode(body).length)
    body += `${i + 1} 0 obj\n${object}\nendobj\n`
  })
  const xref = encoder.encode(body).length
  const entries = at.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')
  return encoder.encode(`${body}xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${entries}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`)
}
