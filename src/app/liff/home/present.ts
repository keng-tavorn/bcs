import type { ApprovalsDto, FollowingDto } from '@/server/queries/home'
import type { TodoDto } from '@/server/services/home'
import type { LiffApprovals, LiffDestination, LiffFollowingRow, LiffTodoRow } from '@/ui/liff/home/home-parts'
import { approvalsView, followingView, todoView, type HomeT } from '../../(workspace)/_tracking/home-present'
import type { Locale, ViewT } from '../../(workspace)/_tracking/present'
import type { TasksT } from '../../(workspace)/_tracking/rows'
import { liffHref, liffTaskHref } from '../_lib/links'

// /liff/home's rows (FR-LINE-302 · BR-LINE-18 · ADR-167): the web home's rows (home-present.ts, from the same services
// and queries, AC1), each leading to its LIFF page when there is one — /liff/tasks/<id>, /liff/requests/<id>,
// /liff/tasks, /liff/track, and whatever src/channels/line/links.ts maps later — and otherwise to the web page, which the
// LIFF page opens outside LINE (AC2). A LIFF list has no filter, so a to-do row whose web list is filtered (overdue tasks,
// returned requests) opens that list's LIFF page whole: the LIFF inbox puts the overdue tasks first, the LIFF list of my
// requests shows each one's status.

/** The rows of each part shown before "ดูทั้งหมด", as the web home's cards (§9.10) */
export const LIFF_HOME_ROWS = 5

/** A web page's LIFF page (by its path, the filter dropped), or the web page itself to open outside LINE */
export function liffHomeDestination(workspaceHref: string): LiffDestination {
  const path = workspaceHref.split('?')[0] ?? workspaceHref
  const inLiff = liffHref(path)
  return inLiff ? { href: inLiff, inLiff: true } : { href: workspaceHref, inLiff: false }
}

export function liffTodoRows(t: HomeT, todo: TodoDto): LiffTodoRow[] {
  return todoView(t, todo.rows).map((r) => ({ key: r.key, text: r.text, tone: r.tone, to: liffHomeDestination(r.href) }))
}

/** "รอฉันอนุมัติ": the web card's rows of every task waiting (the REVIEW and committee tasks of S6 among them, AC5), each opening its LIFF decision page */
export function liffApprovals(t: HomeT, tt: TasksT, tv: ViewT, locale: Locale, approvals: ApprovalsDto): LiffApprovals {
  const all = approvalsView(t, tt, tv, locale, approvals)[0]!
  return {
    count: approvals.all.count,
    overdue: approvals.overdue.count,
    info: approvals.info.count,
    rows: all.rows.slice(0, LIFF_HOME_ROWS).map((r) => ({ id: r.id, href: liffTaskHref(r.id), title: r.title, kindLabel: r.kindLabel, meta: r.meta, amount: r.amount, sla: r.sla, forName: r.forName })),
  }
}

export function liffFollowingRows(tv: ViewT, locale: Locale, following: FollowingDto): LiffFollowingRow[] {
  return followingView(tv, locale, following)
    .slice(0, LIFF_HOME_ROWS)
    .map((r) => ({ id: r.id, to: liffHomeDestination(r.href), title: r.title, status: r.status, statusLabel: r.statusLabel, now: r.now }))
}
