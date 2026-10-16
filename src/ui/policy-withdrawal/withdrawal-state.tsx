import { useLocale, useTranslations } from 'next-intl'
import { nameIn } from '../admin-org/names'
import { Notice } from '../form/notice'
import { formatDateTime } from '../format'

// How a version's withdrawal stands on its admin page (FR-DOA-104 · FR-WF-103, S6-07): waiting for its decision — who
// asked, when, why and who decides, and what approving or rejecting does — or done, with when and who asked. Drawn on
// the server and on the client alike (no state of its own).

export interface WithdrawalStateProps {
  readonly pending: boolean
  readonly withdrawnAt: string | null
  readonly requestedBy: { readonly nameTh: string; readonly nameEn: string | null } | null
  readonly requestedAt: string | null
  readonly reason: string | null
  /** Who decides while it waits */
  readonly waiting: readonly string[]
}

export function WithdrawalState({ pending, withdrawnAt, requestedBy, requestedAt, reason, waiting }: WithdrawalStateProps) {
  const t = useTranslations('policyWithdrawal')
  const locale = useLocale()
  const when = (iso: string) => formatDateTime(locale, iso)
  const who = requestedBy ? nameIn(locale, requestedBy) : '-'
  if (withdrawnAt) {
    return (
      <Notice tone="info">
        <p className="font-medium">{t('withdrawn', { time: when(withdrawnAt) })}</p>
        {requestedAt ? <p>{t('withdrawnBy', { name: who, time: when(requestedAt) })}</p> : null}
        {reason ? <p className="break-words whitespace-pre-line">{t('reasonLine', { reason })}</p> : null}
      </Notice>
    )
  }
  if (!pending) return null
  return (
    <Notice tone="warning">
      <p className="font-medium">{t('pendingTitle')}</p>
      {requestedAt ? <p>{t('pending', { name: who, time: when(requestedAt) })}</p> : null}
      {reason ? <p className="break-words whitespace-pre-line">{t('reasonLine', { reason })}</p> : null}
      {waiting.length ? <p>{t('pendingWaiting', { names: waiting.join(', ') })}</p> : null}
    </Notice>
  )
}
