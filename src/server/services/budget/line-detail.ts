import { z } from 'zod'
import { err, ok, type Result } from '@/core/result'
import { authorize } from '@/server/authz'
import type { Ctx } from '@/server/context'
import { forTenant } from '@/server/db/tenant'
import { BUDGET_LINE_AMOUNTS, budgetFigures, budgetLowThreshold, budgetViewScope, fiscalYearDto, lineAmounts, type BudgetFiguresDto } from './dashboard'
import { budgetDocumentsOf, type BudgetDocumentsDto } from './documents'

// The drill-down of one budget line (spec §11.2, FR-BUD-005 AC2): what the line is, its amounts, the documents that make
// up each of them and the latest movements of its ledger (documents.ts). Who may open it follows the dashboard:
// budget.view for the whole organization, or a department head for the lines of the departments they head.

export type {
  BudgetActualPoDocDto,
  BudgetImportDocDto,
  BudgetInvoiceDocDto,
  BudgetMovementDto,
  BudgetMovementKind,
  BudgetPoDocDto,
  BudgetRequestDocDto,
  NameDto,
} from './documents'
export { BUDGET_DOCUMENT_LIMIT, BUDGET_MOVEMENT_LIMIT } from './documents'

export interface BudgetLineDetailDto extends BudgetDocumentsDto {
  readonly line: BudgetFiguresDto & {
    readonly id: string
    readonly code: string
    readonly nameTh: string
    readonly accountCode: string | null
    readonly status: 'OPEN' | 'FROZEN' | 'CLOSED'
    readonly fiscalYear: { readonly id: string; readonly code: string; readonly startsOn: string; readonly endsOn: string }
    readonly department: { readonly id: string; readonly code: string; readonly nameTh: string; readonly nameEn: string | null }
    readonly costCenter: { readonly code: string; readonly nameTh: string }
  }
  readonly lowPct: number
  readonly asOf: string
}

/** The documents behind each amount and the latest ledger movements of one budget line (FR-BUD-005 AC2) */
export async function budgetLineDetail(ctx: Ctx, budgetLineId: string): Promise<Result<BudgetLineDetailDto>> {
  return forTenant(ctx.organizationId).$transaction(async (tx) => {
    const allowed = await authorize(tx, ctx, 'budget.view')
    if (!allowed.ok) return err(allowed.error.code, allowed.error.message, allowed.error.details)
    const principal = allowed.data
    const view = budgetViewScope(principal)
    if (!view) return err('FORBIDDEN', 'the budget pages are for department heads and the budget roles', { capability: 'budget.view' })
    if (!z.uuid().safeParse(budgetLineId).success) return err('NOT_FOUND', 'budget line not found')

    const line = await tx.budgetLine.findFirst({
      where: { id: budgetLineId },
      select: {
        id: true,
        code: true,
        nameTh: true,
        accountCode: true,
        status: true,
        fiscalYear: { select: { id: true, code: true, startsOn: true, endsOn: true } },
        department: { select: { id: true, code: true, nameTh: true, nameEn: true } },
        costCenter: { select: { code: true, nameTh: true } },
        ...BUDGET_LINE_AMOUNTS,
      },
    })
    if (!line) return err('NOT_FOUND', 'budget line not found')
    if (view.kind === 'DEPT' && !view.departmentIds.has(line.department.id)) {
      return err('FORBIDDEN', 'a department head sees the budget lines of the departments they head', { capability: 'budget.view' })
    }
    const { lowPct, lowBp } = await budgetLowThreshold(tx, ctx.organizationId)
    const documents = await budgetDocumentsOf(tx, principal, [line])

    return ok({
      line: {
        id: line.id,
        code: line.code,
        nameTh: line.nameTh,
        accountCode: line.accountCode,
        status: line.status,
        fiscalYear: fiscalYearDto(line.fiscalYear),
        department: line.department,
        costCenter: line.costCenter,
        ...budgetFigures(lineAmounts(line), lowBp),
      },
      lowPct,
      asOf: ctx.now.toISOString(),
      ...documents,
    })
  })
}
