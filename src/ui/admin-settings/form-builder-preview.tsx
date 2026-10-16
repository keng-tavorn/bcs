'use client'

import { useLocale, useTranslations } from 'next-intl'
import { useId, useState } from 'react'
import { markMoneyFields, type FormInput } from '@/core/forms'
import { satangOf } from '@/core/forms/money-text'
import { Field } from '../form/field'
import { FieldInput } from '../request-form/field-input'
import { applicableRules, visibleFieldIds } from '../request-form/model'
import { plainMoney } from '../request-form/money'
import { RequirementList } from '../request-form/rule-text'
import type { FormDefinition, ScreenLocale } from '../request-form/types'
import { useKindLabel } from './form-builder-dialogs'
import type { BuilderForm } from './form-builder-model'

// "ตัวอย่างฟอร์ม" (S6-14 · FR-INT-104 AC2): the draft as the requester will see it, drawn with the request form's own
// field components and its own rules (core/forms), before anything is published. The admin may answer the questions and
// try an amount to see the questions a condition shows and the files a rule then asks for; nothing here is saved.

/** The form as the request page reads it: comparisons on fields of type money marked, as the server marks them */
function definitionOf(form: BuilderForm): FormDefinition {
  const money = new Set(form.fields.filter((f) => f.type === 'money').map((f) => f.id))
  return {
    fields: form.fields,
    visibility: form.visibility.map((v) => ({ ...v, when: markMoneyFields(v.when, money) })),
    rules: form.rules.map((r) => ({ ...r, when: markMoneyFields(r.when, money), require: markMoneyFields(r.require, money) })),
    lines: form.lines,
    ...(form.steps ? { steps: form.steps } : {}),
  }
}

export function FormPreview({ form, requestTypeCode }: { form: BuilderForm; requestTypeCode: string }) {
  const t = useTranslations('formBuilder.preview')
  const locale = useLocale() as ScreenLocale
  const kindLabel = useKindLabel()
  const id = useId()
  const [values, setValues] = useState<Record<string, unknown>>({})
  const [amount, setAmount] = useState('')
  const definition = definitionOf(form)
  const satang = satangOf(plainMoney(amount)) ?? 0n
  const input: FormInput = { fields: values, attachments: {}, variables: { $amountGross: satang, $amountNet: satang, $requestType: requestTypeCode } }
  const visible = visibleFieldIds(definition, input)
  const rules = applicableRules(definition, input)

  return (
    <div className="flex flex-col gap-5">
      <p className="text-ink-muted">{t('intro')}</p>
      <Field id={`${id}-amount`} label={t('amount')} hint={t('amountHint')} inputMode="decimal" className="tabular text-right" value={amount} onChange={(e) => setAmount(e.currentTarget.value)} />
      <div className="flex flex-col gap-4 border-t border-line pt-4">
        {form.fields.length === 0 ? <p className="text-ink-muted">{t('noFields')}</p> : null}
        {form.fields
          .filter((def) => visible.has(def.id))
          .map((def) => (
            <FieldInput key={def.id} def={def} value={values[def.id]} locale={locale} onChange={(value) => setValues((v) => ({ ...v, [def.id]: value }))} />
          ))}
        {form.fields.length > visible.size ? <p className="text-base text-ink-muted md:text-sm">{t('hidden', { count: form.fields.length - visible.size })}</p> : null}
      </div>
      <section aria-labelledby={`${id}-rules`} className="flex flex-col gap-2 border-t border-line pt-4">
        <h3 id={`${id}-rules`} className="font-semibold">
          {t('rulesTitle')}
        </h3>
        {rules.length ? (
          <ul className="flex flex-col gap-3">
            {rules.map((rule) => (
              <li key={rule.id} className="flex flex-col gap-1">
                <p className="font-medium">{rule.id}</p>
                <RequirementList requirement={rule.require} input={input} fields={form.fields} locale={locale} kindLabel={kindLabel} ruleMet={rule.met} />
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-ink-muted">{t('noRules')}</p>
        )}
      </section>
    </div>
  )
}
