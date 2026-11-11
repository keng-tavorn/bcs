'use client'

import { CircleAlert, CircleCheck } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { useId, useState } from 'react'
import { BASIS_POINTS_WHOLE } from '@/lib/constants'
import { Notice } from '../form/notice'
import { Button } from '../shadcn/button'
import { Input } from '../shadcn/input'
import { Label } from '../shadcn/label'
import { NativeSelect, NativeSelectOption } from '../shadcn/native-select'
import { bpOf, percentOf, type RfxOutcome } from './setup-model'
import { useRfxAct } from './use-rfx-act'

// Step "Scorecard" of /sourcing/[id]/edit (S10-12 · BR-RFX-09 · BR-SOD-14 · OQ-206): the criteria with their weights in
// per cent (kept as basis points; together 100%), one criterion of price that the system scores from the bids, the
// others scored by the evaluators; and the evaluators — at least the organization's minimum. The creator of the RFx
// and the requesters of its lines may not score it (BR-SOD-14): they are listed with the reason and cannot be picked.
// rfx.setScorecard checks the weights, the price criterion and the SoD again.

export interface CriterionRow {
  readonly code: string
  readonly nameTh: string
  readonly nameEn: string
  readonly percent: string
  readonly kind: 'PRICE' | 'QUALITY'
}

export interface EvaluatorChoice {
  readonly id: string
  readonly name: string
  /** Why BR-SOD-14 keeps this member from scoring, worded, or null */
  readonly conflict: string | null
}

export interface ScorecardSaveInput {
  readonly criteria: ReadonlyArray<{ readonly code: string; readonly nameTh: string; readonly nameEn: string; readonly weightBp: number; readonly kind: 'PRICE' | 'QUALITY' }>
  readonly evaluatorMemberIds: readonly string[]
}

const CODE = /^[A-Z][A-Z0-9_]{0,19}$/

export function SetupScorecard({
  initialCriteria,
  initialEvaluators,
  members,
  minEvaluators,
  save,
}: {
  readonly initialCriteria: readonly CriterionRow[]
  readonly initialEvaluators: readonly string[]
  readonly members: readonly EvaluatorChoice[]
  readonly minEvaluators: number
  readonly save: (input: ScorecardSaveInput, key: string) => Promise<RfxOutcome>
}) {
  const t = useTranslations('sourcing.setup')
  const id = useId()
  const { act, pending, message, setMessage } = useRfxAct()
  const [rows, setRows] = useState<CriterionRow[]>([...initialCriteria])
  const [evaluators, setEvaluators] = useState<string[]>([...initialEvaluators])
  const [adding, setAdding] = useState('')
  const set = (i: number, patch: Partial<CriterionRow>) => setRows((all) => all.map((r, j) => (j === i ? { ...r, ...patch } : r)))
  const weights = rows.map((r) => bpOf(r.percent))
  const total = weights.reduce<number>((sum, w) => sum + (w ?? 0), 0)
  const priceOnly = rows.length > 0 && rows.every((r) => r.kind === 'PRICE')
  const nameOf = (memberId: string) => members.find((m) => m.id === memberId)?.name ?? memberId

  function submit() {
    if (rows.some((r, i) => !CODE.test(r.code.trim()) || !r.nameTh.trim() || weights[i] === null)) return setMessage({ tone: 'danger', text: t('scorecard.rowInvalid') })
    if (total !== BASIS_POINTS_WHOLE) return setMessage({ tone: 'danger', text: t('errors.WEIGHTS_SUM') })
    if (rows.filter((r) => r.kind === 'PRICE').length !== 1) return setMessage({ tone: 'danger', text: t('scorecard.onePrice') })
    void act(
      (key) => save({ criteria: rows.map((r, i) => ({ code: r.code.trim(), nameTh: r.nameTh, nameEn: r.nameEn, weightBp: weights[i]!, kind: r.kind })), evaluatorMemberIds: evaluators }, key),
      t('scorecard.saved'),
    )
  }

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault()
        submit()
      }}
    >
      {message ? <Notice tone={message.tone}>{message.text}</Notice> : null}
      <fieldset className="flex flex-col gap-3">
        <legend className="mb-2 font-semibold text-ink">{t('scorecard.criteria')}</legend>
        <ol className="flex flex-col divide-y divide-line">
          {rows.map((r, i) => (
            <li key={i} className="grid grid-cols-2 gap-3 py-3 md:grid-cols-[8rem_minmax(0,1fr)_minmax(0,1fr)_6rem_9rem_auto] md:items-end">
              <div className="flex flex-col gap-2">
                <Label htmlFor={`${id}-code-${i}`}>{t('scorecard.code')}</Label>
                <Input id={`${id}-code-${i}`} className="min-h-11 lg:min-h-10" value={r.code} maxLength={20} onChange={(e) => set(i, { code: e.target.value.toUpperCase() })} />
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor={`${id}-name-${i}`}>{t('scorecard.nameTh')}</Label>
                <Input id={`${id}-name-${i}`} className="min-h-11 lg:min-h-10" value={r.nameTh} maxLength={200} onChange={(e) => set(i, { nameTh: e.target.value })} />
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor={`${id}-name-en-${i}`}>{t('scorecard.nameEn')}</Label>
                <Input id={`${id}-name-en-${i}`} className="min-h-11 lg:min-h-10" value={r.nameEn} maxLength={200} onChange={(e) => set(i, { nameEn: e.target.value })} />
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor={`${id}-weight-${i}`}>{t('scorecard.weight')}</Label>
                <Input id={`${id}-weight-${i}`} inputMode="decimal" className="min-h-11 text-right tabular lg:min-h-10" value={r.percent} onChange={(e) => set(i, { percent: e.target.value })} />
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor={`${id}-kind-${i}`}>{t('scorecard.kind')}</Label>
                <NativeSelect id={`${id}-kind-${i}`} className="min-h-11 w-full lg:min-h-10" value={r.kind} onChange={(e) => set(i, { kind: e.target.value === 'PRICE' ? 'PRICE' : 'QUALITY' })}>
                  <NativeSelectOption value="PRICE">{t('scorecard.kindPrice')}</NativeSelectOption>
                  <NativeSelectOption value="QUALITY">{t('scorecard.kindQuality')}</NativeSelectOption>
                </NativeSelect>
              </div>
              {rows.length > 1 ? (
                <Button type="button" variant="outline" className="min-h-11 self-end lg:min-h-10" onClick={() => setRows((all) => all.filter((_, j) => j !== i))}>
                  {t('scorecard.removeCriterion', { code: r.code || String(i + 1) })}
                </Button>
              ) : null}
            </li>
          ))}
        </ol>
        <p className={`inline-flex items-start gap-2 font-medium ${total === BASIS_POINTS_WHOLE ? 'text-ink' : 'text-warn'}`} aria-live="polite">
          {total === BASIS_POINTS_WHOLE ? <CircleCheck className="mt-[0.3em] size-4 shrink-0 text-primary" aria-hidden="true" /> : <CircleAlert className="mt-[0.3em] size-4 shrink-0" aria-hidden="true" />}
          <span>{t('scorecard.total', { percent: percentOf(total) })}</span>
        </p>
        <Button type="button" variant="outline" className="min-h-11 self-start lg:min-h-10" disabled={rows.length >= 20} onClick={() => setRows((all) => [...all, { code: '', nameTh: '', nameEn: '', percent: '0', kind: 'QUALITY' }])}>
          {t('scorecard.addCriterion')}
        </Button>
      </fieldset>

      <fieldset className="flex flex-col gap-3 border-t border-line pt-4">
        <legend className="mb-2 font-semibold text-ink">{t('scorecard.evaluators')}</legend>
        <p className="text-ink-muted">{priceOnly ? t('scorecard.priceOnly') : t('scorecard.evaluatorsHint', { min: minEvaluators })}</p>
        <Notice tone="info">{t('scorecard.sodNote')}</Notice>
        {evaluators.length ? (
          <ul aria-label={t('scorecard.evaluators')} className="flex flex-col divide-y divide-line">
            {evaluators.map((memberId) => (
              <li key={memberId} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <span className="text-ink">{nameOf(memberId)}</span>
                <Button type="button" variant="outline" className="min-h-11 lg:min-h-10" onClick={() => setEvaluators((all) => all.filter((x) => x !== memberId))}>
                  {t('scorecard.removeEvaluator', { name: nameOf(memberId) })}
                </Button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-ink-muted">{t('scorecard.noEvaluators')}</p>
        )}
        <div className="flex flex-col gap-3 md:flex-row md:items-end">
          <div className="flex min-w-0 flex-1 flex-col gap-2">
            <Label htmlFor={`${id}-evaluator`}>{t('scorecard.pickEvaluator')}</Label>
            <NativeSelect id={`${id}-evaluator`} className="min-h-11 w-full lg:min-h-10" value={adding} onChange={(e) => setAdding(e.target.value)}>
              <NativeSelectOption value="">{t('scorecard.choose')}</NativeSelectOption>
              {members
                .filter((m) => !evaluators.includes(m.id))
                .map((m) => (
                  <NativeSelectOption key={m.id} value={m.id} disabled={m.conflict !== null}>
                    {m.conflict ? `${m.name} (${m.conflict})` : m.name}
                  </NativeSelectOption>
                ))}
            </NativeSelect>
          </div>
          <Button
            type="button"
            variant="outline"
            className="min-h-11 self-start lg:min-h-10 md:self-auto"
            disabled={!adding}
            onClick={() => {
              setEvaluators((all) => [...all, adding])
              setAdding('')
            }}
          >
            {t('scorecard.addEvaluator')}
          </Button>
        </div>
      </fieldset>
      <Button type="submit" className="min-h-11 self-start lg:min-h-10" disabled={pending}>
        {pending ? t('scorecard.saving') : t('scorecard.save')}
      </Button>
    </form>
  )
}
