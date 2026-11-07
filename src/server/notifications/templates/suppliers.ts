// The in-app notices of S7 (lane 1's own file · docs/sub-specs/S7.md "การแจ้งเตือน"): an application submitted (DIGEST to
// its inviter) and an approved application's bank account waiting for FINANCE to claim it (S7-10). A sole proprietor's
// application is named by its number only (BR-NOTI ข้อ 10).

type Data = Readonly<Record<string, unknown>>
type Text = { readonly th: string; readonly en: string }
type Template = (data: Data, subject: { readonly type: string | null; readonly id: string | null }) => { title: Text; body?: Text; href: string | null }

const str = (v: unknown) => (typeof v === 'string' || typeof v === 'number' ? String(v) : '')

export const SUPPLIER_TEMPLATES: Readonly<Record<string, Template>> = {
  'supplier.application_submitted': (d) => ({
    title: {
      th: d.nameTh ? `ผู้ขายส่งใบสมัคร ${str(d.number)} ${str(d.nameTh)} แล้ว รอตรวจ` : `ผู้ขายส่งใบสมัคร ${str(d.number)} แล้ว รอตรวจ`,
      en: d.nameTh ? `Supplier application ${str(d.number)} ${str(d.nameTh)} was sent, waiting for checks` : `Supplier application ${str(d.number)} was sent, waiting for checks`,
    },
    href: `/suppliers/applications/${str(d.applicationId)}`,
  }),
  // S7-07 (BR-SUP ข้อ 12): an application still waiting for its supplier at escalateAt, to its inviter and PROCUREMENT
  'supplier.application_escalated': (d) => ({
    title: {
      th: d.nameTh ? `ใบสมัครผู้ขาย ${str(d.nameTh)} ค้างเกินกำหนด ผู้ขายยังไม่ส่ง` : `ใบสมัครผู้ขาย${d.number ? ` ${str(d.number)}` : ''} ค้างเกินกำหนด ผู้ขายยังไม่ส่ง`,
      en: d.nameTh ? `The supplier application of ${str(d.nameTh)} is overdue: not sent yet` : `A supplier application${d.number ? ` ${str(d.number)}` : ''} is overdue: not sent yet`,
    },
    href: `/suppliers/applications/${str(d.applicationId)}`,
  }),
  // S7-11 (FR-SUP-105): the supplier acknowledged a PO (digest) or moved its delivery date (at once) — dates, no price
  'po.acknowledged': (d) => ({
    title: {
      th: d.promisedDeliveryOn ? `ผู้ขายรับทราบใบสั่งซื้อ ${str(d.number)} แล้ว ส่งวันที่ ${str(d.promisedDeliveryOn)}` : `ผู้ขายรับทราบใบสั่งซื้อ ${str(d.number)} แล้ว`,
      en: d.promisedDeliveryOn ? `The supplier acknowledged PO ${str(d.number)}, delivering on ${str(d.promisedDeliveryOn)}` : `The supplier acknowledged PO ${str(d.number)}`,
    },
    href: `/procurement/pos/${str(d.poId)}`,
  }),
  'po.delivery_changed': (d) => ({
    title: {
      th: d.from ? `ผู้ขายเลื่อนวันส่งใบสั่งซื้อ ${str(d.number)} จาก ${str(d.from)} เป็น ${str(d.to)}` : `ผู้ขายแจ้งวันส่งใบสั่งซื้อ ${str(d.number)} เป็น ${str(d.to)}`,
      en: d.from ? `The supplier moved delivery of PO ${str(d.number)} from ${str(d.from)} to ${str(d.to)}` : `The supplier will deliver PO ${str(d.number)} on ${str(d.to)}`,
    },
    href: `/procurement/pos/${str(d.poId)}`,
  }),
  // S7-06 (BR-SDOC ข้อ 04): one line of PROCUREMENT's digest per document reminded of
  'supplier.documents_expiring_digest': (d) => ({
    title: { th: `เอกสาร ${str(d.typeName)} ของผู้ขายจะหมดอายุวันที่ ${str(d.expiresOn)}`, en: `A supplier's ${str(d.typeName)} expires on ${str(d.expiresOn)}` },
    href: d.supplierId ? `/suppliers/${str(d.supplierId)}?tab=documents` : '/suppliers',
  }),
  'supplier.bank_change_from_portal': (d) => ({
    title: { th: `มีคำขอบัญชีธนาคารจากผู้ขาย ${str(d.code)} รอการเงินรับเรื่อง`, en: `A bank account request from supplier ${str(d.code)} waits for finance to claim it` },
    href: `/finance/bank-accounts/changes/${str(d.changeId)}`,
  }),
}

/** §10.1 rows of S7 whose channel is "LINE → อีเมล": deliver.ts sends these by LINE (LINE_TEMPLATES) */
export const SUPPLIER_LINE_TEMPLATES: readonly string[] = ['supplier.application_escalated', 'po.delivery_changed']
