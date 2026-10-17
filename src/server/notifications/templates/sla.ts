// Templates of the timer jobs (spec §10.1, §10.3, S5-07 and S5-08): task.overdue, task.escalated, delegation.window and
// digest.daily, in Thai and English. Short and polite with the neutral "โปรดพิจารณา" (§10.3); they name documents by
// number (an authority change, which has none, by its kind) and never carry items, prices, files or people's names
// (BR-NOTI-01). Every one links back to the task, the document or the page that settles it (BR-NOTI-02). They promise
// only what will happen: the next band hears that escalation follows only when it will (data.willEscalate), and the
// administrators hear why nobody was added (data.reason) and what they can do in this build — no command moves a task
// by hand, and a step escalates once (ADR-048 item 4), so they are pointed at the approver and at the authority changes
// that move an approver's open tasks: an acting appointment, or a new holder of the position (BR-DOA-17, BR-DLG-04). A
// delegate whose acting period ended with tasks that could not go back hears that a new holder of the position takes
// them (NEW-28), never that someone will move them. task.reminder lives with the board's reminder in index.ts.

import type { ApprovalSubject } from '@/core/sod'

type Data = Readonly<Record<string, unknown>>
type Text = { readonly th: string; readonly en: string }
export type SlaTemplate = (data: Data, subject: { readonly type: string | null; readonly id: string | null }) => { title: Text; body?: Text; href: string | null }

const str = (v: unknown, fallback = ''): string => (typeof v === 'string' || typeof v === 'number' ? String(v) : fallback)
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
/** Basis points in one percent (budget alert thresholds are kept in basis points) */
const BP_PER_PERCENT = 100
const same = (s: string): Text => ({ th: s, en: s })
/** "1 task" / "2 tasks" (Thai has no plural) */
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

/** The kinds of OrgAuthorityChange in words (as doa.authority_changed names them) */
const CHANGE_KIND: Readonly<Record<string, Text>> = {
  POSITION_ASSIGN: { th: 'แต่งตั้งผู้ดำรงตำแหน่ง', en: 'appointment' },
  POSITION_END: { th: 'สิ้นสุดการดำรงตำแหน่ง', en: 'end of appointment' },
  DEPARTMENT_REPARENT: { th: 'ย้ายแผนก', en: 'department move' },
  DELEGATION_ON_BEHALF: { th: 'ตั้งผู้รักษาการแทน', en: 'acting appointment' },
  IDENTITY_RESET: { th: 'รีเซ็ตตัวตนของผู้มีอำนาจ', en: 'identity reset' },
}

/** Every subject of an approval route by its kind (P1-07: the subjects of phase 1 too, checked by typecheck) */
export const SUBJECT_NAME = {
  REQUEST: { th: 'คำขอ', en: 'Request' },
  PURCHASE_ORDER: { th: 'ใบสั่งซื้อ', en: 'Purchase order' },
  VARIANCE: { th: 'ผลต่างการตรวจรับของใบสั่งซื้อ', en: 'Receiving variance of purchase order' },
  DOA_VERSION: { th: 'DOA', en: 'DOA' },
  ORG_AUTHORITY_CHANGE: { th: 'การเปลี่ยนโครงสร้างอำนาจ', en: 'Authority change' },
  BUDGET_TRANSFER: { th: 'การโอนงบ', en: 'Budget transfer' },
  BUDGET_OVERRUN: { th: 'การขออนุมัติเกินงบ', en: 'Over-budget approval' },
  WORKFLOW_VERSION: { th: 'ผู้ตรวจคู่ขนานฉบับ', en: 'Reviewer workflow version' },
  INVOICE: { th: 'ใบแจ้งหนี้', en: 'Invoice' },
  PO_CHANGE: { th: 'การแก้ไขใบสั่งซื้อ', en: 'PO change' },
  PAYMENT_RUN: { th: 'รอบจ่าย', en: 'Payment run' },
  BANK_ACCOUNT_CHANGE: { th: 'การเปลี่ยนบัญชีธนาคาร', en: 'Bank account change' },
} as const satisfies Record<ApprovalSubject, Text>
const nameOfSubject = (type: unknown): Text | undefined => (Object.hasOwn(SUBJECT_NAME, str(type)) ? SUBJECT_NAME[str(type) as ApprovalSubject] : undefined)

/** An authority change by its kind: "การเปลี่ยนโครงสร้างอำนาจ (แต่งตั้งผู้ดำรงตำแหน่ง)" */
function changeNamed(kind: unknown): Text {
  const words = CHANGE_KIND[str(kind)]
  const base = SUBJECT_NAME.ORG_AUTHORITY_CHANGE
  return words ? { th: `${base.th} (${words.th})`, en: `${base.en} (${words.en})` } : base
}

/** A document's number once it has one, else its title or label (as the other templates name documents), or its kind */
function ref(d: Data): Text {
  const plain = str(d.number) || str(d.title) || str(d.label)
  if (plain) return same(plain)
  return d.changeKind !== undefined ? changeNamed(d.changeKind) : same('')
}

/** The page of the document an approval task is on */
function documentHref(d: Data): string {
  const id = str(d.subjectId)
  switch (d.subjectType) {
    case 'REQUEST':
      return `/requests/${id}`
    case 'PURCHASE_ORDER':
      return `/procurement/pos/${id}`
    case 'VARIANCE':
      // A variance is settled on its purchase order's page
      return d.poId ? `/procurement/pos/${str(d.poId)}` : '/tasks'
    case 'DOA_VERSION':
      return `/admin/doa/${id}`
    case 'ORG_AUTHORITY_CHANGE':
      return '/admin/org-authority'
    case 'BUDGET_TRANSFER':
      return `/budgets/transfers/${id}`
    case 'BUDGET_OVERRUN':
      return `/budgets/overruns/${id}`
    case 'WORKFLOW_VERSION':
      return `/admin/workflows/${id}`
    case 'INVOICE':
      return `/finance/invoices/${id}`
    case 'PO_CHANGE':
      // A change is made and settled on its purchase order's page
      return d.poId ? `/procurement/pos/${str(d.poId)}/change` : '/tasks'
    case 'PAYMENT_RUN':
      return `/finance/payments/${id}`
    case 'BANK_ACCOUNT_CHANGE':
      return `/finance/bank-accounts/changes/${id}`
    default:
      return '/tasks'
  }
}

const taskHref = (d: Data) => (d.taskId ? `/tasks/${str(d.taskId)}` : documentHref(d))

/** Business minutes as hours and minutes */
function age(minutes: number): Text {
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  return {
    th: h > 0 ? `${h} ชม.${m ? ` ${m} นาที` : ''}` : `${m} นาที`,
    en: h > 0 ? `${h} h${m ? ` ${m} min` : ''}` : `${m} min`,
  }
}

/** "คำขอ PR-2569-00012" / "Request PR-2569-00012" */
function named(item: { subjectType?: unknown; label?: unknown; changeKind?: unknown }): Text {
  if (item.subjectType === 'ORG_AUTHORITY_CHANGE') return changeNamed(item.changeKind)
  const kind = nameOfSubject(item.subjectType)
  const label = str(item.label)
  return { th: `${kind?.th ?? 'เอกสาร'} ${label}`.trim(), en: `${kind?.en ?? 'Document'} ${label}`.trim() }
}

interface DigestItem {
  readonly subjectType?: unknown
  readonly label?: unknown
  readonly changeKind?: unknown
  readonly ageMinutes?: unknown
  readonly overdue?: unknown
}

function digestBody(d: Data): Text {
  const th: string[] = []
  const en: string[] = []
  const mine = (d.mine && typeof d.mine === 'object' ? d.mine : null) as { pending?: unknown; overdue?: unknown; oldest?: unknown } | null
  if (mine && num(mine.pending) > 0) {
    const pending = num(mine.pending)
    const late = num(mine.overdue)
    th.push(`โปรดพิจารณางานที่รออนุมัติ ${pending} งาน${late ? ` (เกินกำหนด ${late} งาน)` : ''}`)
    en.push(`${plural(pending, 'approval is', 'approvals are')} waiting for you${late ? ` (${late} past ${late === 1 ? 'its' : 'their'} due time)` : ''}`)
    for (const item of (Array.isArray(mine.oldest) ? mine.oldest : []) as DigestItem[]) {
      const n = named(item)
      const a = age(num(item.ageMinutes))
      th.push(`• ${n.th} รอ ${a.th}${item.overdue ? ' เกินกำหนด' : ''}`)
      en.push(`• ${n.en}, waiting ${a.en}${item.overdue ? ', overdue' : ''}`)
    }
  }
  const scope = (d.scope && typeof d.scope === 'object' ? d.scope : null) as {
    kind?: unknown
    pending?: unknown
    overdue?: unknown
    lowBudgetLines?: unknown
    lowLineCodes?: unknown
    lowPct?: unknown
    budgetLines?: unknown
    budgetLineFlags?: unknown
  } | null
  if (scope) {
    // BUDGET (S6-18): a BUDGET_ADMIN's summary names budget lines only
    if (scope.kind !== 'BUDGET') {
      const where: Text = scope.kind === 'ORG' ? { th: 'ทั้งองค์กร', en: 'Across the organization' } : { th: 'ในหน่วยงานของคุณ', en: 'In your departments' }
      const pending = num(scope.pending)
      const late = num(scope.overdue)
      th.push(`${where.th}: รออนุมัติ ${pending} งาน เกินกำหนด ${late} งาน`)
      en.push(`${where.en}: ${plural(pending, 'approval', 'approvals')} waiting, ${late} past ${late === 1 ? 'its' : 'their'} due time`)
    }
    if (Array.isArray(scope.budgetLineFlags)) {
      // S6-18 (BR-BUD-17): each line once, with every reason it is named for
      const lines = num(scope.budgetLines)
      if (lines > 0) {
        const flags = (scope.budgetLineFlags as Array<{ code?: unknown; reasons?: unknown }>).map((f) => ({ code: str(f.code), reasons: Array.isArray(f.reasons) ? f.reasons.map((r) => str(r)) : [] }))
        const reason = (r: string): Text =>
          r === 'LOW'
            ? { th: `เหลือต่ำกว่า ${num(scope.lowPct)}%`, en: `under ${num(scope.lowPct)}% left` }
            : r === 'FORECAST_OVER'
              ? { th: 'พยากรณ์เกินงบ', en: 'forecast over budget' }
              : { th: `ใช้ถึง ${Number(r.replace('USED_', '')) / BP_PER_PERCENT}%`, en: `${Number(r.replace('USED_', '')) / BP_PER_PERCENT}% used` }
        const list = (lang: 'th' | 'en') => flags.map((f) => `${f.code} (${f.reasons.map((r) => reason(r)[lang]).join(', ')})`).join(', ') + (lines > flags.length ? ', …' : '')
        th.push(`บรรทัดงบที่ควรดู ${lines} บรรทัด: ${list('th')}`)
        en.push(`${plural(lines, 'budget line needs', 'budget lines need')} a look: ${list('en')}`)
      }
    } else {
      const lines = num(scope.lowBudgetLines)
      if (lines > 0) {
        const codes = (Array.isArray(scope.lowLineCodes) ? scope.lowLineCodes : []).map((c) => str(c)).filter(Boolean)
        const list = codes.length ? ` (${codes.join(', ')}${lines > codes.length ? ', …' : ''})` : ''
        th.push(`บรรทัดงบที่เหลือต่ำกว่า ${num(scope.lowPct)}% ${lines} บรรทัด${list}`)
        en.push(`${plural(lines, 'budget line has', 'budget lines have')} less than ${num(scope.lowPct)}% left${list}`)
      }
    }
  }
  const updates = num(d.updates)
  if (updates > 0) {
    th.push(`อัปเดตอื่น ${updates} รายการ ดูได้ในกล่องแจ้งเตือน`)
    en.push(`${plural(updates, 'other update is', 'other updates are')} in your notifications`)
  }
  return { th: th.join('\n'), en: en.join('\n') }
}

/**
 * What an administrator can do for an overdue task nobody was added to: follow up with the approver, and — when the
 * approver is away — propose on the authority changes page an acting appointment or a new holder of the approver's
 * position, which take the approver's open tasks once approved and in effect. Nothing moves a task by hand.
 */
const FOLLOW_UP: Text = {
  th: 'โปรดติดตามกับผู้อนุมัติ ถ้าผู้อนุมัติไม่อยู่ เสนอตั้งผู้รักษาการแทนหรือเปลี่ยนผู้ดำรงตำแหน่งได้ที่หน้าเปลี่ยนโครงสร้างอำนาจ',
  en: 'Follow up with the approver. If they are away, propose an acting appointment or a new holder of their position on the Authority changes page',
}

/** BR-SLA-04 "ถ้าไม่มีช่วงถัดไปให้แจ้ง ORG_ADMIN": why nobody was added, so the administrator knows what to fix */
function nobodyAdded(d: Data): { title: Text; body: Text } {
  const r = ref(d)
  switch (d.reason) {
    case 'APPROVER_NOT_FOUND':
      // The step escalates once (ADR-048 item 4): a holder appointed now joins later escalations, not this task
      return {
        title: { th: `${r.th} เลยกำหนด แต่ตำแหน่งผู้อนุมัติระดับถัดไปไม่มีผู้ดำรงตำแหน่ง`, en: `${r.en} is overdue, but no one holds the position of the next approval level` },
        body: {
          th: 'โปรดแต่งตั้งผู้ดำรงตำแหน่งที่ว่างได้ที่หน้าเปลี่ยนโครงสร้างอำนาจ งานนี้จะไม่ถูกส่งต่ออีก โปรดติดตามกับผู้อนุมัติ',
          en: 'Appoint someone to the vacant position on the Authority changes page. This task will not be escalated again, so follow up with the approver',
        },
      }
    case 'DOA_AMBIGUOUS':
      return {
        title: { th: `${r.th} เลยกำหนด แต่ DOA ไม่ระบุผู้อนุมัติระดับถัดไปได้ชัดเจน`, en: `${r.en} is overdue, but the DOA does not say clearly who approves at the next level` },
        body: { th: 'โปรดตรวจ DOA ฉบับที่ใช้ และติดตามกับผู้อนุมัติ', en: 'Check the DOA version in use and follow up with the approver' },
      }
    case 'NOT_LAST_STEP':
      return {
        title: { th: `${r.th} เลยกำหนดที่ขั้นที่ยังมีขั้นถัดไป ระบบจึงยังไม่เพิ่มผู้อนุมัติร่วม`, en: `${r.en} is overdue at a step with more steps after it, so no co-approver was added` },
        body: FOLLOW_UP,
      }
    default:
      return { title: { th: `${r.th} เลยกำหนดและไม่มีผู้อนุมัติระดับถัดไปให้ส่งต่อ`, en: `${r.en} is overdue and has no higher approval level to escalate to` }, body: FOLLOW_UP }
  }
}

/** "1 open task" / "2 open tasks" */
const openTasks = (n: number) => plural(n, 'open task', 'open tasks')

export const SLA_TEMPLATES: Readonly<Record<string, SlaTemplate>> = {
  // §10.1 approval_task.overdue: the assignee, and the approver of the next band for acknowledgement (BR-SLA-04)
  'task.overdue': (d) => {
    const r = ref(d)
    return d.role === 'ACK'
      ? {
          title: { th: `แจ้งเพื่อทราบ: ${r.th} เลยกำหนดพิจารณาแล้ว`, en: `For your information: ${r.en} is past its due time` },
          ...(d.willEscalate === true ? { body: { th: 'ถ้ายังไม่มีผู้ตัดสิน งานนี้จะส่งต่อให้ผู้อนุมัติระดับถัดไปร่วมพิจารณา', en: 'If nobody decides it, it will be escalated to the next approval level' } } : {}),
          href: documentHref(d),
        }
      : {
          title: { th: `เลยกำหนด: ${r.th} รอคุณพิจารณา`, en: `Overdue: ${r.en} is waiting for your decision` },
          body: { th: 'โปรดพิจารณาโดยเร็ว', en: 'Please decide as soon as you can' },
          href: taskHref(d),
        }
  },
  // §10.1 approval_task.escalated: the new co-assignee, the assignee, the requester; with nobody added ORG_ADMIN
  'task.escalated': (d) => {
    const r = ref(d)
    switch (d.role) {
      case 'CO_ASSIGNEE':
        return {
          title: { th: `ส่งต่อถึงคุณ: ${r.th} เลยกำหนด โปรดพิจารณา`, en: `Escalated to you: ${r.en} is overdue, please decide` },
          body: { th: 'ผู้อนุมัติเดิมยังตัดสินได้ ผู้ที่ตัดสินก่อนเป็นผู้ตัดสิน', en: 'The first approver can still decide; whoever decides first decides' },
          href: taskHref(d),
        }
      case 'ASSIGNEE':
        return {
          title: { th: `${r.th} เลยกำหนด จึงส่งต่อให้ผู้อนุมัติระดับถัดไปร่วมพิจารณา`, en: `${r.en} is overdue and was escalated to the next approval level` },
          body: { th: 'คุณยังตัดสินได้ ผู้ที่ตัดสินก่อนเป็นผู้ตัดสิน', en: 'You can still decide; whoever decides first decides' },
          href: taskHref(d),
        }
      case 'ADMIN':
        return { ...nobodyAdded(d), href: documentHref(d) }
      default:
        return d.outcome === 'NO_NEXT_BAND'
          ? { title: { th: `${r.th} เลยกำหนดพิจารณา ผู้ดูแลระบบได้รับแจ้งแล้ว`, en: `${r.en} is overdue; your administrator has been told` }, href: documentHref(d) }
          : { title: { th: `${r.th} เลยกำหนด จึงส่งต่อให้ผู้อนุมัติระดับถัดไป`, en: `${r.en} is overdue and was escalated to the next approval level` }, href: documentHref(d) }
    }
  },
  // §10.1 delegation.started · delegation.ended (and a revoked one ending early, NEW-35): the delegator and the delegate
  'delegation.window': (d) => {
    const n = num(d.movedTasks)
    const toYou = d.role === 'DELEGATE'
    if (d.phase === 'ENDED') {
      const kept = num(d.keptTasks)
      return toYou
        ? {
            title: { th: `สิ้นสุดการรักษาการแทนแล้ว งานค้าง ${n} งานกลับไปที่ผู้มอบ`, en: `Your acting period has ended: ${openTasks(n)} went back` },
            // The delegator is no longer active: what could not go back stays with the delegate (who may still decide it,
            // ADR-048 item 6) until a new holder of the delegator's position takes office through an authority change,
            // which takes the position's open tasks (BR-DOA-17, NEW-28). Nothing moves a task by hand
            ...(kept > 0
              ? {
                  body: {
                    th: `งานค้าง ${kept} งานยังอยู่กับคุณ จนกว่าจะมีผู้ดำรงตำแหน่งคนใหม่ที่แต่งตั้งผ่านหน้าเปลี่ยนโครงสร้างอำนาจ`,
                    en: `${plural(kept, 'open task stays', 'open tasks stay')} with you until a new holder of the position is appointed through the Authority changes page`,
                  },
                }
              : {}),
            href: kept > 0 ? '/tasks' : '/settings/delegation',
          }
        : { title: { th: `สิ้นสุดช่วงรักษาการแล้ว งานค้าง ${n} งานกลับมาที่คุณ`, en: `Your delegation has ended: ${openTasks(n)} came back to you` }, href: '/tasks' }
    }
    if (d.phase === 'REVOKED') return { title: { th: `ยกเลิกการรักษาการแล้ว งานค้าง ${n} งานกลับมาที่คุณ`, en: `The delegation was cancelled: ${openTasks(n)} came back to you` }, href: '/tasks' }
    return toYou
      ? { title: { th: `เริ่มรักษาการแทนแล้ว รับงานค้าง ${n} งาน`, en: `Your acting period has started: ${openTasks(n)} moved to you` }, body: { th: 'โปรดพิจารณางานที่ได้รับมอบ', en: 'Please review the tasks you received' }, href: '/tasks' }
      : { title: { th: `เริ่มช่วงรักษาการแล้ว ย้ายงานค้าง ${n} งานไปผู้รักษาการ`, en: `Your delegation has started: ${openTasks(n)} moved to your delegate` }, body: { th: 'คุณยังตัดสินงานเหล่านี้ได้', en: 'You can still decide these tasks' }, href: '/settings/delegation' }
  },
  // §10.3 the daily summary
  'digest.daily': (d) => {
    const mine = (d.mine && typeof d.mine === 'object' ? d.mine : null) as { pending?: unknown } | null
    const pending = num(mine?.pending)
    const body = digestBody(d)
    return {
      title: pending > 0 ? { th: `สรุปประจำวัน: มีงานรอคุณพิจารณา ${pending} งาน`, en: `Daily summary: ${plural(pending, 'approval', 'approvals')} waiting for you` } : { th: 'สรุปประจำวัน', en: 'Daily summary' },
      ...(body.th ? { body } : {}),
      href: d.scope ? '/board/pending' : '/tasks',
    }
  },
}
