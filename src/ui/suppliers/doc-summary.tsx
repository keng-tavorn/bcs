'use client'

import { useLocale, useTranslations } from 'next-intl'
import { formatEnglishBeDate, formatThaiDate } from '@/core/thai/date'
import { StatusBadge, type BadgeLook } from '../document/badges'
import { Notice } from '../form/notice'

// The overall state of a supplier's documents above its list (S7-09 · BR-SDOC ข้อ 06): each required type of its payee
// type, and each type it has a copy of, with its state on today's date — valid, expiring, expired, missing, waiting —
// and the answer to "are the required documents in", as S10 S11 and the PO page read it.

export type DocumentStateView = 'OK' | 'EXPIRING' | 'EXPIRED' | 'MISSING' | 'PENDING'

export interface DocSummaryRowView {
  readonly documentTypeCode: string
  readonly nameTh: string
  readonly nameEn: string
  readonly required: boolean
  readonly scope: string | null
  readonly state: DocumentStateView
  readonly expiresOn: string | null
}

const LOOK: Readonly<Record<DocumentStateView, BadgeLook>> = {
  OK: { tone: 'ok', icon: 'CircleCheck' },
  EXPIRING: { tone: 'warn', icon: 'AlarmClock' },
  EXPIRED: { tone: 'danger', icon: 'CircleX' },
  MISSING: { tone: 'danger', icon: 'CircleX' },
  PENDING: { tone: 'warn', icon: 'Hourglass' },
}

export function DocSummary({ rows, requiredDocumentsOk }: { rows: readonly DocSummaryRowView[]; requiredDocumentsOk: boolean }) {
  const t = useTranslations('supplierContacts.docSummary')
  const locale = useLocale()
  const day = (iso: string) => (locale === 'en' ? formatEnglishBeDate(iso) : formatThaiDate(iso))
  if (rows.length === 0) return <p className="text-ink-muted">{t('none')}</p>
  return (
    <div className="flex flex-col gap-3">
      <Notice tone={requiredDocumentsOk ? 'success' : 'warning'} role="status">
        {requiredDocumentsOk ? t('allOk') : t('notOk')}
      </Notice>
      <ul className="flex flex-col divide-y divide-line">
        {rows.map((r) => (
          <li key={`${r.documentTypeCode}:${r.scope ?? ''}`} className="flex flex-col gap-1 py-2 first:pt-0 last:pb-0 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
            <div className="flex min-w-0 flex-col">
              <span className="font-medium text-ink">{locale === 'en' ? r.nameEn : r.nameTh}</span>
              <span className="text-base text-ink-muted md:text-sm">{[r.required ? t('required') : t('optional'), r.scope].filter(Boolean).join(' · ')}</span>
            </div>
            <div className="flex flex-col gap-1 sm:items-end">
              <StatusBadge look={LOOK[r.state]} label={t(`state.${r.state}`)} className="self-start sm:self-end" />
              {r.state !== 'MISSING' && r.state !== 'PENDING' ? <span className="tabular text-base text-ink-muted md:text-sm">{r.expiresOn ? t('expiresOn', { date: day(r.expiresOn) }) : t('noExpiry')}</span> : null}
            </div>
          </li>
        ))}
      </ul>
    </div>
  )
}
