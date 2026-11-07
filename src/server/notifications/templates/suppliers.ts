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
