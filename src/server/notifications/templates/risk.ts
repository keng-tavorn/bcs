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
const FLAG: Readonly<Record<string, Text>> = {
  CEASED: { th: 'เลิกกิจการ', en: 'ceased' },
  VAT_CANCELLED: { th: 'ยกเลิกจดทะเบียน VAT', en: 'VAT registration cancelled' },
  NOT_FOUND: { th: 'ไม่พบในทะเบียน', en: 'not found in the registry' },
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
  // S11-08 (BR-NOTI-12): who asked for an override, in the day's digest — approved (with its last day), rejected or returned
  'risk.override_decided': (d) => {
    const n = d.number ? ` ${str(d.number)}` : ''
    const href = d.overrideId ? `/risk/overrides/${str(d.overrideId)}` : '/risk/overrides'
    if (d.outcome === 'APPROVED') {
      return {
        title: { th: `คำขออนุมัติข้ามด่านความเสี่ยง${n} ได้รับอนุมัติ`, en: `Risk override${n} was approved` },
        body: { th: `ใช้ออกใบสั่งซื้อได้ถึงวันที่ ${str(d.expiresOn)} ภายในเพดานที่อนุมัติ`, en: `It lets purchase orders out until ${str(d.expiresOn)}, within the approved cap` },
        href,
      }
    }
    return d.outcome === 'RETURNED'
      ? { title: { th: `คำขออนุมัติข้ามด่านความเสี่ยง${n} ถูกตีกลับให้แก้`, en: `Risk override${n} was returned for changes` }, href }
      : { title: { th: `คำขออนุมัติข้ามด่านความเสี่ยง${n} ไม่ได้รับอนุมัติ`, en: `Risk override${n} was rejected` }, href }
  },
  // S11-09 (FR-RSK-205 · BR-NOTI-12): PROCUREMENT, in the day's digest — a reassessment due at remindOn (the job opened the
  // supplier's new assessment) or after an override lapsed with no valid assessment behind the supplier
  'risk.review_due': (d) => {
    const who = str(d.supplierCode)
    const due = str(d.dueOn)
    const href = d.assessmentId ? `/risk/assessments/${str(d.assessmentId)}` : '/risk'
    if (d.reason === 'OVERRIDE_EXPIRED') {
      return {
        title: { th: `การอนุมัติข้ามด่านของผู้ขาย ${who} หมดอายุ ต้องประเมินความเสี่ยงก่อนออกใบสั่งซื้อใหม่`, en: `The risk override of supplier ${who} lapsed: assess the supplier before new purchase orders` },
        href,
      }
    }
    return {
      title: { th: `ถึงรอบประเมินความเสี่ยงซ้ำของผู้ขาย ${who} ภายในวันที่ ${due}`, en: `Supplier ${who} is due for its risk reassessment by ${due}` },
      body: d.assessmentId
        ? { th: 'ระบบเปิดแบบประเมินใบใหม่และส่งอีเมลให้ผู้ขายแล้ว', en: 'A new assessment is open and the supplier has been e-mailed' }
        : { th: 'โปรดเปิดแบบประเมินใบใหม่ให้ผู้ขาย', en: 'Please open a new assessment for the supplier' },
      href,
    }
  },
  // S11-09 (BR-RSK-12 BR-RSK-13 · BR-NOTI-12): PROCUREMENT — a registry flag at once by LINE then e-mail (REASSESS_REQUIRED),
  // a lapsed assessment in the day's digest (OVERDUE)
  'risk.status_changed': (d) => {
    const who = str(d.supplierCode)
    const href = d.supplierId ? `/suppliers/${str(d.supplierId)}` : '/risk'
    if (d.to === 'REASSESS_REQUIRED') {
      const flag = FLAG[str(d.registryFlag)]
      return {
        title: { th: `ผู้ขาย ${who} สถานะทะเบียนเปลี่ยน${flag ? ` (${flag.th})` : ''} ต้องประเมินความเสี่ยงซ้ำ`, en: `Supplier ${who}'s registry status changed${flag ? ` (${flag.en})` : ''}: reassess its risk` },
        body: { th: 'ใบสั่งซื้อใหม่ของผู้ขายรายนี้ติดด่านจนกว่าจะประเมินซ้ำ', en: 'New purchase orders to this supplier are held until it is reassessed' },
        href,
      }
    }
    return {
      title: { th: `แบบประเมินความเสี่ยงของผู้ขาย ${who} เลยรอบแล้ว`, en: `The risk assessment of supplier ${who} is overdue` },
      // blocks: the gate's rule for an OVERDUE assessment (the tier's blocksPo, or MEDIUM under mediumOverdueBlocks)
      body: d.blocks
        ? { th: 'ผู้ขายรายนี้ออกใบสั่งซื้อใหม่ไม่ได้จนกว่าจะประเมินซ้ำเสร็จ', en: 'This supplier gets no new purchase order until its reassessment completes' }
        : { th: 'ใบสั่งซื้อใหม่ต้องกรอกเหตุผลจนกว่าจะประเมินซ้ำเสร็จ', en: 'New purchase orders need a reason until its reassessment completes' },
      href,
    }
  },
  // S11-09 (BR-RSK-10 · BR-NOTI-12): the requester and PROCUREMENT, in the day's digest — an override's last day within seven
  // days, or past
  'risk.override_expiring': (d) => {
    const n = d.number ? ` ${str(d.number)}` : ''
    const href = d.overrideId ? `/risk/overrides/${str(d.overrideId)}` : '/risk/overrides'
    return d.expired
      ? { title: { th: `การอนุมัติข้ามด่านความเสี่ยง${n} หมดอายุแล้ว`, en: `Risk override${n} has lapsed` }, href }
      : { title: { th: `การอนุมัติข้ามด่านความเสี่ยง${n} ใช้ได้ถึงวันที่ ${str(d.expiresOn)}`, en: `Risk override${n} lapses after ${str(d.expiresOn)}` }, href }
  },
  // S11-07 (FR-RSK-203 AC6 · BR-NOTI-12): AUDITOR, in the day's digest, of every PO an override lets out
  'risk.override_used': (d) => ({
    title: {
      th: `ใบสั่งซื้อผ่านด่านความเสี่ยงด้วยการอนุมัติข้าม${d.number ? ` ${str(d.number)}` : ''}`,
      en: `A purchase order passed the risk gate on an override${d.number ? ` ${str(d.number)}` : ''}`,
    },
    href: d.poId ? `/procurement/pos/${str(d.poId)}` : '/risk',
  }),
}
