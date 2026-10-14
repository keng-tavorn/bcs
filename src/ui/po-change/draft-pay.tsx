'use client'

import { useTranslations } from 'next-intl'
import { useId, useState, type FormEvent } from 'react'
import { BASIS_POINTS_WHOLE } from '@/lib/constants'
import { Button } from '../form/button'
import { Notice } from '../form/notice'
import { useOutcomeAction } from '../procurement/use-outcome-action'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../shadcn/dialog'
import { Input } from '../shadcn/input'
import { Label } from '../shadcn/label'
import { Refusal } from './failure'
import { bpToPercent, percentToBp, PO_S8_NO_ANSWER, type PoS8Outcome } from './outcome'

// The milestones and the retention of a draft PO (S8-13, FR-AP-106 AC1, BR-RET-01, BR-RET-03), shown only with module
// PAY on (BR-AP-13). "แบ่งงวด" opens a dialog from the member's press (NG-13) for one service line ordered for one
// request line: 2 to 12 shares in percent that add up to 100 (checked here as the member types, and again by the
// service); the server splits the quantity and works out each milestone's amount. The retention form takes the
// percentage held back from every invoice and the days it is held after the last milestone. Percentages travel as text
// and become basis points as integers — never a float.

const MIN_PARTS = 2
const MAX_PARTS = 12

export interface SplittableLine {
  readonly id: string
  readonly lineNo: number
  readonly description: string
  readonly quantity: string
  readonly uom: string
}

export interface DraftPayProps {
  readonly poId: string
  readonly version: number
  readonly retentionBp: number
  readonly retentionHoldDays: number | null
  readonly lines: readonly SplittableLine[]
  readonly actions: {
    readonly milestones: (input: { poId: string; expectedVersion: number; poLineId: string; shares: string[] }, idempotencyKey: string) => Promise<PoS8Outcome>
    readonly retention: (input: { poId: string; expectedVersion: number; retentionPercent: string; holdDays: string }, idempotencyKey: string) => Promise<PoS8Outcome>
  }
}

export function DraftPay({ poId, version, retentionBp, retentionHoldDays, lines, actions }: DraftPayProps) {
  const t = useTranslations('poChange')
  const id = useId()
  return (
    <section aria-labelledby={`${id}-title`} className="flex flex-col gap-4 border-t border-line pt-5">
      <div className="flex flex-col gap-1">
        <h2 id={`${id}-title`} className="text-lg font-semibold text-ink">
          {t('draft.title')}
        </h2>
        <p className="text-ink-muted">{t('draft.intro')}</p>
      </div>
      {lines.length ? (
        <ul className="flex flex-col gap-2">
          {lines.map((line) => (
            <li key={line.id}>
              <MilestonesDialog poId={poId} version={version} line={line} run={actions.milestones} />
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-ink-muted">{t('draft.noLines')}</p>
      )}
      <RetentionForm poId={poId} version={version} retentionBp={retentionBp} retentionHoldDays={retentionHoldDays} run={actions.retention} />
    </section>
  )
}

function MilestonesDialog({ poId, version, line, run }: { poId: string; version: number; line: SplittableLine; run: DraftPayProps['actions']['milestones'] }) {
  const t = useTranslations('poChange.milestones')
  const id = useId()
  const [open, setOpen] = useState(false)
  const [shares, setShares] = useState<string[]>(['50', '50'])
  const [checked, setChecked] = useState(false)
  const action = useOutcomeAction<PoS8Outcome>(PO_S8_NO_ANSWER)
  const bps = shares.map(percentToBp)
  const valid = bps.every((b) => b !== null && b > 0)
  const sum = bps.reduce<number>((s, b) => s + (b ?? 0), 0)
  const problem = !valid ? t('badShare') : sum !== BASIS_POINTS_WHOLE ? t('sumWrong', { sum: bpToPercent(sum) }) : null

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setChecked(true)
    if (problem) return
    const outcome = await action.run((key) => run({ poId, expectedVersion: version, poLineId: line.id, shares: shares.map((s) => s.trim()) }, key))
    if (outcome.ok) setOpen(false)
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Button variant="secondary" onClick={() => setOpen(true)}>
        {t('open', { no: line.lineNo })}
      </Button>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={onSubmit} className="flex flex-col gap-4" noValidate>
          <DialogHeader>
            <DialogTitle className="text-lg font-semibold">{t('title', { no: line.lineNo })}</DialogTitle>
            <DialogDescription className="text-base text-ink-muted md:text-sm">{t('description', { description: line.description, quantity: line.quantity, uom: line.uom })}</DialogDescription>
          </DialogHeader>
          <ol className="flex max-h-[50dvh] flex-col gap-3 overflow-y-auto">
            {shares.map((share, i) => (
              <li key={i} className="flex items-end gap-2">
                <div className="flex flex-1 flex-col gap-1.5">
                  <Label htmlFor={`${id}-share-${i}`} className="text-base md:text-sm">
                    {t('share', { no: i + 1 })}
                  </Label>
                  <Input
                    id={`${id}-share-${i}`}
                    inputMode="decimal"
                    className="h-11 text-base"
                    value={share}
                    aria-invalid={checked && percentToBp(share) === null ? true : undefined}
                    onChange={(e) => setShares(shares.map((s, j) => (j === i ? e.target.value : s)))}
                  />
                </div>
                {shares.length > MIN_PARTS ? (
                  <Button variant="link" className="min-h-11" onClick={() => setShares(shares.filter((_, j) => j !== i))}>
                    {t('remove', { no: i + 1 })}
                  </Button>
                ) : null}
              </li>
            ))}
          </ol>
          {shares.length < MAX_PARTS ? (
            <Button variant="link" className="self-start" onClick={() => setShares([...shares, ''])}>
              {t('add')}
            </Button>
          ) : null}
          <p className="tabular text-ink" aria-live="polite">
            {t('sum', { sum: bpToPercent(sum) })}
          </p>
          {checked && problem ? <Notice tone="danger">{problem}</Notice> : null}
          {action.outcome && !action.outcome.ok ? <Refusal failure={action.outcome} /> : null}
          <DialogFooter className="flex-row flex-wrap gap-x-6 gap-y-2 sm:justify-start">
            <Button type="submit" disabled={action.pending}>
              {action.pending ? t('working') : t('save', { count: shares.length })}
            </Button>
            <Button variant="link" className="min-h-11" disabled={action.pending} onClick={() => setOpen(false)}>
              {t('cancel')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function RetentionForm({ poId, version, retentionBp, retentionHoldDays, run }: { poId: string; version: number; retentionBp: number; retentionHoldDays: number | null; run: DraftPayProps['actions']['retention'] }) {
  const t = useTranslations('poChange.retention')
  const id = useId()
  const [percent, setPercent] = useState(bpToPercent(retentionBp))
  const [days, setDays] = useState(retentionHoldDays === null ? '' : String(retentionHoldDays))
  const [errors, setErrors] = useState<{ percent?: string; days?: string }>({})
  const action = useOutcomeAction<PoS8Outcome>(PO_S8_NO_ANSWER)

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const next = {
      ...(percentToBp(percent || '0') === null ? { percent: t('badPercent') } : {}),
      ...(days.trim() !== '' && !/^\d{1,4}$/.test(days.trim()) ? { days: t('badDays') } : {}),
    }
    setErrors(next)
    if (next.percent || next.days) return
    await action.run((key) => run({ poId, expectedVersion: version, retentionPercent: percent.trim(), holdDays: days.trim() }, key))
  }

  return (
    <form onSubmit={onSubmit} aria-labelledby={`${id}-title`} className="flex flex-col gap-3" noValidate>
      <h3 id={`${id}-title`} className="font-semibold text-ink">
        {t('title')}
      </h3>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${id}-percent`} className="text-base md:text-sm">
            {t('percent')}
          </Label>
          <Input
            id={`${id}-percent`}
            inputMode="decimal"
            className="h-11 text-base"
            value={percent}
            aria-invalid={errors.percent ? true : undefined}
            aria-describedby={`${id}-percent-hint${errors.percent ? ` ${id}-percent-error` : ''}`}
            onChange={(e) => setPercent(e.target.value)}
          />
          <p id={`${id}-percent-hint`} className="text-base text-ink-muted md:text-sm">
            {t('percentHint')}
          </p>
          {errors.percent ? (
            <p id={`${id}-percent-error`} className="text-base text-danger md:text-sm">
              {errors.percent}
            </p>
          ) : null}
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${id}-days`} className="text-base md:text-sm">
            {t('days')}
          </Label>
          <Input
            id={`${id}-days`}
            inputMode="numeric"
            className="h-11 text-base"
            value={days}
            aria-invalid={errors.days ? true : undefined}
            aria-describedby={`${id}-days-hint${errors.days ? ` ${id}-days-error` : ''}`}
            onChange={(e) => setDays(e.target.value)}
          />
          <p id={`${id}-days-hint`} className="text-base text-ink-muted md:text-sm">
            {t('daysHint')}
          </p>
          {errors.days ? (
            <p id={`${id}-days-error`} className="text-base text-danger md:text-sm">
              {errors.days}
            </p>
          ) : null}
        </div>
      </div>
      {action.outcome && !action.outcome.ok ? <Refusal failure={action.outcome} /> : null}
      {action.outcome?.ok ? <Notice tone="success">{t('done')}</Notice> : null}
      <Button type="submit" variant="secondary" className="self-start" disabled={action.pending}>
        {action.pending ? t('working') : t('save')}
      </Button>
    </form>
  )
}
