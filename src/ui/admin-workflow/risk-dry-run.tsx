'use client'

import { CircleCheck, CirclePlus, PenLine, Trash2 } from 'lucide-react'
import { useId, useState, type FormEvent } from 'react'
import { failureKey } from '../admin-org/outcome'
import { SelectField } from '../admin-org/select-field'
import { errorValues, useAction } from '../admin-org/use-action'
import { Button } from '../form/button'
import { Field } from '../form/field'
import { Notice } from '../form/notice'
import type { DryRunAction, DryRunRiskRowView, DryRunRiskSideView } from './dry-run'
import { MAX_RISK_CASES, PAYEE_TYPES, RISK_TIERS, SCREENING_FIELDS, codesOf, riskCaseDraftOf, riskCaseOf, type PayeeType, type RiskCaseDraft, type RiskCaseValue, type RiskTier } from './model'
import { WORKFLOW_REASONS } from './outcome'
import type { WorkflowContext, WorkflowWords } from './words'

// The dry-run of the risk reviewers (S11-06 · FR-RSK-202 AC1 · BR-RSK-07): a few supplier risk assessments — the three
// screening answers, the tier and the tier before the answers, the supplier's categories, its payee type and who opened
// it — through the real engine (riskReviewers), the reviewers of the version in effect beside the draft's: each slot's
// rules, reviewer and the parts of the assessment they see, "no rule matches: it completes without reviewers", or why no
// reviewer was found. A difference is said in words with an icon, never colour alone (NFR-A11Y-03). One assessment is
// edited at a time (§9.9: no more than 8 fields on one page); all of them run together. Running it on a draft records
// that the dry-run ran on the latest save, which the send needs; it changes nothing else.

export interface RiskDryRunProps {
  readonly versionId: string
  /** "WF-SIMEC ฉบับ 2" */
  readonly draftName: string
  /** The version in effect it is read beside, or null when none is */
  readonly currentName: string | null
  /** Why it cannot run now (unsaved changes), or null */
  readonly blocked: string | null
  /** Who opens a new assessment to try: the dry-run's usual requester */
  readonly defaultOpenerId: string | null
  readonly context: WorkflowContext
  readonly words: WorkflowWords
  /** The category codes the editor knows, as a hint for the supplier's categories */
  readonly categoryCodes: readonly string[]
  readonly run: DryRunAction
}

/** An assessment in one line: its answers, tier (and the tier before the answers when it differs), payee, categories, opener */
export function riskCaseSummary(words: WorkflowWords, c: Pick<RiskCaseValue, 'screening' | 'tier' | 'payeeType' | 'openedById' | 'categoryCodes' | 'inherentTier'>): string {
  const { t } = words
  const values = {
    screening: SCREENING_FIELDS.map((f) => t('riskDryRun.answer', { field: words.riskField(f), answer: words.yesNo(c.screening[f]) })).join(' · '),
    tier: words.tier(c.tier),
    inherent: c.inherentTier ? words.tier(c.inherentTier) : '',
    payee: words.payeeType(c.payeeType),
    categories: c.categoryCodes.length ? c.categoryCodes.join(', ') : t('riskDryRun.noCategories'),
    opener: c.openedById ? words.member(c.openedById) : t('riskDryRun.noOpener'),
  }
  return c.inherentTier && c.inherentTier !== c.tier ? t('riskDryRun.summaryInherent', values) : t('riskDryRun.summary', values)
}

export interface RiskCaseResultProps {
  readonly id: string
  /** 1, 2, … as the assessments are listed */
  readonly n: number
  /** The assessment as it was run (the form may have changed since) */
  readonly tried: RiskCaseValue | undefined
  readonly row: DryRunRiskRowView
  readonly currentName: string | null
  readonly draftName: string
  readonly words: WorkflowWords
}

/** One assessment's reviewers under the version in effect beside the draft's */
export function RiskCaseResult({ id, n, tried, row, currentName, draftName, words }: RiskCaseResultProps) {
  const { t } = words
  const sideError = (e: NonNullable<DryRunRiskSideView['error']>) => {
    const rule = typeof e.details?.rule === 'string' ? e.details.rule : null
    if (e.code === 'REVIEWER_NOT_FOUND') return rule ? t('riskDryRun.sideErrors.REVIEWER_NOT_FOUND', { rule }) : t('riskDryRun.sideErrors.REVIEWER_NOT_FOUND_NO_RULE')
    return t('riskDryRun.sideErrors.OTHER', { code: e.code })
  }
  const names = (ids: readonly string[]) => ids.map((m) => words.member(m)).join(', ')
  const side = (title: string, s: DryRunRiskSideView, differs: boolean) => (
    <section aria-label={title} className="flex min-w-0 flex-col gap-3 rounded-md border border-line p-3">
      <h5 className="flex flex-wrap items-center gap-x-2 font-semibold">
        <span>{title}</span>
        {differs ? (
          <span className="inline-flex items-center gap-1 text-base font-normal text-ink md:text-sm">
            <PenLine className="size-3.5 shrink-0" aria-hidden="true" />
            {t('dryRun.differs')}
          </span>
        ) : null}
      </h5>
      {s.error ? (
        <Notice tone="warning" role="status">
          {sideError(s.error)}
        </Notice>
      ) : s.slots.length ? (
        <ol className="flex list-decimal flex-col gap-1 pl-5">
          {s.slots.map((slot, i) => (
            <li key={i} className="break-words">
              {t('riskDryRun.slot', { rules: slot.ruleCodes.join(', '), names: names(slot.memberIds), domains: words.domains(slot.riskDomains) })}
            </li>
          ))}
        </ol>
      ) : (
        <p className="text-ink-muted">{t('riskDryRun.noSlots')}</p>
      )}
    </section>
  )
  return (
    <section aria-labelledby={id} className="flex flex-col gap-3 border-t border-line pt-3">
      <h4 id={id} className="flex flex-col font-semibold">
        <span>{t('riskDryRun.resultTitle', { n })}</span>
        {tried ? <span className="text-base font-normal break-words text-ink-muted md:text-sm">{riskCaseSummary(words, tried)}</span> : null}
      </h4>
      <p className="flex items-center gap-2 font-medium">
        {row.changed ? <PenLine className="size-4 shrink-0" aria-hidden="true" /> : <CircleCheck className="size-4 shrink-0 text-primary" aria-hidden="true" />}
        {row.changed ? t('riskDryRun.changed') : t('riskDryRun.same')}
      </p>
      <div className="grid gap-3 md:grid-cols-2">
        {side(currentName ? t('dryRun.currentTitle', { name: currentName }) : t('dryRun.currentNone'), row.current, false)}
        {side(t('dryRun.draftTitle', { name: draftName }), row.draft, row.changed)}
      </div>
    </section>
  )
}

export function RiskDryRun({ versionId, draftName, currentName, blocked, defaultOpenerId, context, words, categoryCodes, run }: RiskDryRunProps) {
  const { t } = words
  const id = useId()
  const action = useAction()
  const [cases, setCases] = useState<readonly RiskCaseDraft[]>(() => [riskCaseDraftOf(defaultOpenerId)])
  const [selected, setSelected] = useState(0)
  const [openerMissing, setOpenerMissing] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const [ran, setRan] = useState<{ readonly cases: readonly RiskCaseValue[]; readonly rows: readonly DryRunRiskRowView[] } | null>(null)
  const editing = cases[selected] ?? cases[0]!

  const update = (patch: Partial<RiskCaseDraft>) => {
    setCases((list) => list.map((c, i) => (i === selected ? { ...c, ...patch } : c)))
    if ('openedById' in patch) setOpenerMissing(false)
  }
  const select = (i: number) => {
    setSelected(i)
    setOpenerMissing(false)
  }
  const add = () => {
    if (cases.length >= MAX_RISK_CASES) return
    setCases((list) => [...list, riskCaseDraftOf(defaultOpenerId)])
    select(cases.length)
  }
  const remove = (i: number) => {
    if (cases.length <= 1) return
    setCases((list) => list.filter((_, j) => j !== i))
    select(selected === i ? Math.max(0, i - 1) : selected > i ? selected - 1 : selected)
  }

  async function onRun(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setFailure(null)
    const checked = cases.map(riskCaseOf)
    // The one thing to choose is who opened it: go to the first assessment without one
    const missing = checked.findIndex((c) => !c.ok)
    if (missing >= 0) {
      setSelected(missing)
      setOpenerMissing(true)
      return
    }
    const riskCases = checked.flatMap((c) => (c.ok ? [c.value] : []))
    const outcome = await action.run((key) => run({ versionId, documents: [], riskCases }, key))
    if (outcome.ok) {
      setRan({ cases: riskCases, rows: outcome.riskRows })
      // The page learns that the dry-run ran on the latest draft (the send needs it)
      action.done()
      return
    }
    setFailure(t(`errors.${failureKey(outcome, WORKFLOW_REASONS)}`, errorValues(outcome)))
  }

  const draftSummary = (d: RiskCaseDraft) => riskCaseSummary(words, { ...d, inherentTier: d.inherentTier || undefined, categoryCodes: codesOf(d.categoryCodes) })
  const options = <T extends string>(values: readonly T[], label: (v: T) => string) => values.map((v) => ({ value: v, label: label(v) }))
  const caseId = `${id}-case${selected}`

  return (
    <div className="flex flex-col gap-5">
      <p className="text-ink-muted">{t('riskDryRun.intro', { name: draftName })}</p>
      {blocked ? <Notice tone="warning">{blocked}</Notice> : null}
      <form onSubmit={onRun} className="flex flex-col gap-4" noValidate>
        <section aria-labelledby={`${id}-cases`} className="flex flex-col gap-2">
          <h4 id={`${id}-cases`} className="font-semibold">
            {t('riskDryRun.casesTitle', { count: cases.length })}
          </h4>
          <ol aria-label={t('riskDryRun.casesLabel')} className="flex flex-col divide-y divide-line border-y border-line">
            {cases.map((c, i) => (
              <li key={i} className="flex flex-col gap-2 py-3 md:flex-row md:items-start md:justify-between md:gap-4">
                <p className="flex min-w-0 flex-col">
                  <span className="font-medium">{i === selected ? t('riskDryRun.caseEditing', { n: i + 1 }) : t('riskDryRun.caseN', { n: i + 1 })}</span>
                  <span className="text-base break-words text-ink-muted md:text-sm">{draftSummary(c)}</span>
                </p>
                <div className="flex shrink-0 flex-wrap gap-2">
                  {i !== selected ? (
                    <Button variant="secondary" aria-label={t('riskDryRun.editCaseNamed', { n: i + 1 })} onClick={() => select(i)}>
                      {t('riskDryRun.editCase')}
                    </Button>
                  ) : null}
                  {cases.length > 1 ? (
                    <Button variant="secondary" aria-label={t('riskDryRun.removeCaseNamed', { n: i + 1 })} onClick={() => remove(i)}>
                      <Trash2 className="size-4 shrink-0" aria-hidden="true" />
                      {t('riskDryRun.removeCase')}
                    </Button>
                  ) : null}
                </div>
              </li>
            ))}
          </ol>
          <Button variant="secondary" className="self-start" disabled={cases.length >= MAX_RISK_CASES} onClick={add}>
            <CirclePlus className="size-4 shrink-0" aria-hidden="true" />
            {t('riskDryRun.addCase')}
          </Button>
        </section>

        <fieldset className="flex flex-col gap-4 border-l-4 border-primary py-1 pl-3">
          <legend className="float-left mb-1 w-full font-semibold">{t('riskDryRun.caseEditing', { n: selected + 1 })}</legend>
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-1 font-medium">{t('riskDryRun.screening')}</legend>
            <div className="grid gap-4 md:grid-cols-3">
              {SCREENING_FIELDS.map((f) => (
                <SelectField
                  key={f}
                  id={`${caseId}-${f}`}
                  label={words.riskField(f)}
                  value={editing.screening[f]}
                  onChange={(ev) => update({ screening: { ...editing.screening, [f]: ev.currentTarget.value === 'Y' ? 'Y' : 'N' } })}
                  options={options(['Y', 'N'] as const, words.yesNo)}
                />
              ))}
            </div>
          </fieldset>
          <div className="grid gap-4 md:grid-cols-2">
            <SelectField
              id={`${caseId}-tier`}
              label={t('riskDryRun.tier')}
              value={editing.tier}
              onChange={(ev) => update({ tier: ev.currentTarget.value as RiskTier })}
              options={options(RISK_TIERS, words.tier)}
            />
            <SelectField
              id={`${caseId}-inherent`}
              label={t('riskDryRun.inherentTier')}
              hint={t('riskDryRun.inherentTierHint')}
              placeholder={t('riskDryRun.inherentSame')}
              value={editing.inherentTier}
              onChange={(ev) => update({ inherentTier: ev.currentTarget.value as RiskTier | '' })}
              options={options(RISK_TIERS, words.tier)}
            />
            <SelectField
              id={`${caseId}-payee`}
              label={t('riskDryRun.payeeType')}
              value={editing.payeeType}
              onChange={(ev) => update({ payeeType: ev.currentTarget.value as PayeeType })}
              options={options(PAYEE_TYPES, words.payeeType)}
            />
            <Field
              id={`${caseId}-categories`}
              label={t('riskDryRun.categories')}
              hint={categoryCodes.length ? t('codesHintKnown', { codes: categoryCodes.join(', ') }) : t('codesHint')}
              value={editing.categoryCodes}
              onChange={(ev) => update({ categoryCodes: ev.currentTarget.value })}
            />
          </div>
          <SelectField
            id={`${caseId}-opener`}
            label={t('riskDryRun.openedBy')}
            hint={t('riskDryRun.openedByHint')}
            placeholder={t('choose')}
            value={editing.openedById}
            onChange={(ev) => update({ openedById: ev.currentTarget.value })}
            options={context.members.filter((m) => m.active).map((m) => ({ value: m.id, label: words.member(m.id) }))}
            error={openerMissing && editing.openedById === '' ? t('riskDryRun.openedByRequired') : undefined}
          />
        </fieldset>
        {failure ? <Notice tone="danger">{failure}</Notice> : null}
        <Button type="submit" disabled={action.pending || blocked !== null} className="self-start">
          {action.pending ? t('dryRun.running') : t('riskDryRun.run', { count: cases.length })}
        </Button>
      </form>
      <div aria-live="polite" className="flex flex-col gap-4">
        {ran ? ran.rows.map((row, i) => <RiskCaseResult key={i} id={`${id}-result${i}`} n={i + 1} tried={ran.cases[i]} row={row} currentName={currentName} draftName={draftName} words={words} />) : null}
      </div>
    </div>
  )
}
