'use client'

import { useTranslations } from 'next-intl'
import { useId, useState } from 'react'
import { Button } from '../form/button'
import { Notice } from '../form/notice'
import { announcePoolAction, useOtherPoolAction } from './activity'
import { poolErrorKey, type PoolOutcome } from './outcome'
import { DraftLinks, draftLinkLabel } from './pool-board'
import { useOutcomeAction } from './use-outcome-action'

// "รวมเป็นร่าง PO ตอนนี้" (spec FR-P2P-002 AC3): runs a consolidation round by hand and says what it made — the draft POs,
// each a link named by its supplier, site and kind, with its lines, requests and amount before VAT right-aligned — and
// what it left in the pool and why (BR-CONS-03: no supplier yet). When the next automatic round runs is told above the
// button (AC2). A draft cannot be thrown away or given another supplier yet (it is only edited line by line), so the
// round asks a second time, saying how many lines it puts on drafts, before it runs (§9.9: nothing that cannot be
// undone without a confirmation). The service checks po.create again.

export interface ConsolidatePanelProps {
  /** "รอบอัตโนมัติถัดไป จ. 5 ต.ค. 2569 15:00 น." or why there is none, already worded */
  readonly next: string
  /** Lines of the pool that have their supplier: what a round puts on drafts now */
  readonly ready: number
  readonly consolidate: (idempotencyKey: string) => Promise<PoolOutcome>
}

const SOURCE = 'round'

export function ConsolidatePanel({ next, ready, consolidate }: ConsolidatePanelProps) {
  const t = useTranslations('procurement.pool')
  const id = useId()
  const action = useOutcomeAction<PoolOutcome>({ ok: false, code: 'FAILED' })
  const [confirming, setConfirming] = useState(false)
  // A supplier chosen after the round: its result is no longer the last thing done
  useOtherPoolAction(SOURCE, () => {
    action.clear()
    setConfirming(false)
  })
  const outcome = action.outcome

  async function run() {
    announcePoolAction(SOURCE)
    await action.run((key) => consolidate(key))
    setConfirming(false)
  }

  return (
    <section aria-labelledby={`${id}-title`} className="flex flex-col gap-3">
      <h2 id={`${id}-title`} className="text-lg font-semibold text-ink">
        {t('round.title')}
      </h2>
      <p className="font-medium text-ink">{next}</p>
      <p className="text-base text-ink-muted md:text-sm">{t('round.hint')}</p>
      {confirming ? (
        <div role="group" aria-labelledby={`${id}-confirm`} className="flex flex-col gap-2 border-l-4 border-info bg-surface px-3 py-2.5">
          <p id={`${id}-confirm`} className="font-medium text-ink">
            {t('round.confirmText', { count: ready })}
          </p>
          <div className="flex flex-wrap gap-3">
            <Button onClick={() => void run()} disabled={action.pending}>
              {action.pending ? t('round.working') : t('round.confirm')}
            </Button>
            <Button variant="secondary" onClick={() => setConfirming(false)} disabled={action.pending}>
              {t('round.back')}
            </Button>
          </div>
        </div>
      ) : (
        <Button
          onClick={() => {
            action.clear()
            setConfirming(true)
          }}
          disabled={action.pending}
          className="self-start"
        >
          {t('round.submit')}
        </Button>
      )}
      {outcome?.ok ? (
        <Notice tone={outcome.drafts?.length ? 'success' : 'info'}>
          <p className="font-medium">{outcome.drafts?.length ? t('round.made', { count: outcome.drafts.length }) : t('round.madeNone')}</p>
          {outcome.drafts?.length ? (
            <ul className="mt-1 flex flex-col divide-y divide-line">
              {outcome.drafts.map((d) => (
                <li key={d.id} className="flex flex-col py-1.5">
                  <DraftLinks drafts={[d]} label={(draft) => draftLinkLabel(t, draft)} />
                  {/* Document numbers never break at their hyphens */}
                  <span className="text-base text-ink-muted md:text-sm">
                    {t('round.draftLines', { lines: d.lineCount })} · {t('round.requestsLabel')}{' '}
                    {d.requestNumbers.map((number, i) => (
                      <span key={number} className="whitespace-nowrap">
                        {number}
                        {i < d.requestNumbers.length - 1 ? ', ' : ''}
                      </span>
                    ))}
                  </span>
                  <span className="flex items-baseline justify-between gap-3 text-base md:text-sm">
                    <span className="text-ink-muted">{t('round.draftAmountLabel')}</span>
                    <span className="tabular text-ink">{t('round.draftAmountValue', { amount: d.net })}</span>
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
          <p className="mt-1">{outcome.left ? t('round.left', { count: outcome.left }) : t('round.leftNone')}</p>
          {outcome.waiting ? <p>{t('round.leftWaiting', { count: outcome.waiting })}</p> : null}
        </Notice>
      ) : null}
      {outcome && !outcome.ok ? <Notice tone="danger">{t(`errors.${poolErrorKey(outcome)}`, { requestId: outcome.requestId ?? '-' })}</Notice> : null}
    </section>
  )
}
