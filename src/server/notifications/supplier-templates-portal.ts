import { formatThaiDateTime } from '@/core/thai'
import { registerSupplierTemplate, supplierMail } from './supplier-notices'

// The e-mails of the supplier portal (S7-04 · BR-PORTAL ข้อ 01 ข้อ 02 · BR-SUP ข้อ 17), registered in lane 1's own file and
// imported by the portal's commands and the job supplier-notice-send. Thai, a rule, then English, as every supplier
// e-mail. The code e-mail has no link (BR-PORTAL ข้อ 02); the code and the link are dropped from the notice once sent.

export const PORTAL_SUPPLIER_TEMPLATES = {
  loginLink: 'supplier.login_link',
  otp: 'supplier.otp',
  newDevice: 'supplier.new_device',
  contactAdded: 'supplier.contact_added',
} as const

const str = (v: unknown) => (typeof v === 'string' || typeof v === 'number' ? String(v) : '')
const at = (v: unknown) => (typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? formatThaiDateTime(v) : '')

registerSupplierTemplate(
  PORTAL_SUPPLIER_TEMPLATES.loginLink,
  (d, c) =>
    supplierMail(
      `ลิงก์เข้าพอร์ทัลผู้ขายของ ${c.organizationName} / Your sign-in link`,
      [`เรียน ${c.supplierName}`, `กดลิงก์นี้เพื่อเข้าพอร์ทัลผู้ขายของ ${c.organizationName} (ใช้ได้ครั้งเดียว ภายใน ${at(d.expiresAt)}):`, str(d.url), 'หากท่านไม่ได้ขอลิงก์นี้ ไม่ต้องทำอะไร'],
      [`Open this link to sign in to the supplier portal of ${c.organizationName} (once, until ${str(d.expiresAt)}):`, str(d.url), 'If you did not ask for it, you need not do anything.'],
    ),
  { redactAfterSend: ['url'] },
)

registerSupplierTemplate(
  PORTAL_SUPPLIER_TEMPLATES.otp,
  (d, c) =>
    supplierMail(
      `รหัสยืนยัน ${str(d.code)} สำหรับพอร์ทัลผู้ขายของ ${c.organizationName} / Your code`,
      [`รหัสยืนยันของท่านคือ ${str(d.code)}`, `ใช้ได้ถึง ${at(d.expiresAt)} ที่หน้าพอร์ทัลผู้ขายของ ${c.organizationName} บนอุปกรณ์ที่ขอรหัสนี้เท่านั้น`, 'อย่าบอกรหัสนี้กับผู้ใด เจ้าหน้าที่ไม่มีวันขอรหัสนี้จากท่าน'],
      [`Your code is ${str(d.code)}, valid until ${str(d.expiresAt)} on the device that asked for it.`, 'Never share it: no one from the organization will ever ask you for it.'],
    ),
  { redactAfterSend: ['code'] },
)

registerSupplierTemplate(PORTAL_SUPPLIER_TEMPLATES.newDevice, (d, c) =>
  supplierMail(
    `มีการเข้าพอร์ทัลผู้ขายของ ${c.organizationName} จากอุปกรณ์ใหม่ / A new device signed in`,
    [`เรียน ${c.supplierName}`, `มีการเข้าพอร์ทัลผู้ขายของ ${c.organizationName} ด้วยบัญชีของ ${str(d.contactName)} จากอุปกรณ์ที่ไม่เคยใช้ เมื่อ ${at(d.signedInAt)}`, `หากไม่ใช่ท่าน โปรดติดต่อฝ่ายจัดซื้อของ ${c.organizationName} ทันที`],
    [`${str(d.contactName)} signed in to the supplier portal of ${c.organizationName} from a new device at ${str(d.signedInAt)}.`, 'If this was not you, call its procurement team at once.'],
  ),
)

// BR-SUP ข้อ 17: the address in the register (and the primary contact) always hears that someone may now act for the
// supplier, and who added them; never the new address
registerSupplierTemplate(PORTAL_SUPPLIER_TEMPLATES.contactAdded, (d, c) =>
  supplierMail(
    `${c.organizationName} เพิ่มผู้ติดต่อพอร์ทัลของท่าน / A portal contact was added`,
    [
      `เรียน ${c.supplierName}`,
      `${str(d.addedByTh)} ของ ${c.organizationName} ${d.changed === 'EMAIL' ? 'เปลี่ยนอีเมลของผู้ติดต่อ' : 'เพิ่มผู้ติดต่อ'} ${str(d.contactName)} ให้เข้าพอร์ทัลผู้ขายในนามของท่านได้`,
      `หากท่านไม่ได้ขอ โปรดติดต่อฝ่ายจัดซื้อของ ${c.organizationName} ทันทีทางเบอร์โทรศัพท์ที่ท่านรู้จัก`,
    ],
    [`${str(d.addedByEn) || str(d.addedByTh)} of ${c.organizationName} ${d.changed === 'EMAIL' ? 'changed the e-mail of' : 'added'} the contact ${str(d.contactName)}, who may now use the supplier portal for you.`, 'If you did not ask for this, call its procurement team at once on a number you know.'],
  ),
)
