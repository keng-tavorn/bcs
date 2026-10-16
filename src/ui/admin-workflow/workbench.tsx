'use client'

import { ArrowDown, ArrowUp, CirclePlus, PenLine, Trash2, Undo2 } from 'lucide-react'
import { useId, useState, type FormEvent, type ReactNode } from 'react'
import { REASON_MAX_LENGTH } from '@/lib/constants'
import { failureKey } from '../admin-org/outcome'
import { thaiLocalToIso } from '../admin-org/thai-time'
import { errorValues, useAction } from '../admin-org/use-action'
import { Button } from '../form/button'
import { Field } from '../form/field'
import { Notice } from '../form/notice'
import { formatDateTime } from '../format'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../shadcn/tabs'
import { DiffList, type WorkflowDiff } from './diff-list'
import { DryRun, type DryRunAction } from './dry-run'
import { changedParts, isDirty, moveRule, putRule, ruleIndexOf, saveInput, type DraftState, type RuleValue, type SaveInput, type TestCaseValue } from './model'
import { WORKFLOW_REASONS, type WorkflowFailure, type WorkflowIssue } from './outcome'
import { RuleDialog } from './rule-dialog'
import { SubmitPanel, type SubmitPanelProps, type SubmitWorkflowAction } from './submit-panel'
import { TestCases } from './test-cases'
import { useWorkflowWords, type WorkflowContext } from './words'

// One workflow version on screen (FR-WF-103 AC1 AC2, ADR-103, NG-4): tabs for its rules, the dry-run, the comparison
// with the version it is read beside and — for a draft — the lint and the send. A draft's rules are a list edited one
// rule at a time in a Dialog, moved up or down with buttons (no dragging), removed with one press and brought back
// with another; its test cases, effective date and reason sit under them, and one save sends the whole draft. Any save
// means the dry-run must run again before the send (the service clears it); while changes are unsaved the dry-run and
// the send say to save first. Any other version is read only: a change is a new draft. The 90-day backtest (BR-WF-13,
// S6-07) is a tab of its own when the page gives one: it runs on the saved draft, so with unsaved changes it says so.

export type SaveWorkflowResult = { readonly ok: true; readonly version: number } | WorkflowFailure
export type SaveWorkflowAction = (input: SaveInput, idempotencyKey: string) => Promise<SaveWorkflowResult>

export interface WorkbenchProps {
  readonly versionId: string
  readonly code: string
  readonly versionNo: number
  /** WorkflowVersion.version as read (§6.1 optimistic lock) */
  readonly lock: number
  readonly editable: boolean
  readonly changeReason: string | null
  readonly rules: readonly RuleValue[]
  readonly testCases: readonly TestCaseValue[]
  readonly baseline: { readonly code: string; readonly versionNo: number; readonly relation: 'IN_EFFECT' | 'PREVIOUS'; readonly rules: readonly RuleValue[] } | null
  readonly diff: WorkflowDiff | null
  readonly lint: { readonly errors: readonly WorkflowIssue[]; readonly warnings: ReadonlyArray<WorkflowIssue & { readonly key: string }> }
  readonly context: WorkflowContext
  readonly categoryCodes: readonly string[]
  readonly accountCodes: readonly string[]
  readonly effectiveDate: string
  readonly minEffectiveDate: string
  readonly slaMaxHours: number
  readonly canSimulate: boolean
  readonly dryRunDefaults: { readonly requesterMemberId: string | null; readonly chargedDepartmentId: string | null }
  readonly submit: Omit<SubmitPanelProps, 'versionId' | 'draftName' | 'errors' | 'warnings' | 'unsaved' | 'words' | 'submit'> | null
  readonly actions: { readonly save: SaveWorkflowAction; readonly dryRun: DryRunAction; readonly submit: SubmitWorkflowAction }
  /** The 90-day backtest panel (src/ui/backtest/panel.tsx), for a version it applies to and a reader who may run it */
  readonly backtest?: ReactNode
}

type Tab = 'rules' | 'dry-run' | 'backtest' | 'diff' | 'check'
type Removed = { readonly rule: RuleValue; readonly index: number }
type DateError = 'DATE' | 'MIN' | 'EFFECTIVE_IN_PAST' | 'LATER_VERSION_SCHEDULED'

const TRIGGER =
  'min-h-11 flex-none rounded-none border-0 border-b-2 border-transparent px-3 text-base font-medium text-ink-muted hover:text-ink data-[state=active]:border-primary data-[state=active]:text-ink md:text-sm'
const ROW_GRID = 'md:grid-cols-[8rem_minmax(0,1fr)_minmax(0,1.2fr)]'

export function Workbench(props: WorkbenchProps) {
  const words = useWorkflowWords(props.context)
  const { t, locale } = words
  const id = useId()
  const action = useAction()
  const draftName = words.versionName(props.code, props.versionNo)
  const [tab, setTab] = useState<Tab>('rules')
  const [lock, setLock] = useState(props.lock)
  const [saved, setSaved] = useState<DraftState>({ rules: props.rules, testCases: props.testCases, effectiveDate: props.effectiveDate })
  const [rules, setRules] = useState<readonly RuleValue[]>(props.rules)
  const [testCases, setTestCases] = useState<readonly TestCaseValue[]>(props.testCases)
  const [effectiveDate, setEffectiveDate] = useState(props.effectiveDate)
  const [reason, setReason] = useState(props.changeReason ?? '')
  const [dialog, setDialog] = useState<{ readonly rule: RuleValue | null } | null>(null)
  const [removed, setRemoved] = useState<Removed | null>(null)
  const [ruleProblem, setRuleProblem] = useState<{ readonly code: string; readonly message: string } | null>(null)
  const [dateError, setDateError] = useState<{ readonly code: DateError; readonly version?: string } | null>(null)
  const [reasonError, setReasonError] = useState<string | undefined>()
  const [failure, setFailure] = useState<string | null>(null)
  const [savedNotice, setSavedNotice] = useState(false)

  const dirty = props.editable && isDirty(saved, { rules, testCases, effectiveDate })
  const savedRules = saved.rules

  function edited() {
    setSavedNotice(false)
    setFailure(null)
  }

  function onSaveRule(rule: RuleValue, editing: string | null) {
    setRules((list) => putRule(list, rule, editing))
    setRemoved(null)
    if (ruleProblem?.code === (editing ?? rule.code)) setRuleProblem(null)
    setDialog(null)
    edited()
  }

  function remove(rule: RuleValue) {
    setRemoved({ rule, index: rules.findIndex((r) => r.code === rule.code) })
    setRules((list) => list.filter((r) => r.code !== rule.code))
    edited()
  }

  function restore() {
    if (!removed) return
    const { rule, index } = removed
    setRules((list) => (list.some((r) => r.code === rule.code) ? list : [...list.slice(0, index), rule, ...list.slice(index)]))
    setRemoved(null)
  }

  async function onSave(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setFailure(null)
    setSavedNotice(false)
    const trimmed = reason.trim()
    const reasonProblem = trimmed.length < 3 ? t('errors.REASON') : trimmed.length > REASON_MAX_LENGTH ? t('errors.REASON_TOO_LONG', { max: REASON_MAX_LENGTH }) : undefined
    setReasonError(reasonProblem)
    const dateProblem: DateError | null = !thaiLocalToIso(`${effectiveDate}T00:00`) ? 'DATE' : effectiveDate < props.minEffectiveDate ? 'MIN' : null
    setDateError(dateProblem ? { code: dateProblem } : null)
    if (reasonProblem || dateProblem) return
    const outcome = await action.run((key) => props.actions.save(saveInput(props.versionId, lock, effectiveDate, trimmed, rules, testCases), key))
    if (outcome.ok) {
      setLock(outcome.version)
      setSaved({ rules, testCases, effectiveDate })
      setSavedNotice(true)
      setRuleProblem(null)
      // The page reads the saved draft again: its lint, its comparison, and that the dry-run must run again
      action.done()
      return
    }
    if (outcome.field === 'effectiveDate' && (outcome.reason === 'EFFECTIVE_IN_PAST' || outcome.reason === 'LATER_VERSION_SCHEDULED' || outcome.reason === 'DATE')) {
      return setDateError({ code: outcome.reason, version: outcome.versionNo !== undefined ? String(outcome.versionNo) : undefined })
    }
    if (outcome.field === 'changeReason') return setReasonError(t('errors.REASON'))
    const message = t(`errors.${failureKey(outcome, WORKFLOW_REASONS)}`, errorValues(outcome))
    // A refusal about one rule goes to that rule in the list
    const at = ruleIndexOf(outcome.field)
    const target = at !== null ? rules[at] : undefined
    if (target) return setRuleProblem({ code: target.code, message })
    setFailure(message)
  }

  // ---------- the rules ----------

  const tag = (icon: 'new' | 'changed', text: string) => (
    <span className="inline-flex items-center gap-1 rounded-sm border border-line px-1.5 text-base font-normal text-ink md:text-sm">
      {icon === 'new' ? <CirclePlus className="size-3.5 shrink-0" aria-hidden="true" /> : <PenLine className="size-3.5 shrink-0" aria-hidden="true" />}
      {text}
    </span>
  )

  const ruleRow = (r: RuleValue, i: number) => {
    const before = savedRules.find((s) => s.code === r.code)
    const parts = changedParts(before, r)
    return (
      <li key={r.code} className="flex flex-col gap-2 py-3">
        <div className={`grid grid-cols-1 gap-2 md:items-baseline md:gap-x-4 ${ROW_GRID}`}>
          <p className="flex flex-wrap items-center gap-x-2 gap-y-1 font-semibold">
            <span className="md:sr-only">{t('headers.rule')}</span> <span>{r.code}</span>
            {props.editable && !before ? tag('new', t('tagNew')) : null}
            {props.editable && parts.length ? tag('changed', t('tagChanged', { parts: parts.map((p) => t(`parts.${p}`)).join(', ') })) : null}
          </p>
          <div className="flex min-w-0 flex-col">
            <span className="text-ink-muted md:sr-only">{t('headers.when')}</span>
            <span className="break-words">{r.requestTypeCodes.map(words.requestType).join(', ')}</span>
            <span className="text-base break-words text-ink-muted md:text-sm">{words.condition(r.when)}</span>
          </div>
          <div className="flex min-w-0 flex-col">
            <span className="text-ink-muted md:sr-only">{t('headers.who')}</span>
            <span className="break-words">{r.reviewers.map(words.reviewer).join(', ')}</span>
            <span className="text-base text-ink-muted md:text-sm">
              {words.mode(r.mode, r.quorumCount, r.reviewers.length)} · {words.sla(r.slaMinutes)}
            </span>
            <span className="text-base break-words text-ink-muted md:text-sm">{r.fallback ? t('fallbackLine', { reviewer: words.reviewer(r.fallback) }) : t('noFallback')}</span>
            {r.descriptionTh ? <span className="text-base break-words text-ink-muted md:text-sm">{r.descriptionTh}</span> : null}
          </div>
        </div>
        {props.editable ? (
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="secondary" aria-label={t('editRule', { rule: r.code })} onClick={() => setDialog({ rule: r })}>
              {t('edit')}
            </Button>
            <Button variant="secondary" aria-label={t('moveUpRule', { rule: r.code })} disabled={i === 0} onClick={() => {
                setRules((list) => moveRule(list, r.code, -1))
                edited()
              }}>
              <ArrowUp className="size-4 shrink-0" aria-hidden="true" />
              {t('moveUp')}
            </Button>
            <Button variant="secondary" aria-label={t('moveDownRule', { rule: r.code })} disabled={i === rules.length - 1} onClick={() => {
                setRules((list) => moveRule(list, r.code, 1))
                edited()
              }}>
              <ArrowDown className="size-4 shrink-0" aria-hidden="true" />
              {t('moveDown')}
            </Button>
            <Button variant="danger" className="ml-auto" aria-label={t('removeRuleNamed', { rule: r.code })} onClick={() => remove(r)}>
              <Trash2 className="size-4 shrink-0" aria-hidden="true" />
              {t('removeRule')}
            </Button>
          </div>
        ) : null}
        {ruleProblem?.code === r.code ? <Notice tone="danger">{t('ruleProblem', { rule: r.code, problem: ruleProblem.message })}</Notice> : null}
      </li>
    )
  }

  const echo = () => {
    const at = thaiLocalToIso(`${effectiveDate}T00:00`)
    return at ? t('effectiveEcho', { time: formatDateTime(locale, at) }) : t('effectiveHint')
  }
  const dateMessage = dateError
    ? dateError.code === 'MIN'
      ? t('dateErrors.MIN', { date: formatDateTime(locale, thaiLocalToIso(`${props.minEffectiveDate}T00:00`) ?? props.minEffectiveDate) })
      : t(`dateErrors.${dateError.code}`, { version: dateError.version ?? '' })
    : undefined

  const rulesTab = (
    <div className="flex flex-col gap-6">
      <section aria-labelledby={`${id}-rules`} className="flex flex-col gap-2">
        <h3 id={`${id}-rules`} className="text-lg font-semibold">
          {t('rulesTitle', { count: rules.length })}
        </h3>
        <p className="text-base text-ink-muted md:text-sm">{props.editable ? t('rulesHint') : t('rulesHintReadOnly')}</p>
        {rules.length === 0 ? (
          <p className="border-y border-line py-3 text-ink-muted">{t('noRules')}</p>
        ) : (
          <>
            <div className={`hidden border-b border-line pb-2 text-sm font-medium text-ink-muted md:grid md:gap-x-4 ${ROW_GRID}`} aria-hidden="true">
              <span>{t('headers.rule')}</span>
              <span>{t('headers.when')}</span>
              <span>{t('headers.who')}</span>
            </div>
            <ul aria-label={t('rulesListLabel')} className="flex flex-col divide-y divide-line border-b border-line">
              {rules.map(ruleRow)}
            </ul>
          </>
        )}
        <div aria-live="polite">
          {removed ? (
            <Notice tone="info">
              <p>{t('removed', { rule: removed.rule.code })}</p>
              <Button variant="secondary" className="mt-2" onClick={restore}>
                <Undo2 className="size-4 shrink-0" aria-hidden="true" />
                {t('restoreRule', { rule: removed.rule.code })}
              </Button>
            </Notice>
          ) : null}
        </div>
        {props.editable ? (
          <Button variant="secondary" className="self-start" onClick={() => setDialog({ rule: null })}>
            <CirclePlus className="size-4 shrink-0" aria-hidden="true" />
            {t('addRule')}
          </Button>
        ) : null}
      </section>

      <section aria-labelledby={`${id}-tests`} className="flex flex-col gap-2">
        <h3 id={`${id}-tests`} className="text-lg font-semibold">
          {t('testCases.title')}
        </h3>
        <p className="text-base text-ink-muted md:text-sm">{t('testCases.hint')}</p>
        <TestCases
          testCases={testCases}
          onChange={(list) => {
            setTestCases(list)
            edited()
          }}
          ruleCodes={rules.map((r) => r.code)}
          failing={dirty ? [] : (props.submit?.testCasesFailing ?? [])}
          editable={props.editable}
          context={props.context}
          words={words}
          categoryCodes={props.categoryCodes}
          accountCodes={props.accountCodes}
        />
      </section>

      {props.editable ? (
        <form onSubmit={onSave} className="flex flex-col gap-4 border-t border-line pt-4" noValidate aria-labelledby={`${id}-save`}>
          <h3 id={`${id}-save`} className="text-lg font-semibold">
            {t('saveTitle')}
          </h3>
          <div className="flex max-w-2xl flex-col gap-4">
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
                edited()
              }}
              error={dateMessage}
              className="max-w-xs"
            />
            <Field
              id={`${id}-reason`}
              label={t('reason')}
              hint={t('reasonHint')}
              maxLength={REASON_MAX_LENGTH}
              value={reason}
              onChange={(ev) => {
                setReason(ev.currentTarget.value)
                setReasonError(undefined)
              }}
              error={reasonError}
            />
          </div>
          {failure ? (
            <Notice tone="danger">
              <p>{failure}</p>
            </Notice>
          ) : null}
          <div aria-live="polite">{savedNotice && !dirty ? <Notice tone="success">{t('saved', { name: draftName })}</Notice> : null}</div>
          <p className="max-w-2xl text-base text-ink-muted md:text-sm">{dirty ? t('unsavedHint') : t('saveHint')}</p>
          <Button type="submit" disabled={action.pending} className="self-start">
            {action.pending ? t('saving') : t('save', { name: draftName })}
          </Button>
        </form>
      ) : null}
    </div>
  )

  // ---------- the tabs ----------

  const baselineName = props.baseline ? words.versionName(props.baseline.code, props.baseline.versionNo) : null
  const diffTitle = props.baseline ? (props.baseline.relation === 'IN_EFFECT' ? t('diffTab.titleInEffect', { name: baselineName! }) : t('diffTab.titlePrevious', { name: baselineName! })) : t('diffTab.titleNone')
  const blocked = dirty ? t('saveFirst') : null
  const tabs: Array<{ value: Tab; label: string; content: ReactNode }> = [
    { value: 'rules', label: t('tabs.rules'), content: rulesTab },
    ...(props.canSimulate
      ? [
          {
            value: 'dry-run' as const,
            label: t('tabs.dryRun'),
            content: (
              <DryRun
                versionId={props.versionId}
                draftName={draftName}
                currentName={props.baseline?.relation === 'IN_EFFECT' ? baselineName : null}
                blocked={blocked}
                defaults={props.dryRunDefaults}
                context={props.context}
                words={words}
                categoryCodes={props.categoryCodes}
                accountCodes={props.accountCodes}
                run={props.actions.dryRun}
              />
            ),
          },
        ]
      : []),
    ...(props.backtest
      ? [
          {
            value: 'backtest' as const,
            label: t('tabs.backtest'),
            content: (
              <div className="flex flex-col gap-3">
                {dirty ? <Notice tone="info">{t('backtestSavedOnly')}</Notice> : null}
                {props.backtest}
              </div>
            ),
          },
        ]
      : []),
    {
      value: 'diff',
      label: t('tabs.diff'),
      content: (
        <section aria-labelledby={`${id}-diff`} className="flex flex-col gap-3">
          <h3 id={`${id}-diff`} className="text-lg font-semibold">
            {diffTitle}
          </h3>
          {dirty ? <Notice tone="info">{t('diffTab.savedOnly')}</Notice> : null}
          {!props.baseline || !props.diff ? (
            <p className="text-ink-muted">{t('diffTab.first', { code: props.code })}</p>
          ) : props.diff.added.length + props.diff.removed.length + props.diff.changed.length === 0 ? (
            <p className="text-ink-muted">{t('diffTab.none', { name: baselineName! })}</p>
          ) : (
            <DiffList diff={props.diff} before={props.baseline.rules} after={savedRules} words={words} />
          )}
        </section>
      ),
    },
    ...(props.submit
      ? [
          {
            value: 'check' as const,
            label: t('tabs.check'),
            content: (
              <SubmitPanel
                {...props.submit}
                versionId={props.versionId}
                draftName={draftName}
                errors={props.lint.errors}
                warnings={props.lint.warnings}
                unsaved={dirty}
                words={words}
                submit={props.actions.submit}
              />
            ),
          },
        ]
      : []),
  ]

  return (
    <>
      <Tabs value={tabs.some((x) => x.value === tab) ? tab : 'rules'} onValueChange={(next) => setTab(next as Tab)} className="gap-4">
        {/* On a phone the tabs wrap to a second line: every tab stays in sight (no hidden scroll) */}
        <div className="border-b border-line">
          <TabsList aria-label={t('tabs.label')} variant="line" className="h-auto flex-wrap justify-start gap-0 p-0 group-data-horizontal/tabs:h-auto">
            {tabs.map((x) => (
              <TabsTrigger key={x.value} value={x.value} className={TRIGGER}>
                {x.label}
              </TabsTrigger>
            ))}
          </TabsList>
        </div>
        {tabs.map((x) => (
          <TabsContent key={x.value} value={x.value} className="min-w-0">
            {x.content}
          </TabsContent>
        ))}
      </Tabs>
      {props.editable ? (
        <RuleDialog
          open={dialog !== null}
          rule={dialog?.rule ?? null}
          rules={rules}
          context={props.context}
          words={words}
          categoryCodes={props.categoryCodes}
          accountCodes={props.accountCodes}
          slaMaxHours={props.slaMaxHours}
          onSave={onSaveRule}
          onClose={() => setDialog(null)}
        />
      ) : null}
    </>
  )
}
