'use client'

import { useLocale, useTranslations } from 'next-intl'
import { LOGIN_FAILURE_LIMIT, LOGIN_FAILURE_WINDOW_MS, MS_PER_MINUTE, TWO_FACTOR_LOCK_LIMIT, TWO_FACTOR_LOCK_MS } from '@/lib/constants'
import { formatDateTime } from '../format'
import { lockWords } from './answers'

/** What a refused sign-in step (429) carries: our lockout sends code LOGIN_LOCKED with its reason and end time. */
interface RefusedSignIn {
  code?: string
  reason?: unknown
  retryAt?: unknown
}

/**
 * The words for a refused sign-in step: which lock applies (this account, or this network address) and when it
 * lifts, so nobody is sent to reset a password that a reset cannot unlock (§9.9 rule 7); Better Auth's own lock of the
 * second step (TWO_FACTOR_LOCK_LIMIT wrong codes in a row) in words of its own, with how long it lasts — never "too many
 * requests" to someone who waited as told (./answers.ts lockWords). Any other 429 is the §14.2 RATE_LIMITED text.
 */
export function useLockMessage(): (failure: RefusedSignIn) => string {
  const t = useTranslations('auth.lock')
  const locale = useLocale()
  return (failure) => {
    const words = lockWords(failure)
    if (words === 'secondStep') return t('secondStep', { limit: TWO_FACTOR_LOCK_LIMIT, minutes: TWO_FACTOR_LOCK_MS / MS_PER_MINUTE })
    if (words === 'busy') return t('busy')
    const values = { limit: LOGIN_FAILURE_LIMIT, minutes: LOGIN_FAILURE_WINDOW_MS / MS_PER_MINUTE, time: formatDateTime(locale, new Date(String(failure.retryAt))) }
    return t(words, values)
  }
}
