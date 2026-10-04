'use client'

import { useLocale, useTranslations } from 'next-intl'
import type { ReactNode } from 'react'
import { ApproverText } from '../../receiving/approver-text'
import type { ApproverView, DamagedChoice, ExcessChoice, ReceiptPreviewView } from '../../receiving/types'
import { FieldError } from './fields'
import { MarkIcon } from './marks'

// Step 2 of receiving in LIFF (./receive-flow.tsx), loaded only when the receiver needs it: what the server calculated
// before anything is written (§9.9 principle 3) — the PO's status after, per line what came, what is accepted and what is
// still to come, an excess within the tolerance taken at once, and for an excess beyond it or damaged goods the
// receiver's choice: send back or replace without an approval, or keep with the GR_VARIANCE approver named (BR-GR-03,
// the workspace's src/ui/receiving/approver-text.tsx). The evidence is repeated. The step's heading and the confirm
// button belong to the flow (the heading is on the screen, with the focus, while this part loads); a choice still
// missing gets the focus on its first option, which is never one an approval blocks (`<group name>-choice`), and every
// option of the group is described by the error, so a screen reader reads why the focus moved there.

export interface LiffReceiptReviewProps {
  /** Prefix of the radio groups' names (one per line and kind) */
  readonly namePrefix: string
  readonly preview: ReceiptPreviewView
  readonly choices: Readonly<Record<string, { readonly excess?: ExcessChoice; readonly damaged?: DamagedChoice }>>
  /** `<poLineId>:excess` or `<poLineId>:damaged` still without a choice */
  readonly choiceErrors: ReadonlySet<string>
  readonly onChoose: (poLineId: string, kind: 'excess' | 'damaged', value: ExcessChoice | DamagedChoice) => void
  readonly evidence: { readonly deliveryNoteNo: string; readonly photoCount: number; readonly notes: string }
}

/** A sum of money in its own row: the label on the left, the amount right-aligned in tabular digits (§9.9 principle 6) */
function MoneyRow({ label, amount }: { readonly label: string; readonly amount: string }) {
  return (
    <p className="flex items-baseline justify-between gap-3">
      <span className="text-ink-muted">{label}</span>
      <span className="money shrink-0 text-ink">{amount}</span>
    </p>
  )
}

/** One decision of the receiver: send back or replace (no approval), or keep with the approver named */
function ChoiceGroup({
  name,
  legend,
  amount,
  value,
  error,
  options,
  onChange,
  locale,
}: {
  readonly name: string
  readonly legend: string
  readonly amount: ReactNode
  readonly value: string | null
  readonly error?: string
  readonly options: ReadonlyArray<{ readonly value: string; readonly label: string; readonly approver?: ApproverView }>
  readonly onChange: (value: string) => void
  readonly locale: string
}) {
  const errorId = `${name}-error`
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="font-medium text-ink">{legend}</legend>
      {amount}
      {options.map((o, i) => {
        const blocked = o.approver?.kind === 'BLOCKED'
        return (
          <label key={o.value} className={`flex min-h-11 gap-3 py-1 ${o.approver ? 'items-start' : 'items-center'}`}>
            {/* Each option carries the error, so the one that gets the focus is read with it */}
            <input
              id={i === 0 ? `${name}-choice` : undefined}
              type="radio"
              name={name}
              value={o.value}
              checked={value === o.value}
              disabled={blocked}
              onChange={() => onChange(o.value)}
              aria-describedby={error ? errorId : undefined}
              className={`size-5 shrink-0 accent-[var(--primary)] ${o.approver ? 'mt-1' : ''}`}
            />
            <span className="flex flex-col">
              <span className="text-ink">{o.label}</span>
              {o.approver ? <ApproverText approver={o.approver} locale={locale} /> : null}
            </span>
          </label>
        )
      })}
      <FieldError id={errorId} text={error} />
    </fieldset>
  )
}

export function LiffReceiptReview({ namePrefix, preview, choices, choiceErrors, onChoose, evidence }: LiffReceiptReviewProps) {
  const t = useTranslations('receiving.form')
  const locale = useLocale()
  const full = preview.poStatusAfter === 'RECEIVED'

  return (
    <div className="flex flex-col gap-5">
      <p className="flex items-start gap-2 border-l-4 border-line bg-surface px-3 py-2.5 font-medium text-ink">
        <MarkIcon shape={full ? 'packageCheck' : 'packageOpen'} className={full ? 'mt-1 text-primary' : 'mt-1 text-warn'} />
        <span>{full ? t('afterFull') : t('afterPartial', { count: preview.linesOutstandingAfter })}</span>
      </p>

      <ol className="flex flex-col divide-y divide-line border-y border-line">
        {preview.lines.map((l) => (
          <li key={l.poLineId} className="flex flex-col gap-3 py-4">
            <div className="flex flex-col gap-0.5">
              <p className="font-semibold break-words text-ink">{l.description}</p>
              <p className="text-ink">{t('reviewLine', { received: l.received, accepted: l.accepted, left: l.outstandingAfter, uom: l.uom })}</p>
              {l.rejected ? <p className="text-ink">{t('reviewRefused', { quantity: l.rejected, uom: l.uom })}</p> : null}
              {l.withinTolerance ? <p className="text-ink-muted">{t('withinTolerance', { quantity: l.withinTolerance, uom: l.uom, pct: preview.tolerancePct })}</p> : null}
              {l.withinTolerance && l.hold ? <MoneyRow label={t('holdLabel')} amount={t('baht', { amount: l.hold })} /> : null}
            </div>
            {l.excess ? (
              <ChoiceGroup
                name={`${namePrefix}-${l.poLineId}-excess`}
                legend={t('excessLegend', { quantity: l.excess.quantity, uom: l.uom, pct: preview.tolerancePct })}
                amount={l.excess.amount ? <MoneyRow label={t('choiceAmountLabel')} amount={t('baht', { amount: l.excess.amount })} /> : null}
                value={choices[l.poLineId]?.excess ?? null}
                error={choiceErrors.has(`${l.poLineId}:excess`) ? t('fieldErrors.choose') : undefined}
                options={[
                  { value: 'RETURN_EXCESS', label: t('returnExcess') },
                  { value: 'ACCEPT_EXCESS', label: t('keepExcess'), approver: l.excess.keep },
                ]}
                onChange={(value) => onChoose(l.poLineId, 'excess', value as ExcessChoice)}
                locale={locale}
              />
            ) : null}
            {l.damaged ? (
              <ChoiceGroup
                name={`${namePrefix}-${l.poLineId}-damaged`}
                legend={t('damagedLegend', { quantity: l.damaged.quantity, uom: l.uom })}
                amount={l.damaged.amount ? <MoneyRow label={t('choiceAmountLabel')} amount={t('baht', { amount: l.damaged.amount })} /> : null}
                value={choices[l.poLineId]?.damaged ?? null}
                error={choiceErrors.has(`${l.poLineId}:damaged`) ? t('fieldErrors.choose') : undefined}
                options={[
                  { value: 'RETURN_REPLACE', label: t('replaceDamaged') },
                  { value: 'ACCEPT_DAMAGED', label: t('keepDamaged'), approver: l.damaged.keep },
                ]}
                onChange={(value) => onChoose(l.poLineId, 'damaged', value as DamagedChoice)}
                locale={locale}
              />
            ) : null}
          </li>
        ))}
      </ol>

      <div className="flex flex-col gap-1">
        <h3 className="font-semibold text-ink">{t('evidenceTitle')}</h3>
        <p className="break-words text-ink">{evidence.deliveryNoteNo ? t('deliveryNoteValue', { number: evidence.deliveryNoteNo }) : t('noDeliveryNote')}</p>
        <p className="text-ink">{evidence.photoCount ? t('photoCount', { count: evidence.photoCount }) : t('noPhoto')}</p>
        {evidence.notes ? <p className="break-words whitespace-pre-line text-ink">{t('notesValue', { notes: evidence.notes })}</p> : null}
      </div>
    </div>
  )
}
