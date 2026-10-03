import { BudgetScopePage, fiscalYearParam, scopeTitle } from '../../_scope'

type Props = { params: Promise<{ departmentId: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }

export async function generateMetadata({ params, searchParams }: Props) {
  const [{ departmentId }, query] = await Promise.all([params, searchParams])
  return { title: await scopeTitle(departmentId, fiscalYearParam(query.fy)) }
}

// The drill-down of a department's total on the budget dashboard (spec §11.2, FR-BUD-005 AC2): what makes up each of
// its amounts over every budget line of the department in the fiscal year `fy`. budget.view is checked by the service.
export default async function BudgetDepartmentPage({ params, searchParams }: Props) {
  const [{ departmentId }, query] = await Promise.all([params, searchParams])
  return <BudgetScopePage departmentId={departmentId} fiscalYearId={fiscalYearParam(query.fy)} />
}
