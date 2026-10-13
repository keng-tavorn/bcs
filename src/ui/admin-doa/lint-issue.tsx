'use client'

import { useTranslations } from 'next-intl'
import type { IssueView } from '../admin-org/outcome'
import { bandText } from './band'
import { DOC_TYPES, type DocType } from './editor-model'

// One lint error of a DOA version (BR-DOA-08, FR-DOA-002 AC1) as a sentence with its code and, for a gap or an overlap,
// the band that is wrong (amounts with two decimals).

const isDocumentType = (v: string | undefined): v is DocType => v !== undefined && (DOC_TYPES as readonly string[]).includes(v)

export function LintIssueText({ issue }: { issue: IssueView }) {
  const t = useTranslations('adminDoa')
  const documentType = isDocumentType(issue.documentType) ? t(`documentTypes.${issue.documentType}`) : (issue.documentType ?? '')
  let text: string
  switch (issue.code) {
    case 'DOA_LINT_GAP':
    case 'DOA_LINT_OVERLAP': {
      const band = bandText({ gt: issue.gt ?? null, lte: issue.lte ?? null })
      text = t(`lint.${issue.code}`, { documentType, band: t(`band.${band.key}`, band.values) })
      break
    }
    case 'DOA_LINT_MISSING_DOCTYPE':
      text = t('lint.DOA_LINT_MISSING_DOCTYPE', { documentType })
      break
    case 'DOA_LINT_UNRESOLVABLE_GOVERNANCE':
    case 'DOA_LINT_AMOUNT_NOT_ALLOWED':
    case 'DOA_LINT_PARALLEL_STEP':
    case 'DOA_LINT_QUORUM_INVALID':
      text = t(`lint.${issue.code}`, { rule: issue.rule ?? '' })
      break
    default:
      text = t('lint.OTHER', { code: issue.code })
  }
  return (
    <span>
      {text} <span className="text-ink-muted">({t('lintCode', { code: issue.code })})</span>
    </span>
  )
}
