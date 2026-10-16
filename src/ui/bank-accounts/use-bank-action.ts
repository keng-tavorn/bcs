'use client'

import { useTranslations } from 'next-intl'
import { useOutcomeAction } from '../procurement/use-outcome-action'
import { BANK_NO_ANSWER, bankErrorKey, type BankFailure, type BankOutcome } from './outcome'

/**
 * One action of the bank-account screens with this part's submission key (spec §4.3): a resend of the same submission
 * runs once; no answer keeps the key, so pressing again is the same submission. A success refreshes the page.
 */
export function useBankAction() {
  return useOutcomeAction<BankOutcome>(BANK_NO_ANSWER)
}

/** The words of a refusal: what happened and how to fix it (§9.9 rule 7), never the raw code */
export function useBankErrorText() {
  const t = useTranslations('bankAccount.errors')
  return (failure: BankFailure) => t(bankErrorKey(failure))
}
