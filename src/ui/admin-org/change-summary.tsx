'use client'

import { useLocale, useTranslations } from 'next-intl'
import { formatSatang } from '@/core/money/format'
import { formatDateTime } from '../format'

// One sentence that says what an authority change does, on the list of changes and in the review before sending
// (FR-DOA-010 AC1). Names arrive in the reader's language; times as ISO strings; money as satang text.

export type ChangeSummaryInput =
  | { readonly kind: 'POSITION_ASSIGN'; readonly position: string; readonly department: string; readonly member: string }
  | { readonly kind: 'POSITION_END'; readonly position: string; readonly department: string; readonly replacement: string | null }
  | { readonly kind: 'DEPARTMENT_REPARENT'; readonly department: string; readonly parent: string }
  | {
      readonly kind: 'DELEGATION_ON_BEHALF'
      readonly delegator: string
      readonly delegate: string
      readonly startsAt: string
      readonly endsAt: string
      readonly documentTypes: readonly string[]
      /** Satang text, or null for no cap */
      readonly maxAmount: string | null
    }
  | { readonly kind: 'IDENTITY_RESET'; readonly member: string }

const DOCUMENT_TYPES = ['PURCHASE_REQUEST', 'PURCHASE_ORDER', 'GR_VARIANCE', 'DOA_CHANGE', 'ORG_AUTHORITY_CHANGE'] as const
type DocumentType = (typeof DOCUMENT_TYPES)[number]
const isDocumentType = (v: string): v is DocumentType => (DOCUMENT_TYPES as readonly string[]).includes(v)

export function ChangeSummary({ input, className }: { input: ChangeSummaryInput; className?: string }) {
  const t = useTranslations('adminOrg.authority')
  const locale = useLocale()
  let text: string
  switch (input.kind) {
    case 'POSITION_ASSIGN':
      text = t('summary.POSITION_ASSIGN', { member: input.member, position: input.position, department: input.department })
      break
    case 'POSITION_END':
      text = input.replacement
        ? t('summary.POSITION_END_REPLACED', { position: input.position, department: input.department, replacement: input.replacement })
        : t('summary.POSITION_END', { position: input.position, department: input.department })
      break
    case 'DEPARTMENT_REPARENT':
      text = t('summary.DEPARTMENT_REPARENT', { department: input.department, parent: input.parent })
      break
    case 'DELEGATION_ON_BEHALF': {
      const types = input.documentTypes.filter(isDocumentType)
      text = t('summary.DELEGATION_ON_BEHALF', {
        delegate: input.delegate,
        delegator: input.delegator,
        from: formatDateTime(locale, input.startsAt),
        to: formatDateTime(locale, input.endsAt),
      })
      const scope = types.length ? types.map((d) => t(`documentTypes.${d}`)).join(', ') : t('summary.allDocuments')
      const cap = input.maxAmount ? t('summary.cap', { amount: formatSatang(BigInt(input.maxAmount)) }) : t('summary.noCap')
      text = `${text} · ${scope} · ${cap}`
      break
    }
    case 'IDENTITY_RESET':
      text = t('summary.IDENTITY_RESET', { member: input.member })
      break
  }
  return <p className={className}>{text}</p>
}
