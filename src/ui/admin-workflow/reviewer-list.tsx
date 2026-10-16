'use client'

import { CirclePlus, Trash2 } from 'lucide-react'
import { departmentOption } from '../admin-org/names'
import { SelectField } from '../admin-org/select-field'
import { Button } from '../form/button'
import type { ReviewerValue } from './model'
import type { DepartmentOption, PositionOption, WorkflowWords } from './words'

// Who reviews under a rule (BR-WF-08): a position held in a department — looked for from that department up to the
// root — chosen from the organization's positions and departments; a named member kept from an older version can be
// removed but not added (WF_LINT_MEMBER_REVIEWER). The fallback holds the slot when the reviewer is vacant or conflicts
// with the request; without one the rule is sent with a warning to tick (WF_LINT_NO_FALLBACK).

export interface ReviewerPickerProps {
  readonly id: string
  readonly legend: string
  readonly value: ReviewerValue
  readonly onChange: (value: ReviewerValue) => void
  readonly positions: readonly PositionOption[]
  readonly departments: readonly DepartmentOption[]
  readonly words: WorkflowWords
  readonly error?: string
}

/** One reviewer: a position and the department it is looked for from, or a named member shown as it is */
export function ReviewerPicker({ id, legend, value, onChange, positions, departments, words, error }: ReviewerPickerProps) {
  const { t, locale } = words
  if (value.kind === 'MEMBER') {
    return (
      <div className="flex flex-col gap-1">
        <p className="font-medium">{legend}</p>
        <p>{words.reviewer(value)}</p>
        <p className="text-base text-ink-muted md:text-sm">{t('memberReviewerHint')}</p>
      </div>
    )
  }
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="mb-1 font-medium">{legend}</legend>
      <div className="grid gap-3 md:grid-cols-2">
        <SelectField
          id={`${id}-position`}
          label={t('reviewerPositionLabel')}
          placeholder={t('choose')}
          value={value.position}
          onChange={(ev) => onChange({ ...value, position: ev.currentTarget.value })}
          options={positions.map((p) => ({ value: p.code, label: words.position(p.code) }))}
          error={error && !value.position ? error : undefined}
        />
        <SelectField
          id={`${id}-department`}
          label={t('reviewerDepartmentLabel')}
          hint={t('reviewerDepartmentHint')}
          placeholder={t('choose')}
          value={value.department}
          onChange={(ev) => onChange({ ...value, department: ev.currentTarget.value })}
          options={departments.map((d) => ({ value: d.code, label: departmentOption(locale, d) }))}
          error={error && !value.department ? error : undefined}
        />
      </div>
    </fieldset>
  )
}

export interface ReviewerListProps {
  readonly id: string
  readonly reviewers: readonly ReviewerValue[]
  readonly onChange: (reviewers: readonly ReviewerValue[]) => void
  readonly positions: readonly PositionOption[]
  readonly departments: readonly DepartmentOption[]
  readonly words: WorkflowWords
  readonly error?: string
  /** The error is about a reviewer left without a position or department: mark those fields */
  readonly incomplete?: boolean
}

export function ReviewerList({ id, reviewers, onChange, positions, departments, words, error, incomplete: markMissing }: ReviewerListProps) {
  const { t } = words
  const incomplete = markMissing ? t('reviewerMissing') : undefined
  return (
    <div className="flex flex-col gap-3" aria-describedby={error ? `${id}-error` : undefined}>
      <ol className="flex flex-col gap-3">
        {reviewers.map((r, i) => (
          <li key={i} className="flex flex-col gap-2 border-l-2 border-line pl-3">
            <ReviewerPicker
              id={`${id}-${i}`}
              legend={t('reviewerN', { n: i + 1 })}
              value={r}
              onChange={(value) => onChange(reviewers.map((x, j) => (j === i ? value : x)))}
              positions={positions}
              departments={departments}
              words={words}
              error={incomplete}
            />
            {reviewers.length > 1 ? (
              <Button variant="secondary" className="self-start" aria-label={t('removeReviewerNamed', { n: i + 1 })} onClick={() => onChange(reviewers.filter((_, j) => j !== i))}>
                <Trash2 className="size-4 shrink-0" aria-hidden="true" />
                {t('removeReviewer')}
              </Button>
            ) : null}
          </li>
        ))}
      </ol>
      {error ? (
        <p id={`${id}-error`} className="text-base text-danger md:text-sm">
          {error}
        </p>
      ) : null}
      <Button variant="secondary" className="self-start" onClick={() => onChange([...reviewers, { kind: 'POSITION_AT', position: '', department: '' }])}>
        <CirclePlus className="size-4 shrink-0" aria-hidden="true" />
        {t('addReviewer')}
      </Button>
    </div>
  )
}
