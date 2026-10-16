import Link from 'next/link'
import { getLocale, getTranslations } from 'next-intl/server'
import { systemClock } from '@/lib/clock'
import { ctxFromSession } from '@/server/auth/session'
import { getTransferForm, listBudgetTransfers } from '@/server/services/budget/transfer-view'
import { DocumentStatus } from '@/ui/budgets/badges'
import { moneyText } from '@/ui/budgets/format'
import { Refused } from '@/ui/budgets/refused'
import { kindsOffered } from '@/ui/budgets/transfer-model'
import { Notice } from '@/ui/form/notice'
import { formatDateTime } from '@/ui/format'
import { ListEmpty, Page, PageBody, PageHeader, Panel } from '@/ui/page/page'
import { Button } from '@/ui/shadcn/button'
import { getSession } from '../../../_lib/session'
import { routeText, transferLabel } from './_present'

export async function generateMetadata() {
  const t = await getTranslations('budgetTransfer')
  return { title: t('title') }
}

const linkClass = 'inline-flex min-h-11 items-center self-start font-medium text-primary underline underline-offset-4 hover:no-underline'

// The budget transfers and adjustments (S6-15 · FR-BUD-103, §9.1 /budgets/transfers): the ones the member may read —
// who reads every budget, the heads of the departments a transfer concerns, its sender, its approvers — newest first,
// each with its number, kind, lines, amount, status and when it was sent, leading to its page. "โอนหรือปรับงบ" shows
// only to who may send one while the DOA in effect has a BUDGET_TRANSFER rule (AC4); without the rule, who may send
// one is told why instead. The services check budget.view and budget.transfer.submit again.
export default async function BudgetTransfersPage() {
  const ctx = ctxFromSession(await getSession(), 'WEB', systemClock.now())
  if (!ctx) return null
  const [t, tb, locale] = await Promise.all([getTranslations('budgetTransfer'), getTranslations('budgets'), getLocale()])
  const [list, form] = await Promise.all([listBudgetTransfers(ctx), getTransferForm(ctx)])
  if (!list.ok) return <Refused title={t('title')} message={t('forbidden')} href="/" linkLabel={t('home')} />

  const sender = form.ok
  const canStart = form.ok && form.data.ruleInEffect && kindsOffered(form.data.lines).length > 0
  const start = canStart ? (
    <Button asChild className="min-h-11 lg:min-h-10">
      <Link href="/budgets/transfers/new">{t('new')}</Link>
    </Button>
  ) : null

  return (
    <Page>
      <Link href="/budgets" className={linkClass}>
        {t('back')}
      </Link>
      <PageHeader title={t('title')} intro={t('intro')} actions={start} />
      <PageBody>
        {sender && !form.data.ruleInEffect ? (
          <Notice tone="info">
            <p className="font-medium">{t('noRule')}</p>
            <p>{t('noRuleHint')}</p>
          </Notice>
        ) : null}
        <Panel title={t('list.label')} id="budget-transfers">
          {list.data.length === 0 ? (
            <ListEmpty title={t('list.empty')} hint={canStart ? t('list.emptyHintSender') : t('list.emptyHint')} actions={start} />
          ) : (
            <ul className="flex flex-col divide-y divide-line" aria-labelledby="budget-transfers">
              {list.data.map((d) => {
                const label = transferLabel(t, d)
                return (
                  <li key={d.id} className="grid gap-x-6 gap-y-1 py-3 sm:grid-cols-[minmax(0,1fr)_auto]">
                    <div className="flex min-w-0 flex-col gap-1">
                      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                        <Link href={`/budgets/transfers/${d.id}`} aria-label={t('list.open', { label })} className="font-semibold break-words text-primary underline underline-offset-4 hover:no-underline">
                          {label}
                        </Link>
                        <DocumentStatus status={d.status} label={t(`status.${d.status}`)} />
                      </div>
                      <p className="break-words text-ink">
                        {t(`kind.${d.kind}`)} · {routeText(t, d)}
                      </p>
                      <p className="text-base text-ink-muted md:text-sm">{d.submittedAt ? t('list.sentAt', { time: formatDateTime(locale, d.submittedAt) }) : t('list.notSent')}</p>
                    </div>
                    <p className="money font-semibold sm:text-right">
                      {moneyText(d.amount)}
                      <span className="sr-only"> {tb('unit')}</span>
                    </p>
                  </li>
                )
              })}
            </ul>
          )}
        </Panel>
      </PageBody>
    </Page>
  )
}
