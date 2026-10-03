// The e-mail that carries a purchase order to its supplier (spec §10.3 template "PO ถึงผู้ขาย", FR-P2P-005 AC1): the PO
// PDF attached, reply-to the procurement officer who sent it. Plain text and HTML, Thai first then English; short and
// polite, and nothing beyond what the PO itself shows (BR-NOTI-01).

export interface PoEmailInput {
  readonly supplierName: string
  readonly organizationName: string
  readonly poNumber: string
  /** "144,332.30" */
  readonly gross: string
  readonly senderName: string
  readonly resend: boolean
}

const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)

export function poEmail(input: PoEmailInput): { subject: string; text: string; html: string } {
  const again = input.resend ? ' (ส่งอีกครั้ง)' : ''
  const subject = `ใบสั่งซื้อ ${input.poNumber}${again} จาก ${input.organizationName} / Purchase order ${input.poNumber}`
  const thai = [
    `เรียน ${input.supplierName}`,
    `${input.organizationName} ขอส่งใบสั่งซื้อเลขที่ ${input.poNumber}${again} ยอดรวม ${input.gross} บาท ตามไฟล์แนบ`,
    `โปรดตอบกลับอีเมลนี้เพื่อยืนยันการรับใบสั่งซื้อ หรือติดต่อ ${input.senderName}`,
  ]
  const english = [`Please find attached purchase order ${input.poNumber} from ${input.organizationName}, total THB ${input.gross}.`, `Reply to this e-mail to confirm, or contact ${input.senderName}.`]
  const text = [...thai.slice(0, 1), '', ...thai.slice(1), '', ...english, ''].join('\n')
  const html = [
    '<div style="font-family: sans-serif; font-size: 15px; line-height: 1.6">',
    ...thai.map((line) => `<p>${escapeHtml(line)}</p>`),
    '<hr style="border: none; border-top: 1px solid #ddd">',
    ...english.map((line) => `<p style="color: #555">${escapeHtml(line)}</p>`),
    '</div>',
  ].join('\n')
  return { subject, text, html }
}
