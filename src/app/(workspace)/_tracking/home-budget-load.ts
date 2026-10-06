import type { Ctx } from '@/server/context'
import { budgetDashboard } from '@/server/services/budget/dashboard'
import type { BudgetsT } from '../budgets/_present'
import { homeBudgetView, type HomeBudgetView } from './home-budget'
import type { HomeT } from './pool-row'

/**
 * The home's budget summary (./home-budget.ts) for the member signed in, or null for one who may not view budgets. The
 * dashboard service of /budgets decides who sees what (budget.view, checked on the server with the member's departments:
 * the organization-wide roles see every line, a department head the lines of the departments they head), so the home
 * never shows a figure /budgets would not; a requester's own-line grant opens neither.
 */
export async function loadHomeBudget(ctx: Ctx, t: HomeT, tb: BudgetsT): Promise<HomeBudgetView | null> {
  const dashboard = await budgetDashboard(ctx)
  return dashboard.ok ? homeBudgetView(t, tb, dashboard.data) : null
}
