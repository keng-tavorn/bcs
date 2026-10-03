'use client'

import { Camera } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { useId, useState } from 'react'
import { Notice } from '../form/notice'
import { StatusMark } from './status'
import { nameIn, type ReceiptView, type VarianceView } from './types'

// The receipts of a PO so far, newest first (FR-P2P-006): who received what and when, the delivery note, what was
// refused and why, the variances with where they stand, and the photos — a photo opens through a download address valid
// five minutes that the server gives only after it checks the reader may see the receipt (FR-PLT-004 AC2), so no
// address sits in the page. Also the requests to close the PO short (FR-P2P-010 AC2).

function VarianceLine({ variance }: { variance: VarianceView }) {
  const t = useTranslations('receiving')
  return (
    <li className="flex flex-col gap-0.5">
      <StatusMark
        of="variance"
        status={variance.status}
        label={t('history.variance', {
          type: t(`variance.type.${variance.type}`),
          description: variance.description,
          quantity: variance.quantity,
          uom: variance.uom,
          disposition: t(`variance.disposition.${variance.disposition}`),
          status: t(`status.variance.${variance.status}`),
        })}
      />
      {variance.amount ? (
        // The amount in its own right-aligned cell, tabular digits (§9.9 principle 6)
        <span className="flex items-baseline justify-between gap-3 pl-5.5 text-base md:text-sm">
          <span className="text-ink-muted">{t('history.amountLabel')}</span>
          <span className="money shrink-0 text-ink">{t('history.baht', { amount: variance.amount })}</span>
        </span>
      ) : null}
      {variance.reason ? <span className="pl-5.5 text-base break-words text-ink-muted md:text-sm">{t('history.reason', { reason: variance.reason })}</span> : null}
    </li>
  )
}

export function ReceiptHistory({
  receipts,
  closeShort,
  locale,
  open,
}: {
  receipts: readonly ReceiptView[]
  closeShort: readonly VarianceView[]
  locale: string
  open: (fileId: string) => Promise<string | null>
}) {
  const t = useTranslations('receiving')
  const id = useId()
  const [busy, setBusy] = useState<string | null>(null)
  const [failed, setFailed] = useState<string | null>(null)

  async function onOpen(photo: { fileId: string; fileName: string }) {
    setBusy(photo.fileId)
    setFailed(null)
    const url = await open(photo.fileId).catch(() => null)
    setBusy(null)
    if (url) window.location.assign(url)
    else setFailed(photo.fileName)
  }

  return (
    <div className="flex flex-col gap-6">
      <section aria-labelledby={`${id}-receipts`} className="flex flex-col gap-3">
        <h2 id={`${id}-receipts`} className="text-lg font-semibold text-ink">
          {t('history.title')}
        </h2>
        {failed ? <Notice tone="danger">{t('history.photoFailed', { name: failed })}</Notice> : null}
        {receipts.length === 0 ? (
          <p className="text-ink-muted">{t('history.empty')}</p>
        ) : (
          <ul aria-label={t('history.label')} className="flex flex-col divide-y divide-line border-y border-line">
            {receipts.map((r) => (
              <li key={r.id} className="flex flex-col gap-2 py-3">
                <div className="flex flex-col gap-0.5">
                  <p className="font-semibold text-ink">{r.number ?? t('history.noNumber')}</p>
                  <StatusMark of="receipt" status={r.status} label={t(`status.receipt.${r.status}`)} />
                  <p className="text-base text-ink-muted md:text-sm">{t('history.byWhen', { time: r.when, name: nameIn(locale, r.receiver) || t('history.someone') })}</p>
                  {r.deliveryNoteNo ? <p className="break-words text-ink">{t('history.deliveryNote', { number: r.deliveryNoteNo })}</p> : null}
                  {r.reverseReason ? <p className="break-words text-ink">{t('history.reversed', { reason: r.reverseReason })}</p> : null}
                </div>
                <ul className="flex flex-col gap-1">
                  {r.lines.map((l) => (
                    <li key={l.poLineId} className="flex flex-col">
                      <span className="break-words text-ink">{t('history.line', { description: l.description, received: l.received, accepted: l.accepted, uom: l.uom })}</span>
                      {l.refused ? <span className="text-base text-ink-muted md:text-sm">{t('history.rejected', { quantity: l.refused, uom: l.uom })}</span> : null}
                      {l.remark ? <span className="text-base break-words text-ink-muted md:text-sm">{t('history.remark', { remark: l.remark })}</span> : null}
                    </li>
                  ))}
                </ul>
                {r.variances.length ? <ul className="flex flex-col gap-1">{r.variances.map((v) => <VarianceLine key={v.id} variance={v} />)}</ul> : null}
                {r.notes ? <p className="break-words whitespace-pre-line text-ink">{t('history.notes', { notes: r.notes })}</p> : null}
                {r.photos.length ? (
                  <ul aria-label={t('history.photos', { number: r.number ?? '' })} className="flex flex-col">
                    {r.photos.map((p) => (
                      <li key={p.fileId}>
                        <button
                          type="button"
                          onClick={() => void onOpen(p)}
                          disabled={busy === p.fileId}
                          aria-busy={busy === p.fileId || undefined}
                          className="inline-flex min-h-11 items-center gap-2 text-left font-medium text-primary underline underline-offset-4 hover:no-underline disabled:opacity-60"
                        >
                          <Camera className="size-4 shrink-0" aria-hidden="true" />
                          <span className="break-all">{busy === p.fileId ? t('history.openingPhoto', { name: p.fileName }) : t('history.openPhoto', { name: p.fileName })}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>

      {closeShort.length ? (
        <section aria-labelledby={`${id}-close-short`} className="flex flex-col gap-3">
          <h2 id={`${id}-close-short`} className="text-lg font-semibold text-ink">
            {t('closeShort.requestsTitle')}
          </h2>
          <ul className="flex flex-col gap-2 border-y border-line py-3">
            {closeShort.map((v) => (
              <VarianceLine key={v.id} variance={v} />
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  )
}
