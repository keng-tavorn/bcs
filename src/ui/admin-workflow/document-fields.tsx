'use client'

import { SelectField } from '../admin-org/select-field'
import { Field } from '../form/field'
import type { DocumentDraft, DocumentField } from './model'
import type { WorkflowContext, WorkflowWords } from './words'

// What the engine reads of a request (BR-WF-07), for a document of the dry-run or of a test case: the request type,
// the amount with VAT (and before VAT when it differs), the line categories, the account codes of the budget lines and
// the answers of the form's fields that have options. Money is typed as baht and checked to two decimals.

export interface DocumentFieldsProps {
  readonly id: string
  readonly draft: DocumentDraft
  readonly onChange: (draft: DocumentDraft) => void
  readonly errors: Partial<Record<DocumentField, 'REQUIRED' | 'MONEY' | 'NET_ABOVE_GROSS'>>
  readonly context: WorkflowContext
  readonly words: WorkflowWords
  readonly categoryCodes: readonly string[]
  readonly accountCodes: readonly string[]
}

export function DocumentFields({ id, draft, onChange, errors, context, words, categoryCodes, accountCodes }: DocumentFieldsProps) {
  const { t } = words
  const type = context.requestTypes.find((r) => r.code === draft.requestType)
  const choiceFields = (type?.fields ?? []).filter((f) => f.options.length > 0)
  const error = (f: DocumentField) => (errors[f] ? t(`documentErrors.${errors[f]}`) : undefined)
  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-4 md:grid-cols-3">
        <SelectField
          id={`${id}-type`}
          label={t('document.requestType')}
          placeholder={t('choose')}
          value={draft.requestType}
          onChange={(ev) => onChange({ ...draft, requestType: ev.currentTarget.value, fields: {} })}
          options={context.requestTypes.map((r) => ({ value: r.code, label: words.requestType(r.code) }))}
          error={error('requestType')}
        />
        <Field
          id={`${id}-gross`}
          label={t('document.amountGross')}
          hint={t('moneyHint')}
          inputMode="decimal"
          value={draft.amountGross}
          onChange={(ev) => onChange({ ...draft, amountGross: ev.currentTarget.value })}
          error={error('amountGross')}
          className="money"
        />
        <Field
          id={`${id}-net`}
          label={t('document.amountNet')}
          hint={t('document.amountNetHint')}
          inputMode="decimal"
          value={draft.amountNet}
          onChange={(ev) => onChange({ ...draft, amountNet: ev.currentTarget.value })}
          error={error('amountNet')}
          className="money"
        />
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        <Field
          id={`${id}-categories`}
          label={t('document.lineCategories')}
          hint={categoryCodes.length ? t('codesHintKnown', { codes: categoryCodes.join(', ') }) : t('codesHint')}
          value={draft.lineCategories}
          onChange={(ev) => onChange({ ...draft, lineCategories: ev.currentTarget.value })}
        />
        <Field
          id={`${id}-accounts`}
          label={t('document.budgetAccountCodes')}
          hint={accountCodes.length ? t('codesHintKnown', { codes: accountCodes.join(', ') }) : t('codesHint')}
          value={draft.budgetAccountCodes}
          onChange={(ev) => onChange({ ...draft, budgetAccountCodes: ev.currentTarget.value })}
        />
      </div>
      {choiceFields.length ? (
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 font-medium">{t('document.answers')}</legend>
          <div className="grid gap-4 md:grid-cols-2">
            {choiceFields.map((f) => (
              <SelectField
                key={f.id}
                id={`${id}-field-${f.id}`}
                label={words.field(f.id)}
                placeholder={t('document.notAnswered')}
                value={draft.fields[f.id] ?? ''}
                onChange={(ev) => onChange({ ...draft, fields: { ...draft.fields, [f.id]: ev.currentTarget.value } })}
                options={f.options.map((o) => ({ value: o.value, label: words.optionText(f.id, o.value) }))}
              />
            ))}
          </div>
        </fieldset>
      ) : null}
    </div>
  )
}
