import { z } from 'zod'
import { err, ok, type Result } from '@/core/result'
import { authorize } from '@/server/authz'
import type { Ctx } from '@/server/context'
import { forTenant } from '@/server/db/tenant'
import {
  addAmounts,
  BUDGET_LINE_AMOUNTS,
  budgetFigures,
  budgetLowThreshold,
  budgetViewScope,
  chooseFiscalYear,
  fiscalYearDto,
  lineAmounts,
  NO_AMOUNTS,
  type BudgetFiguresDto,
} from './dashboard'
import { budgetDocumentsOf, type BudgetDocumentsDto } from './documents'

// The drill-down of the dashboard's added-up rows (spec §11.2, FR-BUD-005 AC2 "คลิกยอดใด"): a department's total over
// its budget lines in a fiscal year, or the total of every line the viewer may see — the whole organization (ORG), or
// the departments a head heads (DEPT). It holds the same figures as the dashboard's row and the documents that make up
// each of them (documents.ts), so whichever amount of the dashboard is clicked leads to its documents. Who may open it
// follows the dashboard (budget.view): a department head only the departments they head.

export interface BudgetScopeDetailDto extends BudgetDocumentsDto {
  /** DEPARTMENT: the lines of one department · TOTAL: every line the viewer may see */
  readonly kind: 'DEPARTMENT' | 'TOTAL'
  /** What the viewer may see: the whole organization (ORG), or the departments they head (DEPT) */
  readonly scope: 'ORG' | 'DEPT'
  readonly fiscalYear: { readonly id: string; readonly code: string; readonly startsOn: string; readonly endsOn: string }
  readonly department: { readonly id: string; readonly code: string; readonly nameTh: string; readonly nameEn: string | null } | null
  /** The lines added up, as the dashboard's row shows them */
  readonly figures: BudgetFiguresDto
  readonly lineCount: number
  readonly departmentCount: number
  readonly lowPct: number
  readonly asOf: string
}

const ScopeInput = z.strictObject({ fiscalYearId: z.uuid().optional(), departmentId: z.uuid().optional() })

/** The documents behind each amount of a department's total, or of the total of everything the viewer may see (FR-BUD-005 AC2) */
export async function budgetScopeDetail(ctx: Ctx, input: { readonly fiscalYearId?: string; readonly departmentId?: string }): Promise<Result<BudgetScopeDetailDto>> {
  return forTenant(ctx.organizationId).$transaction(async (tx) => {
    const allowed = await authorize(tx, ctx, 'budget.view')
    if (!allowed.ok) return err(allowed.error.code, allowed.error.message, allowed.error.details)
    const principal = allowed.data
    const view = budgetViewScope(principal)
    if (!view) return err('FORBIDDEN', 'the budget pages are for department heads and the budget roles', { capability: 'budget.view' })
    const parsed = ScopeInput.safeParse(input)
    if (!parsed.success) return err('NOT_FOUND', 'department or fiscal year not found')
    const { fiscalYearId, departmentId } = parsed.data

    const department = departmentId ? await tx.department.findFirst({ where: { id: departmentId }, select: { id: true, code: true, nameTh: true, nameEn: true } }) : null
    if (departmentId && !department) return err('NOT_FOUND', 'department not found')
    if (department && view.kind === 'DEPT' && !view.departmentIds.has(department.id)) {
      return err('FORBIDDEN', 'a department head sees the budgets of the departments they head', { capability: 'budget.view' })
    }
    const { lowPct, lowBp, timezone } = await budgetLowThreshold(tx, ctx.organizationId)
    const chosen = await chooseFiscalYear(tx, ctx.now, timezone, fiscalYearId)
    if (!chosen.ok) return chosen
    const year = chosen.data.year
    if (!year) return err('NOT_FOUND', 'the organization has no fiscal year')

    const lines = await tx.budgetLine.findMany({
      where: {
        fiscalYearId: year.id,
        ...(department ? { departmentId: department.id } : view.kind === 'DEPT' ? { departmentId: { in: [...view.departmentIds] } } : {}),
      },
      select: { id: true, code: true, departmentId: true, ...BUDGET_LINE_AMOUNTS },
      orderBy: { code: 'asc' },
    })
    const documents = await budgetDocumentsOf(tx, principal, lines)
    return ok({
      kind: department ? 'DEPARTMENT' : 'TOTAL',
      scope: view.kind,
      fiscalYear: fiscalYearDto(year),
      department,
      figures: budgetFigures(lines.map(lineAmounts).reduce(addAmounts, NO_AMOUNTS), lowBp),
      lineCount: lines.length,
      departmentCount: new Set(lines.map((l) => l.departmentId)).size,
      lowPct,
      asOf: ctx.now.toISOString(),
      ...documents,
    })
  })
}
