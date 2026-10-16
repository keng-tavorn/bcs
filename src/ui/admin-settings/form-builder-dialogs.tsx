'use client'

import { ChevronDown, CirclePlus, Trash2 } from 'lucide-react'
import { useLocale, useTranslations } from 'next-intl'
import { useId, useState } from 'react'
import type { AttachmentRule, Condition, Requirement } from '@/core/forms'
import type { FieldDef } from '@/core/forms/fields'
import { SelectField } from '../admin-org/select-field'
import { Button } from '../form/button'
import { Field } from '../form/field'
import { Notice } from '../form/notice'
import { conditionText } from '../request-form/rule-text'
import { fieldLabel, optionLabel } from '../request-form/field-input'
import type { ScreenLocale } from '../request-form/types'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '../shadcn/collapsible'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../shadcn/dialog'
import {
  ATTACHMENT_KINDS,
  FIELD_TYPES,
  OPS_BY_KIND,
  SPECIAL_FIELDS,
  checkFieldDraft,
  checkRows,
  checkRuleDraft,
  choicesOf,
  conditionOf,
  emptyFieldDraft,
  emptyOption,
  emptyRequirementRow,
  emptyRow,
  emptyRuleDraft,
  fieldDraftOf,
  fieldKind,
  isChoiceType,
  rowsOf,
  ruleDraftOf,
  takesValue,
  type ConditionRow,
  type FieldDraft,
  type FieldDraftError,
  type FieldDraftKey,
  type FieldType,
  type RequirementError,
  type RequirementRow,
  type RowError,
  type RuleDraft,
  type RuleDraftErrors,
} from './form-builder-model'

// The two Dialogs of the no-code form builder (S6-14 · FR-INT-104), opened by the admin's press only (NG-13): one
// question — its id, kind, words in Thai and English, whether it must be answered, the options of a choice, and the
// condition that shows it — and one attachment rule — its id, when it applies and the files it asks for. A dialog
// changes the draft on the page; nothing reaches the server until the draft is saved. Fewer than 8 inputs show at once:
// the hint and the condition open on a press (Collapsible), as each option's and each row's inputs are a group of their
// own. A stored condition with "any" or groups inside groups, or a requirement with either/or, is shown in words and kept
// unless replaced.

export type BuilderT = ReturnType<typeof useTranslations<'formBuilder'>>

/** The words of a condition, as the request form says it */
export function useConditionWords(fields: readonly FieldDef[]): (condition: Condition) => string {
  const tRules = useTranslations('requestForm.rules')
  const locale = useLocale() as ScreenLocale
  return (condition) => conditionText(condition, fields, locale, tRules)
}

/** The name of a kind of file in the reader's language */
export function useKindLabel(): (kind: string) => string {
  const t = useTranslations('formBuilder')
  return (kind) => ((ATTACHMENT_KINDS as readonly string[]).includes(kind) ? t(`kinds.${kind as (typeof ATTACHMENT_KINDS)[number]}`) : kind)
}

/** What a requirement asks for, in words: "ใบเสนอราคา อย่างน้อย 3 ไฟล์ หรือ …" */
export function requirementText(requirement: Requirement, t: BuilderT, kindLabel: (kind: string) => string, words: (c: Condition) => string): string {
  if ('attachments' in requirement) return t('requirementFiles', { kind: kindLabel(requirement.attachments), min: requirement.min })
  if ('all' in requirement) return requirement.all.map((r) => requirementText(r, t, kindLabel, words)).join(t('andJoin'))
  if ('any' in requirement) return requirement.any.map((r) => `(${requirementText(r, t, kindLabel, words)})`).join(t('orJoin'))
  return words(requirement)
}

function MoreSection({ title, children, defaultOpen = false }: { title: string; children: React.ReactNode; defaultOpen?: boolean }) {
  return (
    <Collapsible defaultOpen={defaultOpen} className="flex flex-col gap-3 border-t border-line pt-3">
      <CollapsibleTrigger className="group inline-flex min-h-11 items-center gap-2 self-start font-medium text-primary underline underline-offset-4 hover:no-underline">
        <ChevronDown className="size-4 shrink-0 transition-transform duration-150 group-data-[state=open]:rotate-180" aria-hidden="true" />
        {title}
      </CollapsibleTrigger>
      <CollapsibleContent className="flex flex-col gap-3">{children}</CollapsibleContent>
    </Collapsible>
  )
}

// ---------- condition rows ----------

export function ConditionRows({
  id,
  rows,
  onChange,
  fields,
  errors,
  noneText,
}: {
  id: string
  rows: readonly ConditionRow[]
  onChange: (rows: ConditionRow[]) => void
  /** The fields a row may read (the question itself is left out of its own condition) */
  fields: readonly FieldDef[]
  errors: Readonly<Record<number, RowError>>
  noneText: string
}) {
  const t = useTranslations('formBuilder')
  const tRules = useTranslations('requestForm.rules')
  const locale = useLocale() as ScreenLocale
  const setRow = (i: number, change: Partial<ConditionRow>) => onChange(rows.map((r, j) => (j === i ? { ...r, ...change } : r)))
  const special = (f: string) => (f === '$amountGross' ? tRules('amountGross') : f === '$amountNet' ? tRules('amountNet') : tRules('requestType'))
  const fieldOptions = [...SPECIAL_FIELDS.map((f) => ({ value: f, label: special(f) })), ...fields.map((f) => ({ value: f.id, label: t('fieldOption', { label: fieldLabel(f, locale), id: f.id }) }))]
  const rowError = (i: number, what: RowError) => (errors[i] === what ? t(`rowErrors.${what}`) : undefined)

  return (
    <div className="flex flex-col gap-3">
      {rows.length === 0 ? <p className="text-ink-muted">{noneText}</p> : null}
      {rows.length > 1 ? <p className="text-ink-muted">{t('allRowsHint')}</p> : null}
      <ol className="flex flex-col gap-3">
        {rows.map((row, i) => {
          const kind = row.field ? fieldKind(row.field, fields) : 'text'
          const choices = row.field ? choicesOf(row.field, fields) : []
          const def = fields.find((f) => f.id === row.field)
          const choiceLabel = (v: string) => (def?.type === 'checkbox' ? t(v === 'true' ? 'checked' : 'unchecked') : def ? optionLabel(def, v, locale) : v)
          const valueId = `${id}-r${i}-value`
          let value: React.ReactNode = null
          if (row.op && takesValue(row.op)) {
            if (row.op !== 'in' && choices.length) {
              value = <SelectField id={valueId} label={t('conditionValue')} placeholder={t('choose')} value={row.value} onChange={(e) => setRow(i, { value: e.currentTarget.value })} options={choices.map((c) => ({ value: c, label: choiceLabel(c) }))} error={rowError(i, 'VALUE')} />
            } else {
              value = (
                <Field
                  id={valueId}
                  label={row.op === 'in' ? t('conditionValues') : kind === 'money' ? t('conditionAmount') : t('conditionValue')}
                  hint={row.op === 'in' ? (choices.length ? t('valuesHintChoices', { list: choices.join(', ') }) : t('valuesHint')) : kind === 'money' ? t('moneyHint') : undefined}
                  inputMode={kind === 'money' || kind === 'number' ? 'decimal' : undefined}
                  value={row.value}
                  onChange={(e) => setRow(i, { value: e.currentTarget.value })}
                  error={rowError(i, 'VALUE') ?? rowError(i, 'MONEY')}
                />
              )
            }
          }
          return (
            <li key={i} className="flex flex-col gap-3 border-l-2 border-line pl-3">
              <fieldset className="flex min-w-0 flex-col gap-3">
                <legend className="mb-1 font-semibold">{t('conditionRow', { n: i + 1 })}</legend>
                <div className="grid gap-3 md:grid-cols-2">
                  <SelectField
                    id={`${id}-r${i}-field`}
                    label={t('conditionField')}
                    placeholder={t('choose')}
                    value={row.field}
                    onChange={(e) => {
                      const field = e.currentTarget.value
                      setRow(i, { field, op: field ? OPS_BY_KIND[fieldKind(field, fields)][0]! : '', value: '' })
                    }}
                    options={fieldOptions}
                    error={rowError(i, 'FIELD')}
                  />
                  <SelectField
                    id={`${id}-r${i}-op`}
                    label={t('conditionOp')}
                    placeholder={t('choose')}
                    value={row.op}
                    disabled={!row.field}
                    onChange={(e) => setRow(i, { op: e.currentTarget.value as ConditionRow['op'], value: '' })}
                    options={(row.field ? OPS_BY_KIND[kind] : []).map((op) => ({ value: op, label: t(`ops.${op}`) }))}
                    error={rowError(i, 'OP')}
                  />
                </div>
                {value}
              </fieldset>
              <Button variant="secondary" className="self-start" aria-label={t('removeRowNamed', { n: i + 1 })} onClick={() => onChange(rows.filter((_, j) => j !== i))}>
                <Trash2 className="size-4 shrink-0" aria-hidden="true" />
                {t('removeRow')}
              </Button>
            </li>
          )
        })}
      </ol>
      <Button variant="secondary" className="self-start" onClick={() => onChange([...rows, emptyRow()])}>
        <CirclePlus className="size-4 shrink-0" aria-hidden="true" />
        {t('addRow')}
      </Button>
    </div>
  )
}

/** A stored condition the rows cannot show: its words, and a press to start again with rows */
function KeptCondition({ text, onReplace }: { text: string; onReplace: () => void }) {
  const t = useTranslations('formBuilder')
  return (
    <div className="flex flex-col gap-3">
      <Notice tone="info">
        <p>{t('keptCondition')}</p>
        <p className="mt-1 font-medium break-words">{text}</p>
      </Notice>
      <Button variant="secondary" className="self-start" onClick={onReplace}>
        {t('replaceCondition')}
      </Button>
    </div>
  )
}

// ---------- one question ----------

export interface FieldDialogProps {
  readonly open: boolean
  /** The question edited, or null for a new one */
  readonly field: FieldDef | null
  /** The condition that shows it now */
  readonly visibility: Condition | null
  readonly fields: readonly FieldDef[]
  readonly onSave: (def: FieldDef, visibility: Condition | null, editing: string | null) => void
  readonly onClose: () => void
}

export function FieldDialog(props: FieldDialogProps) {
  // A fresh form every time it opens: the dialog's state lives in its body, which mounts with it
  return (
    <Dialog open={props.open} onOpenChange={(next) => (next ? null : props.onClose())}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto p-6 sm:max-w-2xl">{props.open ? <FieldForm {...props} /> : null}</DialogContent>
    </Dialog>
  )
}

function FieldForm({ field, visibility, fields, onSave, onClose }: FieldDialogProps) {
  const t = useTranslations('formBuilder')
  const tForms = useTranslations('adminSettings.forms')
  const words = useConditionWords(fields)
  const id = useId()
  const [draft, setDraft] = useState<FieldDraft>(() => (field ? fieldDraftOf(field) : emptyFieldDraft()))
  const [rows, setRows] = useState<ConditionRow[] | null>(() => (visibility ? rowsOf(visibility) : []))
  const [errors, setErrors] = useState<Partial<Record<FieldDraftKey, FieldDraftError>>>({})
  const [rowErrors, setRowErrors] = useState<Readonly<Record<number, RowError>>>({})
  const others = fields.filter((f) => f.id !== field?.id)
  const change = (patch: Partial<FieldDraft>) => {
    setDraft((d) => ({ ...d, ...patch }))
    setErrors((e) => {
      const next = { ...e }
      if ('id' in patch) delete next.id
      if ('labelTh' in patch || 'labelEn' in patch) delete next.label
      if ('helpTh' in patch || 'helpEn' in patch) delete next.help
      if ('options' in patch || 'type' in patch) delete next.options
      return next
    })
  }
  const error = (key: FieldDraftKey) => (errors[key] ? t(`fieldErrors.${errors[key]}`) : undefined)
  const setOption = (i: number, patch: Partial<FieldDraft['options'][number]>) => change({ options: draft.options.map((o, j) => (j === i ? { ...o, ...patch } : o)) })

  function save() {
    const checked = checkFieldDraft(draft, others.map((f) => f.id), field)
    const condition = rows ? checkRows(rows, others) : null
    setErrors(checked.ok ? {} : checked.errors)
    setRowErrors(condition && !condition.ok ? condition.errors : {})
    if (!checked.ok || (condition && !condition.ok)) return
    // No rows: the question always shows; a kept condition stays as stored
    const when = condition ? (condition.comparisons.length ? conditionOf(condition.comparisons) : null) : visibility
    onSave(checked.def, when, field?.id ?? null)
  }

  return (
    <div className="flex min-w-0 flex-col gap-5">
      <DialogHeader>
        <DialogTitle className="text-xl font-semibold text-ink">{field ? t('fieldDialog.editTitle', { id: field.id }) : t('fieldDialog.addTitle')}</DialogTitle>
        <DialogDescription className="text-base text-ink-muted md:text-sm">{t('fieldDialog.description')}</DialogDescription>
      </DialogHeader>
      {Object.keys(errors).length || Object.keys(rowErrors).length ? <Notice tone="danger">{t('fieldDialog.fix')}</Notice> : null}
      <div className="grid gap-4 md:grid-cols-2">
        <Field id={`${id}-id`} label={t('fieldDialog.id')} hint={t('fieldDialog.idHint')} value={draft.id} maxLength={64} spellCheck={false} autoComplete="off" onChange={(e) => change({ id: e.currentTarget.value })} error={error('id')} />
        <SelectField
          id={`${id}-type`}
          label={t('fieldDialog.type')}
          value={draft.type}
          onChange={(e) => {
            const type = e.currentTarget.value as FieldType
            change({ type, options: isChoiceType(type) ? (draft.options.length ? draft.options : [emptyOption(), emptyOption()]) : [] })
          }}
          options={FIELD_TYPES.map((type) => ({ value: type, label: tForms(`fieldTypes.${type}`) }))}
        />
        <Field id={`${id}-label-th`} label={t('fieldDialog.labelTh')} value={draft.labelTh} maxLength={200} onChange={(e) => change({ labelTh: e.currentTarget.value })} error={error('label')} />
        <Field id={`${id}-label-en`} label={t('fieldDialog.labelEn')} value={draft.labelEn} maxLength={200} onChange={(e) => change({ labelEn: e.currentTarget.value })} error={error('label')} />
      </div>
      <label className="flex min-h-11 items-center gap-3">
        <input type="checkbox" checked={draft.required} onChange={(e) => change({ required: e.currentTarget.checked })} className="size-5 shrink-0" />
        <span>{t('fieldDialog.required')}</span>
      </label>

      {isChoiceType(draft.type) ? (
        <fieldset className="flex min-w-0 flex-col gap-3 border-t border-line pt-3" aria-describedby={errors.options ? `${id}-options-error` : undefined}>
          <legend className="font-semibold">{t('fieldDialog.options')}</legend>
          <p className="text-base text-ink-muted md:text-sm">{t('fieldDialog.optionsHint')}</p>
          <ol className="flex flex-col gap-3">
            {draft.options.map((o, i) => (
              <li key={i} className="flex flex-col gap-3 border-l-2 border-line pl-3">
                <fieldset className="grid min-w-0 gap-3 md:grid-cols-3">
                  <legend className="mb-1 font-medium">{t('fieldDialog.option', { n: i + 1 })}</legend>
                  <Field id={`${id}-o${i}-value`} label={t('fieldDialog.optionValue')} value={o.value} spellCheck={false} autoComplete="off" onChange={(e) => setOption(i, { value: e.currentTarget.value })} />
                  <Field id={`${id}-o${i}-th`} label={t('fieldDialog.optionTh')} value={o.th} onChange={(e) => setOption(i, { th: e.currentTarget.value })} />
                  <Field id={`${id}-o${i}-en`} label={t('fieldDialog.optionEn')} value={o.en} onChange={(e) => setOption(i, { en: e.currentTarget.value })} />
                </fieldset>
                <Button variant="secondary" className="self-start" aria-label={t('fieldDialog.removeOptionNamed', { n: i + 1 })} onClick={() => change({ options: draft.options.filter((_, j) => j !== i) })}>
                  <Trash2 className="size-4 shrink-0" aria-hidden="true" />
                  {t('fieldDialog.removeOption')}
                </Button>
              </li>
            ))}
          </ol>
          {error('options') ? (
            <p id={`${id}-options-error`} className="text-base text-danger md:text-sm">
              {error('options')}
            </p>
          ) : null}
          <Button variant="secondary" className="self-start" onClick={() => change({ options: [...draft.options, emptyOption()] })}>
            <CirclePlus className="size-4 shrink-0" aria-hidden="true" />
            {t('fieldDialog.addOption')}
          </Button>
        </fieldset>
      ) : null}

      <MoreSection title={t('fieldDialog.help')} defaultOpen={Boolean(draft.helpTh || draft.helpEn)}>
        <div className="grid gap-4 md:grid-cols-2">
          <Field id={`${id}-help-th`} label={t('fieldDialog.helpTh')} value={draft.helpTh} maxLength={200} onChange={(e) => change({ helpTh: e.currentTarget.value })} error={error('help')} />
          <Field id={`${id}-help-en`} label={t('fieldDialog.helpEn')} value={draft.helpEn} maxLength={200} onChange={(e) => change({ helpEn: e.currentTarget.value })} error={error('help')} />
        </div>
      </MoreSection>

      <MoreSection title={t('fieldDialog.visibility')} defaultOpen={visibility !== null}>
        <p className="text-base text-ink-muted md:text-sm">{t('fieldDialog.visibilityHint')}</p>
        {rows ? (
          <ConditionRows id={`${id}-vis`} rows={rows} onChange={(next) => (setRows(next), setRowErrors({}))} fields={others} errors={rowErrors} noneText={t('fieldDialog.alwaysShown')} />
        ) : (
          <KeptCondition text={visibility ? words(visibility) : ''} onReplace={() => setRows([])} />
        )}
      </MoreSection>

      <p className="text-base text-ink-muted md:text-sm">{t('dialogNotSaved')}</p>
      <div className="flex flex-wrap gap-3 border-t border-line pt-4">
        <Button onClick={save}>{field ? t('fieldDialog.apply') : t('fieldDialog.add')}</Button>
        <Button variant="secondary" onClick={onClose}>
          {t('cancel')}
        </Button>
      </div>
    </div>
  )
}

// ---------- one attachment rule ----------

export interface RuleDialogProps {
  readonly open: boolean
  readonly rule: AttachmentRule | null
  readonly rules: readonly AttachmentRule[]
  readonly fields: readonly FieldDef[]
  readonly onSave: (rule: AttachmentRule, editing: string | null) => void
  readonly onClose: () => void
}

export function RuleDialog(props: RuleDialogProps) {
  return (
    <Dialog open={props.open} onOpenChange={(next) => (next ? null : props.onClose())}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto p-6 sm:max-w-2xl">{props.open ? <RuleForm {...props} /> : null}</DialogContent>
    </Dialog>
  )
}

function RequirementRows({ id, rows, onChange, errors }: { id: string; rows: readonly RequirementRow[]; onChange: (rows: RequirementRow[]) => void; errors: Readonly<Record<number, RequirementError>> }) {
  const t = useTranslations('formBuilder')
  const kindLabel = useKindLabel()
  const setRow = (i: number, patch: Partial<RequirementRow>) => onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)))
  return (
    <div className="flex flex-col gap-3">
      {rows.length > 1 ? <p className="text-ink-muted">{t('ruleDialog.allFilesHint')}</p> : null}
      <ol className="flex flex-col gap-3">
        {rows.map((row, i) => (
          <li key={i} className="flex flex-col gap-3 border-l-2 border-line pl-3">
            <fieldset className="grid min-w-0 gap-3 md:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
              <legend className="mb-1 font-semibold">{t('ruleDialog.fileRow', { n: i + 1 })}</legend>
              <SelectField
                id={`${id}-f${i}-kind`}
                label={t('ruleDialog.kind')}
                placeholder={t('choose')}
                value={row.kind}
                onChange={(e) => setRow(i, { kind: e.currentTarget.value })}
                options={ATTACHMENT_KINDS.map((k) => ({ value: k, label: kindLabel(k) }))}
                error={errors[i] === 'KIND' ? t('ruleErrors.KIND') : undefined}
              />
              <Field id={`${id}-f${i}-min`} label={t('ruleDialog.min')} inputMode="numeric" value={row.min} onChange={(e) => setRow(i, { min: e.currentTarget.value })} error={errors[i] === 'MIN' ? t('ruleErrors.MIN') : undefined} />
            </fieldset>
            <Button variant="secondary" className="self-start" aria-label={t('ruleDialog.removeFileNamed', { n: i + 1 })} onClick={() => onChange(rows.filter((_, j) => j !== i))}>
              <Trash2 className="size-4 shrink-0" aria-hidden="true" />
              {t('removeRow')}
            </Button>
          </li>
        ))}
      </ol>
      <Button variant="secondary" className="self-start" onClick={() => onChange([...rows, emptyRequirementRow()])}>
        <CirclePlus className="size-4 shrink-0" aria-hidden="true" />
        {t('ruleDialog.addFile')}
      </Button>
    </div>
  )
}

function RuleForm({ rule, rules, fields, onSave, onClose }: RuleDialogProps) {
  const t = useTranslations('formBuilder')
  const words = useConditionWords(fields)
  const kindLabel = useKindLabel()
  const id = useId()
  const [draft, setDraft] = useState<RuleDraft>(() => (rule ? ruleDraftOf(rule) : emptyRuleDraft()))
  const [errors, setErrors] = useState<RuleDraftErrors>({})
  const others = rules.filter((r) => r.id !== rule?.id).map((r) => r.id)

  function save() {
    const checked = checkRuleDraft(draft, others, fields)
    if (!checked.ok) return setErrors(checked.errors)
    onSave(checked.rule, rule?.id ?? null)
  }

  return (
    <div className="flex min-w-0 flex-col gap-5">
      <DialogHeader>
        <DialogTitle className="text-xl font-semibold text-ink">{rule ? t('ruleDialog.editTitle', { id: rule.id }) : t('ruleDialog.addTitle')}</DialogTitle>
        <DialogDescription className="text-base text-ink-muted md:text-sm">{t('ruleDialog.description')}</DialogDescription>
      </DialogHeader>
      {Object.keys(errors).length ? <Notice tone="danger">{t('ruleDialog.fix')}</Notice> : null}
      <Field
        id={`${id}-id`}
        label={t('ruleDialog.id')}
        hint={t('ruleDialog.idHint')}
        value={draft.id}
        maxLength={64}
        spellCheck={false}
        autoComplete="off"
        onChange={(e) => {
          const value = e.currentTarget.value.toUpperCase()
          setDraft((d) => ({ ...d, id: value }))
          setErrors(({ id: _id, ...rest }) => rest)
        }}
        error={errors.id ? t(`ruleErrors.${errors.id}`) : undefined}
        className="max-w-sm"
      />
      <section aria-labelledby={`${id}-when`} className="flex flex-col gap-2 border-t border-line pt-3">
        <h3 id={`${id}-when`} className="font-semibold">
          {t('ruleDialog.when')}
        </h3>
        {draft.when ? (
          <ConditionRows
            id={`${id}-when-rows`}
            rows={draft.when}
            onChange={(when) => {
              setDraft((d) => ({ ...d, when }))
              setErrors(({ when: _when, ...rest }) => rest)
            }}
            fields={fields}
            errors={errors.when ?? {}}
            noneText={t('ruleDialog.always')}
          />
        ) : (
          <KeptCondition text={draft.storedWhen ? words(draft.storedWhen) : ''} onReplace={() => setDraft((d) => ({ ...d, when: [] }))} />
        )}
      </section>
      <section aria-labelledby={`${id}-require`} className="flex flex-col gap-2 border-t border-line pt-3">
        <h3 id={`${id}-require`} className="font-semibold">
          {t('ruleDialog.require')}
        </h3>
        {errors.requireEmpty ? <Notice tone="danger">{t('ruleErrors.EMPTY')}</Notice> : null}
        {draft.require ? (
          <RequirementRows
            id={`${id}-req`}
            rows={draft.require}
            onChange={(require) => {
              setDraft((d) => ({ ...d, require }))
              setErrors(({ require: _r, requireEmpty: _e, ...rest }) => rest)
            }}
            errors={errors.require ?? {}}
          />
        ) : (
          <div className="flex flex-col gap-3">
            <Notice tone="info">
              <p>{t('keptRequirement')}</p>
              <p className="mt-1 font-medium break-words">{draft.storedRequire ? requirementText(draft.storedRequire, t, kindLabel, words) : ''}</p>
            </Notice>
            <Button variant="secondary" className="self-start" onClick={() => setDraft((d) => ({ ...d, require: [emptyRequirementRow()] }))}>
              {t('replaceRequirement')}
            </Button>
          </div>
        )}
      </section>
      <p className="text-base text-ink-muted md:text-sm">{t('dialogNotSaved')}</p>
      <div className="flex flex-wrap gap-3 border-t border-line pt-4">
        <Button onClick={save}>{rule ? t('ruleDialog.apply') : t('ruleDialog.add')}</Button>
        <Button variant="secondary" onClick={onClose}>
          {t('cancel')}
        </Button>
      </div>
    </div>
  )
}
