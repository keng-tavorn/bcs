import Link from 'next/link'
import { notFound } from 'next/navigation'
import { getLocale, getTranslations } from 'next-intl/server'
import { cache } from 'react'
import { z } from 'zod'
import { systemClock } from '@/lib/clock'
import { ctxFromSession } from '@/server/auth/session'
import { budgetDashboard } from '@/server/services/budget/dashboard'
import { budgetScopeDetail } from '@/server/services/budget/scope-detail'
import { LowBadge } from '@/ui/budgets/badges'
import { LineFigures } from '@/ui/budgets/line-detail'
import { Refused } from '@/ui/budgets/refused'
import { formatDateTime } from '@/ui/format'
import { getSession } from '../../_lib/session'
import { BudgetDocumentSections } from './_documents'
import { dayText, figureStrip, localeOf, lowText, nameIn, shareStrip, usedUp, type BudgetsT } from './_present'

// The drill-down of the dashboard's added-up rows (spec §11.2, FR-BUD-005 AC2): a department's total (/budgets/
// departments/[id]) or the total of everything the viewer may see (/budgets/total), in the fiscal year `fy` (or the
// current one): the same figures as the dashboard's row, each leading to what makes it up on the page, and the
// documents of every line added up, each naming its line. budgetScopeDetail checks budget.view and, for a department
// head, that they head the department.

const linkClass = 'inline-flex min-h-11 items-center self-start font-medium text-primary underline underline-offset-4 hover:no-underline'

/** `fy` of the address when it is an id; anything else asks for the current fiscal year */
export const fiscalYearParam = (value: string | string[] | undefined): string | undefined => {
  const one = Array.isArray(value) ? value[0] : value
  return one && z.uuid().safeParse(one).success ? one : undefined
}

/** One read per request: the title and the page share it */
export const loadScope = cache(async (departmentId: string | null, fiscalYearId: string | undefined) => {
  const ctx = ctxFromSession(await getSession(), 'WEB', systemClock.now())
  if (!ctx) return null
  const input = { ...(departmentId ? { departmentId } : {}), ...(fiscalYearId ? { fiscalYearId } : {}) }
  return { ctx, result: await budgetScopeDetail(ctx, input) }
})

/** The page's title: what is added up, for those who may see it */
export async function scopeTitle(departmentId: string | null, fiscalYearId: string | undefined): Promise<string> {
  const [t, locale, loaded] = await Promise.all([getTranslations('budgets'), getLocale().then(localeOf), loadScope(departmentId, fiscalYearId)])
  if (!loaded?.result.ok) return t('title')
  const d = loaded.result.data
  return d.department ? t('detail.metaDepartment', { name: nameIn(locale, d.department) }) : t(`table.total.${d.scope}`)
}

function heading(t: BudgetsT, d: { department: { nameTh: string; nameEn: string | null } | null; scope: 'ORG' | 'DEPT' }, locale: 'th' | 'en') {
  return d.department ? t('table.departmentTotal', { name: nameIn(locale, d.department) }) : t(`table.total.${d.scope}`)
}

export async function BudgetScopePage({ departmentId, fiscalYearId }: { departmentId: string | null; fiscalYearId: string | undefined }) {
  const loaded = await loadScope(departmentId, fiscalYearId)
  if (!loaded) return null
  const { ctx, result } = loaded
  const [t, locale] = await Promise.all([getTranslations('budgets'), getLocale().then(localeOf)])
  if (!result.ok) {
    if (result.error.code === 'NOT_FOUND') notFound()
    // A head of another department may still see their own budgets; anyone else goes home
    const own = await budgetDashboard(ctx)
    return own.ok ? <Refused title={t('title')} message={t('detail.forbidden')} href="/budgets" linkLabel={t('back')} /> : <Refused title={t('title')} message={t('forbidden')} href="/" linkLabel={t('home')} />
  }

  const d = result.data
  const year = d.fiscalYear
  const low = lowText(t, d.figures)
  // What the amounts' links say they are of: the department, or the scope ("ทั้งองค์กร")
  const of = d.department ? nameIn(locale, d.department) : t(`scope.${d.scope}`)

  return (
    <div className="flex flex-col gap-8">
      <Link href={`/budgets?fy=${year.id}`} className={linkClass}>
        {t('back')}
      </Link>

      <header className="flex max-w-4xl flex-col gap-2">
        <h1 className="text-2xl font-semibold break-words">{heading(t, d, locale)}</h1>
        {/* The heading names what is added up; the year says which */}
        <p className="text-ink">{t('detail.yearLine', { code: year.code, from: dayText(locale, year.startsOn), to: dayText(locale, year.endsOn) })}</p>
        <p className="text-ink">{d.department ? t('detail.lineCount', { count: d.lineCount }) : t('detail.lineAndDepartmentCount', { lines: d.lineCount, departments: d.departmentCount })}</p>
        {low ? <LowBadge label={low} out={usedUp(d.figures)} /> : null}
        <p className="text-ink-muted">{t('asOf', { time: formatDateTime(locale, d.asOf) })}</p>
      </header>

      <LineFigures title={t('detail.figuresTitle')} figures={figureStrip(t, d.figures, of)} shares={shareStrip(t, d.figures)} unit={t('unit')} />

      <BudgetDocumentSections t={t} locale={locale} docs={d} many />
    </div>
  )
}
