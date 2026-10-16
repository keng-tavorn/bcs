import Link from 'next/link'
import { getTranslations } from 'next-intl/server'
import type { TransferDto } from '@/server/services/budget/transfer-view'
import { moneyText } from '@/ui/budgets/format'
import { formatDateTime } from '@/ui/format'
import { Facts, Section } from '@/ui/request-view/facts'
import { lineText } from '../budgets/transfers/_present'

// The body of a BUDGET_TRANSFER task (S6-15 · FR-BUD-103 · ADR-068 subject registry): what the approver decides — the
// kind, the line it gives from and the line it gives to, the amount (no VAT) and the reason, who sent it and when — what
// deciding does to the budget, and the way to its own page. Read through getBudgetTransfer (budget.view ASSIGNED: the
// transfer's approvers read it).

const linkClass = 'inline-flex min-h-11 items-center self-start font-medium text-primary underline underline-offset-4 hover:no-underline'

export async function BudgetTransferSubject({ transfer, locale }: { transfer: TransferDto; locale: string }) {
  const t = await getTranslations('budgetTransfer')
  const label = transfer.number ?? t('list.draft')
  return (
    <Section id="budget-transfer" title={t('task.title')}>
      <div className="flex flex-col gap-4">
        <Facts
          items={[
            { label: t('detail.kind'), value: t(`kind.${transfer.kind}`) },
            ...(transfer.from ? [{ label: t('detail.from'), value: lineText(transfer.from) }] : []),
            ...(transfer.to ? [{ label: t('detail.to'), value: lineText(transfer.to) }] : []),
            { label: t('detail.amount'), value: <span className="money font-semibold">{t('detail.amountValue', { amount: moneyText(transfer.amount) })}</span> },
            { label: t('detail.reason'), value: <span className="break-words whitespace-pre-line">{transfer.reason}</span> },
            { label: t('detail.submittedBy'), value: transfer.submittedBy.nameTh },
            ...(transfer.submittedAt ? [{ label: t('detail.submittedAt'), value: formatDateTime(locale, transfer.submittedAt) }] : []),
          ]}
        />
        <p className="text-ink-muted">{t(`task.effect.${transfer.kind}`)}</p>
        <Link href={`/budgets/transfers/${transfer.id}`} className={linkClass}>
          {t('task.open', { label })}
        </Link>
      </div>
    </Section>
  )
}
