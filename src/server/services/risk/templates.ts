import { formatThaiDateTime } from '@/core/thai'
import { registerSupplierTemplate, supplierMail } from '@/server/notifications/supplier-notices'

// The e-mails of supplier risk to the supplier's contact (S11 · BR-RSK-17 BR-RSK-18 · "การแจ้งเตือน" of the sub-spec),
// registered in lane 3's own file and imported by the risk services and the job supplier-notice-send. Thai, a rule, then
// English, as every supplier e-mail. A link is dropped from the notice once sent (BR-PORTAL ข้อ 01).

export const RISK_SUPPLIER_TEMPLATES = {
  questionnaire: 'supplier.risk_questionnaire',
  reminder: 'supplier.risk_reminder',
  evidenceRejected: 'supplier.risk_evidence_rejected',
  // S11-06 (BR-NOTI-12): the outcome of the reviewers
  returned: 'supplier.risk_returned',
  completed: 'supplier.risk_completed',
} as const

const str = (v: unknown) => (typeof v === 'string' || typeof v === 'number' ? String(v) : '')
const at = (v: unknown) => (typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? formatThaiDateTime(v) : '')
const atEn = (v: unknown) =>
  typeof v === 'string' && !Number.isNaN(Date.parse(v))
    ? `${new Date(v).toLocaleString('en-GB', { timeZone: 'Asia/Bangkok', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })} (Bangkok)`
    : ''

registerSupplierTemplate(
  RISK_SUPPLIER_TEMPLATES.questionnaire,
  (d, c) =>
    supplierMail(
      `${c.organizationName} ขอให้ตอบแบบประเมินความเสี่ยงคู่ค้า ${str(d.number)} / Supplier risk questionnaire`,
      [`เรียน ${c.supplierName}`, `${c.organizationName} ขอให้ท่านตอบแบบประเมินความเสี่ยงคู่ค้าเลขที่ ${str(d.number)} ในพอร์ทัลผู้ขาย`, `กดลิงก์นี้เพื่อเข้าตอบ (ใช้ได้ครั้งเดียว ภายใน ${at(d.expiresAt)}):`, str(d.url)],
      [`${c.organizationName} asks you to answer its supplier risk questionnaire ${str(d.number)} in the supplier portal.`, `Open this link to answer (once, until ${atEn(d.expiresAt)}):`, str(d.url)],
    ),
  { redactAfterSend: ['url'] },
)

registerSupplierTemplate(
  RISK_SUPPLIER_TEMPLATES.reminder,
  (d, c) =>
    supplierMail(
      `เตือน: แบบประเมินความเสี่ยงคู่ค้า ${str(d.number)} ของ ${c.organizationName} / Reminder: risk questionnaire`,
      [`เรียน ${c.supplierName}`, `แบบประเมินความเสี่ยงคู่ค้าเลขที่ ${str(d.number)} ยังรอคำตอบของท่าน`, `กดลิงก์นี้เพื่อเข้าตอบต่อ (ใช้ได้ครั้งเดียว ภายใน ${at(d.expiresAt)}):`, str(d.url)],
      [`The supplier risk questionnaire ${str(d.number)} still waits for your answers.`, `Open this link to carry on (once, until ${atEn(d.expiresAt)}):`, str(d.url)],
    ),
  { redactAfterSend: ['url'] },
)

registerSupplierTemplate(RISK_SUPPLIER_TEMPLATES.evidenceRejected, (d, c) =>
  supplierMail(
    `ไฟล์หลักฐานของแบบประเมิน ${str(d.number)} ไม่ผ่านการตรวจความปลอดภัย / An evidence file failed the security check`,
    [`เรียน ${c.supplierName}`, `ไฟล์หลักฐานที่ท่านแนบในคำถาม ${str(d.questionCode)} ของแบบประเมินเลขที่ ${str(d.number)} ไม่ผ่านการตรวจความปลอดภัยและถูกนำออกแล้ว`, 'คำตอบของท่านยังอยู่ โปรดแนบไฟล์ใหม่ในพอร์ทัลผู้ขาย'],
    [`The evidence file you attached to question ${str(d.questionCode)} of questionnaire ${str(d.number)} failed the security check and was removed.`, 'Your answer stays; please attach a new file in the supplier portal.'],
  ),
)

// S11-06 (BR-RSK-08): a return carries only the words the reviewer allowed to reach the supplier, and a new link when the
// portal answers for it; nothing else of the review (who reviewed, the other parts) leaves BCS
registerSupplierTemplate(
  RISK_SUPPLIER_TEMPLATES.returned,
  (d, c) =>
    supplierMail(
      `แบบประเมินความเสี่ยงคู่ค้า ${str(d.number)} ของ ${c.organizationName} ขอให้แก้ไข / Risk questionnaire returned for changes`,
      [
        `เรียน ${c.supplierName}`,
        `${c.organizationName} ขอให้ท่านแก้ไขหรือเพิ่มเติมคำตอบในแบบประเมินความเสี่ยงคู่ค้าเลขที่ ${str(d.number)}`,
        ...(d.reason ? [`ข้อความจากผู้ตรวจ: ${str(d.reason)}`] : ['โปรดติดต่อฝ่ายจัดซื้อเพื่อทราบรายละเอียด']),
        ...(d.url ? [`กดลิงก์นี้เพื่อเข้าแก้ไข (ใช้ได้ครั้งเดียว ภายใน ${at(d.expiresAt)}):`, str(d.url)] : []),
      ],
      [
        `${c.organizationName} asks you to change or add to your answers in risk questionnaire ${str(d.number)}.`,
        ...(d.reason ? [`From the reviewer: ${str(d.reason)}`] : ['Please contact the procurement team for the details.']),
        ...(d.url ? [`Open this link to change them (once, until ${atEn(d.expiresAt)}):`, str(d.url)] : []),
      ],
    ),
  { redactAfterSend: ['url'] },
)

registerSupplierTemplate(RISK_SUPPLIER_TEMPLATES.completed, (d, c) =>
  supplierMail(
    `แบบประเมินความเสี่ยงคู่ค้า ${str(d.number)} ของ ${c.organizationName} เสร็จแล้ว / Risk questionnaire completed`,
    [`เรียน ${c.supplierName}`, `${c.organizationName} ตรวจแบบประเมินความเสี่ยงคู่ค้าเลขที่ ${str(d.number)} ครบแล้ว ขอบคุณที่ให้ข้อมูล`],
    [`${c.organizationName} has finished reviewing risk questionnaire ${str(d.number)}. Thank you for your answers.`],
  ),
)
