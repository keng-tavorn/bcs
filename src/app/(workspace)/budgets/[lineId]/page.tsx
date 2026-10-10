import Link from 'next/link'
import { notFound } from 'next/navigation'
import { getLocale, getTranslations } from 'next-intl/server'
import { cache } from 'react'
import { systemClock } from '@/lib/clock'
import { ctxFromSession } from '@/server/auth/session'
import { budgetDashboard } from '@/server/services/budget/dashboard'
import { budgetLineDetail } from '@/server/services/budget/line-detail'
import { LineStatusBadge, LowBadge } from '@/ui/budgets/badges'
import { LineFigures } from '@/ui/budgets/line-detail'
import { Refused } from '@/ui/budgets/refused'
import { formatDateTime } from '@/ui/format'
import { Page, PageBody, PageHeader } from '@/ui/page/page'
import { getSession } from '../../../_lib/session'
import { BudgetDocumentSections } from '../_documents'
import { figureStrip, localeOf, lowBadge, nameIn, shareStrip } from '../_present'

/** One read per request: the title and the page share it */
const load = cache(async (lineId: string) => {
  const ctx = ctxFromSession(await getSession(), 'WEB', systemClock.now())
  return ctx ? { ctx, result: await budgetLineDetail(ctx, lineId) } : null
})

export async function generateMetadata({ params }: { params: Promise<{ lineId: string }> }) {
  const [t, loaded] = await Promise.all([getTranslations('budgets'), params.then(({ lineId }) => load(lineId))])
  // The title names the line only for those who may see it
  return { title: loaded?.result.ok ? t('line.metaTitle', { code: loaded.result.data.line.code }) : t('title') }
}

const linkClass = 'inline-flex min-h-11 items-center self-start font-medium text-primary underline underline-offset-4 hover:no-underline'

// The drill-down of one budget line (spec §9.1 /budgets/[lineId], §11.2, FR-BUD-005 AC2): what the line is, its
// amounts — each leading to what makes it up on this page — the imports behind the planned amount, the requests and POs
// that reserve, the POs that commit, the POs with their invoices that make the actual, and the ledger's latest
// movements behind what is available. budgetLineDetail checks budget.view for this line; documents link (and show their
// title, requester or supplier) only for those who may open them.
export default async function BudgetLinePage({ params }: { params: Promise<{ lineId: string }> }) {
  const loaded = await load((await params).lineId)
  if (!loaded) return null
  const { ctx, result } = loaded
  const [t, locale] = await Promise.all([getTranslations('budgets'), getLocale().then(localeOf)])
  if (!result.ok) {
    if (result.error.code === 'NOT_FOUND') notFound()
    // A head of another department may still see their own budgets; anyone else goes home
    const own = await budgetDashboard(ctx)
    return own.ok ? <Refused title={t('title')} message={t('line.forbidden')} href="/budgets" linkLabel={t('back')} /> : <Refused title={t('title')} message={t('forbidden')} href="/" linkLabel={t('home')} />
  }

  const d = result.data
  const line = d.line
  // the warning's number opens the movements behind what is left, further down this page
  const low = lowBadge(t, line, line.code)

  return (
    <Page>
      <Link href={`/budgets?fy=${line.fiscalYear.id}`} className={linkClass}>
        {t('back')}
      </Link>

      <PageHeader title={line.nameTh}>
        {/* The code under the name, never a small label above the title (§9.10) */}
        <p className="font-medium text-ink">{line.code}</p>
        <p className="text-ink">{t('line.facts', { department: nameIn(locale, line.department), costCenter: line.costCenter.code, fiscalYear: line.fiscalYear.code })}</p>
        {line.accountCode ? <p className="text-ink-muted">{t('line.account', { code: line.accountCode })}</p> : null}
        {low || line.status !== 'OPEN' ? (
          <div className="flex flex-wrap items-center gap-2">
            {low ? <LowBadge label={low.label} out={low.out} link={low.link} /> : null}
            {line.status !== 'OPEN' ? <LineStatusBadge status={line.status} label={t(`status.${line.status}`)} /> : null}
          </div>
        ) : null}
        <p className="text-ink-muted">{t('asOf', { time: formatDateTime(locale, d.asOf) })}</p>
      </PageHeader>

      <PageBody>
        <LineFigures title={t('line.figuresTitle')} figures={figureStrip(t, line, line.code)} shares={shareStrip(t, line, line.code)} unit={t('unit')} />

        <BudgetDocumentSections t={t} locale={locale} docs={d} many={false} />
      </PageBody>
    </Page>
  )
}
