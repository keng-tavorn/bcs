import { deflateSync } from 'node:zlib'

// Test-made e-Tax files (spec BR-IVC-05) — never a real supplier's invoice: the XML after ขมธอ. 3-2560 (UN/CEFACT Cross
// Industry Invoice) with the parts the reader uses, and a PDF/A-3-shaped file that embeds files the way an e-Tax
// Invoice by Email carries its XML.

export interface EtaxXmlValues {
  invoiceNo?: string
  /** 388 tax invoice (default), T02 invoice/tax invoice, 80 debit note, 81 credit note */
  typeCode?: string
  issueDate?: string
  sellerRegistration?: string
  net?: string
  vat?: string
  gross?: string
}

export function etaxXml(values: EtaxXmlValues = {}): string {
  const v = { invoiceNo: 'ET-0001', typeCode: '388', issueDate: '2026-10-05T00:00:00', sellerRegistration: '0999999000012', net: '10000.00', vat: '700.00', gross: '10700.00', ...values }
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<rsm:TaxInvoice_CrossIndustryInvoice xmlns:rsm="urn:etda:uncefact:data:standard:TaxInvoice_CrossIndustryInvoice:2" xmlns:ram="urn:etda:uncefact:data:standard:TaxInvoice_ReusableAggregateBusinessInformationEntity:2">',
    '  <rsm:ExchangedDocumentContext><ram:GuidelineSpecifiedDocumentContextParameter><ram:ID schemeAgencyID="ETDA">ER3-2560</ram:ID></ram:GuidelineSpecifiedDocumentContextParameter></rsm:ExchangedDocumentContext>',
    '  <rsm:ExchangedDocument>',
    `    <ram:ID>${v.invoiceNo}</ram:ID>`,
    '    <ram:Name>ใบกำกับภาษี</ram:Name>',
    `    <ram:TypeCode>${v.typeCode}</ram:TypeCode>`,
    `    <ram:IssueDateTime>${v.issueDate}</ram:IssueDateTime>`,
    '  </rsm:ExchangedDocument>',
    '  <rsm:SupplyChainTradeTransaction>',
    '    <ram:ApplicableHeaderTradeAgreement>',
    '      <ram:SellerTradeParty>',
    '        <ram:Name>บริษัท ผู้ขายทดสอบ &amp; ลูก จำกัด</ram:Name>',
    `        <ram:SpecifiedTaxRegistration><ram:ID schemeID="TXID">${v.sellerRegistration}</ram:ID></ram:SpecifiedTaxRegistration>`,
    '      </ram:SellerTradeParty>',
    '    </ram:ApplicableHeaderTradeAgreement>',
    '    <ram:ApplicableHeaderTradeSettlement>',
    '      <ram:InvoiceCurrencyCode listID="ISO 4217 3A">THB</ram:InvoiceCurrencyCode>',
    '      <ram:SpecifiedTradeSettlementHeaderMonetarySummation>',
    `        <ram:LineTotalAmount>${v.net}</ram:LineTotalAmount>`,
    `        <ram:TaxBasisTotalAmount>${v.net}</ram:TaxBasisTotalAmount>`,
    `        <ram:TaxTotalAmount>${v.vat}</ram:TaxTotalAmount>`,
    `        <ram:GrandTotalAmount>${v.gross}</ram:GrandTotalAmount>`,
    '      </ram:SpecifiedTradeSettlementHeaderMonetarySummation>',
    '    </ram:ApplicableHeaderTradeSettlement>',
    '  </rsm:SupplyChainTradeTransaction>',
    '</rsm:TaxInvoice_CrossIndustryInvoice>',
  ].join('\n')
}

export interface Embedded {
  name: string
  content: string | Uint8Array
  /** The /Filter: FlateDecode (default) or [/FlateDecode] deflate the content, none writes it as it is, any other value
   *  is written verbatim over the content as it is */
  filter?: string
  /** Write /Length as an indirect reference instead of the number */
  indirectLength?: boolean
  /** Bytes written as the stream in place of the encoded content (a damaged stream) */
  written?: Uint8Array
}

/** A one-page PDF whose catalogue lists `files` as its embedded (associated) files, with a cross-reference table */
export function pdfWithEmbedded(files: readonly Embedded[], options: { encrypted?: boolean } = {}): Uint8Array {
  const chunks: Buffer[] = []
  const offsets: number[] = []
  let size = 0
  const push = (chunk: Buffer | string) => {
    const b = typeof chunk === 'string' ? Buffer.from(chunk, 'latin1') : chunk
    chunks.push(b)
    size += b.length
  }
  const object = (n: number, body: Array<Buffer | string>) => {
    offsets[n] = size
    push(`${n} 0 obj\n`)
    for (const part of body) push(part)
    push('\nendobj\n')
  }
  push('%PDF-1.7\n%\xe2\xe3\xcf\xd3\n')
  // objects 1–3: catalogue, pages, page; then per file a file specification and its stream (and its length object)
  const firstFile = 4
  const specs = files.map((_, i) => firstFile + i * 3)
  const names = files.map((f, i) => `(${f.name}) ${specs[i]} 0 R`).join(' ')
  object(1, [`<< /Type /Catalog /Pages 2 0 R /Names << /EmbeddedFiles << /Names [${names}] >> >> /AF [${specs.map((s) => `${s} 0 R`).join(' ')}] >>`])
  object(2, ['<< /Type /Pages /Kids [3 0 R] /Count 1 >>'])
  object(3, ['<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] >>'])
  files.forEach((file, i) => {
    const spec = specs[i]!
    const content = typeof file.content === 'string' ? Buffer.from(file.content, 'utf8') : Buffer.from(file.content)
    const filter = file.filter ?? 'FlateDecode'
    const flate = filter === 'FlateDecode' || filter === '[/FlateDecode]'
    const data = file.written ? Buffer.from(file.written) : flate ? deflateSync(content) : content
    const filterEntry = filter === 'none' ? '' : filter === 'FlateDecode' ? ' /Filter /FlateDecode' : ` /Filter ${filter}`
    object(spec, [`<< /Type /Filespec /F (${file.name}) /UF (${file.name}) /AFRelationship /Data /EF << /F ${spec + 1} 0 R >> >>`])
    const length = file.indirectLength ? `${spec + 2} 0 R` : String(data.length)
    object(spec + 1, [`<< /Type /EmbeddedFile /Subtype /text#2Fxml /Params << /Size ${content.length} >>${filterEntry} /Length ${length} >>\nstream\n`, data, '\nendstream'])
    object(spec + 2, [String(data.length)])
  })
  const count = firstFile + files.length * 3
  const xrefAt = size
  push(`xref\n0 ${count}\n0000000000 65535 f \n`)
  for (let n = 1; n < count; n++) push(`${String(offsets[n]).padStart(10, '0')} 00000 n \n`)
  push(`trailer\n<< /Size ${count} /Root 1 0 R${options.encrypted ? ' /Encrypt << /Filter /Standard /V 2 >>' : ''} >>\nstartxref\n${xrefAt}\n%%EOF\n`)
  return new Uint8Array(Buffer.concat(chunks))
}
