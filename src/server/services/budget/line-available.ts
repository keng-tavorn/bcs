import { z } from 'zod'
import { toMoneyDto, type MoneyDto } from '@/core/money/dto'
import { err, ok, type Result } from '@/core/result'
import { authorize } from '@/server/authz'
import type { Ctx } from '@/server/context'
import { forTenant } from '@/server/db/tenant'
import { budgetViewScope } from './dashboard'

// What is left on one budget line, and nothing else of it (§9.9 principle 5: the decision page shows the state of the
// budget; §9.4 /liff/tasks/[id]): the one figure a decider reads next to a request's amount. The same reader as the
// line's drill-down (./line-detail.ts, FR-BUD-005 AC2) — budget.view for the whole organization, or a head of the
// line's department (§2.4) — so a member who may not open the line's figures gets FORBIDDEN here too, and the page shows
// the line without them. One indexed read: no documents, no ledger movements.

export interface BudgetLineAvailableDto {
  readonly available: MoneyDto
}

export async function budgetLineAvailable(ctx: Ctx, budgetLineId: string): Promise<Result<BudgetLineAvailableDto>> {
  return forTenant(ctx.organizationId).$transaction(async (tx) => {
    const allowed = await authorize(tx, ctx, 'budget.view')
    if (!allowed.ok) return err(allowed.error.code, allowed.error.message, allowed.error.details)
    const view = budgetViewScope(allowed.data)
    if (!view) return err('FORBIDDEN', 'the figures of a budget line are for department heads and the budget roles', { capability: 'budget.view' })
    if (!z.uuid().safeParse(budgetLineId).success) return err('NOT_FOUND', 'budget line not found')
    const line = await tx.budgetLine.findFirst({ where: { id: budgetLineId }, select: { departmentId: true, balance: { select: { availableSatang: true } } } })
    if (!line) return err('NOT_FOUND', 'budget line not found')
    if (view.kind === 'DEPT' && !view.departmentIds.has(line.departmentId)) {
      return err('FORBIDDEN', 'a department head sees the budget lines of the departments they head', { capability: 'budget.view' })
    }
    return ok({ available: toMoneyDto(line.balance?.availableSatang ?? 0n) })
  })
}
