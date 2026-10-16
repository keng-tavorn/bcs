'use client'

import { useTranslations } from 'next-intl'
import { useOutcomeAction } from '../procurement/use-outcome-action'
import { PAY_NO_ANSWER, payErrorKey, type PayFailure, type PayOutcome } from './outcome'

/**
 * One action of the payment run screens with this part's submission key (spec §4.3): a resend of the same submission
 * runs once; no answer keeps the key, so pressing again is the same submission. A success refreshes the page.
 */
export function usePayAction() {
  return useOutcomeAction<PayOutcome>(PAY_NO_ANSWER)
}

/** The words of a refusal: what happened and how to fix it (§9.9 rule 7) */
export function usePayErrorText() {
  const t = useTranslations('payRun')
  return (failure: PayFailure) => {
    const flag = failure.flag && t.has(`task.flag.${failure.flag}` as 'task.flag.REGISTRY_CHANGED') ? t(`task.flag.${failure.flag}` as 'task.flag.REGISTRY_CHANGED') : (failure.flag ?? '-')
    return t(`errors.${payErrorKey(failure)}`, {
      supplier: failure.supplier ?? '-',
      flag,
      number: failure.number ?? '-',
      checks: failure.checks ?? '-',
      rule: failure.rule ?? '-',
      requestId: failure.requestId ?? '-',
    })
  }
}
