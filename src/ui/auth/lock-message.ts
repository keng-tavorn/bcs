'use client'

import { useLocale, useTranslations } from 'next-intl'
import { LOGIN_FAILURE_LIMIT, LOGIN_FAILURE_WINDOW_MS, MS_PER_MINUTE } from '@/lib/constants'
import { formatDateTime } from '../format'

/** What a refused sign-in step (429) carries: our lockout sends code LOGIN_LOCKED with its reason and end time. */
interface RefusedSignIn {
  code?: string
  reason?: unknown
  retryAt?: unknown
}

/**
 * The words for a refused sign-in step: which lock applies (this account, or this network address) and when it
 * lifts, so nobody is sent to reset a password that a reset cannot unlock (§9.9 rule 7). Any other 429 is the
 * §14.2 RATE_LIMITED text.
 */
export function useLockMessage(): (failure: RefusedSignIn) => string {
  const t = useTranslations('auth.lock')
  const locale = useLocale()
  return (failure) => {
    const retryAt = typeof failure.retryAt === 'string' ? new Date(failure.retryAt) : null
    if (failure.code !== 'LOGIN_LOCKED' || !retryAt || Number.isNaN(retryAt.getTime())) return t('busy')
    const values = { limit: LOGIN_FAILURE_LIMIT, minutes: LOGIN_FAILURE_WINDOW_MS / MS_PER_MINUTE, time: formatDateTime(locale, retryAt) }
    return failure.reason === 'IP' ? t('address', values) : t('account', values)
  }
}
