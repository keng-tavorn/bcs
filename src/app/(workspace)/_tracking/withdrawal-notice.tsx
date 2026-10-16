import { getTranslations } from 'next-intl/server'
import type { WithdrawalTaskDto } from '@/server/queries/tasks'
import { Notice } from '@/ui/form/notice'
import { memberName, when, type Locale } from './present'

// A task on the route of a withdrawal (FR-DOA-104 · BR-DOA-18 · FR-WF-103, S6-07), said first on its decision page: the
// version asked to be withdrawn, approved but not yet in effect, who asked, when and why, and what each decision does
// — approving withdraws it and the version before it stays in effect; rejecting keeps it on its date. Once withdrawn,
// when.

export async function WithdrawalNotice({ withdrawal, version, effectiveFrom, locale }: { withdrawal: WithdrawalTaskDto; version: string; effectiveFrom: Date; locale: Locale }) {
  const t = await getTranslations('tasks.withdrawal')
  const effective = when(locale, effectiveFrom)
  return (
    <Notice tone="warning" role="status">
      <p className="font-semibold">{t('title')}</p>
      <p>
        {withdrawal.requestedBy && withdrawal.requestedAt
          ? t('asked', { name: memberName(locale, withdrawal.requestedBy), version, effective, at: when(locale, withdrawal.requestedAt) })
          : t('askedNoName', { version, effective })}
      </p>
      {withdrawal.reason ? <p className="break-words whitespace-pre-line">{t('reason', { reason: withdrawal.reason })}</p> : null}
      {withdrawal.withdrawnAt ? <p className="font-medium">{t('withdrawn', { time: when(locale, withdrawal.withdrawnAt) })}</p> : <p>{t('effect')}</p>}
    </Notice>
  )
}
