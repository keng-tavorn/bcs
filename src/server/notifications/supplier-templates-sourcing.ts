import { formatThaiDateTime } from '@/core/thai'
import { registerSupplierTemplate, supplierMail } from './supplier-notices'

// The e-mails of sourcing to suppliers (S10 · BR-NOTI-11), registered in lane 2's own file and imported by the sourcing
// services and the job supplier-notice-send. Thai, a rule, then English, as every supplier e-mail; never a price of
// another supplier, never who asked a question. The link of an invitation is dropped from the notice once sent.

export const SOURCING_SUPPLIER_TEMPLATES = {
  invited: 'rfx.invited',
  reminder: 'rfx.reminder',
  amended: 'rfx.amended',
  extended: 'rfx.extended',
  questionAnswered: 'rfx.question_answered',
  bidReceived: 'rfx.bid_received',
  closed: 'rfx.closed',
  cancelled: 'rfx.cancelled',
  fileRejected: 'rfx.file_rejected',
  awarded: 'rfx.awarded',
  notAwarded: 'rfx.not_awarded',
  netPriceConfirmRequested: 'rfx.net_price_confirm_requested',
} as const

const str = (v: unknown) => (typeof v === 'string' || typeof v === 'number' ? String(v) : '')
const at = (v: unknown) => (typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? formatThaiDateTime(v) : '')
/** The English line's time: Bangkok's, as the Thai line shows it */
const atEn = (v: unknown) =>
  typeof v === 'string' && !Number.isNaN(Date.parse(v))
    ? `${new Date(v).toLocaleString('en-GB', { timeZone: 'Asia/Bangkok', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })} (Bangkok)`
    : ''
/** The RFx's title in English when it has one (BR-FORM-11), else the Thai one */
const titleEn = (d: Record<string, unknown>) => str(d.titleEn) || str(d.title)

registerSupplierTemplate(
  SOURCING_SUPPLIER_TEMPLATES.invited,
  (d, c) =>
    supplierMail(
      `${c.organizationName} เชิญเสนอราคา ${str(d.number)} / Invitation to bid ${str(d.number)}`,
      [
        `เรียน ${c.supplierName}`,
        `${c.organizationName} เชิญท่านยื่นข้อเสนอสำหรับ "${str(d.title)}" (${str(d.number)})`,
        `ปิดรับข้อเสนอ ${at(d.closesAt)} · ถามคำถามได้ถึง ${at(d.questionCutoffAt)}`,
        'กดลิงก์นี้เพื่อเข้าพอร์ทัล (ใช้ได้ครั้งเดียว ระบบจะส่งรหัสยืนยัน 6 หลักไปที่อีเมลนี้):',
        str(d.url),
        `หากใช้ลิงก์แล้ว เข้าอีกครั้งได้ที่ ${str(d.loginUrl)} ด้วยอีเมลนี้`,
      ],
      [
        `${c.organizationName} invites you to bid for "${titleEn(d)}" (${str(d.number)}).`,
        `Bids close ${atEn(d.closesAt)} · questions until ${atEn(d.questionCutoffAt)}.`,
        'Open this link to sign in (once; a six-digit code will be sent to this e-mail):',
        str(d.url),
        `After that, sign in again at ${str(d.loginUrl)} with this e-mail.`,
      ],
    ),
  { redactAfterSend: ['url'] },
)

registerSupplierTemplate(SOURCING_SUPPLIER_TEMPLATES.reminder, (d, c) =>
  supplierMail(
    `เตือน: ${str(d.number)} ปิดรับข้อเสนอ ${at(d.closesAt)} / Reminder: bids close soon`,
    [`เรียน ${c.supplierName}`, `${str(d.number)} "${str(d.title)}" จะปิดรับข้อเสนอ ${at(d.closesAt)} ท่านยังไม่ได้ยื่นข้อเสนอหรือแจ้งไม่เสนอ`, `เข้าพอร์ทัลได้ที่ ${str(d.loginUrl)}`],
    [`${str(d.number)} "${titleEn(d)}" closes ${atEn(d.closesAt)}; you have not bid or declined yet.`, `Sign in at ${str(d.loginUrl)}.`],
  ),
)

registerSupplierTemplate(SOURCING_SUPPLIER_TEMPLATES.amended, (d, c) =>
  supplierMail(
    `${str(d.number)} มีการแก้ไข (ฉบับที่ ${str(d.revisionNo)}) / Amendment ${str(d.revisionNo)}`,
    [
      `เรียน ${c.supplierName}`,
      `${c.organizationName} แก้ไข ${str(d.number)} "${str(d.title)}" เป็นฉบับที่ ${str(d.revisionNo)}: ${str(d.summary)}`,
      `ปิดรับข้อเสนอ ${at(d.closesAt)} · ข้อเสนอที่ยื่นก่อนฉบับนี้ต้องยืนยันหรือยื่นใหม่ในพอร์ทัล ${str(d.loginUrl)}`,
    ],
    [
      `${c.organizationName} amended ${str(d.number)} "${titleEn(d)}" (revision ${str(d.revisionNo)}): ${str(d.summaryEn) || str(d.summary)}`,
      `Bids close ${atEn(d.closesAt)}; a bid sent before this revision must be confirmed or sent again on the portal ${str(d.loginUrl)}.`,
    ],
  ),
)

registerSupplierTemplate(SOURCING_SUPPLIER_TEMPLATES.extended, (d, c) =>
  supplierMail(
    `${str(d.number)} ขยายเวลาปิดรับเป็น ${at(d.closesAt)} / Closing time extended`,
    [`เรียน ${c.supplierName}`, `${c.organizationName} ขยายเวลาปิดรับข้อเสนอของ ${str(d.number)} "${str(d.title)}" จาก ${at(d.previousClosesAt)} เป็น ${at(d.closesAt)} เงื่อนไขอื่นไม่เปลี่ยน`, `เข้าพอร์ทัลได้ที่ ${str(d.loginUrl)}`],
    [`${c.organizationName} extended the close of ${str(d.number)} "${titleEn(d)}" from ${atEn(d.previousClosesAt)} to ${atEn(d.closesAt)}; nothing else changed.`, `Sign in at ${str(d.loginUrl)}.`],
  ),
)

// BR-RFX-04: the question and its answer, never who asked
registerSupplierTemplate(SOURCING_SUPPLIER_TEMPLATES.questionAnswered, (d, c) =>
  supplierMail(
    `คำถามและคำตอบของ ${str(d.number)} / A question answered`,
    [`เรียน ${c.supplierName}`, `${c.organizationName} ตอบคำถามของ ${str(d.number)} "${str(d.title)}"`, `คำถาม: ${str(d.question)}`, `คำตอบ: ${str(d.answer)}`, `อ่านคำถามคำตอบทั้งหมดในพอร์ทัล ${str(d.loginUrl)}`],
    [`${c.organizationName} answered a question about ${str(d.number)} "${titleEn(d)}".`, `Question: ${str(d.question)}`, `Answer: ${str(d.answer)}`, `Read every question and answer on the portal ${str(d.loginUrl)}.`],
  ),
)

// BR-RFX-07: the supplier's own amounts back, never anyone else's
registerSupplierTemplate(SOURCING_SUPPLIER_TEMPLATES.bidReceived, (d, c) =>
  supplierMail(
    `${c.organizationName} ได้รับข้อเสนอของท่านสำหรับ ${str(d.number)} แล้ว / Bid received`,
    [`เรียน ${c.supplierName}`, `${c.organizationName} ได้รับข้อเสนอครั้งที่ ${str(d.submitCount)} ของท่านสำหรับ ${str(d.number)} "${str(d.title)}" แล้ว`, ...(d.rfi ? [] : [`ยอดก่อน VAT ${str(d.net)} บาท · VAT ${str(d.vat)} บาท · รวม ${str(d.gross)} บาท`]), `แก้หรือถอนได้จนปิดรับที่พอร์ทัล ${str(d.loginUrl)}`],
    [`${c.organizationName} received your bid no. ${str(d.submitCount)} for ${str(d.number)} "${titleEn(d)}".`, ...(d.rfi ? [] : [`Before VAT ${str(d.net)} THB · VAT ${str(d.vat)} THB · total ${str(d.gross)} THB`]), `You may change or withdraw it until the close on the portal ${str(d.loginUrl)}.`],
  ),
)

registerSupplierTemplate(SOURCING_SUPPLIER_TEMPLATES.closed, (d, c) =>
  supplierMail(
    `${str(d.number)} ปิดรับข้อเสนอแล้ว / Bidding closed`,
    [`เรียน ${c.supplierName}`, `${str(d.number)} "${str(d.title)}" ปิดรับข้อเสนอเมื่อ ${at(d.closedAt)} ขอบคุณที่ยื่นข้อเสนอ เราจะแจ้งผลอีกครั้ง`],
    [`${str(d.number)} "${titleEn(d)}" closed for bids at ${atEn(d.closedAt)}. Thank you for your bid; we will write again with the result.`],
  ),
)

registerSupplierTemplate(SOURCING_SUPPLIER_TEMPLATES.cancelled, (d, c) =>
  supplierMail(
    `${c.organizationName} ยกเลิก ${str(d.number) || str(d.title)} / Cancelled`,
    [`เรียน ${c.supplierName}`, `${c.organizationName} ยกเลิกการจัดหา "${str(d.title)}" ${str(d.number)} แล้ว ข้อเสนอที่ยื่นไว้ไม่ถูกพิจารณา`],
    [`${c.organizationName} cancelled "${titleEn(d)}" ${str(d.number)}. Bids sent for it will not be considered.`],
  ),
)

// S10-07 (BR-PORTAL-07): a file attached to a bid that the central scan found infected is taken off the bid
registerSupplierTemplate(SOURCING_SUPPLIER_TEMPLATES.fileRejected, (d, c) =>
  supplierMail(
    `${str(d.number)} ไฟล์แนบไม่ผ่านการตรวจ / An attached file was refused`,
    [`เรียน ${c.supplierName}`, `ไฟล์ "${str(d.fileName)}" ที่แนบกับข้อเสนอ ${str(d.number)} "${str(d.title)}" ไม่ผ่านการตรวจความปลอดภัย ระบบนำออกจากข้อเสนอแล้ว กรุณาแนบไฟล์ใหม่ก่อนปิดรับในพอร์ทัล ${str(d.loginUrl)}`],
    [`The file "${str(d.fileName)}" attached to your bid for ${str(d.number)} "${titleEn(d)}" did not pass the security check and was taken off the bid. Please attach another before the close at ${str(d.loginUrl)}.`],
  ),
)

// S10-11 (FR-SRC-204 AC3 · BR-NOTI-11): the award approved — to a winner its own lines and prices before VAT, the PO
// following on its own; to a supplier who bid and won nothing a thank-you without the winner or any price
type AwardedLine = { readonly lineNo?: unknown; readonly description?: unknown; readonly quantity?: unknown; readonly uom?: unknown; readonly unitPrice?: unknown; readonly lineNet?: unknown }
const awardedLines = (d: Record<string, unknown>) => (Array.isArray(d.lines) ? (d.lines as AwardedLine[]) : [])

registerSupplierTemplate(SOURCING_SUPPLIER_TEMPLATES.awarded, (d, c) =>
  supplierMail(
    `${c.organizationName} มอบงาน ${str(d.number)} ให้ท่าน / You won ${str(d.number)}`,
    [
      `เรียน ${c.supplierName}`,
      `${c.organizationName} อนุมัติผลการจัดหา ${str(d.number)} "${str(d.title)}" ให้ท่านในรายการต่อไปนี้ (ราคาก่อน VAT):`,
      // a winner who bid with VAT has no price before VAT until it confirms one: its line's amount before VAT only
      ...awardedLines(d).map((l) => `รายการ ${str(l.lineNo)} ${str(l.description)} · ${str(l.quantity)} ${str(l.uom)}${str(l.unitPrice) ? ` × ${str(l.unitPrice)} บาท = ${str(l.lineNet)} บาท` : ` · ยอดก่อน VAT ${str(l.lineNet)} บาท`}`),
      d.pendingPrice ? 'ท่านยื่นราคารวม VAT กรุณายืนยันราคาก่อน VAT ในพอร์ทัลก่อน ใบสั่งซื้อจะตามมาหลังยืนยัน' : d.need ? 'ราคาที่มอบจะเป็นราคาตกลงของรายการที่มีในแคตตาล็อก' : 'ใบสั่งซื้อจะส่งตามมาแยกต่างหาก',
      `ดูผลในพอร์ทัล ${str(d.loginUrl)}`,
    ],
    [
      `${c.organizationName} approved the award of ${str(d.number)} "${titleEn(d)}" to you for these lines (before VAT):`,
      ...awardedLines(d).map((l) => `Line ${str(l.lineNo)} · ${str(l.quantity)} ${str(l.uom)}${str(l.unitPrice) ? ` × ${str(l.unitPrice)} THB = ${str(l.lineNet)} THB` : ` · ${str(l.lineNet)} THB before VAT`}`),
      d.pendingPrice ? 'You bid with VAT included: please confirm your prices before VAT on the portal first; the purchase order follows.' : d.need ? 'The awarded prices become the agreed prices of the catalogue items.' : 'The purchase order follows separately.',
      `See the result on the portal ${str(d.loginUrl)}.`,
    ],
  ),
)

registerSupplierTemplate(SOURCING_SUPPLIER_TEMPLATES.notAwarded, (d, c) =>
  supplierMail(
    `ผลการจัดหา ${str(d.number)} / Result of ${str(d.number)}`,
    [`เรียน ${c.supplierName}`, `${c.organizationName} ขอบคุณที่ยื่นข้อเสนอสำหรับ ${str(d.number)} "${str(d.title)}" ครั้งนี้ข้อเสนอของท่านไม่ได้รับเลือก หวังว่าจะได้ร่วมงานกันในครั้งต่อไป`],
    [`${c.organizationName} thanks you for your bid for ${str(d.number)} "${titleEn(d)}". It was not selected this time; we hope to work with you next time.`],
  ),
)

// OQ-212: a winner who bid with VAT included confirms each line's price before VAT, at most the price bid less its VAT
registerSupplierTemplate(SOURCING_SUPPLIER_TEMPLATES.netPriceConfirmRequested, (d, c) =>
  supplierMail(
    `กรุณายืนยันราคาก่อน VAT ของ ${str(d.number)} / Please confirm your prices before VAT`,
    [
      `เรียน ${c.supplierName}`,
      `ท่านยื่นราคารวม VAT สำหรับ ${str(d.number)} "${str(d.title)}" ก่อนออกใบสั่งซื้อ กรุณายืนยันราคาต่อหน่วยก่อน VAT ของแต่ละรายการในพอร์ทัล (ราคาก่อน VAT บวก VAT ต้องไม่เกินราคาที่ยื่น)`,
      `ยืนยันได้ที่ ${str(d.loginUrl)}`,
    ],
    [`You bid with VAT included for ${str(d.number)} "${titleEn(d)}". Before the purchase order, please confirm each line's unit price before VAT on the portal (that price plus VAT may not exceed your bid).`, `Confirm at ${str(d.loginUrl)}.`],
  ),
)
