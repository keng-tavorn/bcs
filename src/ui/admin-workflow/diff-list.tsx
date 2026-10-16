'use client'

import { CircleMinus, CirclePlus, PenLine } from 'lucide-react'
import type { RulePart, RuleValue } from './model'
import type { WorkflowWords } from './words'

// What changed rule by rule against the version this one is read beside (FR-WF-103 AC1): rules added, removed, and
// changed with each part before and after, in words with an icon, never colour alone (NFR-A11Y-03). The order of the
// rules is not a change.

export interface WorkflowDiff {
  readonly added: readonly string[]
  readonly removed: readonly string[]
  readonly changed: ReadonlyArray<{ readonly code: string; readonly fields: readonly RulePart[] }>
}

export function DiffList({ diff, before, after, words }: { diff: WorkflowDiff; before: readonly RuleValue[]; after: readonly RuleValue[]; words: WorkflowWords }) {
  const { t } = words
  const part = (r: RuleValue, p: RulePart): string => {
    switch (p) {
      case 'requestTypes':
        return r.requestTypeCodes.map(words.requestType).join(', ')
      case 'when':
        return words.condition(r.when)
      case 'reviewers':
        return r.reviewers.map(words.reviewer).join(', ')
      case 'fallback':
        return r.fallback ? words.reviewer(r.fallback) : t('noFallback')
      case 'mode':
        return words.mode(r.mode, r.quorumCount, r.reviewers.length)
      case 'sla':
        return words.sla(r.slaMinutes)
      case 'description':
        return r.descriptionTh ?? t('noDescription')
    }
  }
  const summary = (r: RuleValue) => t('diff.ruleLine', { types: r.requestTypeCodes.map(words.requestType).join(', '), condition: words.condition(r.when), reviewers: r.reviewers.map(words.reviewer).join(', ') })
  return (
    <ul className="flex flex-col divide-y divide-line border-y border-line">
      {diff.changed.map((c) => {
        const b = before.find((r) => r.code === c.code)
        const a = after.find((r) => r.code === c.code)
        if (!a || !b) return null
        return (
          <li key={`changed-${c.code}`} className="flex flex-col gap-1 py-3">
            <p className="flex items-center gap-2 font-medium">
              <PenLine className="size-4 shrink-0" aria-hidden="true" />
              {t('diff.changed', { rule: c.code })}
            </p>
            <dl className="flex flex-col gap-1 pl-6">
              {c.fields.map((f) => (
                <div key={f} className="flex flex-col">
                  <dt className="text-ink-muted">{t(`parts.${f}`)}</dt>
                  <dd className="break-words">{t('diff.beforeAfter', { before: part(b, f), after: part(a, f) })}</dd>
                </div>
              ))}
            </dl>
          </li>
        )
      })}
      {diff.added.map((code) => {
        const a = after.find((r) => r.code === code)
        return (
          <li key={`added-${code}`} className="flex flex-col gap-1 py-3">
            <p className="flex items-center gap-2 font-medium">
              <CirclePlus className="size-4 shrink-0" aria-hidden="true" />
              {t('diff.added', { rule: code })}
            </p>
            {a ? <p className="pl-6 break-words text-ink-muted">{summary(a)}</p> : null}
          </li>
        )
      })}
      {diff.removed.map((code) => {
        const b = before.find((r) => r.code === code)
        return (
          <li key={`removed-${code}`} className="flex flex-col gap-1 py-3">
            <p className="flex items-center gap-2 font-medium">
              <CircleMinus className="size-4 shrink-0" aria-hidden="true" />
              {t('diff.removed', { rule: code })}
            </p>
            {b ? <p className="pl-6 break-words text-ink-muted">{summary(b)}</p> : null}
          </li>
        )
      })}
    </ul>
  )
}
