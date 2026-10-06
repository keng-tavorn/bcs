// The file tasks-fixtures.ts attaches to a request through the file service, and the bytes the decision page must hand
// back when the approver opens it (FR-PLT-004 AC2, §9.9 principle 5). A minimal PDF: the service checks the %PDF- head.
export const ATTACHMENT_NAME = 'quotation-b.pdf'
export const ATTACHMENT_PDF = Buffer.from(`%PDF-1.7\n${'x'.repeat(256)}\n%%EOF\n`, 'latin1')
