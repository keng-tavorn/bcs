import type { BudgetDashboardDto } from '@/server/services/budget/dashboard'
import { moneyText } from '@/ui/budgets/format'
import { amountLinks, budgetHref, lowText, usedUp, type BudgetsT } from '../budgets/_present'
import type { HomeT } from './pool-row'

// The budget on the home page (§9.1 "/": a budget summary for members who may view budgets), after the work and the
// requests (§9.9 principle 1: my work first, charts later): from the dashboard of /budgets itself (budgetDashboard, the
// same figures within the member's budget.view scope — the whole organization, or the departments a head heads), what is
// left in that scope against what was planned, then the budget lines running low or used up, each with its icon and
// words. A plain list, no card and no chart; every amount leads to what makes it up as on /budgets (amountLinks: the
// ledger's movements for what is left, the imports for what was planned), every line to its page, and the whole budget
// is a link away. Pure: the dashboard comes in, translated and formatted words go out (./home-budget-load.ts reads it).

/** How many budget lines running low the home lists; the rest are a link away, on /budgets */
export const HOME_LOW_LINES = 5

/** The budget dashboard, where every line of the scope is listed */
export const BUDGETS_HREF = '/budgets'

/** An amount as shown, the list it leads to, and its accessible name (which holds the amount as shown) */
export interface HomeBudgetAmount {
  readonly text: string
  readonly href: string
  readonly label: string
}

export interface HomeBudgetLowLine {
  readonly id: string
  /** "IT-OPEX-2569 · ค่าใช้จ่ายดำเนินงาน ฝ่ายไอที" */
  readonly title: string
  /** The line's page */
  readonly href: string
  /** "ใกล้หมด เหลือ 8.3%", or "งบหมด เหลือ 0.00 บาท" once nothing is left */
  readonly warning: string
  /** Nothing is left: a new request on it is refused (BR-BUD-02), said in --danger */
  readonly out: boolean
  /** What is left on it */
  readonly available: HomeBudgetAmount
}

export interface HomeBudgetLabels {
  /** The section's heading */
  readonly title: string
  /** The list's accessible name */
  readonly list: string
  /** The heading of the amounts' column: what they are and their unit */
  readonly amountHeading: string
}

export type HomeBudgetView =
  | {
      readonly kind: 'FIGURES'
      readonly labels: HomeBudgetLabels
      /** "ปีงบ FY2569 · ทั้งองค์กร" */
      readonly scopeLine: string
      /** "รวมทั้งองค์กร", or "รวมแผนกที่คุณดูแล" */
      readonly totalLabel: string
      /** What is left in the scope */
      readonly available: HomeBudgetAmount
      /** "งบตั้งต้น 2,950,000.00 บาท": what was planned in the scope */
      readonly planned: HomeBudgetAmount
      /** At most HOME_LOW_LINES lines running low or used up, in the order /budgets lists them */
      readonly low: readonly HomeBudgetLowLine[]
      /** Said when no line of the scope runs low */
      readonly noneLow: string | null
      /** The whole budget: "ดูงบประมาณทั้งหมด", with how many lines run low when the home lists only some */
      readonly all: { readonly href: string; readonly text: string }
    }
  | {
      /** No fiscal year yet, or no budget line in it: what will show here and when (§9.9 principle 8) */
      readonly kind: 'EMPTY'
      readonly labels: HomeBudgetLabels
      readonly title: string
      readonly hint: string
      /** For the budget administrators: the import that brings the figures */
      readonly importLink: { readonly href: string; readonly text: string } | null
    }

/** The home's budget summary from the dashboard of /budgets, in the member's budget.view scope */
export function homeBudgetView(t: HomeT, tb: BudgetsT, d: BudgetDashboardDto): HomeBudgetView {
  const labels: HomeBudgetLabels = { title: t('budget.title'), list: t('budget.list'), amountHeading: t('budget.amountHeading') }
  const year = d.fiscalYear
  if (!year || d.lines.length === 0) {
    return {
      kind: 'EMPTY',
      labels,
      title: tb(year ? 'empty.title' : 'empty.noYear'),
      hint: tb(d.can.import ? 'empty.hintAdmin' : 'empty.hintOther'),
      importLink: d.can.import ? { href: '/budgets/import', text: tb('actions.import') } : null,
    }
  }
  const scope = tb(`scope.${d.scope}`)
  const total = amountLinks(tb, d.total, scope, budgetHref.total(year.id))
  // Running low, or used up (nothing left, whatever the warning threshold), as the low notice of /budgets counts them
  const low = d.lines.filter((l) => l.low || usedUp(l))
  return {
    kind: 'FIGURES',
    labels,
    scopeLine: t('budget.scope', { code: year.code, scope }),
    totalLabel: tb(`table.total.${d.scope}`),
    available: { text: moneyText(d.total.available), ...total.available },
    planned: { text: t('budget.planned', { amount: moneyText(d.total.planned) }), ...total.planned },
    low: low.slice(0, HOME_LOW_LINES).map((l) => {
      const href = budgetHref.line(l.id)
      return {
        id: l.id,
        title: `${l.code} · ${l.nameTh}`,
        href,
        warning: lowText(tb, l) ?? '',
        out: usedUp(l),
        available: { text: moneyText(l.available), ...amountLinks(tb, l, l.code, href).available },
      }
    }),
    noneLow: low.length === 0 ? t('budget.noneLow') : null,
    all: { href: BUDGETS_HREF, text: low.length > HOME_LOW_LINES ? t('budget.allLow', { count: low.length }) : t('budget.all') },
  }
}
