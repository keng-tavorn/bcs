// The in-app, LINE and e-mail notices of supplier risk to members (S11 · lane 3's own file · BR-NOTI-12 · the table
// "การแจ้งเตือน" of docs/sub-specs/S11.md). Numbers, the tier and the domains only: never an answer or a reason
// (BR-NOTI-01 · BR-RSK-20); a sole proprietor is named by the assessment's number only (supplierName left out).

type Data = Readonly<Record<string, unknown>>
type Text = { readonly th: string; readonly en: string }
type Template = (data: Data, subject: { readonly type: string | null; readonly id: string | null }) => { title: Text; body?: Text; href: string | null }

const str = (v: unknown) => (typeof v === 'string' || typeof v === 'number' ? String(v) : '')

const DOMAIN: Readonly<Record<string, Text>> = {
  GENERAL: { th: 'ทั่วไป', en: 'general' },
  PRIVACY: { th: 'ข้อมูลส่วนบุคคล', en: 'privacy' },
  INFOSEC: { th: 'ความปลอดภัยสารสนเทศ', en: 'information security' },
  PREMISES: { th: 'ความปลอดภัยสถานที่', en: 'premises safety' },
  FINANCE: { th: 'การเงิน', en: 'finance' },
}
const TIER: Readonly<Record<string, Text>> = { LOW: { th: 'ต่ำ', en: 'low' }, MEDIUM: { th: 'กลาง', en: 'medium' }, HIGH: { th: 'สูง', en: 'high' } }

const domains = (d: Data, locale: 'th' | 'en') => (Array.isArray(d.riskDomains) ? d.riskDomains.map((x) => DOMAIN[str(x)]?.[locale] ?? str(x)).join(', ') : '')
/** "RSA-2569-00012 บริษัท ก จำกัด" or the number alone */
const what = (d: Data) => [str(d.number), str(d.supplierName)].filter(Boolean).join(' ')
const taskHref = (d: Data) => (d.taskId ? `/risk/reviews/${str(d.taskId)}` : '/risk/reviews')
const assessmentHref = (d: Data) => (d.assessmentId ? `/risk/assessments/${str(d.assessmentId)}` : '/risk')

export const RISK_TEMPLATES: Readonly<Record<string, Template>> = {
  // review_task.assigned (FR-RSK-202 AC3 AC4): the holder of a slot, at once; LINE shows the card with "ผ่าน" and "ตีกลับ"
  'risk.review_assigned': (d) => ({
    title: d.reassigned
      ? { th: `งานตรวจแบบประเมินความเสี่ยง ${what(d)} ย้ายมาที่คุณ`, en: `The review of risk assessment ${what(d)} moved to you` }
      : {
          th: `มีแบบประเมินความเสี่ยงรอคุณตรวจ: ${what(d)}${d.tier ? ` ระดับ${TIER[str(d.tier)]?.th ?? str(d.tier)}` : ''}`,
          en: `A risk assessment waits for your review: ${what(d)}${d.tier ? ` (${TIER[str(d.tier)]?.en ?? str(d.tier)} risk)` : ''}`,
        },
    body: {
      th: `ส่วนที่คุณตรวจ: ทั่วไป${domains(d, 'th') ? `, ${domains(d, 'th')}` : ''}${d.questionCount !== undefined ? ` · ${str(d.questionCount)} ข้อ` : ''} · ผ่านหรือตีกลับ`,
      en: `Your part: general${domains(d, 'en') ? `, ${domains(d, 'en')}` : ''}${d.questionCount !== undefined ? ` · ${str(d.questionCount)} questions` : ''} · pass or return`,
    },
    href: taskHref(d),
  }),
  'risk.review_reminder': (d) => ({
    title: { th: `เตือน: แบบประเมินความเสี่ยง ${what(d)} รอคุณตรวจ`, en: `Reminder: risk assessment ${what(d)} waits for your review` },
    href: taskHref(d),
  }),
  'risk.review_overdue': (d) => ({
    title: { th: `เลยกำหนด: แบบประเมินความเสี่ยง ${what(d)} รอคุณตรวจ`, en: `Overdue: risk assessment ${what(d)} waits for your review` },
    body: { th: 'โปรดตรวจโดยเร็ว ผู้ขายยังออกใบสั่งซื้อไม่ได้จนกว่าจะตรวจครบ', en: 'Please review it soon: the supplier gets no purchase order until every review is done' },
    href: taskHref(d),
  }),
  // escalateAt: the fallback of the rule, for its information only (no co-reviewer is added · BR-SLA-02)
  'risk.review_escalated': (d) => ({
    title: { th: `แจ้งเพื่อทราบ: งานตรวจแบบประเมินความเสี่ยง ${what(d)} เลยกำหนดแล้ว`, en: `For your information: the review of risk assessment ${what(d)} is overdue` },
    body: { th: 'ผู้ตรวจเดิมยังเป็นผู้ตัดสิน โปรดติดตามกับผู้ตรวจ', en: 'The reviewer still decides it; please follow it up with them' },
    href: '/risk/reviews',
  }),
  'risk.review_delegate_conflict': (d) => ({
    title: { th: `ผู้รักษาการของผู้ตรวจแบบประเมิน ${what(d)} เป็นผู้เตรียมใบนี้ งานจึงอยู่กับผู้ถือตำแหน่ง`, en: `The acting reviewer of assessment ${what(d)} prepared it, so the task stays with the holder` },
    href: '/admin/org-authority',
  }),
  // REVIEWER_NOT_FOUND at the send (FR-RSK-202 AC1): ORG_ADMIN and DOA_ADMIN
  'risk.reviewer_gap': (d) => ({
    title: {
      th: `แบบประเมินความเสี่ยง ${what(d)} ส่งไม่ได้ เพราะไม่พบผู้ตรวจ ${str(d.position)} ของ ${str(d.department)} และผู้สำรองตามข้อ ${str(d.ruleCode)}`,
      en: `Risk assessment ${what(d)} cannot be sent: no reviewer ${str(d.position)} of ${str(d.department)} nor a fallback for rule ${str(d.ruleCode)}`,
    },
    body: { th: 'เสนอแต่งตั้งผู้ดำรงตำแหน่งนี้ หรือแก้ข้อผู้ตรวจความเสี่ยงใน workflow ฉบับใหม่', en: 'Propose a holder for this position, or change the risk reviewer rule in a new workflow version' },
    href: '/admin/workflows',
  }),
  // BR-NOTI-12: who opened the assessment, in the day's digest
  'risk.assessment_completed': (d) => ({
    title: { th: `แบบประเมินความเสี่ยง ${what(d)} ตรวจครบแล้ว`, en: `Risk assessment ${what(d)} passed every review` },
    href: assessmentHref(d),
  }),
  'risk.assessment_returned': (d) => ({
    title: { th: `แบบประเมินความเสี่ยง ${what(d)} ถูกตีกลับให้แก้`, en: `Risk assessment ${what(d)} was returned for changes` },
    href: assessmentHref(d),
  }),
  // S11-07 (FR-RSK-203 AC6 · BR-NOTI-12): AUDITOR, in the day's digest, of every PO an override lets out
  'risk.override_used': (d) => ({
    title: {
      th: `ใบสั่งซื้อผ่านด่านความเสี่ยงด้วยการอนุมัติข้าม${d.number ? ` ${str(d.number)}` : ''}`,
      en: `A purchase order passed the risk gate on an override${d.number ? ` ${str(d.number)}` : ''}`,
    },
    href: d.poId ? `/procurement/pos/${str(d.poId)}` : '/risk',
  }),
}
