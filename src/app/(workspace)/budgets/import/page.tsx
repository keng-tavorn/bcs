import Link from 'next/link'
import { getLocale, getTranslations } from 'next-intl/server'
import { systemClock } from '@/lib/clock'
import { BUDGET_IMPORT_MAX_ROWS, MEMBER_IMPORT_MAX_BYTES } from '@/lib/constants'
import { ctxFromSession } from '@/server/auth/session'
import { budgetImportHistory } from '@/server/services/budget/import'
import { moneyText } from '@/ui/budgets/format'
import { ImportBudgetForm } from '@/ui/budgets/import-form'
import { Refused } from '@/ui/budgets/refused'
import { formatDateTime } from '@/ui/format'
import { getSession } from '../../../_lib/session'
import { localeOf, nameIn } from '../_present'
import { checkBudgetFileAction, importBudgetFileAction } from './actions'

export async function generateMetadata() {
  const t = await getTranslations('budgets.import')
  return { title: t('title') }
}

const linkClass = 'inline-flex min-h-11 items-center self-start font-medium text-primary underline underline-offset-4 hover:no-underline'

// Budget import from Excel (spec §9.1 /budgets, FR-BUD-001 AC1–AC3, S3-04): the template with the organization's codes,
// a check of the file that saves nothing and reports each row, then the import of every row or none — the same file
// again only with a second confirmation — and the latest imports. budget.import (BUDGET_ADMIN) is checked by the
// services on every step.
export default async function BudgetImportPage() {
  const ctx = ctxFromSession(await getSession(), 'WEB', systemClock.now())
  if (!ctx) return null
  const [t, tb, locale] = await Promise.all([getTranslations('budgets.import'), getTranslations('budgets'), getLocale().then(localeOf)])
  const history = await budgetImportHistory(ctx)
  if (!history.ok) return <Refused title={t('title')} message={t('forbidden')} href="/" linkLabel={tb('home')} />

  return (
    <div className="flex max-w-4xl flex-col gap-8">
      <Link href="/budgets" className={linkClass}>
        {tb('back')}
      </Link>
      <div className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold">{t('title')}</h1>
        <p className="text-ink-muted">{t('intro')}</p>
      </div>

      <ImportBudgetForm
        templateHref="/budgets/import/template"
        dashboardHref="/budgets"
        maxBytes={MEMBER_IMPORT_MAX_BYTES}
        maxRows={BUDGET_IMPORT_MAX_ROWS}
        check={checkBudgetFileAction}
        importFile={importBudgetFileAction}
      />

      <section aria-labelledby="import-history" className="flex flex-col gap-3 border-t border-line pt-6">
        <h2 id="import-history" className="text-xl font-semibold">
          {t('historyTitle')}
        </h2>
        {history.data.length === 0 ? (
          <p className="text-ink-muted">{t('historyEmpty')}</p>
        ) : (
          <ul aria-labelledby="import-history" className="flex flex-col divide-y divide-line border-y border-line">
            {history.data.map((h) => (
              <li key={h.id} className="flex flex-col gap-0.5 py-3">
                <p className="font-medium break-all">{h.fileName}</p>
                <p className="tabular">{t('historyRow', { rows: h.rows, total: moneyText(h.total), fiscalYear: h.fiscalYearCode })}</p>
                <p className="text-base text-ink-muted md:text-sm">
                  {h.importedBy ? t('historyWhenBy', { time: formatDateTime(locale, h.importedAt), name: nameIn(locale, h.importedBy) }) : t('historyWhen', { time: formatDateTime(locale, h.importedAt) })}
                </p>
                {h.confirmedDuplicate ? <p className="text-base text-ink-muted md:text-sm">{t('historyDuplicate')}</p> : null}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}
