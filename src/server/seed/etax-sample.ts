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

/** A one-page scanned invoice stand-in (a supplier without e-Tax): a PDF the reader does not read, typed in by FINANCE */
export function scannedInvoicePdf(lines: readonly string[]): Uint8Array {
  const text = lines.map((l) => l.replace(/[()\\]/g, ' ')).join(' / ')
  return new TextEncoder().encode(`%PDF-1.4\n% BCS synthetic invoice: ${text}\n%%EOF\n`)
}
