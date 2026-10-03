'use client'

import { useTranslations } from 'next-intl'
import { StateLine } from '../request-view/status'
import type { ReceiveLineView } from './types'

// The lines of a PO with what was ordered, what came so far and what is not in yet (FR-P2P-006) — with what was given
// up and the damaged goods waiting for approval to be kept — for those who see the PO without receiving it now. Wide
// screens: columns with the numbers right-aligned in tabular digits; phones: each line stacks with the numbers next to
// their label — never a table that scrolls sideways (§9.9).

const GRID = 'md:grid md:grid-cols-[minmax(0,1fr)_8rem_8rem_8rem] md:items-baseline md:gap-4'

function Figure({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <p className="flex items-baseline justify-between gap-3 md:block md:text-right">
      <span className="text-base text-ink-muted md:sr-only">{label}</span>
      <span className={strong ? 'tabular font-semibold text-ink' : 'tabular text-ink'}>{value}</span>
    </p>
  )
}

export function PoLines({ lines }: { lines: readonly ReceiveLineView[] }) {
  const t = useTranslations('receiving.form')
  return (
    <div className="flex flex-col">
      <div className={`hidden border-b border-line pb-2 text-sm text-ink-muted ${GRID}`} aria-hidden="true">
        <span>{t('item')}</span>
        <span className="text-right">{t('ordered')}</span>
        <span className="text-right">{t('receivedSoFar')}</span>
        <span className="text-right">{t('outstanding')}</span>
      </div>
      <ol className="flex flex-col divide-y divide-line border-t border-line md:border-t-0">
        {lines.map((line) => (
          <li key={line.id} className={`flex flex-col gap-1 py-3 ${GRID}`}>
            <div className="min-w-0">
              <p className="font-medium break-words text-ink">{line.description}</p>
              {line.cancelled ? <p className="text-base text-ink-muted md:text-sm">{t('cancelledNote', { quantity: line.cancelled, uom: line.uom })}</p> : null}
              {line.keepPending ? (
                <StateLine kind="waiting" className="text-base md:text-sm">
                  {t('keepPendingNote', { quantity: line.keepPending, uom: line.uom })}
                </StateLine>
              ) : null}
            </div>
            <Figure label={t('ordered')} value={t('quantity', { quantity: line.ordered, uom: line.uom })} />
            <Figure label={t('receivedSoFar')} value={t('quantity', { quantity: line.received, uom: line.uom })} />
            <Figure label={t('outstanding')} value={t('quantity', { quantity: line.outstanding, uom: line.uom })} strong />
          </li>
        ))}
      </ol>
    </div>
  )
}
