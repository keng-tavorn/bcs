import Link from 'next/link'
import { getTranslations } from 'next-intl/server'
import { systemClock } from '@/lib/clock'
import { ctxFromSession } from '@/server/auth/session'
import { getTransferForm } from '@/server/services/budget/transfer-view'
import { Refused } from '@/ui/budgets/refused'
import { TransferForm } from '@/ui/budgets/transfer-form'
import { kindsOffered } from '@/ui/budgets/transfer-model'
import { Notice } from '@/ui/form/notice'
import { Page, PageBody, PageHeader, Panel } from '@/ui/page/page'
import { getSession } from '../../../../_lib/session'
import { cancelBudgetTransferAction, createBudgetTransferAction, submitBudgetTransferAction } from '../actions'

export async function generateMetadata() {
  const t = await getTranslations('budgetTransfer')
  return { title: t('new') }
}

const linkClass = 'inline-flex min-h-11 items-center self-start font-medium text-primary underline underline-offset-4 hover:no-underline'

// A new transfer or adjustment (S6-15 · FR-BUD-103 AC1 AC4, §9.1 /budgets/transfers/new): for who may send one
// (budget.transfer.submit), with the lines of the fiscal year in use and what the member may do with each. While the DOA
// in effect has no BUDGET_TRANSFER rule the page says so in place of the form (AC4): a send could only be refused.
export default async function NewBudgetTransferPage() {
  const ctx = ctxFromSession(await getSession(), 'WEB', systemClock.now())
  if (!ctx) return null
  const t = await getTranslations('budgetTransfer')
  const form = await getTransferForm(ctx)
  if (!form.ok) return <Refused title={t('new')} message={t('forbidden')} href="/budgets" linkLabel={t('back')} />
  const { fiscalYear, lines, ruleInEffect } = form.data
  const offered = kindsOffered(lines)

  const body = !ruleInEffect ? (
    <Notice tone="info">
      <p className="font-medium">{t('noRule')}</p>
      <p>{t('noRuleHint')}</p>
    </Notice>
  ) : !fiscalYear ? (
    <Notice tone="info">{t('noYear')}</Notice>
  ) : offered.length === 0 ? (
    <Notice tone="info">{t('noLines', { code: fiscalYear.code })}</Notice>
  ) : (
    <Panel label={t('new')}>
      <TransferForm lines={lines} actions={{ create: createBudgetTransferAction, submit: submitBudgetTransferAction, cancel: cancelBudgetTransferAction }} />
    </Panel>
  )

  return (
    <Page>
      <Link href="/budgets/transfers" className={linkClass}>
        {t('toList')}
      </Link>
      <PageHeader title={t('new')} intro={ruleInEffect && fiscalYear ? t('form.intro', { code: fiscalYear.code }) : undefined} />
      <PageBody>{body}</PageBody>
    </Page>
  )
}
