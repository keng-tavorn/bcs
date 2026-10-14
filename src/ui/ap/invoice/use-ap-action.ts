'use client'

import { useTranslations } from 'next-intl'
import { useOutcomeAction } from '../../procurement/use-outcome-action'
import { AP_NO_ANSWER, apErrorKey, type ApFailure, type ApOutcome } from './outcome'

/**
 * One action of the invoice screens with this part's submission key (spec §4.3): a resend of the same submission runs
 * once; no answer keeps the key, so pressing again is the same submission. A success refreshes the page.
 */
export function useApAction() {
  return useOutcomeAction<ApOutcome>(AP_NO_ANSWER)
}

/** The words of a refusal, with what the screen knows of it */
export function useApErrorText() {
  const t = useTranslations('apInvoice')
  return (failure: ApFailure) => {
    const type = failure.type && t.has(`exceptions.type.${failure.type}` as 'exceptions.type.PRICE_OVER') ? t(`exceptions.type.${failure.type}` as 'exceptions.type.PRICE_OVER') : (failure.type ?? '-')
    const text = t(`errors.${apErrorKey(failure)}`, { lines: failure.lines ?? '-', type, incomeType: failure.incomeType ?? '-' })
    return failure.requestId ? `${text} (${failure.requestId})` : text
  }
}
