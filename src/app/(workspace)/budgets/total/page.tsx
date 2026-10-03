import { BudgetScopePage, fiscalYearParam, scopeTitle } from '../_scope'

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> }

export async function generateMetadata({ searchParams }: Props) {
  return { title: await scopeTitle(null, fiscalYearParam((await searchParams).fy)) }
}

// The drill-down of the budget dashboard's total (spec §11.2, FR-BUD-005 AC2): what makes up each amount of everything
// the viewer may see in the fiscal year `fy` — the whole organization, or the departments a head heads. budget.view is
// checked by the service.
export default async function BudgetTotalPage({ searchParams }: Props) {
  return <BudgetScopePage departmentId={null} fiscalYearId={fiscalYearParam((await searchParams).fy)} />
}
