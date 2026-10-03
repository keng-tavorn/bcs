// Notification templates (spec §4.7 rule 5, §10.1): each template turns a notification's data into a short text in
// Thai and English and the page it links to (BR-NOTI-02). The in-app list (FR-NOTI-001) uses them now; LINE and e-mail
// use the same text when they arrive (S4, S5). Data holds ids, numbers and titles only (BR-NOTI-01).

export type NotificationLocale = 'th' | 'en'

export interface RenderedNotification {
  readonly title: string
  readonly body: string | null
  /** The page of the document or setting the notification is about */
  readonly href: string | null
}

type Data = Readonly<Record<string, unknown>>
type Text = { readonly th: string; readonly en: string }
type Template = (data: Data, subject: { readonly type: string | null; readonly id: string | null }) => { title: Text; body?: Text; href: string | null }

const str = (v: unknown, fallback = ''): string => (typeof v === 'string' || typeof v === 'number' ? String(v) : fallback)
/** A request's number once it has one, else its title */
const ref = (d: Data) => str(d.number) || str(d.title) || str(d.label)

const CHANGE_KIND: Readonly<Record<string, Text>> = {
  POSITION_ASSIGN: { th: 'แต่งตั้งผู้ดำรงตำแหน่ง', en: 'an appointment' },
  POSITION_END: { th: 'สิ้นสุดการดำรงตำแหน่ง', en: 'the end of an appointment' },
  DEPARTMENT_REPARENT: { th: 'ย้ายแผนก', en: 'a department move' },
  DELEGATION_ON_BEHALF: { th: 'ตั้งผู้รักษาการแทน', en: 'an acting appointment' },
  IDENTITY_RESET: { th: 'รีเซ็ตตัวตนของผู้มีอำนาจ', en: 'an identity reset' },
}

/** Where a policy document lives */
const policyHref = (subjectType: unknown, subjectId: unknown) => (subjectType === 'DOA_VERSION' ? `/admin/doa/${str(subjectId)}` : '/admin/org-authority')

export const TEMPLATES: Readonly<Record<string, Template>> = {
  'task.assigned': (d) => ({
    title: { th: `มีงานรออนุมัติ: ${ref(d)}`, en: `Waiting for your approval: ${ref(d)}` },
    href: d.taskId ? `/tasks/${str(d.taskId)}` : null,
  }),
  'request.approved': (d) => ({
    title: { th: `คำขอ ${ref(d)} อนุมัติแล้ว`, en: `Request ${ref(d)} is approved` },
    href: `/requests/${str(d.requestId)}`,
  }),
  'request.decided': (d) => ({
    title:
      d.decision === 'RETURN'
        ? { th: `คำขอ ${ref(d)} ถูกตีกลับให้แก้ไข`, en: `Request ${ref(d)} was returned for changes` }
        : { th: `คำขอ ${ref(d)} ไม่ได้รับอนุมัติ`, en: `Request ${ref(d)} was not approved` },
    body: { th: 'เปิดคำขอเพื่อดูเหตุผลจากผู้อนุมัติ', en: 'Open the request to read the approver’s reason' },
    href: `/requests/${str(d.requestId)}`,
  }),
  'request.info_requested': (d) => ({
    title: { th: `ผู้อนุมัติขอข้อมูลเพิ่มเติมของคำขอ ${ref(d)}`, en: `The approver asked for more information on request ${ref(d)}` },
    href: `/requests/${str(d.requestId)}`,
  }),
  'request.info_provided': (d) => ({
    title: { th: `ผู้ขอตอบข้อมูลของคำขอ ${ref(d)} แล้ว`, en: `The requester answered on request ${ref(d)}` },
    href: d.taskId ? `/tasks/${str(d.taskId)}` : `/requests/${str(d.requestId)}`,
  }),
  'request.draft_expiring': (d) => ({
    title: { th: `ร่างคำขอ ${ref(d)} จะถูกลบเพราะไม่ได้แก้ไขนาน`, en: `Your draft ${ref(d)} will be removed because it has not been edited` },
    body: { th: 'เปิดร่างแล้วบันทึกอีกครั้งเพื่อเก็บไว้ หรือปล่อยไว้ถ้าไม่ใช้แล้ว', en: 'Open and save it again to keep it, or leave it if you no longer need it' },
    href: `/requests/${str(d.requestId)}`,
  }),
  'supplier_request.submitted': (d) => ({
    title: { th: `มีคำขอเพิ่มผู้ขายรายใหม่ ${ref(d)}`, en: `New supplier request ${ref(d)}` },
    href: `/requests/${str(d.requestId)}`,
  }),
  'approval_task.delegate_conflict': (d) => ({
    title: { th: `งาน ${ref(d)} อยู่กับผู้มอบ เพราะผู้รักษาการเกี่ยวข้องกับเอกสารนี้`, en: `Task ${ref(d)} stayed with the delegator because the acting person is involved in the document` },
    href: d.subjectType === 'REQUEST' ? `/requests/${str(d.subjectId)}` : null,
  }),
  'delegation.created': () => ({
    title: { th: 'คุณได้รับมอบหมายให้รักษาการแทน', en: 'You have been asked to act on someone’s behalf' },
    href: '/settings/delegation',
  }),
  'delegation.revoked': () => ({
    title: { th: 'การรักษาการแทนที่มอบให้คุณถูกยกเลิก', en: 'An acting appointment given to you was cancelled' },
    href: '/settings/delegation',
  }),
  'doa.authority_changed': (d) =>
    d.kind === 'DOA_VERSION'
      ? {
          title: { th: `DOA ${str(d.code)} ฉบับ ${str(d.versionNo)} มีผลแล้ว`, en: `DOA ${str(d.code)} version ${str(d.versionNo)} is now in effect` },
          href: `/admin/doa/${str(d.versionId)}`,
        }
      : {
          title: {
            th: `การเปลี่ยนโครงสร้างอำนาจมีผลแล้ว: ${CHANGE_KIND[str(d.changeKind)]?.th ?? ''}`.trim(),
            en: `An authority change is now in effect: ${CHANGE_KIND[str(d.changeKind)]?.en ?? ''}`.trim(),
          },
          href: '/admin/org-authority',
        },
  'position.vacant': (d) => ({
    title: { th: `ตำแหน่ง ${str(d.positionCode)} ว่างแล้ว`, en: `Position ${str(d.positionCode)} is now vacant` },
    body: Number(d.openTasks) > 0 ? { th: `มีงานค้าง ${str(d.openTasks)} งานยังอยู่กับผู้ดำรงตำแหน่งเดิม`, en: `${str(d.openTasks)} open tasks remain with the former holder` } : undefined,
    href: '/admin/org-authority',
  }),
  'doa_version.approved': (d) => ({ title: { th: 'DOA ฉบับที่คุณส่งได้รับอนุมัติแล้ว', en: 'The DOA version you submitted was approved' }, href: policyHref('DOA_VERSION', d.subjectId) }),
  'doa_version.rejected': (d) => ({ title: { th: 'DOA ฉบับที่คุณส่งไม่ได้รับอนุมัติ', en: 'The DOA version you submitted was not approved' }, href: policyHref('DOA_VERSION', d.subjectId) }),
  'org_authority_change.approved': () => ({ title: { th: 'การเปลี่ยนโครงสร้างอำนาจที่คุณเสนอได้รับอนุมัติแล้ว', en: 'The authority change you proposed was approved' }, href: '/admin/org-authority' }),
  'org_authority_change.rejected': () => ({ title: { th: 'การเปลี่ยนโครงสร้างอำนาจที่คุณเสนอไม่ได้รับอนุมัติ', en: 'The authority change you proposed was not approved' }, href: '/admin/org-authority' }),
  'admin.module_changed': (d) => ({
    title: d.enabled ? { th: `เปิดใช้โมดูล ${str(d.module)} แล้ว`, en: `Module ${str(d.module)} was switched on` } : { th: `ปิดโมดูล ${str(d.module)} แล้ว`, en: `Module ${str(d.module)} was switched off` },
    href: '/admin/modules',
  }),
  'task.reminder': (d) => ({
    title: { th: `เตือน: ${ref(d)} รอคุณตัดสิน`, en: `Reminder: ${ref(d)} is waiting for your decision` },
    href: d.taskId ? `/tasks/${str(d.taskId)}` : null,
  }),
  'po.approved': (d) => ({
    title: { th: `ใบสั่งซื้อ ${ref(d)} อนุมัติแล้ว พร้อมส่งให้ผู้ขาย`, en: `Purchase order ${ref(d)} is approved and ready to send` },
    href: `/purchase-orders/${str(d.poId)}`,
  }),
  'gr.posted': (d) => ({
    title: { th: `ตรวจรับของตามใบสั่งซื้อ ${str(d.poNumber)} แล้ว (${str(d.number)})`, en: `Goods received for purchase order ${str(d.poNumber)} (${str(d.number)})` },
    href: `/purchase-orders/${str(d.poId)}`,
  }),
  'export.ready': (d) => ({
    title: { th: `ไฟล์ส่งออกพร้อมแล้ว (${str(d.rowCount)} รายการ)`, en: `Your export is ready (${str(d.rowCount)} rows)` },
    href: `/exports/${str(d.exportJobId)}`,
  }),
  'security.notice': (d) => ({
    title: d.kind === 'TWO_FACTOR_RESET' ? { th: 'การยืนยันตัวตนสองชั้นของคุณถูกรีเซ็ต', en: 'Your two-step verification was reset' } : { th: 'มีการเปลี่ยนแปลงด้านความปลอดภัยของบัญชีคุณ', en: 'There was a security change on your account' },
    body: { th: 'ถ้าคุณไม่ได้ขอ ให้ติดต่อผู้ดูแลระบบทันที', en: 'If you did not ask for this, contact your administrator now' },
    href: '/settings/security',
  }),
}

const FALLBACK: Template = () => ({ title: { th: 'มีการแจ้งเตือนใหม่', en: 'New notification' }, href: null })

/** The text and link of one notification in the reader's language (BR-NOTI-03) */
export function renderNotification(n: { readonly templateKey: string; readonly data: unknown; readonly subjectType: string | null; readonly subjectId: string | null }, locale: NotificationLocale): RenderedNotification {
  const data = (n.data && typeof n.data === 'object' ? n.data : {}) as Data
  const rendered = (TEMPLATES[n.templateKey] ?? FALLBACK)(data, { type: n.subjectType, id: n.subjectId })
  return { title: rendered.title[locale], body: rendered.body?.[locale] ?? null, href: rendered.href }
}
