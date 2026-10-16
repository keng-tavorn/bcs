'use client'

import { CirclePlus, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { SelectField } from '../admin-org/select-field'
import { Button } from '../form/button'
import { Field } from '../form/field'
import { Notice } from '../form/notice'
import { OPS_BY_KIND, SET_VARIABLES, VARIABLES, emptyRow, fieldKind, isListOp, takesValue, type ConditionDraft, type ConditionRow, type FieldKind, type Op, type RowError } from './model'
import type { FormField, WorkflowWords } from './words'

// The condition of a reviewer rule as rows (FR-WF-103 AC1, BR-WF-07): each row is a field — a variable of the request
// or a field of the forms of the rule's types — how it compares, and the value; the rows are joined by "all" or "any".
// No rows: every request of the rule's types. A list (in, anyIn) is ticked from the field's options, or typed as codes
// split by commas. A stored condition with groups inside groups is kept as it is until replaced. No dragging (NG-4).

export interface ConditionBuilderProps {
  readonly id: string
  readonly draft: ConditionDraft
  readonly onChange: (draft: ConditionDraft) => void
  /** The fields of the forms of the rule's request types */
  readonly fields: readonly FormField[]
  /** The request types the $requestType rows choose from */
  readonly requestTypes: ReadonlyArray<{ readonly code: string; readonly label: string }>
  readonly rowErrors: Readonly<Record<number, RowError>>
  readonly categoryCodes: readonly string[]
  readonly accountCodes: readonly string[]
  readonly words: WorkflowWords
}

/** Codes typed with commas: the text stays as typed, the list follows it */
function CodesField({ id, label, hint, values, onValues, error }: { id: string; label: string; hint: string; values: readonly string[]; onValues: (values: string[]) => void; error?: string }) {
  const [text, setText] = useState(values.join(', '))
  return (
    <Field
      id={id}
      label={label}
      hint={hint}
      value={text}
      onChange={(ev) => {
        const next = ev.currentTarget.value
        setText(next)
        onValues([...new Set(next.split(/[,\s]+/).map((c) => c.trim()).filter((c) => c !== ''))])
      }}
      error={error}
    />
  )
}

export function ConditionBuilder({ id, draft, onChange, fields, requestTypes, rowErrors, categoryCodes, accountCodes, words }: ConditionBuilderProps) {
  const { t } = words
  const kindOf = (field: string): FieldKind => fieldKind(field, fields.find((f) => f.id === field))
  const setRow = (i: number, change: Partial<ConditionRow>) => onChange({ ...draft, rows: draft.rows.map((r, j) => (j === i ? { ...r, ...change } : r)) })
  const fieldOptions = [...VARIABLES.map((v) => ({ value: v, label: words.field(v) })), ...fields.map((f) => ({ value: f.id, label: t('formFieldOption', { label: words.field(f.id) }) }))]
  const optionsOf = (field: string) =>
    field === '$requestType' ? requestTypes.map((r) => ({ value: r.code, label: r.label })) : (fields.find((f) => f.id === field)?.options ?? []).map((o) => ({ value: o.value, label: words.optionText(field, o.value) }))
  const rowError = (i: number) => (rowErrors[i] ? t(`rowErrors.${rowErrors[i]}`) : undefined)

  if (draft.nested) {
    return (
      <div className="flex flex-col gap-3">
        <Notice tone="info">{t('conditionNestedHint')}</Notice>
        <Button variant="secondary" className="self-start" onClick={() => onChange({ join: 'all', rows: [], nested: null })}>
          {t('conditionReplace')}
        </Button>
      </div>
    )
  }

  const valueControl = (row: ConditionRow, i: number) => {
    if (!row.op || !takesValue(row.op)) return null
    const kind = kindOf(row.field)
    const error = rowError(i)
    const valueId = `${id}-row${i}-value`
    if (isListOp(row.op)) {
      const options = optionsOf(row.field)
      if (options.length) {
        return (
          <fieldset className="flex flex-col gap-1">
            <legend className="mb-1 font-medium">{t('conditionValues')}</legend>
            <div className="grid gap-x-6 sm:grid-cols-2">
              {options.map((o) => (
                <label key={o.value} className="flex min-h-11 items-center gap-3">
                  <input
                    type="checkbox"
                    checked={row.values.includes(o.value)}
                    onChange={(ev) => {
                      const checked = ev.currentTarget.checked
                      setRow(i, { values: checked ? [...row.values, o.value] : row.values.filter((v) => v !== o.value) })
                    }}
                    className="size-5 shrink-0"
                  />
                  <span>{o.label}</span>
                </label>
              ))}
            </div>
            {error ? <p className="text-base text-danger md:text-sm">{error}</p> : null}
          </fieldset>
        )
      }
      const known = row.field === '$lineCategories' ? categoryCodes : row.field === '$budgetAccountCodes' ? accountCodes : []
      return (
        <CodesField
          key={`${row.field}-${row.op}`}
          id={valueId}
          label={t('conditionValues')}
          hint={known.length ? t('codesHintKnown', { codes: known.join(', ') }) : t('codesHint')}
          values={row.values}
          onValues={(values) => setRow(i, { values })}
          error={error}
        />
      )
    }
    const options = optionsOf(row.field)
    if (options.length && kind !== 'money') {
      return <SelectField id={valueId} label={t('conditionValue')} placeholder={t('choose')} value={row.value} onChange={(ev) => setRow(i, { value: ev.currentTarget.value })} options={options} error={error} />
    }
    return (
      <Field
        id={valueId}
        label={kind === 'money' ? t('conditionAmount') : t('conditionValue')}
        hint={kind === 'money' ? t('moneyHint') : undefined}
        inputMode={kind === 'money' ? 'decimal' : undefined}
        value={row.value}
        onChange={(ev) => setRow(i, { value: ev.currentTarget.value })}
        error={error}
        className={kind === 'money' ? 'money' : undefined}
      />
    )
  }

  return (
    <div className="flex flex-col gap-3">
      {draft.rows.length === 0 ? <p className="text-ink-muted">{t('conditionNone')}</p> : null}
      {draft.rows.length > 1 ? (
        <fieldset className="flex flex-col gap-1">
          <legend className="mb-1 font-medium">{t('joinLabel')}</legend>
          {(['all', 'any'] as const).map((join) => (
            <label key={join} className="flex min-h-11 items-center gap-3">
              <input type="radio" name={`${id}-join`} checked={draft.join === join} onChange={() => onChange({ ...draft, join })} className="size-5 shrink-0" />
              <span>{t(`join.${join}`)}</span>
            </label>
          ))}
        </fieldset>
      ) : null}
      <ol className="flex flex-col gap-3">
        {draft.rows.map((row, i) => {
          const ops = row.field ? OPS_BY_KIND[kindOf(row.field)] : []
          const error = rowErrors[i]
          return (
            <li key={i} className="flex flex-col gap-3 border-l-2 border-line pl-3">
              <fieldset className="flex flex-col gap-3">
                <legend className="mb-1 font-semibold">{t('conditionRow', { n: i + 1 })}</legend>
                <div className="grid gap-3 md:grid-cols-2">
                  <SelectField
                    id={`${id}-row${i}-field`}
                    label={t('conditionField')}
                    placeholder={t('choose')}
                    value={row.field}
                    onChange={(ev) => {
                      const field = ev.currentTarget.value
                      const first = field ? OPS_BY_KIND[kindOf(field)][0]! : ''
                      setRow(i, { field, op: first, value: '', values: [] })
                    }}
                    options={fieldOptions}
                    error={error === 'FIELD' ? t('rowErrors.FIELD') : undefined}
                  />
                  <SelectField
                    id={`${id}-row${i}-op`}
                    label={t('conditionOp')}
                    placeholder={t('choose')}
                    value={row.op}
                    disabled={!row.field}
                    onChange={(ev) => setRow(i, { op: ev.currentTarget.value as Op, value: '', values: [] })}
                    options={ops.map((op) => ({ value: op, label: t(`ops.${op}`) }))}
                    error={error === 'OP' ? t('rowErrors.OP') : undefined}
                  />
                </div>
                {error === 'FIELD' || error === 'OP' ? null : valueControl(row, i)}
                {SET_VARIABLES.includes(row.field) && row.op === 'anyIn' ? <p className="text-base text-ink-muted md:text-sm">{t('anyInHint')}</p> : null}
              </fieldset>
              <Button variant="secondary" className="self-start" aria-label={t('removeRowNamed', { n: i + 1 })} onClick={() => onChange({ ...draft, rows: draft.rows.filter((_, j) => j !== i) })}>
                <Trash2 className="size-4 shrink-0" aria-hidden="true" />
                {t('removeRow')}
              </Button>
            </li>
          )
        })}
      </ol>
      <Button variant="secondary" className="self-start" onClick={() => onChange({ ...draft, rows: [...draft.rows, emptyRow()] })}>
        <CirclePlus className="size-4 shrink-0" aria-hidden="true" />
        {t('addRow')}
      </Button>
    </div>
  )
}
