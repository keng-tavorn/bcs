import type { getTranslations } from 'next-intl/server'
import type { ApprovalsDto, FollowingDto } from '@/server/queries/home'
import type { InboxTaskDto } from '@/server/queries/tasks'
import type { OnTimeRowDto, TodoKey, TodoRowDto } from '@/server/services/home'
import type { ApprovalRowView, ApprovalTabView } from '@/ui/home/approvals-tabs'
import type { FollowingRowView, OnTimeRowView } from '@/ui/home/home-cards'
import type { TodoRowView } from '@/ui/home/todo-list'
import { invoicesHref, posHref, requestsHref, tasksHref } from './list-filters'
import { dueText, memberName, money, nameIn, stageText, type Locale, type ViewT } from './present'
import { taskTitle, type TasksT } from './rows'

// The home page's cards for the reader (spec §9.10 "หน้าแรก", FR-VIS-006): every to-do row and every on-time row with
// the list it opens, the requests followed and the tasks waiting, translated and formatted. Each link carries exactly
// the filter whose count the row shows (./list-filters.ts), so the list it opens holds that many (AC2).

export type HomeT = Awaited<ReturnType<typeof getTranslations<'home'>>>

/** Where each to-do row leads, with the filter of its count (the table of §9.10) */
export const TODO_HREF: Readonly<Record<TodoKey, string>> = {
  OVERDUE_TASKS: tasksHref('/tasks', { due: 'overdue' }),
  RETURNED: requestsHref('/requests', { status: 'RETURNED', scope: 'mine' }),
  QUESTIONS: requestsHref('/requests', { scope: 'mine', info: 'open' }),
  RECEIVING: '/receiving',
  POOL: '/procurement/pool',
  PO_APPROVED: posHref('/procurement/pos', { status: 'APPROVED' }),
  INVOICES: invoicesHref('/finance/invoices', { gr: 'posted' }),
  EXPORTS: '/finance/exports',
  DRAFTS: requestsHref('/requests', { status: 'DRAFT', scope: 'mine' }),
}

const TODO_ICON: Readonly<Record<TodoKey, TodoRowView['icon']>> = {
  OVERDUE_TASKS: 'AlarmClock',
  RETURNED: 'Undo2',
  QUESTIONS: 'MessageCircleQuestion',
  RECEIVING: 'PackageCheck',
  POOL: 'ShoppingCart',
  PO_APPROVED: 'Send',
  INVOICES: 'Receipt',
  EXPORTS: 'FileOutput',
  DRAFTS: 'FilePen',
}

export function todoView(t: HomeT, rows: readonly TodoRowDto[]): TodoRowView[] {
  return rows.map((r) => ({ key: r.key, href: TODO_HREF[r.key], text: t(`todo.${r.key}`, { count: r.count }), icon: TODO_ICON[r.key], tone: r.tone === 'DANGER' ? 'danger' : r.tone === 'WARN' ? 'warn' : 'neutral' }))
}

/** /insights on the same 30 days, on the row's department when it has one */
const insightsHref = (departmentId: string | null) => (departmentId ? `/insights?range=30d&dept=${departmentId}` : '/insights?range=30d')

export function onTimeView(t: HomeT, rows: readonly OnTimeRowDto[]): OnTimeRowView[] {
  return rows.map((r) => {
    const { current, deltaPoints } = r.figure
    const delta =
      deltaPoints === null
        ? null
        : deltaPoints > 0
          ? { direction: 'up' as const, text: t('onTime.up', { points: deltaPoints }) }
          : deltaPoints < 0
            ? { direction: 'down' as const, text: t('onTime.down', { points: -deltaPoints }) }
            : { direction: 'same' as const, text: t('onTime.same') }
    return {
      key: r.key,
      label: t(`onTime.${r.key}`),
      // my tasks open the ones overdue now; the others the summary with the same filter (§9.10)
      href: r.key === 'MINE' ? tasksHref('/tasks', { due: 'overdue' }) : insightsHref(r.insightsDepartmentId),
      value: current.pct === null ? null : t('onTime.percent', { pct: current.pct }),
      delta,
      counts: current.pct === null ? null : t('onTime.counts', { onTime: current.onTime, late: current.late }),
      none: t('onTime.none'),
    }
  })
}

export function followingView(tv: ViewT, locale: Locale, following: FollowingDto): FollowingRowView[] {
  return following.rows.map((r) => ({
    id: r.id,
    href: `/requests/${r.id}`,
    title: r.number ? `${r.number} · ${r.title}` : `${tv('noNumber')} · ${r.title}`,
    status: r.status,
    statusLabel: tv(`status.${r.status}`),
    now: stageText(tv, locale, r.stage, r.relation === 'REQUESTER'),
  }))
}

export const FOLLOWING_HREF = requestsHref('/requests', { scope: 'following' })

function approvalRow(t: HomeT, tt: TasksT, tv: ViewT, locale: Locale, task: InboxTaskDto): ApprovalRowView {
  const s = task.subject
  const meta =
    s.kind === 'REQUEST'
      ? [memberName(locale, s.requester), s.department ? nameIn(locale, s.department.name) : null].filter(Boolean).join(' · ')
      : s.kind === 'PURCHASE_ORDER' && s.submittedBy
        ? memberName(locale, s.submittedBy)
        : null
  const sla =
    task.status === 'INFO_REQUESTED'
      ? { key: 'INFO_REQUESTED' as const, label: t('approvals.infoBadge') }
      : task.overdue
        ? { key: 'OVERDUE' as const, label: t('approvals.overdueBadge') }
        : task.dueAt
          ? { key: 'OPEN' as const, label: dueText(tv, locale, task.dueAt, false) ?? t('approvals.onTimeBadge') }
          : { key: 'OPEN' as const, label: t('approvals.onTimeBadge') }
  return {
    id: task.id,
    href: `/tasks/${task.id}`,
    kind: s.kind,
    kindLabel: t(`approvals.kind.${s.kind}`),
    title: taskTitle(tt, task),
    meta: meta || null,
    amount: task.amountSatang !== null ? t('approvals.amount', { amount: money(task.amountSatang) }) : null,
    sla,
    forName: task.holding?.kind === 'FOR' ? t('approvals.forName', { name: firstName(memberName(locale, task.holding.member)) }) : null,
  }
}

export function approvalsView(t: HomeT, tt: TasksT, tv: ViewT, locale: Locale, approvals: ApprovalsDto): ApprovalTabView[] {
  const tab = (key: ApprovalTabView['key'], part: ApprovalsDto['all'], label: string, listLabel: string, empty: string, seeAll: { href: string; text: string }): ApprovalTabView => ({
    key,
    label,
    listLabel,
    rows: part.rows.map((task) => approvalRow(t, tt, tv, locale, task)),
    empty,
    seeAll: part.count > 0 ? seeAll : null,
  })
  return [
    tab('all', approvals.all, t('approvals.all', { count: approvals.all.count }), t('approvals.listAll'), t('approvals.empty'), { href: '/tasks', text: t('approvals.seeAll', { count: approvals.all.count }) }),
    tab('overdue', approvals.overdue, t('approvals.overdue', { count: approvals.overdue.count }), t('approvals.listOverdue'), t('approvals.emptyOverdue'), {
      href: tasksHref('/tasks', { due: 'overdue' }),
      text: t('approvals.seeOverdue', { count: approvals.overdue.count }),
    }),
    tab('info', approvals.info, t('approvals.info', { count: approvals.info.count }), t('approvals.listInfo'), t('approvals.emptyInfo'), {
      href: tasksHref('/tasks', { due: 'info' }),
      text: t('approvals.seeInfo', { count: approvals.info.count }),
    }),
  ]
}

/** The first word of a display name: "สมชาย ใจดี" → "สมชาย" (§9.10 คำทักทาย) */
export function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] ?? ''
}
