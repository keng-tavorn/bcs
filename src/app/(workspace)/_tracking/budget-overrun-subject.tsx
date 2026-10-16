import Link from 'next/link'
import { getTranslations } from 'next-intl/server'
import type { OverrunDto } from '@/server/services/budget/overrun-view'
import { moneyText } from '@/ui/budgets/format'
import { formatDateTime } from '@/ui/format'
import { Facts, Section } from '@/ui/request-view/facts'
import { overrunLineText, overrunRequestLabel } from '../budgets/overruns/_present'

// The body of a BUDGET_OVERRUN task (S6-16 · FR-BUD-101 · ADR-068 subject registry): what the approver decides — the
// shortfall asked (no VAT), the budget line it goes into, what the source request needs there, the requester's reason,
// who asked and when — what deciding does to the budget, and the ways to the source request (its approvers read it
// through their task, request.view ASSIGNED) and to the overrun's own page. Read through getBudgetOverrun (budget.view
// ASSIGNED: the overrun's approvers read it).

const linkClass = 'inline-flex min-h-11 items-center self-start font-medium text-primary underline underline-offset-4 hover:no-underline'

export async function BudgetOverrunSubject({ overrun, locale }: { overrun: OverrunDto; locale: string }) {
  const t = await getTranslations('budgetOverrun')
  const request = overrunRequestLabel(overrun.request)
  return (
    <Section id="budget-overrun" title={t('task.title')}>
      <div className="flex flex-col gap-4">
        <Facts
          items={[
            { label: t('detail.shortfall'), value: <span className="money font-semibold">{t('money', { amount: moneyText(overrun.shortfall) })}</span> },
            { label: t('detail.line'), value: overrunLineText(overrun.budgetLine) },
            { label: t('detail.request'), value: overrun.request.number ? t('detail.requestValue', { number: overrun.request.number, title: overrun.request.title }) : overrun.request.title },
            { label: t('detail.requestNet'), value: <span className="money">{t('money', { amount: moneyText(overrun.requestNet) })}</span> },
            { label: t('detail.reason'), value: <span className="break-words whitespace-pre-line">{overrun.reason}</span> },
            { label: t('detail.submittedBy'), value: overrun.submittedBy.nameTh },
            { label: t('detail.submittedAt'), value: formatDateTime(locale, overrun.submittedAt) },
          ]}
        />
        <p className="text-ink-muted">{t('task.effect')}</p>
        <div className="flex flex-col gap-1 sm:flex-row sm:flex-wrap sm:gap-x-6">
          <Link href={`/requests/${overrun.request.id}`} className={linkClass}>
            {t('task.openRequest', { label: request })}
          </Link>
          <Link href={`/budgets/overruns/${overrun.id}`} className={linkClass}>
            {t('task.open', { number: overrun.number })}
          </Link>
        </div>
      </div>
    </Section>
  )
}
