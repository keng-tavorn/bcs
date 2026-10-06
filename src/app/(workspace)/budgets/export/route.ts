import { getLocale, getTranslations } from 'next-intl/server'
import { z } from 'zod'
import { HTTP_STATUS } from '@/core/result'
import { systemClock } from '@/lib/clock'
import { ctxFromSession, resolveSession } from '@/server/auth/session'
import { budgetDashboard } from '@/server/services/budget/dashboard'
import { BUDGET_EXPORT_COLUMNS, budgetDashboardWorkbook, type BudgetExportTexts } from '@/server/services/budget/export'
import { formatDateTime } from '@/ui/format'
import { dayText, localeOf, nameIn } from '../_present'

/** "See Other": the browser follows it with a GET of the dashboard */
const HTTP_STATUS_SEE_OTHER = 303

// GET the Excel file of the budget dashboard (spec §11.2 "ส่งออก Excel"): the fiscal year `fy` (or the current one) in
// the scope the member may see — budgetDashboard checks budget.view, so the file never holds more than the page.
// Read-only: it changes nothing. A refusal answers with the HTTP status of its §14.2 code and the code itself — but
// when the member followed the dashboard's link (a browser navigation), the refusal goes back to the dashboard of the
// same year instead (§9.9 rule 7): the page runs the same check and says each refusal in words with its way on — the
// budget pages are not for this account, the year was not found, or (the session ended) the sign-in page — where the
// browser would only show a failed download of its own.
export async function GET(request: Request): Promise<Response> {
  const noStore = { 'cache-control': 'no-store' }
  const asked = new URL(request.url).searchParams.get('fy')
  const navigated = request.headers.get('sec-fetch-mode') === 'navigate'
  const refused = (code: keyof typeof HTTP_STATUS): Response =>
    navigated
      ? new Response(null, { status: HTTP_STATUS_SEE_OTHER, headers: { location: `/budgets${asked ? `?fy=${encodeURIComponent(asked)}` : ''}`, ...noStore } })
      : Response.json({ code }, { status: HTTP_STATUS[code], headers: noStore })
  const ctx = ctxFromSession(await resolveSession(request.headers), 'WEB', systemClock.now())
  if (!ctx) return refused('UNAUTHENTICATED')
  const result = await budgetDashboard(ctx, asked && z.uuid().safeParse(asked).success ? { fiscalYearId: asked } : {})
  if (!result.ok) return refused(result.error.code)

  const [t, locale] = await Promise.all([getTranslations('budgets.export'), getLocale().then(localeOf)])
  const tScope = await getTranslations('budgets.scope')
  const d = result.data
  const code = d.fiscalYear?.code ?? ''
  const texts: BudgetExportTexts = {
    sheetName: t('sheet'),
    heading: [
      t('title', { code }),
      ...(d.fiscalYear ? [`${dayText(locale, d.fiscalYear.startsOn)} – ${dayText(locale, d.fiscalYear.endsOn)}`] : []),
      t('scope', { scope: tScope(d.scope) }),
      t('asOf', { time: formatDateTime(locale, d.asOf) }),
      t('note'),
    ],
    headers: Object.fromEntries(BUDGET_EXPORT_COLUMNS.map((c) => [c, t(`columns.${c}`)])) as BudgetExportTexts['headers'],
    kinds: { line: t('kinds.line'), department: t('kinds.department'), total: t('kinds.total') },
    status: { OPEN: t('status.OPEN'), FROZEN: t('status.FROZEN'), CLOSED: t('status.CLOSED') },
    low: t('low'),
    departmentName: (department) => nameIn(locale, department),
  }
  const bytes = await budgetDashboardWorkbook(d, texts)
  return new Response(new Uint8Array(bytes), {
    headers: {
      'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'content-disposition': `attachment; filename="bcs-budgets-${code || 'none'}.xlsx"`,
      ...noStore,
    },
  })
}
