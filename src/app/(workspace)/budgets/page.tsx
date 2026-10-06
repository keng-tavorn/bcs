import Link from 'next/link'
import { getLocale, getTranslations } from 'next-intl/server'
import { z } from 'zod'
import { systemClock } from '@/lib/clock'
import { ctxFromSession } from '@/server/auth/session'
import { budgetDashboard, type BudgetDashboardDto } from '@/server/services/budget/dashboard'
import { BudgetTable, type BudgetDepartmentView } from '@/ui/budgets/budget-table'
import { Refused } from '@/ui/budgets/refused'
import { Button } from '@/ui/form/button'
import { Notice } from '@/ui/form/notice'
import { formatDateTime } from '@/ui/format'
import { getSession } from '../../_lib/session'
import { amountLinks, budgetHref, dayText, figureView, localeOf, lowItemText, nameIn, usedUp, type BudgetsT, type Locale } from './_present'

export async function generateMetadata() {
  const t = await getTranslations('budgets')
  return { title: t('title') }
}

const linkClass = 'inline-flex min-h-11 items-center font-medium text-primary underline underline-offset-4 hover:no-underline'
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)

function departments(t: BudgetsT, locale: Locale, d: BudgetDashboardDto, fiscalYearId: string): BudgetDepartmentView[] {
  return d.departments.map((dept) => {
    const name = nameIn(locale, dept)
    const href = budgetHref.department(dept.id, fiscalYearId)
    return {
      id: dept.id,
      name,
      totalLabel: t('table.departmentTotal', { name }),
      href,
      ...figureView(t, dept, amountLinks(t, dept, name, href)),
      lines: d.lines
        .filter((l) => l.departmentId === dept.id)
        .map((l) => {
          const lineHref = budgetHref.line(l.id)
          return {
            id: l.id,
            code: l.code,
            name: l.nameTh,
            href: lineHref,
            status: l.status === 'OPEN' ? null : { kind: l.status, label: t(`status.${l.status}`) },
            ...figureView(t, l, amountLinks(t, l, l.code, lineHref)),
          }
        }),
    }
  })
}

// The budget dashboard (spec §9.1 /budgets, §11.2, FR-BUD-005 AC1 AC3, demo scene 9): the lines running low first,
// then every budget line by department with the total, every amount of a line, a department and the total leading to
// what makes it up (AC2: /budgets/[lineId], /budgets/departments/[id], /budgets/total), the fiscal year and the scope
// shown, when the figures were read, and the Excel file of the same. budgetDashboard checks budget.view: the whole
// organization for FINANCE, BUDGET_ADMIN, EXECUTIVE and AUDITOR, a head's own departments otherwise.
export default async function BudgetsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const ctx = ctxFromSession(await getSession(), 'WEB', systemClock.now())
  if (!ctx) return null
  const [t, locale] = await Promise.all([getTranslations('budgets'), getLocale().then(localeOf)])
  const asked = one((await searchParams).fy)
  const fiscalYearId = asked && z.uuid().safeParse(asked).success ? asked : undefined
  const result = await budgetDashboard(ctx, fiscalYearId ? { fiscalYearId } : {})

  if (!result.ok && result.error.code === 'NOT_FOUND') {
    return (
      <div className="flex max-w-2xl flex-col gap-6">
        <h1 className="text-2xl font-semibold">{t('title')}</h1>
        <Notice tone="warning">{t('year.notFound')}</Notice>
        <Link href="/budgets" className={linkClass}>
          {t('year.current')}
        </Link>
      </div>
    )
  }
  if (!result.ok) return <Refused title={t('title')} message={t('forbidden')} href="/" linkLabel={t('home')} />

  const d = result.data
  const year = d.fiscalYear
  // Running low, or used up (nothing left, whatever the organization's warning threshold)
  const low = d.lines.filter((l) => l.low || usedUp(l))
  const query = year ? `?fy=${year.id}` : ''

  return (
    <div className="flex flex-col gap-6">
      <div className="flex max-w-4xl flex-col gap-2">
        <h1 className="text-2xl font-semibold">{t('title')}</h1>
        <p className="text-ink-muted">{t('intro')}</p>
        {year ? <p className="font-medium text-ink">{t('yearLine', { code: year.code, from: dayText(locale, year.startsOn), to: dayText(locale, year.endsOn), scope: t(`scope.${d.scope}`) })}</p> : null}
        <p className="flex flex-wrap items-center gap-x-4 gap-y-1 text-ink">
          <span>{t('asOf', { time: formatDateTime(locale, d.asOf) })}</span>
          {/* A full reload: an installed app (PWA) has no reload button of its own */}
          <a href={`/budgets${query}`} className={linkClass}>
            {t('refresh')}
          </a>
        </p>
      </div>

      <nav aria-label={t('actions.label')} className="flex flex-wrap gap-x-6 gap-y-1 border-y border-line py-2">
        {year && d.lines.length ? (
          // No download attribute: the file comes as an attachment and the page stays; a refusal leads back here in words
          <a href={`/budgets/export${query}`} className={linkClass}>
            {t('actions.export', { code: year.code })}
          </a>
        ) : null}
        {d.can.import ? (
          <Link href="/budgets/import" className={linkClass}>
            {t('actions.import')}
          </Link>
        ) : null}
        {d.can.manageGrants ? (
          <Link href="/budgets/grants" className={linkClass}>
            {t('actions.grants')}
          </Link>
        ) : null}
      </nav>

      {d.fiscalYears.length > 1 ? (
        <form method="get" action="/budgets" className="flex flex-col gap-3 sm:flex-row sm:items-end">
          <div className="flex flex-col gap-1.5 sm:w-64">
            <label htmlFor="budget-year" className="font-medium text-ink">
              {t('year.label')}
            </label>
            <select id="budget-year" name="fy" defaultValue={year?.id ?? ''} className="h-11 w-full rounded-md border border-input bg-bg px-3 text-base text-ink">
              {d.fiscalYears.map((y) => (
                <option key={y.id} value={y.id}>
                  {y.code}
                </option>
              ))}
            </select>
          </div>
          <Button type="submit" variant="secondary" className="self-start sm:self-auto">
            {t('year.submit')}
          </Button>
        </form>
      ) : null}

      {low.length ? (
        <Notice tone="warning">
          <p className="font-medium">{t('low.title', { count: low.length })}</p>
          <p>{t('low.hint', { pct: d.lowPct })}</p>
          <ul className="mt-1 flex flex-col">
            {low.map((l) => (
              <li key={l.id}>
                <Link href={budgetHref.line(l.id)} className={linkClass}>
                  {lowItemText(t, l)}
                </Link>
              </li>
            ))}
          </ul>
        </Notice>
      ) : null}

      {!year || d.lines.length === 0 ? (
        <div className="flex flex-col gap-2 border-y border-line py-6">
          <p className="font-medium text-ink">{year ? t('empty.title') : t('empty.noYear')}</p>
          <p className="text-ink-muted">{d.can.import ? t('empty.hintAdmin') : t('empty.hintOther')}</p>
          {d.can.import ? (
            <Link href="/budgets/import" className={linkClass}>
              {t('actions.import')}
            </Link>
          ) : null}
        </div>
      ) : (
        <BudgetTable
          departments={departments(t, locale, d, year.id)}
          total={{
            label: t(`table.total.${d.scope}`),
            href: budgetHref.total(year.id),
            ...figureView(t, d.total, amountLinks(t, d.total, t(`scope.${d.scope}`), budgetHref.total(year.id))),
          }}
          labels={{
            caption: t('table.caption', { code: year.code }),
            line: t('columns.line'),
            planned: t('columns.planned'),
            available: t('columns.available'),
            reserved: t('columns.reserved'),
            committed: t('columns.committed'),
            actual: t('columns.actual'),
            share: t('columns.share'),
            noShare: t('columns.noShare'),
            unit: t('unit'),
          }}
        />
      )}

      <section aria-labelledby="budget-legend" className="flex max-w-4xl flex-col gap-2 border-t border-line pt-4">
        <h2 id="budget-legend" className="text-lg font-semibold">
          {t('legend.title')}
        </h2>
        <ul className="flex flex-col gap-1 text-ink-muted">
          {(['planned', 'available', 'reserved', 'committed', 'actual', 'shares'] as const).map((k) => (
            <li key={k}>{t(`legend.${k}`)}</li>
          ))}
        </ul>
      </section>
    </div>
  )
}
