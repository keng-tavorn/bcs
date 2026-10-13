import { PIN_FAILURE_LIMIT, PIN_LOCK_MINUTES } from '@/core/pin'
import { SLA_TEMPLATES } from './sla'

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
  // S6 (§10.1 · BR-WF-09): a reviewer's task of the REVIEW step — pass, return or ask; never reject
  'task.review_assigned': (d) => ({
    title: { th: `มีงานรอตรวจ: ${ref(d)}`, en: `Waiting for your review: ${ref(d)}` },
    body: { th: 'ผ่าน ตีกลับ หรือขอข้อมูลเพิ่ม ก่อนถึงผู้อนุมัติตาม DOA', en: 'Pass, return or ask for more information before it reaches the DOA approver' },
    href: d.taskId ? `/tasks/${str(d.taskId)}` : null,
  }),
  'request.approved': (d) => ({
    title: { th: `คำขอ ${ref(d)} อนุมัติแล้ว`, en: `Request ${ref(d)} is approved` },
    href: `/requests/${str(d.requestId)}`,
  }),
  // S6-07 (FR-DOA-104 AC3): a version approved but not yet in effect was withdrawn, or its withdrawal was not approved
  'policy.withdrawn': (d) => ({
    title:
      d.kind === 'WORKFLOW_VERSION'
        ? { th: `ถอนผู้ตรวจคู่ขนาน ${str(d.code)} ฉบับ ${str(d.versionNo)} แล้ว`, en: `Parallel reviewers ${str(d.code)} version ${str(d.versionNo)} was withdrawn` }
        : { th: `ถอน DOA ${str(d.code)} ฉบับ ${str(d.versionNo)} แล้ว`, en: `DOA ${str(d.code)} version ${str(d.versionNo)} was withdrawn` },
    body: { th: 'ฉบับนี้จะไม่มีผล ฉบับก่อนหน้ามีผลต่อไป', en: 'It will not take effect; the version before it stays in effect' },
    href: d.kind === 'WORKFLOW_VERSION' ? `/admin/workflows/${str(d.versionId)}` : `/admin/doa/${str(d.versionId)}`,
  }),
  'policy.withdrawal_rejected': (d) => ({
    title:
      d.kind === 'WORKFLOW_VERSION'
        ? { th: `คำขอถอนผู้ตรวจคู่ขนาน ${str(d.code)} ฉบับ ${str(d.versionNo)} ไม่ได้รับอนุมัติ`, en: `The withdrawal of parallel reviewers ${str(d.code)} version ${str(d.versionNo)} was not approved` }
        : { th: `คำขอถอน DOA ${str(d.code)} ฉบับ ${str(d.versionNo)} ไม่ได้รับอนุมัติ`, en: `The withdrawal of DOA ${str(d.code)} version ${str(d.versionNo)} was not approved` },
    body: { th: 'ฉบับนี้ยังมีผลตามวันที่กำหนด', en: 'It still takes effect on its date' },
    href: d.kind === 'WORKFLOW_VERSION' ? `/admin/workflows/${str(d.versionId)}` : `/admin/doa/${str(d.versionId)}`,
  }),
  // S6 (§10.1): every reviewer passed the request; it goes on to the DOA approver
  'request.reviews_done': (d) => ({
    title: { th: `คำขอ ${ref(d)} ผ่านผู้ตรวจครบแล้ว`, en: `Request ${ref(d)} passed every reviewer` },
    body: { th: 'คำขอไปถึงผู้อนุมัติตาม DOA แล้ว', en: 'It is now with the DOA approver' },
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
  // FR-INT-013 AC2: the requester added this member as a follower of the request
  'request.follower_added': (d) => ({
    title: { th: `คุณถูกเพิ่มเป็นผู้ติดตามคำขอ ${ref(d)}`, en: `You were added as a follower of request ${ref(d)}` },
    body: { th: 'คุณจะได้แจ้งเตือนเมื่อคำขอนี้อนุมัติ ตีกลับ หรือไม่อนุมัติ', en: 'You will be told when this request is approved, returned or not approved' },
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
    d.kind === 'WORKFLOW_VERSION'
      ? {
          // S6 (§10.1): a workflow version changes who reviews requests in parallel
          title: { th: `ผู้ตรวจคู่ขนาน ${str(d.code)} ฉบับ ${str(d.versionNo)} ได้รับอนุมัติแล้ว`, en: `Parallel reviewers ${str(d.code)} version ${str(d.versionNo)} were approved` },
          href: `/admin/workflows/${str(d.versionId)}`,
        }
      : d.kind === 'DOA_VERSION'
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
  'workflow_version.approved': (d) => ({ title: { th: 'ผู้ตรวจคู่ขนานฉบับที่คุณส่งได้รับอนุมัติแล้ว', en: 'The workflow version you submitted was approved' }, href: `/admin/workflows/${str(d.subjectId)}` }),
  'workflow_version.rejected': (d) => ({ title: { th: 'ผู้ตรวจคู่ขนานฉบับที่คุณส่งไม่ได้รับอนุมัติ', en: 'The workflow version you submitted was not approved' }, href: `/admin/workflows/${str(d.subjectId)}` }),
  'doa_version.rejected': (d) => ({ title: { th: 'DOA ฉบับที่คุณส่งไม่ได้รับอนุมัติ', en: 'The DOA version you submitted was not approved' }, href: policyHref('DOA_VERSION', d.subjectId) }),
  'org_authority_change.approved': () => ({ title: { th: 'การเปลี่ยนโครงสร้างอำนาจที่คุณเสนอได้รับอนุมัติแล้ว', en: 'The authority change you proposed was approved' }, href: '/admin/org-authority' }),
  'org_authority_change.rejected': () => ({ title: { th: 'การเปลี่ยนโครงสร้างอำนาจที่คุณเสนอไม่ได้รับอนุมัติ', en: 'The authority change you proposed was not approved' }, href: '/admin/org-authority' }),
  // FR-DOA-003 AC3 (§10.1): a requester could not submit because the DOA names nobody who can approve the request
  'admin.doa_gap': (d) => {
    const code = str(d.code)
    // REVIEWER_NOT_FOUND (S6 · BR-WF-08): neither the reviewer of a workflow rule nor its fallback can review
    if (code === 'REVIEWER_NOT_FOUND') {
      const dept = Array.isArray(d.departments) ? d.departments.filter((x): x is string => typeof x === 'string').join(', ') : ''
      return {
        title: {
          th: `คำขอ ${ref(d)} ส่งไม่ได้ เพราะไม่พบผู้ตรวจ ${str(d.position)} ของ ${dept} และผู้สำรองตามข้อ ${str(d.ruleCode)}`,
          en: `Request ${ref(d)} cannot be sent: no reviewer ${str(d.position)} of ${dept} nor a fallback for rule ${str(d.ruleCode)}`,
        },
        body: { th: 'เสนอแต่งตั้งผู้ดำรงตำแหน่งนี้ หรือแก้ข้อผู้ตรวจใน workflow ฉบับใหม่ แล้วแจ้งผู้ขอให้ส่งอีกครั้ง', en: 'Propose a holder for this position, or change the reviewer rule in a new workflow version, then ask the requester to send it again' },
        href: '/admin/org-authority',
      }
    }
    const title: Text =
      code === 'APPROVER_NOT_FOUND'
        ? { th: `คำขอ ${ref(d)} ส่งไม่ได้ เพราะไม่มีผู้ดำรงตำแหน่ง ${str(d.position)} ตาม DOA ข้อ ${str(d.ruleCode)}`, en: `Request ${ref(d)} cannot be sent: nobody holds ${str(d.position)} for DOA rule ${str(d.ruleCode)}` }
        : code === 'NO_HIGHER_AUTHORITY'
          ? { th: `คำขอ ${ref(d)} ส่งไม่ได้ เพราะ DOA ไม่มีผู้มีอำนาจสูงกว่าผู้ขอสำหรับยอดนี้`, en: `Request ${ref(d)} cannot be sent: the DOA has no authority above the requester for this amount` }
          : { th: `คำขอ ${ref(d)} ส่งไม่ได้ เพราะยังไม่มี DOA ที่มีผลสำหรับคำขอซื้อ`, en: `Request ${ref(d)} cannot be sent: no DOA is in effect for purchase requests` }
    return {
      title,
      body:
        code === 'APPROVER_NOT_FOUND'
          ? { th: 'เสนอแต่งตั้งผู้ดำรงตำแหน่งนี้ แล้วแจ้งผู้ขอให้ส่งอีกครั้ง', en: 'Propose a holder for this position, then ask the requester to send it again' }
          : { th: 'ตรวจ DOA ที่มีผล แล้วแจ้งผู้ขอให้ส่งอีกครั้ง', en: 'Check the DOA in effect, then ask the requester to send it again' },
      href: code === 'APPROVER_NOT_FOUND' ? '/admin/org-authority' : '/admin/doa',
    }
  },
  // FR-AUTH-003 AC2, BR-AUTH-06: a deactivated member still had approval tasks. No command moves a task by hand: an
  // appointment through the authority changes page moves the position's open tasks to the new holder when it takes
  // effect (BR-DOA-17, NEW-28), so that is what the notice offers — and opens
  // S6-08 (BR-WF-14): a department move left open tasks with their holders: the new holder is missing or conflicts
  'admin.reparent_tasks_stay': (d) => ({
    title: { th: `ย้ายแผนกแล้ว มีงานอนุมัติ ${str(d.openTasks)} งานที่ยังอยู่กับผู้ถือเดิม`, en: `A department moved; ${str(d.openTasks)} approval tasks stay with their holders` },
    body: {
      th: 'ผู้ดำรงตำแหน่งตามผังใหม่ว่างหรือเกี่ยวข้องกับเอกสารนั้น แต่งตั้งผู้ดำรงตำแหน่งได้ที่หน้าเปลี่ยนโครงสร้างอำนาจ',
      en: 'The holder by the new tree is missing or has a part in the document; appoint a holder on the Authority changes page',
    },
    href: '/admin/org-authority',
  }),
  'admin.reassign_needed': (d) => ({
    title: { th: `${str(d.name)} ถูกปิดใช้งานและมีงานอนุมัติค้าง ${str(d.openTasks)} งาน`, en: `${str(d.name)} was deactivated with ${str(d.openTasks)} approval tasks open` },
    body: {
      th: 'แต่งตั้งผู้ดำรงตำแหน่งคนใหม่ได้ที่หน้าเปลี่ยนโครงสร้างอำนาจ งานค้างของตำแหน่งจะย้ายไปผู้ดำรงคนใหม่เมื่อการแต่งตั้งมีผล',
      en: 'Appoint a new holder of the position on the Authority changes page; the position’s open tasks move to them when the appointment takes effect',
    },
    href: '/admin/org-authority',
  }),
  'admin.module_changed': (d) => ({
    title: d.enabled ? { th: `เปิดใช้โมดูล ${str(d.module)} แล้ว`, en: `Module ${str(d.module)} was switched on` } : { th: `ปิดโมดูล ${str(d.module)} แล้ว`, en: `Module ${str(d.module)} was switched off` },
    href: '/admin/modules',
  }),
  // S13 (§10.1): AI credits at the alert share or used up, and an agent switched on or off (docs/sub-specs/S13.md)
  'admin.ai_credits': (d) => ({
    title:
      d.kind === 'EXHAUSTED'
        ? { th: `credits ของ AI เดือนนี้หมดแล้ว (ใช้ ${str(d.used)} จาก ${str(d.granted)})`, en: `This month's AI credits are used up (${str(d.used)} of ${str(d.granted)})` }
        : { th: `ใช้ credits ของ AI เดือนนี้แล้ว ${str(d.used)} จาก ${str(d.granted)}`, en: `${str(d.used)} of ${str(d.granted)} AI credits used this month` },
    body: { th: 'ฟีเจอร์อื่นทำงานตามปกติ ติดต่อทีม BCS เพื่อเพิ่ม credits', en: 'Everything else works as usual; contact the BCS team for more credits' },
    href: '/admin/ai',
  }),
  'admin.ai_agent_changed': (d) => ({
    title: d.enabled ? { th: `เปิดผู้ช่วย AI ${str(d.agent)} แล้ว`, en: `AI assistant ${str(d.agent)} was switched on` } : { th: `ปิดผู้ช่วย AI ${str(d.agent)} แล้ว`, en: `AI assistant ${str(d.agent)} was switched off` },
    href: '/admin/ai',
  }),
  'task.reminder': (d) => ({
    title: { th: `เตือน: ${ref(d)} รอคุณตัดสิน`, en: `Reminder: ${ref(d)} is waiting for your decision` },
    href: d.taskId ? `/tasks/${str(d.taskId)}` : null,
  }),
  'po.approved': (d) => ({
    title: { th: `ใบสั่งซื้อ ${ref(d)} อนุมัติแล้ว พร้อมส่งให้ผู้ขาย`, en: `Purchase order ${ref(d)} is approved and ready to send` },
    href: `/procurement/pos/${str(d.poId)}`,
  }),
  'po.sent': (d) => ({
    title: { th: `ใบสั่งซื้อ ${ref(d)} ส่งถึงผู้ขายแล้ว`, en: `Purchase order ${ref(d)} was sent to the supplier` },
    // A RECEIVER opens the receiving page; the requester the PO (§16.10: receivers see PO lines through gr.post)
    href: d.forReceiver ? `/receiving/${str(d.poId)}` : `/procurement/pos/${str(d.poId)}`,
  }),
  'po.send_bounced': (d) => ({
    title: { th: `ส่งใบสั่งซื้อ ${ref(d)} ไม่ถึงผู้ขาย อีเมลถูกตีกลับ`, en: `Purchase order ${ref(d)} did not reach the supplier: the e-mail bounced` },
    body: { th: 'ตรวจอีเมลของผู้ขายแล้วส่งอีกครั้งพร้อมเหตุผล', en: 'Check the supplier e-mail address, then send again with a reason' },
    href: `/procurement/pos/${str(d.poId)}`,
  }),
  'gr.posted': (d) => ({
    title: { th: `ตรวจรับของตามใบสั่งซื้อ ${str(d.poNumber)} แล้ว (${str(d.number)})`, en: `Goods received for purchase order ${str(d.poNumber)} (${str(d.number)})` },
    href: `/procurement/pos/${str(d.poId)}`,
  }),
  'export.ready': (d) => ({
    title: { th: `ไฟล์ส่งออกพร้อมแล้ว (${str(d.rowCount)} รายการ)`, en: `Your export is ready (${str(d.rowCount)} rows)` },
    // §9.1: Express files under finance, audit exports under /audit, report files under /reports
    href: d.kind === 'AUDIT' ? '/audit' : d.kind === 'REPORT' ? '/reports' : '/finance/exports',
  }),
  'security.notice': (d) => {
    switch (d.kind) {
      case 'PIN_LOCKED':
        return {
          // FR-AUTH-005 AC3: five wrong PINs in a row lock the PIN; the owner hears of it at once, by e-mail only (§10.1)
          title: { th: `PIN ยืนยันธุรกรรมของคุณถูกล็อก ${PIN_LOCK_MINUTES} นาที`, en: `Your transaction PIN is locked for ${PIN_LOCK_MINUTES} minutes` },
          body: {
            th: `มีการใส่ PIN ผิด ${PIN_FAILURE_LIMIT} ครั้งติดกัน ถ้าไม่ใช่คุณ ให้เปลี่ยนรหัสผ่านและติดต่อผู้ดูแลระบบทันที`,
            en: `A wrong PIN was entered ${PIN_FAILURE_LIMIT} times in a row. If it was not you, change your password and contact your administrator now`,
          },
          href: '/settings/pin',
        }
      case 'LINE_LINKED':
        return {
          // ADR-049 item 10: every LINE link is told to the account owner at once (e-mail only, §10.1), so a QR or link
          // someone else used is noticed; the notice says nothing about the LINE account itself. What to do names the
          // pages as the member finds them: the member's own page is "บัญชี LINE" (/settings/line; "ตั้งค่า LINE" is the
          // organization's channel, /admin/line), which the notice opens and which links to "ลืมรหัสผ่าน" (/login sends a
          // signed-in member away, so that link is how they get there). A new password set there ends every session of
          // the account, this one too (revokeSessionsOnPasswordReset), and a link outlives it: unlink first. There is no
          // change-password screen yet: a decision for the user
          title: { th: 'มีการผูกบัญชี LINE กับบัญชี BCS ของคุณ', en: 'A LINE account was linked to your BCS account' },
          body: {
            th: 'ถ้าไม่ใช่คุณ ให้ยกเลิกการผูกที่หน้าบัญชี LINE แล้วกดลิงก์ ลืมรหัสผ่าน ในหน้าเดียวกันเพื่อตั้งรหัสผ่านใหม่ทันที ซึ่งจะออกจากระบบทุกอุปกรณ์',
            en: 'If this was not you, unlink it on your LINE account page, then use the Forgot password link on that page to set a new password at once, which signs you out everywhere',
          },
          href: '/settings/line',
        }
      default:
        return {
          title: d.kind === 'TWO_FACTOR_RESET' ? { th: 'การยืนยันตัวตนสองชั้นของคุณถูกรีเซ็ต', en: 'Your two-step verification was reset' } : { th: 'มีการเปลี่ยนแปลงด้านความปลอดภัยของบัญชีคุณ', en: 'There was a security change on your account' },
          body: { th: 'ถ้าคุณไม่ได้ขอ ให้ติดต่อผู้ดูแลระบบทันที', en: 'If you did not ask for this, contact your administrator now' },
          href: '/settings/security',
        }
    }
  },
  // The timer jobs of S5 (task.overdue, task.escalated, delegation.window, digest.daily)
  ...SLA_TEMPLATES,
}

const FALLBACK: Template = () => ({ title: { th: 'มีการแจ้งเตือนใหม่', en: 'New notification' }, href: null })

/** The text and link of one notification in the reader's language (BR-NOTI-03) */
export function renderNotification(n: { readonly templateKey: string; readonly data: unknown; readonly subjectType: string | null; readonly subjectId: string | null }, locale: NotificationLocale): RenderedNotification {
  const data = (n.data && typeof n.data === 'object' ? n.data : {}) as Data
  const rendered = (TEMPLATES[n.templateKey] ?? FALLBACK)(data, { type: n.subjectType, id: n.subjectId })
  return { title: rendered.title[locale], body: rendered.body?.[locale] ?? null, href: rendered.href }
}
