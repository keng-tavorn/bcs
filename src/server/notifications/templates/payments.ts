// The notification templates of S9 (docs/sub-specs/S9.md "สิทธิ์ event error และการแจ้งเตือน", §10.1), kept in a file of
// lane 2 so the shared index.ts and deliver.ts take one line each (ADR-135). Thai and English; ids, numbers, codes and
// kinds only — never an account number or an account's name (BR-NOTI-01, BR-BANK-08).

type Data = Readonly<Record<string, unknown>>
type Text = { readonly th: string; readonly en: string }
type Template = (data: Data, subject: { readonly type: string | null; readonly id: string | null }) => { title: Text; body?: Text; href: string | null }

const str = (v: unknown, fallback = ''): string => (typeof v === 'string' || typeof v === 'number' ? String(v) : fallback)

const CHANGE_KIND: Readonly<Record<string, Text>> = {
  ADD: { th: 'เพิ่มบัญชี', en: 'add an account' },
  REPLACE: { th: 'เปลี่ยนบัญชี', en: 'replace an account' },
  CLOSE: { th: 'ปิดบัญชี', en: 'close an account' },
}
const kindOf = (d: Data): Text => CHANGE_KIND[str(d.kind)] ?? { th: 'เปลี่ยนบัญชี', en: 'change an account' }
/** Whose account: a supplier's code, or the organization's */
const ownerOf = (d: Data): Text => (d.supplierCode ? { th: `ผู้ขาย ${str(d.supplierCode)}`, en: `supplier ${str(d.supplierCode)}` } : { th: 'บัญชีบริษัท', en: 'the company' })

export const PAYMENT_TEMPLATES: Readonly<Record<string, Template>> = {
  // §10.1 bank_account_change.approved · .rejected · .returned: the proposer hears the decision (S9-04)
  'bank_account_change.decided': (d) => {
    const what = `${str(d.number)} (${kindOf(d).th} ${ownerOf(d).th})`
    const whatEn = `${str(d.number)} (${kindOf(d).en}, ${ownerOf(d).en})`
    return {
      title:
        d.outcome === 'APPROVED'
          ? { th: `คำขอเปลี่ยนบัญชี ${what} อนุมัติแล้ว บัญชีมีผลแล้ว`, en: `Bank account change ${whatEn} is approved and in force` }
          : d.outcome === 'RETURNED'
            ? { th: `คำขอเปลี่ยนบัญชี ${what} ถูกตีกลับให้แก้ไข`, en: `Bank account change ${whatEn} was returned for changes` }
            : { th: `คำขอเปลี่ยนบัญชี ${what} ไม่ได้รับอนุมัติ`, en: `Bank account change ${whatEn} was not approved` },
      ...(d.outcome === 'APPROVED' ? {} : { body: { th: 'เปิดคำขอเพื่อดูเหตุผลจากผู้อนุมัติ', en: 'Open the request to read the approver’s reason' } }),
      href: `/finance/bank-accounts/changes/${str(d.changeId)}`,
    }
  },
  // §10.1 bank_account.activated of a supplier in a draft payment run: its preparer sees it before sending (digest)
  'payment_run.account_changed': (d) => ({
    title: { th: `บัญชีรับเงินของผู้ขาย ${str(d.supplierCode)} เปลี่ยนแล้ว ตรวจรอบจ่ายร่างก่อนส่ง`, en: `The bank account of supplier ${str(d.supplierCode)} changed; check your draft payment run before sending it` },
    href: d.paymentRunId ? `/finance/payments/${str(d.paymentRunId)}` : '/finance/payments',
  }),
}

/** §10.1 rows of S9 whose channel is "LINE → อีเมล": deliver.ts sends these by LINE (LINE_TEMPLATES) */
export const PAYMENT_LINE_TEMPLATES: readonly string[] = ['bank_account_change.decided']
