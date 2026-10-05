import { useTranslations } from 'next-intl'
import type { ReceiveLineView } from '../../receiving/types'

// The lines of a PO on the LIFF receiving page when nothing can be received now (the PO is not out yet, in full, closed,
// or the member only looks): each line stacks with what was ordered, what came so far and what is not in yet, the
// numbers in tabular digits beside their words — one column for a phone, never a table that scrolls sideways (§9.9).
// Rendered by the server (no JavaScript).

export function LiffPoLines({ lines, headingId }: { readonly lines: readonly ReceiveLineView[]; readonly headingId: string }) {
  const t = useTranslations('receiving')
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-3 border-t border-line pt-5">
      <h2 id={headingId} className="text-lg leading-snug font-semibold">
        {t('detail.linesTitle')}
      </h2>
      <ol className="flex flex-col divide-y divide-line border-t border-line">
        {lines.map((line) => (
          <li key={line.id} className="flex flex-col gap-1 py-3">
            <p className="font-medium break-words">{line.description}</p>
            <dl className="grid grid-cols-3 gap-2">
              {(
                [
                  ['ordered', line.ordered, false],
                  ['receivedSoFar', line.received, false],
                  ['outstanding', line.outstanding, true],
                ] as const
              ).map(([key, quantity, strong]) => (
                <div key={key} className="flex flex-col">
                  <dt className="text-ink-muted">{t(`form.${key}`)}</dt>
                  <dd className={strong ? 'tabular font-semibold' : 'tabular'}>{t('form.quantity', { quantity, uom: line.uom })}</dd>
                </div>
              ))}
            </dl>
            {line.cancelled ? <p className="text-ink-muted">{t('form.cancelledNote', { quantity: line.cancelled, uom: line.uom })}</p> : null}
            {line.keepPending ? <p className="text-ink-muted">{t('form.keepPendingNote', { quantity: line.keepPending, uom: line.uom })}</p> : null}
          </li>
        ))}
      </ol>
    </section>
  )
}
