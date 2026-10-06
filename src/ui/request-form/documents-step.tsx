'use client'

import { CircleAlert, CircleCheck, Plus } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { useState } from 'react'
import { v4 as uuidv4 } from 'uuid'
import type { Satang } from '@/core/money/math'
import { REASON_MAX_LENGTH } from '@/lib/constants'
import { Button } from '../form/button'
import { Notice } from '../form/notice'
import { ConfirmRemove } from './confirm-remove'
import { checkboxClass, describedBy, inputClass, Labelled, textareaClass } from './controls'
import type { StepProps } from './details-items'
import { documentFieldIds } from './document-fields'
import { FieldInput } from './field-input'
import { savableQuotation, validMoney, visibleInput, type FormQuotation, type RuleStatus } from './model'
import { showSatang } from './money'
import { MoneyInput } from './money-input'
import { SuggestedSupplierField } from './place-supplier'
import { conditionText, RequirementList } from './rule-text'
import type { Attachment } from './types'
import { UploadButton, type UploadActions } from './upload-button'

// Step 3 (FR-INT-005, BR-FORM-03 to BR-FORM-06): the attachments the rules ask for at the current amount and answers,
// with the questions those rules ask to be answered (the single-source reason of ATT-QUOTES, ./document-fields.ts), the
// supplier the requester suggests from the register (optional, S4-02), the quotations as data — supplier, amount,
// whether it includes VAT, its file — compared before VAT as they are typed, with a reason when the chosen one is not
// the lowest, and the other files of the request, each of a kind.

/** A request carries at most this many quotations (the service's limit) */
const MAX_QUOTATIONS = 20

const blank = (v: unknown) => v === undefined || v === null || (typeof v === 'string' && v.trim() === '') || (Array.isArray(v) && v.length === 0)

export interface DocumentsProps extends StepProps {
  readonly rules: readonly RuleStatus[]
  /** Price before VAT of each complete quotation, by key, and the keys of the lowest (core/forms compareQuotations) */
  readonly nets: Readonly<Record<string, Satang>>
  readonly lowest: readonly string[]
  readonly attachments: readonly Attachment[]
  readonly uploads: UploadActions
  readonly onAttach: (file: { fileId: string; fileName: string }, kind: string) => Promise<void>
  readonly onDetach: (fileId: string) => Promise<void>
  readonly onOpenFile: (fileId: string) => void
  /** Why the last attach or detach failed */
  readonly fileError: string | null
  readonly busy: boolean
}

export function kindLabelOf(t: ReturnType<typeof useTranslations<'requestForm'>>, kind: string): string {
  switch (kind) {
    case 'QUOTATION':
    case 'DELIVERY_NOTE':
    case 'PHOTO':
    case 'JUSTIFICATION':
    case 'INVOICE':
    case 'PO_PDF':
    case 'DPA':
    case 'ETAX':
    case 'REGISTRY_PROOF':
    case 'OTHER':
      return t(`kinds.${kind}`)
    default:
      return kind
  }
}

export function DocumentsStep(props: DocumentsProps) {
  const t = useTranslations('requestForm')
  const tr = useTranslations('requestForm.rules')
  const { data, input, locale, rules, values, update, visible, showErrors, fieldErrors } = props
  const kindLabel = (kind: string) => kindLabelOf(t, kind)
  const shown = visibleInput(data.form, input)
  // The questions the rules ask to be answered, asked here under the rules rather than with the details
  // (./document-fields.ts): the single-source reason of ATT-QUOTES beside the rule that takes it
  const documentFields = documentFieldIds(data.form.rules)
  const asked = data.form.fields.filter((f) => visible.has(f.id) && documentFields.has(f.id))
  return (
    <div className="flex flex-col gap-10">
      <section aria-labelledby="required-documents" className="flex flex-col gap-3">
        <h3 id="required-documents" className="subheading font-semibold">
          {t('documents.requiredTitle')}
        </h3>
        {rules.length === 0 ? (
          <p className="text-ink-muted">{t('documents.noneRequired')}</p>
        ) : (
          <ul className="flex flex-col divide-y divide-line border-y border-line">
            {rules.map((rule) => (
              <li key={rule.id} className="flex flex-col gap-2 py-3" data-rule={rule.id}>
                <p className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <span className="font-semibold">{t('documents.rule', { rule: rule.id })}</span>
                  {rule.met ? (
                    <span className="inline-flex items-center gap-1 text-primary">
                      <CircleCheck className="size-4" aria-hidden="true" />
                      {t('documents.met')}
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1 text-danger">
                      <CircleAlert className="size-4" aria-hidden="true" />
                      {t('documents.notMet')}
                    </span>
                  )}
                </p>
                <p className="text-ink-muted">{t('documents.because', { condition: conditionText(rule.when, data.form.fields, locale, tr) })}</p>
                <RequirementList requirement={rule.require} input={shown} fields={data.form.fields} locale={locale} kindLabel={kindLabel} ruleMet={rule.met} />
              </li>
            ))}
          </ul>
        )}
        {asked.map((def) => (
          <FieldInput
            key={def.id}
            def={def}
            locale={locale}
            value={values.fields[def.id]}
            onChange={(value) => update({ type: 'field', id: def.id, value })}
            error={fieldErrors[def.id] ?? (showErrors && def.required && blank(values.fields[def.id]) ? t('fields.missing') : undefined)}
          />
        ))}
      </section>
      {data.type.documentType === 'PURCHASE_REQUEST' ? (
        <>
          {/* Optional: the requester's suggestion; PROCUREMENT chooses the supplier of each line (FR-P2P-001 AC2) */}
          <SuggestedSupplierField {...props} />
          <Quotations {...props} />
        </>
      ) : null}
      <OtherFiles {...props} kindLabel={kindLabel} />
    </div>
  )
}

function Quotations(props: DocumentsProps) {
  const t = useTranslations('requestForm.quotations')
  const tf = useTranslations('requestForm.fields')
  const tFiles = useTranslations('requestForm.files')
  const { values, update, nets, lowest, showErrors } = props
  const chosen = values.quotations.find((q) => q.selected && savableQuotation(q))
  const needsReason = Boolean(chosen && lowest.length && !lowest.includes(chosen.key))
  const reasonError = needsReason && showErrors && !values.nonLowestQuoteReason.trim() ? t('reasonMissing') : undefined
  return (
    <section aria-labelledby="quotations" className="flex flex-col gap-4">
      <h3 id="quotations" className="subheading font-semibold">
        {t('title')}
      </h3>
      <p className="text-ink-muted">{t('intro')}</p>
      <p className="text-base text-ink-muted md:text-sm">{tFiles('rule')}</p>
      {values.quotations.length === 0 ? (
        <p>{t('empty')}</p>
      ) : (
        <ol className="flex flex-col divide-y divide-line border-y border-line">
          {values.quotations.map((q, i) => (
            <li key={q.key} className="py-5">
              <QuotationFields {...props} q={q} n={i + 1} net={nets[q.key]} isLowest={lowest.includes(q.key)} />
            </li>
          ))}
        </ol>
      )}
      <Button variant="secondary" className="self-start" disabled={values.quotations.length >= MAX_QUOTATIONS} onClick={() => update({ type: 'addQuotation', key: uuidv4() })}>
        <Plus className="size-4" aria-hidden="true" />
        {t('add')}
      </Button>
      {needsReason ? (
        <Labelled id="non-lowest-reason" label={t('reason')} requiredText={tf('required')} hint={t('reasonHint')} error={reasonError}>
          <textarea
            id="non-lowest-reason"
            className={textareaClass}
            value={values.nonLowestQuoteReason}
            maxLength={REASON_MAX_LENGTH}
            required
            aria-required
            aria-invalid={reasonError ? true : undefined}
            aria-describedby={describedBy('non-lowest-reason', true, Boolean(reasonError))}
            onChange={(e) => update({ type: 'reason', value: e.currentTarget.value })}
          />
        </Labelled>
      ) : null}
    </section>
  )
}

function QuotationFields({ q, n, net, isLowest, update, uploads, onOpenFile, showErrors, busy }: DocumentsProps & { q: FormQuotation; n: number; net: Satang | undefined; isLowest: boolean }) {
  const t = useTranslations('requestForm.quotations')
  const tf = useTranslations('requestForm.fields')
  const p = `quote-${n}`
  const set = (patch: Partial<Omit<FormQuotation, 'key' | 'selected'>>) => update({ type: 'quotation', key: q.key, patch })
  const errors = {
    supplier: showErrors && !q.supplierName.trim() ? t('supplierMissing') : undefined,
    amount: q.amount.trim() && !validMoney(q.amount) ? t('amountInvalid') : showErrors && !q.amount.trim() ? t('amountMissing') : undefined,
    file: showErrors && !q.fileId ? t('fileMissing') : undefined,
  }
  return (
    <fieldset className="flex min-w-0 flex-col gap-4">
      <legend className="mb-1 subheading font-semibold">{t('item', { n })}</legend>
      <Labelled id={`${p}-supplier`} label={t('supplier')} requiredText={tf('required')} error={errors.supplier}>
        <input
          id={`${p}-supplier`}
          className={inputClass}
          value={q.supplierName}
          maxLength={200}
          required
          aria-required
          aria-invalid={errors.supplier ? true : undefined}
          aria-describedby={describedBy(`${p}-supplier`, false, Boolean(errors.supplier))}
          onChange={(e) => set({ supplierName: e.currentTarget.value })}
        />
      </Labelled>
      <div className="grid gap-3 sm:grid-cols-2 sm:items-end">
        <Labelled id={`${p}-amount`} label={t('amount')} requiredText={tf('required')} error={errors.amount}>
          <MoneyInput
            id={`${p}-amount`}
            className={`${inputClass} tabular text-right`}
            value={q.amount}
            required
            aria-required
            aria-invalid={errors.amount ? true : undefined}
            aria-describedby={describedBy(`${p}-amount`, false, Boolean(errors.amount))}
            onChange={(e) => set({ amount: e.currentTarget.value })}
          />
        </Labelled>
        <label className="flex min-h-11 items-center gap-3">
          <input type="checkbox" className={checkboxClass} checked={q.includesVat} onChange={(e) => set({ includesVat: e.currentTarget.checked })} />
          <span>{t('includesVat')}</span>
        </label>
      </div>
      <div className="flex flex-col gap-2">
        {q.fileId ? (
          <p className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span>{t('file', { name: q.fileName ?? '' })}</span>
            {/* A link to look at, still a 44 px touch target on a phone (NFR-A11Y-02, §9.4) */}
            <Button variant="link" className="min-h-11" onClick={() => onOpenFile(q.fileId!)}>
              {t('openFile', { n })}
            </Button>
          </p>
        ) : null}
        <UploadButton
          label={q.fileId ? t('replaceFile', { n }) : t('attachFile', { n })}
          actions={uploads}
          disabled={busy}
          showRule={false}
          onUploaded={(f) => set({ fileId: f.fileId, fileName: f.fileName })}
        />
        {errors.file ? (
          <p className="flex items-start gap-1.5 text-base text-danger md:text-sm">
            <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            <span>{errors.file}</span>
          </p>
        ) : null}
      </div>
      <label className="flex min-h-11 items-center gap-3">
        <input type="radio" name="chosen-quotation" className={checkboxClass} checked={q.selected} onChange={() => update({ type: 'selectQuotation', key: q.key })} />
        <span>{t('choose', { n })}</span>
      </label>
      <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
        <ConfirmRemove
          label={t('remove', { n })}
          question={t('removeQuestion', { n })}
          // The file of a quotation comes and goes with it (BR-FORM-06)
          detail={q.fileId ? t('removeWithFile', { name: q.fileName ?? '' }) : undefined}
          confirmLabel={t('removeConfirm')}
          keepLabel={t('removeKeep')}
          onConfirm={() => update({ type: 'removeQuotation', key: q.key })}
        />
        <div className="ml-auto flex flex-col items-end">
          {net !== undefined ? <p className="money">{t('net', { amount: showSatang(net) })}</p> : <p className="text-ink-muted">{t('netPending')}</p>}
          {isLowest ? (
            <p className="inline-flex items-center gap-1 font-medium text-primary">
              <CircleCheck className="size-4" aria-hidden="true" />
              {t('lowest')}
            </p>
          ) : null}
        </div>
      </div>
    </fieldset>
  )
}

function OtherFiles({ data, rules, attachments, uploads, onAttach, onDetach, onOpenFile, fileError, busy, kindLabel }: DocumentsProps & { kindLabel: (kind: string) => string }) {
  const t = useTranslations('requestForm.attachments')
  // The kind most needed now comes first: a rule not met that asks for a kind the requester attaches one by one
  const wanted = rules.filter((r) => !r.met).flatMap((r) => kindsIn(r.require)).find((k) => data.attachmentKinds.includes(k))
  const [kind, setKind] = useState<string>(wanted ?? (data.attachmentKinds.includes('OTHER') ? 'OTHER' : (data.attachmentKinds[0] ?? 'OTHER')))
  return (
    <section aria-labelledby="other-files" className="flex flex-col gap-4">
      <h3 id="other-files" className="subheading font-semibold">
        {t('title')}
      </h3>
      <p className="text-ink-muted">{t('intro')}</p>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
        <Labelled id="attachment-kind" label={t('kind')} className="sm:w-72">
          <select id="attachment-kind" className={inputClass} value={kind} onChange={(e) => setKind(e.currentTarget.value)}>
            {data.attachmentKinds.map((k) => (
              <option key={k} value={k}>
                {kindLabel(k)}
              </option>
            ))}
          </select>
        </Labelled>
        <UploadButton className="sm:pt-8" label={t('upload', { kind: kindLabel(kind) })} actions={uploads} disabled={busy} onUploaded={(f) => onAttach(f, kind)} />
      </div>
      {fileError ? <Notice tone="danger">{fileError}</Notice> : null}
      {attachments.length === 0 ? (
        <p className="text-ink-muted">{t('empty')}</p>
      ) : (
        <ul className="flex flex-col divide-y divide-line border-y border-line">
          {attachments.map((a) => (
            <li key={a.fileId} className="flex flex-col gap-2 py-3">
              <p className="min-w-0 break-words">
                <span className="font-medium">{a.fileName}</span>
                <span className="text-ink-muted"> · {kindLabel(a.kind)}</span>
              </p>
              {/* Opening is a link at the start; taking the file off is a danger button at the far end, asked first */}
              <div className="flex flex-wrap items-start justify-between gap-x-10 gap-y-3">
                <Button variant="link" className="min-h-11" onClick={() => onOpenFile(a.fileId)}>
                  {t('open', { name: a.fileName })}
                </Button>
                <ConfirmRemove
                  className="sm:ml-auto"
                  label={t('remove', { name: a.fileName })}
                  question={t('removeQuestion', { name: a.fileName })}
                  confirmLabel={t('removeConfirm')}
                  keepLabel={t('removeKeep')}
                  disabled={busy}
                  onConfirm={() => void onDetach(a.fileId)}
                />
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

function kindsIn(requirement: RuleStatus['require']): string[] {
  if ('attachments' in requirement) return [requirement.attachments]
  if ('all' in requirement) return requirement.all.flatMap(kindsIn)
  if ('any' in requirement) return requirement.any.flatMap(kindsIn)
  return []
}
