import { getTranslations } from 'next-intl/server'
import { HTTP_STATUS } from '@/core/result'
import { systemClock } from '@/lib/clock'
import { ctxFromSession, resolveSession } from '@/server/auth/session'
import { BUDGET_IMPORT_COLUMNS, budgetImportTemplate, type BudgetImportColumn } from '@/server/services/budget/import'

// GET the Excel template of the budget import (FR-BUD-001 AC1) with its guide sheet: the open fiscal years, departments
// and cost centers of the organization. For BUDGET_ADMIN only (budget.import, checked by the service). Read-only.
export async function GET(request: Request): Promise<Response> {
  const ctx = ctxFromSession(await resolveSession(request.headers), 'WEB', systemClock.now())
  if (!ctx) return new Response(null, { status: HTTP_STATUS.UNAUTHENTICATED })
  const t = await getTranslations('budgets.import')
  const labels = Object.fromEntries(BUDGET_IMPORT_COLUMNS.map((c) => [c, t(`fields.${c}`)])) as Record<BudgetImportColumn, string>
  const result = await budgetImportTemplate(ctx, labels, {
    sheetName: t('guide.sheet'),
    lines: [t('guide.line1'), t('guide.line2'), t('guide.line3'), t('guide.line4')],
    fiscalYearsTitle: t('guide.fiscalYears'),
    departmentsTitle: t('guide.departments'),
    costCentersTitle: t('guide.costCenters'),
    codeHeader: t('guide.code'),
    nameHeader: t('guide.name'),
    departmentHeader: t('guide.department'),
  })
  if (!result.ok) return new Response(null, { status: HTTP_STATUS[result.error.code] })
  return new Response(new Uint8Array(result.data), {
    headers: {
      'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'content-disposition': 'attachment; filename="bcs-budget-template.xlsx"',
      'cache-control': 'no-store',
    },
  })
}
