'use client'

import { useEffect, useId, useRef, useState } from 'react'
import { Button } from '../form/button'
import { Field } from '../form/field'
import { Notice } from '../form/notice'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../shadcn/dialog'
import { ConditionBuilder } from './condition-builder'
import { MODES, RISK_DOMAIN_CODES, checkRule, fieldKind, riskFieldKind, ruleDraftOf, scopeOf, type Mode, type RowError, type RuleDraft, type RuleError, type RuleField, type RuleScope, type RuleValue } from './model'
import { ReviewerList, ReviewerPicker } from './reviewer-list'
import { fieldsOfTypes, type WorkflowContext, type WorkflowWords } from './words'

// The Dialog that edits one reviewer rule (FR-WF-103 AC1): opened by the person's press only (NG-13), in two real
// steps (§9.9: no form of more than 8 fields on one page): (1) when a request enters the rule — its code, the request
// types and the condition rows; (2) who reviews — the reviewers, all of them / any one / a number of them, the
// fallback, the time under the SLA and a description. Saving checks the form as the lint and the service will; a
// problem of step 1 goes back to it. The rule joins the editor's list; nothing is saved to the server until the draft is.
// S11-06 (BR-RSK-07 · BR-RSK-08): a rule of the risk reviewers' tab names no request type and has rows on the fields of
// a risk assessment only (step 1); its one reviewer must pass, so there is no choice of how many (WF_LINT_RISK_QUORUM),
// and step 2 also names the parts of the assessment that reviewer sees, one at least (WF_LINT_RISK_DOMAIN_REQUIRED).

export interface RuleDialogProps {
  readonly open: boolean
  /** The rule being edited, or null for a new one */
  readonly rule: RuleValue | null
  readonly rules: readonly RuleValue[]
  /** The scope of a new rule (the tab it is added from); an edited rule keeps its own */
  readonly scope: RuleScope
  readonly context: WorkflowContext
  readonly words: WorkflowWords
  readonly categoryCodes: readonly string[]
  readonly accountCodes: readonly string[]
  readonly slaMaxHours: number
  readonly onSave: (rule: RuleValue, editing: string | null) => void
  readonly onClose: () => void
}

const DEFAULT_SLA_HOURS = '8'
const FIRST_STEP_FIELDS: readonly RuleField[] = ['code', 'requestTypes', 'condition']

export function RuleDialog(props: RuleDialogProps) {
  // A fresh form every time it opens: the state of the dialog lives in its body, which mounts with it
  return (
    <Dialog open={props.open} onOpenChange={(next) => (next ? null : props.onClose())}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto p-6 sm:max-w-3xl">{props.open ? <RuleForm {...props} /> : null}</DialogContent>
    </Dialog>
  )
}

function RuleForm({ rule, rules, scope: newScope, context, words, categoryCodes, accountCodes, slaMaxHours, onSave, onClose }: RuleDialogProps) {
  const { t } = words
  const id = useId()
  const headingRef = useRef<HTMLHeadingElement>(null)
  const moved = useRef(false)
  const scope = rule ? scopeOf(rule) : newScope
  const risk = scope === 'RISK_ASSESSMENT'
  const [step, setStep] = useState<1 | 2>(1)
  const [draft, setDraft] = useState<RuleDraft>(() => ruleDraftOf(rule, rules, DEFAULT_SLA_HOURS, scope))
  const [errors, setErrors] = useState<Partial<Record<RuleField, RuleError>>>({})
  const [rowErrors, setRowErrors] = useState<Readonly<Record<number, RowError>>>({})
  const fields = risk ? [] : fieldsOfTypes(context, draft.requestTypeCodes)
  const kindOf = (field: string) => (risk ? riskFieldKind(field) : fieldKind(field, fields.find((f) => f.id === field)))
  const editing = rule?.code ?? null
  const title = rule ? t('dialog.editTitle', { rule: rule.code }) : risk ? t('riskDialog.addTitle') : t('dialog.addTitle')

  useEffect(() => {
    if (moved.current) headingRef.current?.focus()
  }, [step])
  const goTo = (next: 1 | 2) => {
    moved.current = true
    setStep(next)
  }

  const change = (patch: Partial<RuleDraft>) => {
    setDraft((d) => ({ ...d, ...patch }))
    // What is shown is about what is there now: a changed part loses its old error at once
    setErrors((e) => {
      const next = { ...e }
      if ('code' in patch) delete next.code
      if ('requestTypeCodes' in patch) delete next.requestTypes
      if ('riskDomains' in patch) delete next.riskDomains
      if ('condition' in patch) delete next.condition
      if ('reviewers' in patch || 'mode' in patch) delete next.reviewers
      if ('fallback' in patch) delete next.fallback
      if ('quorumCount' in patch || 'mode' in patch) delete next.quorumCount
      if ('slaHours' in patch) delete next.slaHours
      if ('descriptionTh' in patch) delete next.descriptionTh
      return next
    })
    if ('condition' in patch) setRowErrors({})
  }
  const error = (f: RuleField) => (errors[f] ? t(`ruleErrors.${errors[f]}`) : undefined)

  function toSecond() {
    const check = checkRule(draft, rules, editing, kindOf, slaMaxHours)
    if (!check.ok) {
      const first = Object.fromEntries(Object.entries(check.errors).filter(([k]) => FIRST_STEP_FIELDS.includes(k as RuleField)))
      if (Object.keys(first).length) {
        setErrors(first)
        setRowErrors(check.rowErrors)
        return
      }
    }
    setErrors({})
    goTo(2)
  }

  function save() {
    const check = checkRule(draft, rules, editing, kindOf, slaMaxHours)
    if (!check.ok) {
      setErrors(check.errors)
      setRowErrors(check.rowErrors)
      if (FIRST_STEP_FIELDS.some((f) => check.errors[f])) goTo(1)
      return
    }
    onSave(check.rule, editing)
  }

  // The one reviewer of a risk rule, and the parts of the assessment they see (BR-RSK-08). A named member kept from an
  // older version cannot be edited in place (ReviewerPicker), so it can be replaced by a position here.
  const reviewer = draft.reviewers[0] ?? { kind: 'POSITION_AT' as const, position: '', department: '' }
  const riskWho = (
    <>
      <section aria-labelledby={`${id}-reviewer`} className="flex flex-col gap-2">
        <h4 id={`${id}-reviewer`} className="font-semibold">
          {t('riskDialog.reviewer')}
        </h4>
        <p className="text-base text-ink-muted md:text-sm">{t('riskDialog.reviewerHint')}</p>
        <ReviewerPicker
          id={`${id}-rv`}
          legend={t('riskDialog.reviewerWho')}
          value={reviewer}
          onChange={(value) => change({ reviewers: [value] })}
          positions={context.positions}
          departments={context.departments}
          words={words}
          error={errors.reviewers === 'INCOMPLETE' || errors.reviewers === 'REQUIRED' ? t('reviewerMissing') : undefined}
        />
        {reviewer.kind === 'MEMBER' ? (
          <Button variant="secondary" className="self-start" onClick={() => change({ reviewers: [{ kind: 'POSITION_AT', position: '', department: '' }] })}>
            {t('riskDialog.usePosition')}
          </Button>
        ) : null}
        {/* A stored rule with more than one reviewer (WF_LINT_RISK_QUORUM): choosing the reviewer again keeps that one only */}
        {errors.reviewers === 'ONE_REVIEWER' ? <p className="text-base text-danger md:text-sm">{t('riskDialog.oneReviewer')}</p> : null}
      </section>
      <fieldset className="flex flex-col gap-1" aria-describedby={`${id}-domains-hint${errors.riskDomains ? ` ${id}-domains-error` : ''}`}>
        <legend className="mb-1 font-medium">{t('riskDialog.domains')}</legend>
        <p id={`${id}-domains-hint`} className="text-base text-ink-muted md:text-sm">
          {t('riskDialog.domainsHint')}
        </p>
        <div className="grid gap-x-6 sm:grid-cols-2">
          {/* GENERAL last: every reviewer sees it anyway; it is chosen for a reviewer who checks the general part only */}
          {[...RISK_DOMAIN_CODES.filter((d) => d !== 'GENERAL'), 'GENERAL' as const].map((code) => (
            <label key={code} className="flex min-h-11 items-center gap-3">
              <input
                type="checkbox"
                checked={draft.riskDomains.includes(code)}
                onChange={(ev) => {
                  const checked = ev.currentTarget.checked
                  change({ riskDomains: checked ? [...draft.riskDomains, code] : draft.riskDomains.filter((d) => d !== code) })
                }}
                className="size-5 shrink-0"
              />
              <span>{code === 'GENERAL' ? t('riskDialog.generalAlways', { name: words.domain(code) }) : words.domain(code)}</span>
            </label>
          ))}
        </div>
        {errors.riskDomains ? (
          <p id={`${id}-domains-error`} className="text-base text-danger md:text-sm">
            {t('riskDialog.domainsRequired')}
          </p>
        ) : null}
      </fieldset>
    </>
  )

  const stepLine = (
    <ol aria-label={t('dialog.stepsLabel')} className="flex flex-wrap gap-x-6 gap-y-1 border-b border-line">
      {[t('dialog.stepWhen'), t('dialog.stepWho')].map((label, i) => (
        <li key={label} aria-current={step === i + 1 ? 'step' : undefined} className={step === i + 1 ? '-mb-px border-b-2 border-primary py-2 font-semibold text-ink' : 'py-2 text-ink-muted'}>
          {t('dialog.stepLabel', { n: i + 1, name: label })}
        </li>
      ))}
    </ol>
  )

  return (
    <div className="flex min-w-0 flex-col gap-5">
      <DialogHeader>
        <DialogTitle className="text-xl font-semibold text-ink">{title}</DialogTitle>
        <DialogDescription className="text-base text-ink-muted md:text-sm">{risk ? t('riskDialog.description') : t('dialog.description')}</DialogDescription>
      </DialogHeader>
      {stepLine}
      <h3 ref={headingRef} tabIndex={-1} className="text-lg font-semibold outline-none">
        {step === 1 ? t('dialog.stepWhen') : t('dialog.stepWho')}
      </h3>

      {step === 1 ? (
        <>
          <Field
            id={`${id}-code`}
            label={t('dialog.code')}
            hint={rule ? t('dialog.codeFixed') : risk ? t('riskDialog.codeHint') : t('dialog.codeHint')}
            value={draft.code}
            readOnly={rule !== null}
            maxLength={40}
            onChange={(ev) => change({ code: ev.currentTarget.value.toUpperCase() })}
            error={error('code')}
            className="max-w-xs"
          />
          {risk ? null : (
            <fieldset className="flex flex-col gap-1" aria-describedby={errors.requestTypes ? `${id}-types-error` : undefined}>
              <legend className="mb-1 font-medium">{t('dialog.requestTypes')}</legend>
              <p className="text-base text-ink-muted md:text-sm">{t('dialog.requestTypesHint')}</p>
              <div className="grid gap-x-6 sm:grid-cols-2">
                {context.requestTypes.map((type) => (
                  <label key={type.code} className="flex min-h-11 items-center gap-3">
                    <input
                      type="checkbox"
                      checked={draft.requestTypeCodes.includes(type.code)}
                      onChange={(ev) => {
                        const checked = ev.currentTarget.checked
                        change({ requestTypeCodes: checked ? [...draft.requestTypeCodes, type.code] : draft.requestTypeCodes.filter((c) => c !== type.code) })
                      }}
                      className="size-5 shrink-0"
                    />
                    <span>
                      {words.requestType(type.code)} ({type.code})
                    </span>
                  </label>
                ))}
              </div>
              {error('requestTypes') ? (
                <p id={`${id}-types-error`} className="text-base text-danger md:text-sm">
                  {error('requestTypes')}
                </p>
              ) : null}
            </fieldset>
          )}
          <section aria-labelledby={`${id}-condition`} className="flex flex-col gap-2">
            <h4 id={`${id}-condition`} className="font-semibold">
              {t('dialog.condition')}
            </h4>
            {risk ? <p className="text-base text-ink-muted md:text-sm">{t('riskDialog.conditionHint')}</p> : null}
            {error('condition') ? <Notice tone="danger">{error('condition')}</Notice> : null}
            <ConditionBuilder
              id={`${id}-cond`}
              draft={draft.condition}
              onChange={(condition) => change({ condition })}
              fields={fields}
              requestTypes={context.requestTypes.map((r) => ({ code: r.code, label: words.requestType(r.code) }))}
              rowErrors={rowErrors}
              categoryCodes={categoryCodes}
              accountCodes={accountCodes}
              words={words}
              scope={scope}
            />
          </section>
          <div className="flex flex-wrap gap-3 border-t border-line pt-4">
            <Button onClick={toSecond}>{t('dialog.next')}</Button>
            <Button variant="secondary" onClick={onClose}>
              {t('dialog.cancel')}
            </Button>
          </div>
        </>
      ) : (
        <>
          {risk ? riskWho : (
            <>
              <fieldset className="flex flex-col gap-1">
                <legend className="mb-1 font-medium">{t('dialog.mode')}</legend>
                {MODES.map((m: Mode) => (
                  <label key={m} className="flex min-h-11 items-start gap-3 py-1">
                    <input type="radio" name={`${id}-mode`} checked={draft.mode === m} onChange={() => change({ mode: m })} className="mt-1 size-5 shrink-0" />
                    <span className="flex flex-col">
                      <span>{t(`modes.${m}`)}</span>
                      <span className="text-base text-ink-muted md:text-sm">{t(`modeHints.${m}`)}</span>
                    </span>
                  </label>
                ))}
              </fieldset>
              <section aria-labelledby={`${id}-reviewers`} className="flex flex-col gap-2">
                <h4 id={`${id}-reviewers`} className="font-semibold">
                  {t('dialog.reviewers')}
                </h4>
                <p className="text-base text-ink-muted md:text-sm">{draft.mode === 'COUNT' ? t('dialog.reviewersHintCount') : t('dialog.reviewersHintOne')}</p>
                <ReviewerList
                  id={`${id}-rv`}
                  reviewers={draft.reviewers}
                  onChange={(reviewers) => change({ reviewers })}
                  positions={context.positions}
                  departments={context.departments}
                  words={words}
                  error={error('reviewers')}
                  incomplete={errors.reviewers === 'INCOMPLETE'}
                />
              </section>
              {draft.mode === 'COUNT' ? (
                <Field
                  id={`${id}-quorum`}
                  label={t('dialog.quorumCount')}
                  hint={t('dialog.quorumCountHint', { count: draft.reviewers.length })}
                  inputMode="numeric"
                  value={draft.quorumCount}
                  onChange={(ev) => change({ quorumCount: ev.currentTarget.value })}
                  error={error('quorumCount')}
                  className="max-w-xs"
                />
              ) : null}
            </>
          )}
          <section aria-labelledby={`${id}-fallback`} className="flex flex-col gap-2">
            <h4 id={`${id}-fallback`} className="font-semibold">
              {t('dialog.fallback')}
            </h4>
            <label className="flex min-h-11 items-center gap-3">
              <input
                type="checkbox"
                checked={draft.fallback !== null}
                onChange={(ev) => change({ fallback: ev.currentTarget.checked ? { kind: 'POSITION_AT', position: '', department: '' } : null })}
                className="size-5 shrink-0"
              />
              <span>{risk ? t('riskDialog.hasFallback') : t('dialog.hasFallback')}</span>
            </label>
            {draft.fallback ? (
              <ReviewerPicker
                id={`${id}-fb`}
                legend={t('dialog.fallbackWho')}
                value={draft.fallback}
                onChange={(fallback) => change({ fallback })}
                positions={context.positions}
                departments={context.departments}
                words={words}
                error={errors.fallback ? t('reviewerMissing') : undefined}
              />
            ) : (
              <p className="text-base text-ink-muted md:text-sm">{risk ? t('riskDialog.noFallbackHint') : t('dialog.noFallbackHint')}</p>
            )}
          </section>
          <Field
            id={`${id}-sla`}
            label={t('dialog.sla')}
            hint={t('dialog.slaHint', { max: slaMaxHours })}
            inputMode="decimal"
            value={draft.slaHours}
            onChange={(ev) => change({ slaHours: ev.currentTarget.value })}
            error={error('slaHours')}
            className="max-w-xs"
          />
          <Field id={`${id}-description`} label={t('dialog.descriptionTh')} hint={risk ? t('riskDialog.descriptionHint') : t('dialog.descriptionHint')} value={draft.descriptionTh} onChange={(ev) => change({ descriptionTh: ev.currentTarget.value })} error={error('descriptionTh')} />
          <div className="flex flex-wrap gap-3 border-t border-line pt-4">
            <Button variant="secondary" onClick={() => goTo(1)}>
              {t('dialog.back')}
            </Button>
            <Button onClick={save}>{rule ? t('dialog.saveRule') : t('dialog.addRule')}</Button>
          </div>
        </>
      )}
    </div>
  )
}
