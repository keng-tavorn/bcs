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
  // S7-05 (BR-SUP ข้อ 08 ข้อ 10 ข้อ 11): the application's e-mails to its contact
  invitation: 'supplier.invitation',
  applicationCopy: 'supplier.application_copy',
  applicationReturned: 'supplier.application_returned',
  applicationRejected: 'supplier.application_rejected',
  applicationApproved: 'supplier.application_approved',
  // S7-07 (BR-SUP ข้อ 12)
  applicationReminder: 'supplier.application_reminder',
  applicationExpired: 'supplier.application_expired',
  // S7-11 (FR-SUP-105): the supplier's own confirmation of its acknowledgement
  poDeliveryAck: 'supplier.po_delivery_ack',
  // S7-06 (BR-SDOC ข้อ 03 ข้อ 04)
  documentRejected: 'supplier.document_rejected',
  documentExpiring: 'supplier.document_expiring',
} as const

const str = (v: unknown) => (typeof v === 'string' || typeof v === 'number' ? String(v) : '')
const at = (v: unknown) => (typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? formatThaiDateTime(v) : '')
/** The English line's time: Bangkok's, as the Thai line shows it */
const atEn = (v: unknown) =>
  typeof v === 'string' && !Number.isNaN(Date.parse(v))
    ? `${new Date(v).toLocaleString('en-GB', { timeZone: 'Asia/Bangkok', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })} (Bangkok)`
    : ''

registerSupplierTemplate(
  PORTAL_SUPPLIER_TEMPLATES.loginLink,
  (d, c) =>
    supplierMail(
      `ลิงก์เข้าพอร์ทัลผู้ขายของ ${c.organizationName} / Your sign-in link`,
      [`เรียน ${c.supplierName}`, `กดลิงก์นี้เพื่อเข้าพอร์ทัลผู้ขายของ ${c.organizationName} (ใช้ได้ครั้งเดียว ภายใน ${at(d.expiresAt)}):`, str(d.url), 'หากท่านไม่ได้ขอลิงก์นี้ ไม่ต้องทำอะไร'],
      [`Open this link to sign in to the supplier portal of ${c.organizationName} (once, until ${atEn(d.expiresAt)}):`, str(d.url), 'If you did not ask for it, you need not do anything.'],
    ),
  { redactAfterSend: ['url'] },
)

registerSupplierTemplate(
  PORTAL_SUPPLIER_TEMPLATES.otp,
  (d, c) =>
    supplierMail(
      `รหัสยืนยัน ${str(d.code)} สำหรับพอร์ทัลผู้ขายของ ${c.organizationName} / Your code`,
      [`รหัสยืนยันของท่านคือ ${str(d.code)}`, `ใช้ได้ถึง ${at(d.expiresAt)} ที่หน้าพอร์ทัลผู้ขายของ ${c.organizationName} บนอุปกรณ์ที่ขอรหัสนี้เท่านั้น`, 'อย่าบอกรหัสนี้กับผู้ใด เจ้าหน้าที่ไม่มีวันขอรหัสนี้จากท่าน'],
      [`Your code is ${str(d.code)}, valid until ${atEn(d.expiresAt)} on the device that asked for it.`, 'Never share it: no one from the organization will ever ask you for it.'],
    ),
  { redactAfterSend: ['code'] },
)

registerSupplierTemplate(PORTAL_SUPPLIER_TEMPLATES.newDevice, (d, c) =>
  supplierMail(
    `มีการเข้าพอร์ทัลผู้ขายของ ${c.organizationName} จากอุปกรณ์ใหม่ / A new device signed in`,
    [`เรียน ${c.supplierName}`, `มีการเข้าพอร์ทัลผู้ขายของ ${c.organizationName} ด้วยบัญชีของ ${str(d.contactName)} จากอุปกรณ์ที่ไม่เคยใช้ เมื่อ ${at(d.signedInAt)}`, `หากไม่ใช่ท่าน โปรดติดต่อฝ่ายจัดซื้อของ ${c.organizationName} ทันที`],
    [`${str(d.contactName)} signed in to the supplier portal of ${c.organizationName} from a new device at ${atEn(d.signedInAt)}.`, 'If this was not you, call its procurement team at once.'],
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

// ---------- S7-05: the application ----------

registerSupplierTemplate(
  PORTAL_SUPPLIER_TEMPLATES.invitation,
  (d, c) =>
    supplierMail(
      `${c.organizationName} เชิญท่านขึ้นทะเบียนผู้ขาย / Invitation to register as a supplier`,
      [`เรียน ${c.supplierName}`, `${c.organizationName} เชิญท่านกรอกใบสมัครผู้ขายผ่านพอร์ทัล กดลิงก์นี้ (ใช้ได้ครั้งเดียว ภายใน ${at(d.expiresAt)}):`, str(d.url), 'เมื่อกดลิงก์ ระบบจะส่งรหัสยืนยัน 6 หลักไปที่อีเมลนี้'],
      [`${c.organizationName} invites you to fill in its supplier application on the portal. Open this link (once, until ${atEn(d.expiresAt)}):`, str(d.url), 'A six-digit code will then be sent to this e-mail.'],
    ),
  { redactAfterSend: ['url'] },
)

// BR-SUP ข้อ 10: what procurement filled in for the supplier, sent with every submit — never the whole account number
registerSupplierTemplate(PORTAL_SUPPLIER_TEMPLATES.applicationCopy, (d, c) => {
  const lines = Array.isArray(d.lines) ? d.lines.map(str).filter(Boolean) : []
  return supplierMail(
    `สำเนาใบสมัครผู้ขาย ${str(d.number)} ที่ ${c.organizationName} กรอกแทนท่าน / A copy of your application`,
    [`เรียน ${c.supplierName}`, `ฝ่ายจัดซื้อของ ${c.organizationName} กรอกและส่งใบสมัครเลขที่ ${str(d.number)} แทนท่านด้วยค่าต่อไปนี้ หากไม่ถูกต้องโปรดแจ้งฝ่ายจัดซื้อ`, ...lines],
    [`The procurement team of ${c.organizationName} filled in and sent application ${str(d.number)} for you with the values above. Please tell them if anything is wrong.`],
  )
})

registerSupplierTemplate(PORTAL_SUPPLIER_TEMPLATES.applicationReturned, (d, c) =>
  supplierMail(
    `ใบสมัครผู้ขาย ${str(d.number)} ถูกส่งกลับให้แก้ไข / Your application was returned`,
    [`เรียน ${c.supplierName}`, `${c.organizationName} ส่งใบสมัครเลขที่ ${str(d.number)} กลับให้แก้ไข ด้วยเหตุผล: ${str(d.reason)}`, 'โปรดเข้าพอร์ทัลเพื่อแก้ไขแล้วส่งอีกครั้ง'],
    [`${c.organizationName} returned application ${str(d.number)} for changes. Reason: ${str(d.reason)}`, 'Please sign in to the portal, change it and send it again.'],
  ),
)

registerSupplierTemplate(PORTAL_SUPPLIER_TEMPLATES.applicationRejected, (d, c) =>
  supplierMail(
    `ใบสมัครผู้ขาย ${str(d.number)} ไม่ได้รับอนุมัติ / Your application was not approved`,
    [`เรียน ${c.supplierName}`, `${c.organizationName} ไม่อนุมัติใบสมัครเลขที่ ${str(d.number)} ด้วยเหตุผล: ${str(d.reason)}`],
    [`${c.organizationName} did not approve application ${str(d.number)}. Reason: ${str(d.reason)}`],
  ),
)

registerSupplierTemplate(PORTAL_SUPPLIER_TEMPLATES.applicationApproved, (d, c) =>
  supplierMail(
    `${c.organizationName} อนุมัติท่านเป็นผู้ขายแล้ว / You are now a supplier`,
    [`เรียน ${c.supplierName}`, `${c.organizationName} อนุมัติใบสมัครเลขที่ ${str(d.number)} แล้ว รหัสผู้ขายของท่านคือ ${str(d.code)}`, 'ท่านเข้าพอร์ทัลเพื่อดูใบสั่งซื้อและสถานะการจ่ายเงินได้ด้วยอีเมลนี้'],
    [`${c.organizationName} approved application ${str(d.number)}. Your supplier code is ${str(d.code)}.`, 'You may sign in to the portal with this e-mail to see purchase orders and payments.'],
  ),
)

// ---------- S7-07: an application waiting for its supplier (BR-SUP ข้อ 12) ----------

const list = (v: unknown) => (Array.isArray(v) ? v.map(str).filter(Boolean) : [])

registerSupplierTemplate(
  PORTAL_SUPPLIER_TEMPLATES.applicationReminder,
  (d, c) => {
    const th = list(d.missingTh)
    const en = list(d.missingEn)
    return supplierMail(
      `ใบสมัครผู้ขายของ ${c.organizationName} ยังไม่เสร็จ / Your application is not finished`,
      [
        `เรียน ${c.supplierName}`,
        `ใบสมัครผู้ขายของท่านที่ ${c.organizationName} ยังไม่ได้ส่ง${th.length ? ' ยังขาด:' : ' โปรดตรวจและส่งใบสมัคร'}`,
        ...th.map((m) => `- ${m}`),
        `กดลิงก์นี้เพื่อเข้าพอร์ทัลและกรอกต่อ (ใช้ได้ครั้งเดียว ภายใน ${at(d.expiresAt)}):`,
        str(d.url),
        `ใบสมัครจะหมดอายุ ${at(d.applicationExpiresAt)} หากยังไม่ส่ง`,
      ],
      [`Your supplier application with ${c.organizationName} is not sent yet.${en.length ? ` Still missing: ${en.join(', ')}.` : ' Please check it and send it.'}`, `Open this link to continue (once, until ${atEn(d.expiresAt)}):`, str(d.url), `The application expires ${atEn(d.applicationExpiresAt)} if it is not sent.`],
    )
  },
  { redactAfterSend: ['url'] },
)

registerSupplierTemplate(PORTAL_SUPPLIER_TEMPLATES.applicationExpired, (_d, c) =>
  supplierMail(
    `ใบสมัครผู้ขายของ ${c.organizationName} หมดอายุแล้ว / Your application expired`,
    [`เรียน ${c.supplierName}`, `ใบสมัครผู้ขายของท่านที่ ${c.organizationName} หมดอายุแล้วเพราะไม่ได้ส่งภายในกำหนด`, `หากยังต้องการขึ้นทะเบียน โปรดติดต่อฝ่ายจัดซื้อของ ${c.organizationName} เพื่อขอลิงก์ใหม่`],
    [`Your supplier application with ${c.organizationName} expired: it was not sent in time.`, 'If you still wish to register, please ask its procurement team for a new link.'],
  ),
)

// ---------- S7-06: documents ----------

registerSupplierTemplate(PORTAL_SUPPLIER_TEMPLATES.documentRejected, (d, c) =>
  supplierMail(
    `เอกสาร ${str(d.typeName)} ไม่ผ่านการตรวจ / A document was not accepted`,
    [`เรียน ${c.supplierName}`, `${c.organizationName} ไม่รับเอกสาร ${str(d.typeName)} ที่ท่านส่ง ด้วยเหตุผล: ${str(d.reason)}`, 'โปรดเข้าพอร์ทัลเพื่อส่งฉบับใหม่'],
    [`${c.organizationName} did not accept your ${str(d.typeName)}. Reason: ${str(d.reason)}`, 'Please sign in to the portal and send a new copy.'],
  ),
)

registerSupplierTemplate(PORTAL_SUPPLIER_TEMPLATES.documentExpiring, (d, c) =>
  supplierMail(
    `เอกสาร ${str(d.typeName)} จะหมดอายุวันที่ ${str(d.expiresOn)} / A document expires soon`,
    [`เรียน ${c.supplierName}`, `เอกสาร ${str(d.typeName)} ของท่านที่ ${c.organizationName} ใช้ได้ถึงวันที่ ${str(d.expiresOn)}`, 'โปรดเข้าพอร์ทัลเพื่อส่งฉบับใหม่ก่อนวันหมดอายุ'],
    [`Your ${str(d.typeName)} with ${c.organizationName} is valid until ${str(d.expiresOn)}.`, 'Please sign in to the portal and send a new copy before then.'],
  ),
)

// ---------- S7-11: a PO acknowledged ----------

registerSupplierTemplate(PORTAL_SUPPLIER_TEMPLATES.poDeliveryAck, (d, c) =>
  supplierMail(
    `รับทราบใบสั่งซื้อ ${str(d.number)} แล้ว / Purchase order acknowledged`,
    [`เรียน ${c.supplierName}`, `${c.organizationName} ได้รับการรับทราบใบสั่งซื้อเลขที่ ${str(d.number)} ของท่านแล้ว${d.promisedDeliveryOn ? ` วันส่งที่แจ้ง ${str(d.promisedDeliveryOn)}` : ''}`, 'หากต้องเปลี่ยนวันส่ง โปรดแจ้งในพอร์ทัลพร้อมเหตุผล'],
    [`${c.organizationName} has your acknowledgement of PO ${str(d.number)}${d.promisedDeliveryOn ? `, delivering on ${str(d.promisedDeliveryOn)}` : ''}.`, 'To change the delivery date, tell us on the portal with the reason.'],
  ),
)
