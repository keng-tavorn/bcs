'use client'

import { useTranslations } from 'next-intl'
import type { FormAction, FormValues } from '../../request-form/model'
import { showMoney } from '../../request-form/money'
import type { BudgetView, RequestFormData, ScreenLocale } from '../../request-form/types'
import { LiffNotice } from '../notice'
import { describedBy, inputClass } from './classes'
import { LiffField } from './field'
import { LiffLabelled } from './labelled'

// Step 1 of the LIFF request form (FR-INT-002, FR-INT-003, FR-INT-004 AC1): the title, the budget line the form opened
// with (BR-FORM-02: the line the requester used last for this type, or their department's only line; only their own or
// granted lines, BR-BUD-04) with the department that pays and what is left on it (only that line, budget.view
// SELECTED_LINE_ONLY), then the questions of the request type shown or hidden as the requester answers (BR-FORM-01). The
// same values, rules and words as the workspace's details step (src/ui/request-form/details-items.tsx), drawn lean for
// the first screen of LIFF (§9.4).

export interface LiffDetailsProps {
  readonly data: RequestFormData
  readonly values: FormValues
  readonly update: (action: FormAction) => void
  readonly locale: ScreenLocale
  readonly visible: ReadonlySet<string>
  /** Show what is still missing (after the requester reached the last step or tried to send) */
  readonly showErrors: boolean
  /** The chosen line's balance as the server last sent it */
  readonly budget: BudgetView | null
  readonly previewLoading: boolean
  /** Errors the server reported for fields of the form (by field id) */
  readonly fieldErrors: Readonly<Record<string, string>>
  /** The longest title the service takes */
  readonly titleMax: number
}

const blank = (v: unknown) => v === undefined || v === null || (typeof v === 'string' && v.trim() === '') || (Array.isArray(v) && v.length === 0)

export function LiffDetailsStep(props: LiffDetailsProps) {
  const t = useTranslations('requestForm')
  const { data, values, update, locale, visible, showErrors, fieldErrors } = props
  const titleError = showErrors && !values.title.trim() ? t('details.titleMissing') : undefined
  return (
    <div className="flex flex-col gap-6">
      <LiffLabelled id="request-title" label={t('details.title')} requiredText={t('fields.required')} hint={t('details.titleHint')} error={titleError}>
        <input
          id="request-title"
          name="title"
          className={inputClass}
          value={values.title}
          maxLength={props.titleMax}
          required
          aria-required
          aria-invalid={titleError ? true : undefined}
          aria-describedby={describedBy('request-title', true, Boolean(titleError))}
          onChange={(e) => update({ type: 'title', value: e.currentTarget.value })}
        />
      </LiffLabelled>
      {data.type.documentType === 'PURCHASE_REQUEST' ? <BudgetLineField {...props} /> : null}
      {data.form.fields
        .filter((f) => visible.has(f.id))
        .map((def) => (
          <LiffField
            key={def.id}
            def={def}
            locale={locale}
            value={values.fields[def.id]}
            onChange={(value) => update({ type: 'field', id: def.id, value })}
            error={fieldErrors[def.id] ?? (showErrors && def.required && blank(values.fields[def.id]) ? t('fields.missing') : undefined)}
          />
        ))}
    </div>
  )
}

function BudgetLineField({ data, values, update, showErrors, budget, previewLoading }: LiffDetailsProps) {
  const t = useTranslations('requestForm.budget')
  const tf = useTranslations('requestForm.fields')
  if (data.budgetLines.length === 0) return <LiffNotice tone="warning">{t('noLines')}</LiffNotice>
  const line = data.budgetLines.find((l) => l.id === values.budgetLineId) ?? null
  const error = showErrors && !line ? t('chooseMissing') : undefined
  const balance = line && budget?.kind === 'LINE' && budget.budgetLineId === line.id ? budget : null
  return (
    <div className="flex flex-col gap-3">
      <LiffLabelled id="budget-line" label={t('line')} requiredText={tf('required')} hint={t('lineHint')} error={error}>
        <select
          id="budget-line"
          name="budgetLineId"
          className={inputClass}
          value={values.budgetLineId}
          required
          aria-required
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy('budget-line', true, Boolean(error))}
          onChange={(e) => update({ type: 'budgetLine', value: e.currentTarget.value })}
        >
          <option value="">{t('choose')}</option>
          {data.budgetLines.map((l) => (
            <option key={l.id} value={l.id}>
              {l.granted ? t('optionGranted', { code: l.code, name: l.name, department: l.departmentName }) : t('option', { code: l.code, name: l.name })}
            </option>
          ))}
        </select>
      </LiffLabelled>
      <dl className="grid grid-cols-[minmax(0,auto)_minmax(0,1fr)] gap-x-4 gap-y-1">
        <dt className="text-ink-muted">{t('department')}</dt>
        <dd>{line?.departmentName ?? data.requesterDepartmentName ?? t('dash')}</dd>
        <dt className="text-ink-muted">{t('costCenter')}</dt>
        <dd>{line ? t('costCenterValue', { code: line.costCenterCode, name: line.costCenterName }) : t('dash')}</dd>
      </dl>
      {line ? (
        // What is left on the chosen line, as the server last said it (FR-INT-004 AC1); the amount it needs comes with the items
        <div aria-live="polite" className="grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-4 border-l-4 border-info bg-surface px-3 py-2">
          <span>{t('remaining')}</span>
          {balance ? (
            <span className="money font-semibold">{t('baht', { amount: showMoney(balance.available) })}</span>
          ) : (
            <span className="text-ink-muted">{budget?.kind === 'NOT_USABLE' ? t('notUsableShort') : previewLoading ? t('loading') : t('unknown')}</span>
          )}
        </div>
      ) : null}
    </div>
  )
}
