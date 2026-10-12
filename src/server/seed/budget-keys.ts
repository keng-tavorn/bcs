import type { DemoHistoryRow } from './sheets'

// P1-02: the phase-1 sheet Request_History names a budget key, not a line; a request uses the key's line of the fiscal
// year that holds the day it is sent. A line code is unique only within its fiscal year (parseBudget), so the line is
// found by year and code together. Pure, so the seed's history (src/server/services/demo-history) and its unit test
// share it.

/** What the history picks a request's budget line from */
export interface HistoryBudgetLines {
  /** Line ids by code: the demo sheet names its line by code, in its one fiscal year */
  readonly budgetLines: ReadonlyMap<string, string>
  /** Line ids by `<fiscal year code>|<line code>` */
  readonly linesByYear: ReadonlyMap<string, string>
  /** The organization's fiscal years, YYYY-MM-DD */
  readonly fiscalYears: ReadonlyArray<{ readonly code: string; readonly startsOn: string; readonly endsOn: string }>
  /** Budget key → fiscal year code → line code (sheet Budget of phase 1, budgetKeyLines) */
  readonly budgetKeys: ReadonlyMap<string, ReadonlyMap<string, string>>
}

/** The lines of each budget key by fiscal year, from sheet Budget, for seedDemoHistory's budgetKeys */
export function budgetKeyLines(sheet: ReadonlyArray<{ readonly budgetKey: string | null; readonly fiscalYear: string; readonly code: string }>): Map<string, Map<string, string>> {
  const keys = new Map<string, Map<string, string>>()
  for (const line of sheet) {
    if (line.budgetKey === null) continue
    const years = keys.get(line.budgetKey) ?? new Map<string, string>()
    years.set(line.fiscalYear, line.code)
    keys.set(line.budgetKey, years)
  }
  return keys
}

/**
 * The id of the line a row's budget names on `day` (YYYY-MM-DD): the demo sheet's line by its code, or the line of the
 * key in the fiscal year that holds the day
 */
export function budgetLineOn(lines: HistoryBudgetLines, budget: DemoHistoryRow['budget'], day: string): string | undefined {
  if ('line' in budget) return lines.budgetLines.get(budget.line)
  const year = lines.fiscalYears.find((y) => y.startsOn <= day && day <= y.endsOn)
  const code = year ? lines.budgetKeys.get(budget.key)?.get(year.code) : undefined
  return year && code !== undefined ? lines.linesByYear.get(`${year.code}|${code}`) : undefined
}
