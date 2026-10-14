'use client'

import { useTranslations } from 'next-intl'
import type { TaxFailure } from './outcome'

const KNOWN = ['FORBIDDEN', 'MODULE_DISABLED', 'NOT_FOUND', 'CONFLICT_VERSION', 'INVALID_STATE_TRANSITION', 'SOD_VIOLATION', 'UNAUTHENTICATED', 'NO_ANSWER'] as const
const FIELDS = ['CODE', 'NAME', 'RATE', 'MONTH'] as const

/** A failure of the tax screens in words that say what happened and what to do (§9.9 rule 7) */
export function useTaxFailureText(): (failure: TaxFailure) => string {
  const t = useTranslations('apTax.errors')
  return (failure) => {
    if (failure.code === 'RETENTION_NOT_DUE') return failure.date ? t('RETENTION_NOT_DUE', { date: failure.date }) : t('RETENTION_NO_DATE')
    if (failure.code === 'VALIDATION_FAILED') return (FIELDS as readonly string[]).includes(failure.field ?? '') ? t(failure.field as (typeof FIELDS)[number]) : t('INPUT')
    if ((KNOWN as readonly string[]).includes(failure.code)) return t(failure.code as (typeof KNOWN)[number])
    return t('FAILED')
  }
}
