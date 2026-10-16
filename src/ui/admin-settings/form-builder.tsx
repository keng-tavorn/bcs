'use client'

import { ArrowDown, ArrowUp, CirclePlus, Pencil, Trash2 } from 'lucide-react'
import { useLocale, useTranslations } from 'next-intl'
import { useState } from 'react'
import type { AttachmentRule, Condition } from '@/core/forms'
import type { FieldDef } from '@/core/forms/fields'
import { Button } from '../form/button'
import { Notice } from '../form/notice'
import { useSubmissionKey } from '../form/submission-key'
import { fieldLabel } from '../request-form/field-input'
import type { ScreenLocale } from '../request-form/types'
import { ListEmpty, Panel } from '../page/page'
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '../shadcn/alert-dialog'
import { FieldDialog, RuleDialog, requirementText, useConditionWords, useKindLabel, type BuilderT } from './form-builder-dialogs'
import {
  addField,
  addRule,
  formJson,
  moveField,
  moveRule,
  removeField,
  removeRule,
  replaceField,
  replaceRule,
  sameBuilderForm,
  setVisibility,
  readerOf,
  visibilityOf,
  type BuilderForm,
  type FieldType,
} from './form-builder-model'
import { FormPreview } from './form-builder-preview'
import { ChangeList, useProblemText } from './form-import'
import type { CreateFormDraftAction, FormBuilderView, PublishFormDraftAction, SaveFormDraftAction } from './forms'
import { commonErrorKey, settle, type FormLintView, type FormProblemView, type SettingsOutcome } from './outcome'

// The no-code form builder of a request type (S6-14 · FR-INT-104 · BR-FORM-09 · OQ-115). Without a draft: the form in
// use, read only, and one press that copies it into a draft. With the draft: the whole form edited on the page — questions
// added, edited, removed and moved up or down with buttons (no dragging), each with the condition that shows it, and the
// attachment rules — saved with one button; the real request form drawn from it ("ตัวอย่างฟอร์ม"); what it changes
// against the form in use and the lint's refusals as of the last save; and the publish, confirmed in an Alert Dialog
// that says new requests take the new version, requests made keep theirs, and the AUDITOR hears of changed attachment
// rules. The service checks, lints and records every step; its refusals are said in words with what to do (§9.9 rule 7).

export interface FormBuilderProps {
  readonly view: FormBuilderView
  readonly typeName: string
  readonly create: CreateFormDraftAction
  readonly save: SaveFormDraftAction
  readonly publish: PublishFormDraftAction
}

type Note = { readonly tone: 'success' | 'danger'; readonly text: string } | null

function useFieldWords() {
  const tForms = useTranslations('adminSettings.forms')
  const locale = useLocale() as ScreenLocale
  return {
    label: (def: FieldDef) => fieldLabel(def, locale),
    type: (type: FieldType) => tForms(`fieldTypes.${type}`),
    required: (def: FieldDef) => (def.required ? tForms('required') : tForms('optional')),
  }
}

/** "คำถาม note ถูกอ้างโดย ATT-X, เงื่อนไขแสดงของคำถาม pd จึงลบหรือเปลี่ยนชนิดไม่ได้" */
export function lintText(t: BuilderT, issue: FormLintView): string {
  const by = issue.by.map((b) => {
    const reader = readerOf(b)
    return reader.kind === 'VISIBILITY' ? t('lintByVisibility', { field: reader.field }) : reader.id
  })
  return t('lint', { field: issue.field, by: by.join(', ') })
}

function LintList({ lint, role }: { lint: readonly FormLintView[]; role?: 'status' | 'alert' }) {
  const t = useTranslations('formBuilder')
  return (
    <Notice tone="danger" {...(role ? { role } : {})}>
      <p className="font-medium">{t('lintTitle')}</p>
      <ul className="mt-2 flex list-disc flex-col gap-1 pl-5">
        {lint.map((issue) => (
          <li key={issue.field} className="break-words">
            {lintText(t, issue)}
          </li>
        ))}
      </ul>
    </Notice>
  )
}

/** The questions and rules of a form, read only */
function FormSummary({ form }: { form: BuilderForm }) {
  const t = useTranslations('formBuilder')
  const words = useFieldWords()
  const condition = useConditionWords(form.fields)
  const kindLabel = useKindLabel()
  return (
    <>
      <h3 className="text-base font-semibold">{t('fieldsTitle')}</h3>
      {form.fields.length ? (
        <ul className="flex flex-col divide-y divide-line border-y border-line">
          {form.fields.map((f) => {
            const when = visibilityOf(form, f.id)
            return (
              <li key={f.id} className="flex flex-col gap-0.5 py-2.5">
                <p className="font-medium break-words">{words.label(f)}</p>
                <p className="text-base break-words text-ink-muted md:text-sm">{[f.id, words.type(f.type), words.required(f), when ? t('shownWhen', { condition: condition(when) }) : null].filter(Boolean).join(' · ')}</p>
              </li>
            )
          })}
        </ul>
      ) : (
        <p className="text-ink-muted">{t('noFields')}</p>
      )}
      <h3 className="text-base font-semibold">{t('rulesTitle')}</h3>
      {form.rules.length ? (
        <ul className="flex flex-col divide-y divide-line border-y border-line">
          {form.rules.map((r) => (
            <li key={r.id} className="flex flex-col gap-0.5 py-2.5">
              <p className="font-medium break-words">{r.id}</p>
              <p className="text-base break-words text-ink-muted md:text-sm">{t('ruleLine', { when: condition(r.when), require: requirementText(r.require, t, kindLabel, condition) })}</p>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-ink-muted">{t('noRules')}</p>
      )}
    </>
  )
}

export function FormBuilder({ view, typeName, create, save, publish }: FormBuilderProps) {
  const t = useTranslations('formBuilder')
  const tCommon = useTranslations('adminSettings')
  const submission = useSubmissionKey()
  const [pending, setPending] = useState(false)
  // Kept here, above the draft: a publish ends the draft, and its success stays said on the page that follows
  const [note, setNote] = useState<Note>(null)
  const failureText = (outcome: SettingsOutcome | null) => (outcome && !outcome.ok ? tCommon(`errors.${commonErrorKey(outcome)}`, { requestId: outcome.requestId ?? '-' }) : tCommon('errors.FAILED'))

  async function onCreate() {
    setNote(null)
    setPending(true)
    const outcome = await settle(create(view.code, submission.key))
    setPending(false)
    if (!outcome) return setNote({ tone: 'danger', text: tCommon('errors.FAILED') })
    submission.next()
    if (!outcome.ok) setNote({ tone: 'danger', text: failureText(outcome) })
  }

  if (!view.draft) {
    return (
      <div className="flex flex-col gap-4 lg:grid lg:grid-cols-[minmax(0,1fr)_26rem] lg:items-start lg:gap-6">
        <Panel title={view.current ? t('currentTitle', { version: view.current.versionNo }) : t('fieldsTitle')} id="builder-current">
          {view.current ? <FormSummary form={view.current.form} /> : <ListEmpty title={t('noCurrent')} />}
        </Panel>
        <Panel title={t('startTitle')} id="builder-start">
          {note ? <Notice tone={note.tone}>{note.text}</Notice> : null}
          <p className="text-ink-muted">{t('startIntro')}</p>
          <Button onClick={() => void onCreate()} disabled={pending} aria-busy={pending || undefined} className="self-start">
            {pending ? t('creating') : t('create')}
          </Button>
        </Panel>
      </div>
    )
  }

  return <DraftEditor key={view.draft.id} view={view} draft={view.draft} typeName={typeName} save={save} publish={publish} note={note} setNote={setNote} />
}

function DraftEditor({
  view,
  draft,
  typeName,
  save,
  publish,
  note,
  setNote,
}: {
  view: FormBuilderView
  draft: NonNullable<FormBuilderView['draft']>
  typeName: string
  save: SaveFormDraftAction
  publish: PublishFormDraftAction
  note: Note
  setNote: (note: Note) => void
}) {
  const t = useTranslations('formBuilder')
  const tCommon = useTranslations('adminSettings')
  const words = useFieldWords()
  const problemText = useProblemText()
  const submission = useSubmissionKey()
  const [form, setForm] = useState<BuilderForm>(draft.form)
  const [pending, setPending] = useState<'save' | 'publish' | null>(null)
  const [problems, setProblems] = useState<readonly FormProblemView[]>([])
  const [saveLint, setSaveLint] = useState<readonly FormLintView[]>([])
  const [fieldDialog, setFieldDialog] = useState<{ field: FieldDef | null } | null>(null)
  const [ruleDialog, setRuleDialog] = useState<{ rule: AttachmentRule | null } | null>(null)
  const [confirming, setConfirming] = useState(false)
  const condition = useConditionWords(form.fields)
  const kindLabel = useKindLabel()
  const dirty = !sameBuilderForm(form, draft.form)
  const rulesChanged = draft.changes.addedRules.length + draft.changes.removedRules.length + draft.changes.changedRules.length > 0
  const canPublish = !dirty && !draft.noChange && draft.lint.length === 0

  const edit = (next: BuilderForm) => {
    setForm(next)
    setNote(null)
  }
  const failure = (outcome: SettingsOutcome | null) => (outcome && !outcome.ok ? tCommon(`errors.${commonErrorKey(outcome)}`, { requestId: outcome.requestId ?? '-' }) : tCommon('errors.FAILED'))

  async function onSave() {
    setNote(null)
    setProblems([])
    setSaveLint([])
    setPending('save')
    const outcome = await settle(save(draft.id, formJson(form), submission.key))
    setPending(null)
    // No answer: the same key goes with a retry, so the save runs at most once
    if (!outcome) return setNote({ tone: 'danger', text: tCommon('errors.FAILED') })
    submission.next()
    if (outcome.ok) return setNote({ tone: 'success', text: t('saved', { version: draft.versionNo }) })
    if (outcome.lint?.length) return setSaveLint(outcome.lint)
    if (outcome.problems?.length) return setProblems(outcome.problems)
    setNote({ tone: 'danger', text: failure(outcome) })
  }

  async function onPublish() {
    setPending('publish')
    const outcome = await settle(publish(draft.id, submission.key))
    setPending(null)
    setConfirming(false)
    if (!outcome) return setNote({ tone: 'danger', text: tCommon('errors.FAILED') })
    submission.next()
    if (outcome.ok) return setNote({ tone: 'success', text: t('published', { version: outcome.versionNo ?? draft.versionNo }) })
    if (outcome.reason === 'NO_CHANGE') return setNote({ tone: 'danger', text: t('errors.NO_CHANGE') })
    if (outcome.code === 'INVALID_STATE_TRANSITION') return setNote({ tone: 'danger', text: t('errors.NOT_DRAFT') })
    if (outcome.lint?.length) return setSaveLint(outcome.lint)
    if (outcome.problems?.length) return setProblems(outcome.problems)
    setNote({ tone: 'danger', text: failure(outcome) })
  }

  function onFieldSave(def: FieldDef, when: Condition | null, editing: string | null) {
    const placed = editing ? replaceField(form, editing, def) : addField(form, def)
    edit(setVisibility(placed, def.id, when))
    setFieldDialog(null)
  }

  function onRuleSave(rule: AttachmentRule, editing: string | null) {
    edit(editing ? replaceRule(form, editing, rule) : addRule(form, rule))
    setRuleDialog(null)
  }

  const rowButtons = (name: string, index: number, count: number, on: { up: () => void; down: () => void; edit: () => void; remove: () => void }) => (
    <div className="flex flex-wrap gap-2">
      <Button variant="secondary" className="h-11 px-3" disabled={index === 0} aria-label={t('moveUpNamed', { name })} onClick={on.up}>
        <ArrowUp className="size-4 shrink-0" aria-hidden="true" />
        {t('moveUp')}
      </Button>
      <Button variant="secondary" className="h-11 px-3" disabled={index === count - 1} aria-label={t('moveDownNamed', { name })} onClick={on.down}>
        <ArrowDown className="size-4 shrink-0" aria-hidden="true" />
        {t('moveDown')}
      </Button>
      <Button variant="secondary" className="h-11 px-3" aria-label={t('editNamed', { name })} onClick={on.edit}>
        <Pencil className="size-4 shrink-0" aria-hidden="true" />
        {t('edit')}
      </Button>
      <Button variant="danger" className="h-11 px-3" aria-label={t('removeNamed', { name })} onClick={on.remove}>
        <Trash2 className="size-4 shrink-0" aria-hidden="true" />
        {t('remove')}
      </Button>
    </div>
  )

  return (
    <div className="flex flex-col gap-4 lg:grid lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] lg:items-start lg:gap-6">
      <div className="flex min-w-0 flex-col gap-4 lg:gap-6">
        <Panel title={t('draftTitle', { version: draft.versionNo })} id="builder-draft">
          {note ? <Notice tone={note.tone}>{note.text}</Notice> : null}
          {problems.length ? (
            <Notice tone="danger">
              <p className="font-medium">{t('problemsTitle')}</p>
              <ul className="mt-2 flex flex-col gap-1">
                {problems.map((p, i) => (
                  <li key={i} className="break-words">
                    {problemText(p)}
                  </li>
                ))}
              </ul>
            </Notice>
          ) : null}
          {saveLint.length ? <LintList lint={saveLint} /> : null}
          <p className="text-ink-muted">{dirty ? t('unsaved') : t('allSaved')}</p>
          <Button onClick={() => void onSave()} disabled={pending !== null || !dirty} aria-busy={pending === 'save' || undefined} className="self-start">
            {pending === 'save' ? t('saving') : t('save')}
          </Button>
        </Panel>

        <Panel
          title={t('fieldsTitle')}
          id="builder-fields"
          actions={
            <Button variant="secondary" onClick={() => setFieldDialog({ field: null })}>
              <CirclePlus className="size-4 shrink-0" aria-hidden="true" />
              {t('addField')}
            </Button>
          }
        >
          {form.fields.length ? (
            <ol className="flex flex-col divide-y divide-line border-y border-line">
              {form.fields.map((f, i) => {
                const when = visibilityOf(form, f.id)
                const name = words.label(f)
                return (
                  <li key={f.id} className="flex flex-col gap-2 py-3">
                    <div className="flex flex-col gap-0.5">
                      <p className="font-medium break-words">{name}</p>
                      <p className="text-base break-words text-ink-muted md:text-sm">{[f.id, words.type(f.type), words.required(f)].join(' · ')}</p>
                      {when ? <p className="text-base break-words text-ink-muted md:text-sm">{t('shownWhen', { condition: condition(when) })}</p> : null}
                    </div>
                    {rowButtons(name, i, form.fields.length, {
                      up: () => edit(moveField(form, f.id, 'UP')),
                      down: () => edit(moveField(form, f.id, 'DOWN')),
                      edit: () => setFieldDialog({ field: f }),
                      remove: () => edit(removeField(form, f.id)),
                    })}
                  </li>
                )
              })}
            </ol>
          ) : (
            <ListEmpty title={t('noFieldsDraft')} />
          )}
        </Panel>

        <Panel
          title={t('rulesTitle')}
          id="builder-rules"
          actions={
            <Button variant="secondary" onClick={() => setRuleDialog({ rule: null })}>
              <CirclePlus className="size-4 shrink-0" aria-hidden="true" />
              {t('addRule')}
            </Button>
          }
        >
          {form.rules.length ? (
            <ol className="flex flex-col divide-y divide-line border-y border-line">
              {form.rules.map((r, i) => (
                <li key={r.id} className="flex flex-col gap-2 py-3">
                  <div className="flex flex-col gap-0.5">
                    <p className="font-medium break-words">{r.id}</p>
                    <p className="text-base break-words text-ink-muted md:text-sm">{t('ruleLine', { when: condition(r.when), require: requirementText(r.require, t, kindLabel, condition) })}</p>
                  </div>
                  {rowButtons(r.id, i, form.rules.length, {
                    up: () => edit(moveRule(form, r.id, 'UP')),
                    down: () => edit(moveRule(form, r.id, 'DOWN')),
                    edit: () => setRuleDialog({ rule: r }),
                    remove: () => edit(removeRule(form, r.id)),
                  })}
                </li>
              ))}
            </ol>
          ) : (
            <ListEmpty title={t('noRulesDraft')} />
          )}
          {form.lines.serviceEndDate ? <p className="text-base text-ink-muted md:text-sm">{t('serviceEndDateKept', { condition: condition(form.lines.serviceEndDate.when) })}</p> : null}
          {form.steps?.length ? <p className="text-base text-ink-muted md:text-sm">{t('stepsKept', { count: form.steps.length })}</p> : null}
        </Panel>
      </div>

      <div className="flex min-w-0 flex-col gap-4 lg:gap-6">
        <Panel title={t('preview.title')} id="builder-preview">
          <FormPreview form={form} requestTypeCode={view.code} />
        </Panel>

        <Panel title={t('publishTitle', { version: draft.versionNo })} id="builder-publish">
          <p className="text-ink-muted">{view.current ? t('changesIntro', { version: view.current.versionNo }) : t('changesIntroFirst')}</p>
          {draft.noChange ? (
            <Notice tone="info">{t('noChange')}</Notice>
          ) : (
            <div className="flex flex-col gap-2">
              <p className="font-medium">{t('changesTitle')}</p>
              <ChangeList changes={draft.changes} />
            </div>
          )}
          {draft.lint.length ? <LintList lint={draft.lint} role="status" /> : null}
          {dirty ? <Notice tone="warning">{t('saveFirst')}</Notice> : null}
          <Button onClick={() => setConfirming(true)} disabled={!canPublish || pending !== null} className="self-start">
            {t('publish', { version: draft.versionNo })}
          </Button>
        </Panel>
      </div>

      <FieldDialog open={fieldDialog !== null} field={fieldDialog?.field ?? null} visibility={fieldDialog?.field ? visibilityOf(form, fieldDialog.field.id) : null} fields={form.fields} onSave={onFieldSave} onClose={() => setFieldDialog(null)} />
      <RuleDialog open={ruleDialog !== null} rule={ruleDialog?.rule ?? null} rules={form.rules} fields={form.fields} onSave={onRuleSave} onClose={() => setRuleDialog(null)} />

      <AlertDialog open={confirming} onOpenChange={(next) => (next ? null : setConfirming(false))}>
        <AlertDialogContent className="max-h-[90dvh] overflow-y-auto">
          <AlertDialogHeader>
            <AlertDialogTitle className="text-lg font-semibold text-ink">{t('confirmTitle', { version: draft.versionNo, name: typeName })}</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="flex flex-col gap-2 text-base text-ink-muted">
                <p>{t('confirmText')}</p>
                <p>{rulesChanged ? t('confirmAuditor') : t('confirmAuditorNone')}</p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="gap-3">
            <AlertDialogCancel className="h-11 px-4 text-base" disabled={pending !== null}>
              {t('cancel')}
            </AlertDialogCancel>
            <Button onClick={() => void onPublish()} disabled={pending !== null} aria-busy={pending === 'publish' || undefined}>
              {pending === 'publish' ? t('publishing') : t('publish', { version: draft.versionNo })}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
