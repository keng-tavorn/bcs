'use client'

import { CirclePlus, PenLine, Trash2, Undo2 } from 'lucide-react'
import Link from 'next/link'
import { useLocale, useTranslations } from 'next-intl'
import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { REASON_MAX_LENGTH } from '@/lib/constants'
import { nameIn, type Named } from '../admin-org/names'
import { thaiLocalToIso } from '../admin-org/thai-time'
import { failureKey, type ActionFailure, type IssueView } from '../admin-org/outcome'
import { SelectField } from '../admin-org/select-field'
import { errorValues, useAction } from '../admin-org/use-action'
import { Button } from '../form/button'
import { Field } from '../form/field'
import { Notice } from '../form/notice'
import { formatDateTime } from '../format'
import { bandText } from './band'
import {
  DOC_TYPES,
  QUORUMS,
  applyDraft,
  approverKey,
  changedParts,
  changedPolicies,
  draftInput,
  draftOf,
  emptyDraft,
  hasAmount,
  removeRule,
  restoreRule,
  textFromSatang,
  type ApproverValue,
  type Band,
  type DocType,
  type DraftInput,
  type FollowNote,
  type PolicyKey,
  type PolicyState,
  type Quorum,
  type RowDraft,
  type RowError,
  type RowField,
  type RuleState,
} from './editor-model'
import { DOA_REASONS } from './import-form'
import { LintIssueText } from './lint-issue'

// The DOA editor (FR-DOA-001 AC1): a copy of a version — by default the latest — edited as a table per document type
// and saved once as a new draft; the source never changes. Three real steps (§9.9: no page of more than 8 fields):
// (1) the rules, one row at a time (band, approver from the organization's positions, time under the SLA; removing a
// rule is outlined in danger away from save, and one press brings it back; a rule's step may be a committee of several
// positions with the votes it needs, FR-WF-102), (2) the version's policies, (3) the
// effective date, the reason and the save, which says first that a saved draft keeps its number. The service checks
// everything again, runs the lint and answers with what to fix; a refusal about a rule goes back to step 1 at that rule.

export type SaveDoaDraftResult = { readonly ok: true; readonly versionId: string; readonly code: string; readonly versionNo: number } | ActionFailure
export type SaveDoaDraftAction = (input: DraftInput, idempotencyKey: string) => Promise<SaveDoaDraftResult>

export interface EditorRuleInput {
  readonly code: string
  readonly documentType: DocType
  readonly band: Band | null
  readonly steps: ReadonlyArray<{ readonly approver: ApproverValue; readonly slaMinutes: number; readonly committee?: { readonly approvers: readonly ApproverValue[]; readonly quorum: Quorum; readonly quorumCount: number | null } }>
}

export interface EditorPolicyInput {
  readonly amountBasis: 'GROSS' | 'NET'
  readonly selfApprovalPolicy: 'ESCALATE_NEXT_BAND' | 'BLOCK'
  readonly collapseDuplicateApprovers: boolean
  /** satang text; null = not set */
  readonly stepUpThreshold: string | null
  readonly approverMayReceive: boolean
  readonly requesterMayReceive: boolean
  readonly doaAdminSeparated: boolean
}

export interface DoaEditorProps {
  readonly sourceVersionId: string
  readonly code: string
  readonly sourceVersionNo: number
  readonly nextVersionNo: number
  /** YYYY-MM-DD, Thai calendar */
  readonly defaultEffectiveDate: string
  readonly minEffectiveDate: string
  readonly policy: EditorPolicyInput
  readonly rules: readonly EditorRuleInput[]
  readonly positions: ReadonlyArray<Named & { readonly code: string; readonly scope: 'DEPARTMENT' | 'ORG' }>
  readonly members: ReadonlyArray<Named & { readonly id: string }>
  readonly save: SaveDoaDraftAction
}

type Step = 1 | 2 | 3
/** What the last row action did, about one document type's rules */
type RowNotice =
  | { readonly kind: 'follow'; readonly documentType: DocType; readonly followed: readonly FollowNote[]; readonly notFollowed: readonly string[] }
  | { readonly kind: 'removed'; readonly documentType: DocType; readonly rule: RuleState; readonly index: number }
  | { readonly kind: 'restored'; readonly documentType: DocType; readonly code: string }
/** The one row being edited: an existing row by its key, or a new one of a document type */
type Editing = { readonly key: number | 'new'; readonly documentType: DocType; readonly draft: RowDraft; readonly errors: Partial<Record<RowField, RowError>> }
type DateError = 'DATE' | 'MIN' | 'EFFECTIVE_IN_PAST' | 'LATER_VERSION_SCHEDULED'

/** Reasons of this form after the shared DOA ones (their messages are under adminDoa.errors) */
const EDITOR_REASONS = [...DOA_REASONS, 'DUPLICATE_RULE', 'BAND_ORDER', 'BAND_NOT_ALLOWED'] as const
const MINUTES_PER_HOUR = 60
const policyOf = (p: EditorPolicyInput): PolicyState => ({ ...p, stepUpThreshold: textFromSatang(p.stepUpThreshold) })

export function DoaEditor(props: DoaEditorProps) {
  const t = useTranslations('adminDoa.editor')
  const tDoa = useTranslations('adminDoa')
  const tDetail = useTranslations('adminDoa.detail')
  const locale = useLocale()
  const id = useId()
  const action = useAction()
  const stepRef = useRef<HTMLHeadingElement>(null)
  const moved = useRef(false)
  const sourceRules = useRef<readonly RuleState[]>(props.rules.map((r, i) => ({ ...r, key: i, isNew: false })))
  const sourcePolicy = useRef<PolicyState>(policyOf(props.policy))
  const [step, setStep] = useState<Step>(1)
  const [rules, setRules] = useState<readonly RuleState[]>(sourceRules.current)
  const [nextKey, setNextKey] = useState(props.rules.length)
  const [editing, setEditing] = useState<Editing | null>(null)
  /**
   * What the last row action did, shown in the table of that rule's document type (where the user is, on a phone too):
   * the bands next to it that moved along, or the rule removed — with where it stood, so one press brings it back (a
   * removal is never confirmed, it is undone) — or the rule brought back
   */
  const [notice, setNotice] = useState<RowNotice | null>(null)
  const [ruleErrors, setRuleErrors] = useState<Readonly<Record<number, string>>>({})
  const [listFailure, setListFailure] = useState<string | null>(null)
  const [policy, setPolicy] = useState<PolicyState>(sourcePolicy.current)
  const [stepUpError, setStepUpError] = useState<string | undefined>()
  const [effectiveDate, setEffectiveDate] = useState(props.defaultEffectiveDate)
  const [dateError, setDateError] = useState<{ readonly code: DateError; readonly version?: string } | null>(null)
  const [reason, setReason] = useState('')
  const [reasonError, setReasonError] = useState<string | undefined>()
  const [lintErrors, setLintErrors] = useState<readonly IssueView[]>([])
  const [failure, setFailure] = useState<string | null>(null)
  const [saved, setSaved] = useState<{ readonly versionId: string; readonly name: string } | null>(null)

  const draftName = tDoa('versionName', { code: props.code, version: props.nextVersionNo })
  const sourceName = tDoa('versionName', { code: props.code, version: props.sourceVersionNo })

  // Each step starts at its heading, so a screen reader and the keyboard follow the change of step
  useEffect(() => {
    if (moved.current) stepRef.current?.focus()
  }, [step])
  const goTo = (next: Step) => {
    moved.current = true
    setStep(next)
  }

  const documentType = (d: DocType) => tDoa(`documentTypes.${d}`)
  const positionName = (code: string) => {
    const p = props.positions.find((x) => x.code === code)
    return p ? `${nameIn(locale, p)} (${p.code})` : code
  }
  const approverText = (a: ApproverValue) => {
    if (a.kind === 'MEMBER') {
      const m = props.members.find((x) => x.id === a.memberId)
      return tDetail('approver.MEMBER', { name: m ? nameIn(locale, m) : a.memberId })
    }
    return tDetail(`approver.${a.kind}`, { position: positionName(a.position) })
  }
  /** One approver, or a committee with the votes it needs */
  const stepText = (s: RuleState['steps'][number]) => {
    const c = s.committee
    if (!c) return approverText(s.approver)
    const approvers = c.approvers.map(approverText).join(', ')
    return c.quorum === 'COUNT' ? tDetail('committee.COUNT', { approvers, count: c.quorumCount ?? c.approvers.length }) : tDetail(`committee.${c.quorum}`, { approvers })
  }
  const slaText = (minutes: number) => (minutes % MINUTES_PER_HOUR === 0 ? tDetail('sla', { hours: minutes / MINUTES_PER_HOUR }) : tDetail('slaMinutes', { minutes }))
  const money = (satang: string) => textFromSatang(satang)
  const bandWords = (band: Band | null) => {
    if (!band) return tDetail('anyAmount')
    const b = bandText(band.lowerKind === 'gte' ? { gte: band.lower, lte: band.upper } : { gt: band.lower, lte: band.upper })
    return tDoa(`band.${b.key}`, b.values)
  }

  /** The approvers a rule may name: every position with the kind its scope gives, and the rule's own if it differs */
  const approverOptions = (current: string) => {
    const options = props.positions.map((p) => {
      const value: ApproverValue = { kind: p.scope === 'ORG' ? 'POSITION_OF_ORG' : 'POSITION_OF_DEPARTMENT', position: p.code }
      return { value: approverKey(value), label: approverText(value) }
    })
    if (current && !options.some((o) => o.value === current)) {
      const own = editing ? rules.find((r) => r.key === editing.key)?.steps[0]?.approver : undefined
      if (own && approverKey(own) === current) options.push({ value: current, label: approverText(own) })
    }
    return options
  }

  function startEdit(rule: RuleState | null, type: DocType) {
    setListFailure(null)
    setNotice(null)
    setEditing(rule ? { key: rule.key, documentType: rule.documentType, draft: draftOf(rule), errors: {} } : { key: 'new', documentType: type, draft: emptyDraft(rules, type), errors: {} })
  }

  function changeDraft(change: Partial<RowDraft>) {
    // What is shown is about what is there now: a changed field loses its old error at once
    setEditing((e) => (e ? { ...e, draft: { ...e.draft, ...change }, errors: Object.fromEntries(Object.entries(e.errors).filter(([k]) => !(k in change))) } : e))
  }

  function saveRow() {
    if (!editing) return
    const result = applyDraft(rules, { key: editing.key, documentType: editing.documentType, newKey: nextKey }, editing.draft)
    if (!result.ok) return setEditing({ ...editing, errors: result.errors })
    if (editing.key === 'new') setNextKey((k) => k + 1)
    const key = editing.key === 'new' ? nextKey : editing.key
    setRules(result.rules)
    setRuleErrors((e) => Object.fromEntries(Object.entries(e).filter(([k]) => Number(k) !== key)))
    setNotice(result.followed.length || result.notFollowed.length ? { kind: 'follow', documentType: editing.documentType, followed: result.followed, notFollowed: result.notFollowed } : null)
    setEditing(null)
  }

  function removeRow(rule: RuleState) {
    setNotice({ kind: 'removed', documentType: rule.documentType, rule, index: rules.findIndex((r) => r.key === rule.key) })
    setRules((list) => removeRule(list, rule.key))
    setRuleErrors((e) => Object.fromEntries(Object.entries(e).filter(([k]) => Number(k) !== rule.key)))
    setEditing(null)
  }

  /** Puts the rule removed last back where it stood, as it was */
  function restoreRow() {
    if (notice?.kind !== 'removed') return
    const { rule, index } = notice
    setRules((list) => restoreRule(list, rule, index))
    setNotice({ kind: 'restored', documentType: rule.documentType, code: rule.code })
  }

  function toPolicies() {
    if (editing) return setListFailure(t('finishEditing'))
    setListFailure(null)
    goTo(2)
  }

  function toSave() {
    const stepUp = draftInput(props.sourceVersionId, rules, policy, effectiveDate, reason)
    if ('error' in stepUp) return setStepUpError(t('stepUpError'))
    setStepUpError(undefined)
    goTo(3)
  }

  async function onSave(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setFailure(null)
    setLintErrors([])
    const trimmed = reason.trim()
    const reasonProblem = trimmed.length < 3 ? tDoa('errors.REASON') : trimmed.length > REASON_MAX_LENGTH ? tDoa('errors.REASON_TOO_LONG', { max: REASON_MAX_LENGTH }) : undefined
    setReasonError(reasonProblem)
    const dateProblem: DateError | null = !thaiLocalToIso(`${effectiveDate}T00:00`) ? 'DATE' : effectiveDate < props.minEffectiveDate ? 'MIN' : null
    setDateError(dateProblem ? { code: dateProblem } : null)
    if (reasonProblem || dateProblem) return
    const input = draftInput(props.sourceVersionId, rules, policy, effectiveDate, trimmed)
    if ('error' in input) {
      setStepUpError(t('stepUpError'))
      return goTo(2)
    }
    const outcome = await action.run((key) => props.save(input, key))
    if (outcome.ok) {
      // No refresh: this page would then offer the number after it, while the user goes on to the draft just saved
      setSaved({ versionId: outcome.versionId, name: tDoa('versionName', { code: outcome.code, version: outcome.versionNo }) })
      return
    }
    if (outcome.code === 'DOA_LINT_FAILED' && outcome.errors?.length) {
      setLintErrors(outcome.errors)
      return setFailure(t('errorsTitle'))
    }
    if (outcome.field === 'effectiveDate' && (outcome.reason === 'EFFECTIVE_IN_PAST' || outcome.reason === 'LATER_VERSION_SCHEDULED' || outcome.reason === 'DATE')) {
      return setDateError({ code: outcome.reason, version: outcome.versionNo !== undefined ? String(outcome.versionNo) : undefined })
    }
    if (outcome.field === 'changeReason') return setReasonError(trimmed.length > REASON_MAX_LENGTH ? tDoa('errors.REASON_TOO_LONG', { max: REASON_MAX_LENGTH }) : tDoa('errors.REASON'))
    const message = tDoa(`errors.${failureKey(outcome, EDITOR_REASONS)}`, errorValues(outcome))
    // A refusal about one rule (rules.<i>…) goes back to the table, at that rule
    const at = /^rules\.(\d+)/.exec(outcome.field ?? '')
    const target = at ? rules[Number(at[1])] : undefined
    if (target) {
      setRuleErrors({ [target.key]: message })
      return goTo(1)
    }
    if (outcome.field?.startsWith('policy')) {
      setStepUpError(message)
      return goTo(2)
    }
    setFailure(message)
  }

  if (saved) {
    return (
      <Notice tone="success">
        <p>{t('saved', { name: saved.name })}</p>
        <Link href={`/admin/doa/${saved.versionId}`} className="inline-flex min-h-11 items-center font-medium text-primary underline underline-offset-4 hover:no-underline">
          {t('openSaved', { name: saved.name })}
        </Link>
      </Notice>
    )
  }

  const steps = (
    <ol aria-label={t('steps.label')} className="flex flex-wrap gap-x-6 gap-y-1 border-b border-line">
      {[t('steps.rules'), t('steps.policy'), t('steps.save')].map((label, i) => (
        <li key={label} aria-current={step === i + 1 ? 'step' : undefined} className={step === i + 1 ? '-mb-px border-b-2 border-primary py-2 font-semibold text-ink' : 'py-2 text-ink-muted'}>
          {t('stepLabel', { n: i + 1, name: label })}
        </li>
      ))}
    </ol>
  )

  const heading = (text: string) => (
    <h2 ref={stepRef} tabIndex={-1} className="text-xl font-semibold outline-none">
      {text}
    </h2>
  )

  // ---------- step 1: the rules ----------

  /**
   * One approver or a committee (FR-WF-102): the switch, then the members ticked from the organization's positions and,
   * for "by count", how many must approve. The quorum's list sits in the grid above, where the approver's was.
   */
  const committeeFields = (e: Editing, field: (f: string) => string, error: (f: RowField) => string | undefined) => {
    const toggle = (key: string, checked: boolean) => changeDraft({ members: checked ? [...e.draft.members, key] : e.draft.members.filter((m) => m !== key) })
    const options = approverOptions('')
    // Members the rule names that are not positions of the list (a named person) stay ticked and can be unticked
    for (const key of e.draft.members) {
      const own = rules.find((r) => r.key === e.key)?.steps[0]?.committee?.approvers.find((a) => approverKey(a) === key)
      if (own && !options.some((o) => o.value === key)) options.push({ value: key, label: approverText(own) })
    }
    const membersError = error('members')
    return (
      <div className="flex flex-col gap-3">
        <label className="flex min-h-11 items-center gap-3">
          <input type="checkbox" checked={e.draft.committee} onChange={(ev) => changeDraft({ committee: ev.currentTarget.checked })} className="size-5 shrink-0" />
          <span>{t('committee')}</span>
        </label>
        {e.draft.committee ? (
          <>
            <fieldset className="flex flex-col gap-1" aria-describedby={membersError ? field('members-error') : undefined}>
              <legend className="mb-1 font-medium">{t('members')}</legend>
              <p className="text-base text-ink-muted md:text-sm">{t('membersHint')}</p>
              <div className="grid gap-x-6 md:grid-cols-2">
                {options.map((o) => (
                  <label key={o.value} className="flex min-h-11 items-center gap-3">
                    <input type="checkbox" checked={e.draft.members.includes(o.value)} onChange={(ev) => toggle(o.value, ev.currentTarget.checked)} className="size-5 shrink-0" />
                    <span>{o.label}</span>
                  </label>
                ))}
              </div>
              {membersError ? (
                <p id={field('members-error')} className="text-danger">
                  {membersError}
                </p>
              ) : null}
            </fieldset>
            {e.draft.quorum === 'COUNT' ? (
              <Field
                id={field('quorumCount')}
                label={t('quorumCount')}
                hint={t('quorumCountHint', { count: e.draft.members.length })}
                inputMode="numeric"
                value={e.draft.quorumCount}
                onChange={(ev) => changeDraft({ quorumCount: ev.currentTarget.value })}
                error={error('quorumCount')}
                className="max-w-xs"
              />
            ) : null}
          </>
        ) : null}
      </div>
    )
  }

  const rowEditor = (e: Editing) => {
    const rule = e.key === 'new' ? null : (rules.find((r) => r.key === e.key) ?? null)
    const name = rule ? rule.code : documentType(e.documentType)
    const field = (f: string) => `${id}-${f}`
    const lowerKind = rule?.band?.lowerKind ?? 'gt'
    const error = (f: RowField) => (e.errors[f] ? t(`rowErrors.${e.errors[f]}`) : undefined)
    const multi = rule !== null && rule.steps.length > 1
    return (
      <fieldset className="flex flex-col gap-4 border-l-4 border-primary py-1 pl-3">
        <legend className="float-left mb-1 w-full font-semibold">{rule ? t('editTitle', { rule: name }) : t('addTitle', { documentType: name })}</legend>
        {rule === null || rule.isNew ? (
          <Field id={field('code')} label={t('code')} hint={t('codeHint')} value={e.draft.code} onChange={(ev) => changeDraft({ code: ev.currentTarget.value })} error={error('code')} maxLength={40} className="max-w-xs" />
        ) : null}
        {/* The approver gets the room it needs on wide screens; the amounts and the hours stay narrow */}
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-[11rem_11rem_minmax(0,1fr)_15rem]">
          {hasAmount(e.documentType) ? (
            <>
              <Field
                id={field('lower')}
                label={lowerKind === 'gte' ? t('lowerGte') : t('lowerGt')}
                hint={t('lowerHint')}
                inputMode="decimal"
                value={e.draft.lower}
                onChange={(ev) => changeDraft({ lower: ev.currentTarget.value })}
                error={error('lower')}
                className="money"
              />
              <Field id={field('upper')} label={t('upper')} hint={t('upperHint')} inputMode="decimal" value={e.draft.upper} onChange={(ev) => changeDraft({ upper: ev.currentTarget.value })} error={error('upper')} className="money" />
            </>
          ) : null}
          {multi ? null : (
            <>
              {e.draft.committee ? (
                <SelectField
                  id={field('quorum')}
                  label={t('quorum')}
                  value={e.draft.quorum}
                  onChange={(ev) => changeDraft({ quorum: ev.currentTarget.value as Quorum })}
                  options={QUORUMS.map((q) => ({ value: q, label: t(`quorums.${q}`) }))}
                />
              ) : (
                <SelectField
                  id={field('approver')}
                  label={t('approver')}
                  placeholder={tDoa('choose')}
                  value={e.draft.approver}
                  onChange={(ev) => changeDraft({ approver: ev.currentTarget.value })}
                  options={approverOptions(e.draft.approver)}
                  error={error('approver')}
                />
              )}
              <Field id={field('sla')} label={t('sla')} hint={t('slaHint')} inputMode="numeric" value={e.draft.slaHours} onChange={(ev) => changeDraft({ slaHours: ev.currentTarget.value })} error={error('slaHours')} />
            </>
          )}
        </div>
        {multi ? null : committeeFields(e, field, error)}
        {multi ? <p className="text-base text-ink-muted md:text-sm">{t('multiStep', { count: rule.steps.length })}</p> : null}
        {/* Save and cancel together; removing is outlined in danger at the far end, away from save, and can be undone */}
        <div className="flex flex-wrap items-center gap-3">
          <Button onClick={saveRow}>{rule ? t('saveRow') : t('addSave')}</Button>
          <Button variant="secondary" onClick={() => setEditing(null)}>
            {t('cancel')}
          </Button>
          {rule ? (
            // A short word on the button; its accessible name starts with it and says which rule (WCAG 2.5.3)
            <Button variant="danger" className="ml-auto" aria-label={t('removeRule', { rule: rule.code })} onClick={() => removeRow(rule)}>
              <Trash2 className="size-4 shrink-0" aria-hidden="true" />
              {t('removeRow')}
            </Button>
          ) : null}
        </div>
      </fieldset>
    )
  }

  const tag = (children: ReactNode) => <span className="inline-flex items-center gap-1 rounded-sm border border-line px-1.5 text-base font-normal text-ink md:text-sm">{children}</span>
  // A document type with amounts has the two band columns; a policy change (no amount, BR-DOA-08 (จ)) has none
  const ROW_GRID = 'md:grid-cols-[10rem_9rem_9rem_minmax(0,1fr)_auto]'
  const ROW_GRID_NO_AMOUNT = 'md:grid-cols-[10rem_minmax(0,1fr)_auto]'

  const ruleRow = (r: RuleState) => {
    const source = sourceRules.current.find((s) => s.code === r.code && s.documentType === r.documentType)
    const parts = changedParts(source, r)
    const amounts = hasAmount(r.documentType)
    return (
      <div className={`grid grid-cols-1 gap-1 md:items-baseline md:gap-x-4 ${amounts ? ROW_GRID : ROW_GRID_NO_AMOUNT}`}>
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 font-semibold">
          <span className="md:sr-only">{t('headers.rule')}</span> <span>{r.code}</span>
          {r.isNew ? tag(<><CirclePlus className="size-3.5 shrink-0" aria-hidden="true" />{t('tagNew')}</>) : parts.length ? tag(<><PenLine className="size-3.5 shrink-0" aria-hidden="true" />{t('tagChanged', { parts: parts.map((p) => tDetail(`ruleFields.${p}`)).join(', ') })}</>) : null}
        </p>
        {!amounts ? null : r.band ? (
          <>
            <p className="flex justify-between gap-4 md:block md:text-right">
              <span className="shrink-0 text-ink-muted md:sr-only">{r.band.lowerKind === 'gte' ? t('lowerGte') : t('lowerGt')}</span>
              <span className="tabular">{r.band.lower === null ? money('0') : money(r.band.lower)}</span>
            </p>
            <p className="flex justify-between gap-4 md:block md:text-right">
              <span className="shrink-0 text-ink-muted md:sr-only">{t('upper')}</span>
              <span className="tabular">{r.band.upper === null ? tDetail('noLimit') : money(r.band.upper)}</span>
            </p>
          </>
        ) : (
          <p className="md:col-span-2 md:text-right">{tDetail('anyAmount')}</p>
        )}
        <div className="flex min-w-0 flex-col">
          <span className="text-ink-muted md:sr-only">{t('approver')}</span>
          <span className="break-words">{r.steps.map(stepText).join(', ')}</span>
          <span className="text-base text-ink-muted md:text-sm">{r.steps.map((s) => slaText(s.slaMinutes)).join(', ')}</span>
        </div>
        <Button variant="secondary" className="mt-1 justify-self-start md:mt-0" aria-label={t('editRule', { rule: r.code })} onClick={() => startEdit(r, r.documentType)}>
          {t('edit')}
        </Button>
      </div>
    )
  }

  const noticeView = (n: RowNotice) =>
    n.kind === 'removed' ? (
      <Notice tone="info">
        <p>{t('removed', { rule: n.rule.code })}</p>
        <Button variant="secondary" className="mt-2" onClick={restoreRow}>
          <Undo2 className="size-4 shrink-0" aria-hidden="true" />
          {t('restoreRule', { rule: n.rule.code })}
        </Button>
      </Notice>
    ) : n.kind === 'restored' ? (
      <Notice tone="info">{t('restored', { rule: n.code })}</Notice>
    ) : (
      <Notice tone={n.notFollowed.length ? 'warning' : 'info'}>
        {n.followed.length ? (
          <p>
            {t('followed', {
              list: n.followed.map((f) => (f.end === 'lower' ? t('followedLower', { rule: f.code, amount: money(f.to) }) : t('followedUpper', { rule: f.code, amount: money(f.to) }))).join(', '),
            })}
          </p>
        ) : null}
        {n.notFollowed.length ? <p>{t('notFollowed', { rules: n.notFollowed.join(', ') })}</p> : null}
      </Notice>
    )

  if (step === 1) {
    return (
      <div className="flex flex-col gap-6">
        {steps}
        {heading(t('rulesTitle'))}
        <p className="text-base text-ink-muted md:text-sm">{t('rulesHint')}</p>
        {listFailure ? <Notice tone="danger">{listFailure}</Notice> : null}
        {DOC_TYPES.map((type) => {
          const group = rules.filter((r) => r.documentType === type)
          const headingId = `${id}-type-${type}`
          return (
            <section key={type} aria-labelledby={headingId} className="flex flex-col gap-2">
              <h3 id={headingId} className="text-lg font-semibold">
                {documentType(type)}
              </h3>
              {group.length === 0 ? (
                <p className="border-y border-line py-3 text-ink-muted">{t('noRules')}</p>
              ) : (
                <>
                  <div className={`hidden border-b border-line pb-2 text-sm font-medium text-ink-muted md:grid md:gap-x-4 ${hasAmount(type) ? ROW_GRID : ROW_GRID_NO_AMOUNT}`} aria-hidden="true">
                    <span>{t('headers.rule')}</span>
                    {hasAmount(type) ? (
                      <>
                        <span className="text-right">{t('lowerGt')}</span>
                        <span className="text-right">{t('upper')}</span>
                      </>
                    ) : null}
                    <span>{t('headers.approverSla')}</span>
                    <span />
                  </div>
                  <ul aria-label={documentType(type)} className="flex flex-col divide-y divide-line border-b border-line">
                    {group.map((r) => (
                      <li key={r.key} className="flex flex-col gap-2 py-3">
                        {editing?.key === r.key ? rowEditor(editing) : ruleRow(r)}
                        {ruleErrors[r.key] ? <Notice tone="danger">{t('ruleProblem', { rule: r.code, problem: ruleErrors[r.key]! })}</Notice> : null}
                      </li>
                    ))}
                  </ul>
                </>
              )}
              {/* Always there, so what is said in it is announced; it holds the notice about this type's rules */}
              <div aria-live="polite">{notice?.documentType === type ? noticeView(notice) : null}</div>
              {editing?.key === 'new' && editing.documentType === type ? (
                rowEditor(editing)
              ) : (
                <Button variant="secondary" className="self-start" onClick={() => startEdit(null, type)}>
                  {t('addRule', { documentType: documentType(type) })}
                </Button>
              )}
            </section>
          )
        })}
        <Button className="self-start" onClick={toPolicies}>
          {t('nextPolicy')}
        </Button>
      </div>
    )
  }

  // ---------- step 2: the policies ----------

  const changed = changedPolicies(sourcePolicy.current, policy)
  const legend = (key: PolicyKey, text: string) => (
    <legend className="float-left mb-1.5 flex w-full flex-wrap items-center gap-x-2 gap-y-1 font-medium text-ink">
      <span>{text}</span>
      {changed.includes(key) ? tag(<><PenLine className="size-3.5 shrink-0" aria-hidden="true" />{t('changedFrom', { name: sourceName })}</>) : null}
    </legend>
  )
  const radios = <V extends string | boolean>(key: PolicyKey, choices: ReadonlyArray<{ value: V; label: string }>, value: V, set: (v: V) => void) => (
    <fieldset className="flex flex-col gap-1">
      {legend(key, tDetail(`policy.${key}`))}
      {choices.map((c) => (
        <label key={String(c.value)} className="flex min-h-11 items-center gap-3">
          <input type="radio" name={`${id}-${key}`} checked={value === c.value} onChange={() => set(c.value)} className="size-5 shrink-0" />
          <span>{c.label}</span>
        </label>
      ))}
    </fieldset>
  )
  const setP = <K extends keyof PolicyState>(k: K, v: PolicyState[K]) => setPolicy((p) => ({ ...p, [k]: v }))

  if (step === 2) {
    return (
      <div className="flex flex-col gap-6">
        {steps}
        {heading(t('policyTitle'))}
        <p className="text-base text-ink-muted md:text-sm">{t('policyHint')}</p>
        <div className="grid gap-6 md:grid-cols-2">
          {radios('amountBasis', [{ value: 'GROSS' as const, label: tDetail('policy.GROSS') }, { value: 'NET' as const, label: tDetail('policy.NET') }], policy.amountBasis, (v) => setP('amountBasis', v))}
          <fieldset className="flex flex-col gap-1">
            {legend('stepUpThreshold', tDetail('policy.stepUpThreshold'))}
            <Field
              id={`${id}-stepUp`}
              label={t('stepUpLabel')}
              hint={t('stepUpHint')}
              inputMode="decimal"
              value={policy.stepUpThreshold}
              onChange={(ev) => {
                setP('stepUpThreshold', ev.currentTarget.value)
                setStepUpError(undefined)
              }}
              error={stepUpError}
              className="money max-w-xs"
            />
          </fieldset>
          {radios('approverMayReceive', [{ value: true, label: tDetail('policy.yes') }, { value: false, label: tDetail('policy.no') }], policy.approverMayReceive, (v) => setP('approverMayReceive', v))}
          {radios('requesterMayReceive', [{ value: true, label: tDetail('policy.yes') }, { value: false, label: tDetail('policy.no') }], policy.requesterMayReceive, (v) => setP('requesterMayReceive', v))}
          {radios(
            'selfApprovalPolicy',
            [
              { value: 'ESCALATE_NEXT_BAND' as const, label: tDetail('policy.ESCALATE_NEXT_BAND') },
              { value: 'BLOCK' as const, label: tDetail('policy.BLOCK') },
            ],
            policy.selfApprovalPolicy,
            (v) => setP('selfApprovalPolicy', v),
          )}
          {radios('doaAdminSeparated', [{ value: false, label: tDetail('policy.doaAdminTogether') }, { value: true, label: tDetail('policy.doaAdminApart') }], policy.doaAdminSeparated, (v) => setP('doaAdminSeparated', v))}
          {radios('collapseDuplicateApprovers', [{ value: true, label: tDetail('policy.on') }, { value: false, label: tDetail('policy.off') }], policy.collapseDuplicateApprovers, (v) => setP('collapseDuplicateApprovers', v))}
        </div>
        <div className="flex flex-wrap gap-3">
          <Button variant="secondary" onClick={() => goTo(1)}>
            {t('backRules')}
          </Button>
          <Button onClick={toSave}>{t('nextSave')}</Button>
        </div>
      </div>
    )
  }

  // ---------- step 3: effective date, reason and save ----------

  const changedRules = rules.filter((r) => !r.isNew && changedParts(sourceRules.current.find((s) => s.code === r.code && s.documentType === r.documentType), r).length)
  const added = rules.filter((r) => r.isNew)
  const removed = sourceRules.current.filter((s) => !rules.some((r) => !r.isNew && r.code === s.code))
  // Band, approver and time under the SLA each on a line of its own, as the rows of step 1 show them: joined into one
  // line with "·" they broke on phones with the dot left at a line end
  const ruleLines = (r: RuleState) => (
    <>
      <span className="tabular text-ink-muted">{bandWords(r.band)}</span>
      <span className="text-ink-muted">{r.steps.map(stepText).join(', ')}</span>
      <span className="text-ink-muted">{r.steps.map((s) => slaText(s.slaMinutes)).join(', ')}</span>
    </>
  )
  const echo = () => {
    const at = thaiLocalToIso(`${effectiveDate}T00:00`)
    return at ? t('effectiveEcho', { time: formatDateTime(locale, at) }) : t('effectiveHint')
  }
  const dateMessage = dateError
    ? dateError.code === 'MIN'
      ? t('dateErrors.MIN', { date: formatDateTime(locale, thaiLocalToIso(`${props.minEffectiveDate}T00:00`) ?? props.minEffectiveDate) })
      : t(`dateErrors.${dateError.code}`, { version: dateError.version ?? '' })
    : undefined

  return (
    <form onSubmit={onSave} className="flex flex-col gap-6" noValidate>
      {steps}
      {heading(t('saveTitle'))}
      <section aria-labelledby={`${id}-summary`} className="flex flex-col gap-2">
        <h3 id={`${id}-summary`} className="text-lg font-semibold">
          {t('summaryTitle', { name: sourceName })}
        </h3>
        {changedRules.length + added.length + removed.length + changed.length === 0 ? (
          <p className="text-ink-muted">{t('summaryNone', { name: sourceName })}</p>
        ) : (
          <ul className="flex flex-col divide-y divide-line border-y border-line">
            {changedRules.map((r) => (
              <li key={`changed-${r.key}`} className="flex flex-col gap-0.5 py-2.5">
                <span className="font-medium">{t('summaryChanged', { rule: r.code, documentType: documentType(r.documentType) })}</span>
                {ruleLines(r)}
              </li>
            ))}
            {added.map((r) => (
              <li key={`added-${r.key}`} className="flex flex-col gap-0.5 py-2.5">
                <span className="font-medium">{t('summaryAdded', { rule: r.code, documentType: documentType(r.documentType) })}</span>
                {ruleLines(r)}
              </li>
            ))}
            {removed.map((r) => (
              <li key={`removed-${r.key}`} className="py-2.5 font-medium">
                {t('summaryRemoved', { rule: r.code, documentType: documentType(r.documentType) })}
              </li>
            ))}
            {changed.length ? (
              <li className="py-2.5 font-medium">{t('summaryPolicies', { policies: changed.map((k) => tDetail(`policy.${k}`)).join(', ') })}</li>
            ) : null}
          </ul>
        )}
      </section>
      {failure ? (
        <Notice tone="danger">
          <p>{failure}</p>
          {lintErrors.length ? (
            <ul className="mt-2 flex list-disc flex-col gap-1 pl-5">
              {lintErrors.map((e, i) => (
                <li key={`${e.code}-${i}`}>
                  <LintIssueText issue={e} />
                </li>
              ))}
            </ul>
          ) : null}
        </Notice>
      ) : null}
      <div className="flex max-w-2xl flex-col gap-6">
        <Field
          id={`${id}-effective`}
          type="date"
          label={t('effective')}
          hint={echo()}
          min={props.minEffectiveDate}
          value={effectiveDate}
          onChange={(ev) => {
            setEffectiveDate(ev.currentTarget.value)
            setDateError(null)
          }}
          error={dateMessage}
          className="max-w-xs"
        />
        <Field
          id={`${id}-reason`}
          label={tDoa('import.reason')}
          hint={tDoa('import.reasonHint')}
          maxLength={REASON_MAX_LENGTH}
          value={reason}
          onChange={(ev) => {
            setReason(ev.currentTarget.value)
            setReasonError(undefined)
          }}
          error={reasonError}
        />
      </div>
      {/* Said before the button: a saved draft keeps its number for good (drafts are never deleted) */}
      <p className="max-w-2xl text-base text-ink-muted md:text-sm">{t('saveHint', { name: draftName })}</p>
      <div className="flex flex-wrap gap-3">
        <Button variant="secondary" onClick={() => goTo(2)}>
          {t('backPolicy')}
        </Button>
        <Button type="submit" disabled={action.pending}>
          {action.pending ? t('saving') : t('save', { name: draftName })}
        </Button>
      </div>
    </form>
  )
}
