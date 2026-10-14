import type { getTranslations } from 'next-intl/server'
import type { MyRequestRowDto } from '@/server/queries/requests'
import type { InboxTaskDto } from '@/server/queries/tasks'
import type { StepBadgeKey } from '@/ui/document/badge-looks'
import type { RequestRow } from '@/ui/request-view/request-list'
import type { StateKind } from '@/ui/request-view/status'
import type { TaskRow } from '@/ui/tasks/task-list'
import { day, dueText, memberName, money, nameIn, stageText, stageWaitingMinutes, waitingText, type Locale, type ViewT } from './present'

// Rows of the inbox, the home page and "my requests", translated and formatted for the reader.

export type TasksT = Awaited<ReturnType<typeof getTranslations<'tasks'>>>
export type BadgeT = Awaited<ReturnType<typeof getTranslations<'document.badge'>>>

/** What a task is about, in one line */
export function taskTitle(t: TasksT, task: InboxTaskDto): string {
  const s = task.subject
  switch (s.kind) {
    case 'REQUEST':
      return s.number ? `${s.number} · ${s.title}` : s.title
    case 'DOA_VERSION':
      return t('item.doa', { code: s.code, version: s.versionNo })
    case 'WORKFLOW_VERSION':
      return t('item.workflow', { code: s.code, version: s.versionNo })
    case 'ORG_AUTHORITY_CHANGE':
      return t('item.change', { kind: t(`changeKind.${s.changeKind}`) })
    case 'PURCHASE_ORDER':
      return t('item.po', { number: s.number ?? '-', supplier: s.supplierName })
    case 'VARIANCE':
      return t('item.variance', { type: t(`varianceType.${s.varianceType}`), description: s.description })
    case 'BUDGET_TRANSFER':
      return t(`item.transfer.${s.transferKind}`, { number: s.number ?? '-' })
    case 'BUDGET_OVERRUN':
      // S6-16: "ขอเกินงบ OB-… · PR-…" — the source request by its number, or its title while it has none
      return t('item.overrun', { number: s.number, request: s.requestNumber ?? s.requestTitle })
    default:
      return t('item.untitled')
  }
}

export function taskRows(t: TasksT, tv: ViewT, locale: Locale, tasks: readonly InboxTaskDto[]): TaskRow[] {
  return tasks.map((task) => {
    const s = task.subject
    const states: Array<{ kind: StateKind; text: string }> = []
    if (task.status === 'INFO_REQUESTED') {
      // Waiting for the requester's answer, and for how long — the wait of the request page's ANSWER step (§9.9 principle 4)
      states.push({ kind: 'question', text: t('item.question') })
      const asked = waitingText(tv, task.question?.waitingMinutes)
      if (asked) states.push({ kind: 'waiting', text: asked })
    } else {
      const waited = waitingText(tv, task.waitingMinutes)
      if (waited) states.push({ kind: 'waiting', text: waited })
      const due = dueText(tv, locale, task.dueAt, task.overdue)
      if (due) states.push({ kind: task.overdue ? 'overdue' : 'due', text: due })
    }
    const tags = [
      ...(task.holding?.kind === 'FOR' ? [t('item.for', { name: memberName(locale, task.holding.member) })] : []),
      ...(task.holding?.kind === 'BY' ? [t('item.by', { name: memberName(locale, task.holding.member) })] : []),
      ...(task.stepUp ? [t('item.stepUp')] : []),
      // S6: a reviewer's task — pass, return or ask before the DOA approver
      ...(task.review ? [t('item.review')] : []),
    ]
    const meta =
      s.kind === 'REQUEST'
        ? s.department
          ? t('item.requester', { name: memberName(locale, s.requester), department: nameIn(locale, s.department.name) })
          : memberName(locale, s.requester)
        : s.kind === 'DOA_VERSION' || s.kind === 'ORG_AUTHORITY_CHANGE' || s.kind === 'WORKFLOW_VERSION'
          ? t('item.effective', { date: day(locale, s.effectiveFrom) })
          : s.kind === 'PURCHASE_ORDER'
            ? s.submittedBy
              ? t('item.poMeta', { name: memberName(locale, s.submittedBy) })
              : undefined
            : s.kind === 'VARIANCE'
              ? t('item.varianceMeta', { number: s.poNumber ?? '-' })
              : s.kind === 'BUDGET_OVERRUN' && s.requestNumber
                ? s.requestTitle
                : undefined
    return {
      id: task.id,
      href: `/tasks/${task.id}`,
      title: taskTitle(t, task),
      ...(meta ? { meta } : {}),
      ...(s.kind === 'REQUEST' ? { amount: money(s.grossSatang), amountLabel: t('item.amountLabel'), amountUnit: tv('amounts.currency') } : {}),
      // A PO is decided on its total with VAT; a variance on its amount before VAT, as recorded
      ...(s.kind === 'PURCHASE_ORDER' ? { amount: money(s.grossSatang), amountLabel: t('item.amountLabel'), amountUnit: tv('amounts.currency') } : {}),
      ...(s.kind === 'VARIANCE' ? { amount: money(s.amountSatang), amountLabel: t('item.varianceAmountLabel'), amountUnit: tv('amounts.currency') } : {}),
      // S6-15: the amount a budget transfer moves (no VAT)
      ...(s.kind === 'BUDGET_TRANSFER' ? { amount: money(s.amountSatang), amountLabel: t('item.transferAmountLabel'), amountUnit: tv('amounts.currency') } : {}),
      // S6-16: the shortfall an over-budget approval asks for (no VAT)
      ...(s.kind === 'BUDGET_OVERRUN' ? { amount: money(s.amountSatang), amountLabel: t('item.overrunAmountLabel'), amountUnit: tv('amounts.currency') } : {}),
      states,
      tags,
    }
  })
}

/**
 * A task's SLA as the step badge of §9.10, as the home's "รอฉันอนุมัติ" reads it (./home-present.ts): waiting for the
 * requester's answer, past its due time, or waiting for the decision. The inbox does not carry how much of the SLA is
 * used, so a task on time stays OPEN (never OPEN_HALF).
 */
function slaKey(task: InboxTaskDto): Extract<StepBadgeKey, 'OPEN' | 'OVERDUE' | 'INFO_REQUESTED'> {
  return task.status === 'INFO_REQUESTED' ? 'INFO_REQUESTED' : task.overdue ? 'OVERDUE' : 'OPEN'
}

/**
 * The rows of taskRows() led by their SLA badge, as the web inbox and LIFF's /liff/tasks show them (§9.10 งานอนุมัติ):
 * the badge says "waiting for the requester's answer", so the row keeps only how long it has waited
 */
export function withSlaBadges(td: BadgeT, rows: readonly TaskRow[], tasks: readonly InboxTaskDto[]): TaskRow[] {
  const label = { OPEN: td('step.OPEN_PLAIN'), OVERDUE: td('step.OVERDUE_PLAIN'), INFO_REQUESTED: td('step.INFO_REQUESTED') } as const
  return rows.map((row, i) => {
    const key = slaKey(tasks[i]!)
    return { ...row, badge: { key, label: label[key] }, states: row.states.filter((s) => s.kind !== 'question') }
  })
}

export function requestRows(tv: ViewT, locale: Locale, rows: readonly MyRequestRowDto[]): RequestRow[] {
  return rows.map((r) => {
    const mine = r.relation === 'REQUESTER'
    const nowStates: Array<{ kind: StateKind; text: string }> = []
    // How long it has waited, whoever it waits for — an approver, the requester, procurement or a supplier (§9.9
    // principle 4) — and, for an approver, past due since when
    const waited = waitingText(tv, stageWaitingMinutes(r.stage))
    if (waited) nowStates.push({ kind: 'waiting', text: waited })
    if (r.stage.kind === 'APPROVER' && r.stage.overdue) nowStates.push({ kind: 'overdue', text: dueText(tv, locale, r.stage.dueAt, true)! })
    const amount = r.grossSatang !== null ? money(r.grossSatang) : r.documentType === 'SUPPLIER_REQUEST' ? tv('amountNone') : tv('amountPending')
    return {
      id: r.id,
      href: `/requests/${r.id}`,
      title: r.number ? `${r.number} · ${r.title}` : `${tv('noNumber')} · ${r.title}`,
      meta: [r.submittedAt ? tv('submittedOn', { date: day(locale, r.submittedAt) }) : tv('createdOn', { date: day(locale, r.createdAt) }), ...(mine ? [] : [tv('following')])],
      status: r.status,
      statusLabel: tv(`status.${r.status}`),
      now: stageText(tv, locale, r.stage, mine),
      nowStates,
      amount,
      amountIsMoney: r.grossSatang !== null,
    }
  })
}
