import Link from 'next/link'
import { getLocale, getTranslations } from 'next-intl/server'
import { systemClock } from '@/lib/clock'
import { ctxFromSession } from '@/server/auth/session'
import { newPaymentRunView } from '@/server/services/payments/view'
import { Notice } from '@/ui/form/notice'
import { Page, PageBody, PageHeader, Panel } from '@/ui/page/page'
import { NewRunForm } from '@/ui/payments/new-run-form'
import { payErrorKey } from '@/ui/payments/outcome'
import { accountValues, dayText, money } from '@/ui/payments/present'
import { getSession } from '../../../../_lib/session'
import { createRunAction } from '../actions'

// /finance/payments/new (S9-09, FR-PAY-101 AC1, demo step 1): the payer account and the pay date, both proposed — the
// next run day of payment.runWeekdays with the holidays (OQ-130) and the company's accounts in force — and what a run on
// that day would take (invoices due by then and every released retention, BR-PAY-03). ?payDate= asks for another day
// (a GET that changes nothing); a day that cannot be used is said and the proposed one is shown. "สร้างร่าง" makes the
// draft with those documents and opens it. FINANCE only (paymentRun.prepare, checked by the view and the command).

export async function generateMetadata() {
  const t = await getTranslations('payRun.new')
  return { title: t('metaTitle') }
}

const linkClass = 'inline-flex min-h-11 items-center self-start font-medium text-primary underline underline-offset-4 hover:no-underline'
const DAY = /^\d{4}-\d{2}-\d{2}$/

export default async function NewPaymentRunPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const ctx = ctxFromSession(await getSession(), 'WEB', systemClock.now())
  if (!ctx) return null
  const asked = (await searchParams).payDate
  const payDate = typeof asked === 'string' && DAY.test(asked) ? asked : null
  const [t, tp, locale] = await Promise.all([getTranslations('payRun.new'), getTranslations('payRun'), getLocale()])
  const result = await newPaymentRunView(ctx, { payDate })
  if (!result.ok) {
    return (
      <Page>
        <PageHeader title={t('forbiddenTitle')} />
        <div className="flex max-w-2xl flex-col gap-4">
          <Notice tone="warning">{result.error.code === 'MODULE_DISABLED' ? tp('list.moduleOff') : t('forbiddenHint')}</Notice>
          <Link href="/finance/payments" className={linkClass}>
            {t('back')}
          </Link>
        </div>
      </Page>
    )
  }
  const view = result.data
  const p = view.proposed
  const askedWhy = view.asked ? tp(`errors.${payErrorKey({ ok: false, code: view.asked.code, ...(view.asked.reason ? { reason: view.asked.reason } : {}) })}`, { supplier: '-', flag: '-', number: '-', checks: '-', rule: '-', requestId: '-' }) : null

  return (
    <Page>
      <Link href="/finance/payments" className={linkClass}>
        {t('back')}
      </Link>
      <PageHeader title={t('title')} intro={t('intro')} />
      <PageBody>
        {view.asked && askedWhy ? <Notice tone="warning">{t('askedRefused', { date: dayText(locale, view.asked.date), why: askedWhy })}</Notice> : null}
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_22rem] lg:items-start lg:gap-6">
          <Panel>
            {view.payers.length === 0 ? <Notice tone="warning">{t('noPayer')}</Notice> : null}
            <NewRunForm
              payers={view.payers.map((x) => ({ id: x.id, label: x.code ? tp('account.withCode', accountValues(locale, x)) : tp('account.masked', accountValues(locale, x)) }))}
              payDate={view.payDate}
              payDateText={dayText(locale, view.payDate)}
              create={createRunAction}
            />
          </Panel>
          <Panel title={t('proposedTitle')} id="proposed">
            {p.documents > 0 ? (
              <>
                <p className="text-ink">{t('proposed', { documents: p.documents, suppliers: p.suppliers, invoices: p.invoices, retentions: p.retentions })}</p>
                <dl className="flex items-baseline justify-between gap-4 border-y border-line py-2">
                  <dt className="text-ink-muted">{t('proposedTotal')}</dt>
                  <dd className="money font-semibold text-ink">
                    {money(p.payableSatang)}
                    <span className="sr-only"> {tp('unit')}</span>
                  </dd>
                </dl>
              </>
            ) : (
              <p className="text-ink-muted">{t('proposedNone')}</p>
            )}
            {view.payers.some((x) => x.neutralTemplate) ? <Notice tone="info">{tp('run.neutral')}</Notice> : null}
          </Panel>
        </div>
      </PageBody>
    </Page>
  )
}
