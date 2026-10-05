import { useTranslations } from 'next-intl'
import { nameIn, type ReceiptView, type VarianceView } from '../../receiving/types'
import { LiffStatusMark } from './marks'
import { LiffPhotoButton } from './photo-button'

// The receipts of a PO so far on the LIFF receiving page, newest first (FR-P2P-006, FR-LINE-003 AC3): who received what
// and when, the delivery note, what was refused, the variances with where they stand, the notes and the photos — each
// photo opens in the page through an address the server gives after it checks the reader (./photo-button.tsx); photos of
// one receipt that share a name (an iPhone calls every capture "image.jpg") are numbered, so each button has a name of
// its own. Also the requests to close the PO short. The same words as the workspace's
// src/ui/receiving/receipt-history.tsx, rendered by the server: only the photo buttons carry JavaScript.

/** Each photo of a receipt with what it is called: its name, numbered by its place when another photo has the same name */
export function photoNames<P extends { readonly fileName: string }>(photos: readonly P[], numbered: (name: string, n: number) => string): Array<P & { readonly name: string }> {
  const counts = new Map<string, number>()
  for (const p of photos) counts.set(p.fileName.toLowerCase(), (counts.get(p.fileName.toLowerCase()) ?? 0) + 1)
  return photos.map((p, i) => ({ ...p, name: (counts.get(p.fileName.toLowerCase()) ?? 0) > 1 ? numbered(p.fileName, i + 1) : p.fileName }))
}

function VarianceLine({ variance }: { readonly variance: VarianceView }) {
  const t = useTranslations('receiving')
  return (
    <li className="flex flex-col gap-0.5">
      <LiffStatusMark
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
        <span className="flex items-baseline justify-between gap-3 pl-5.5">
          <span className="text-ink-muted">{t('history.amountLabel')}</span>
          <span className="money shrink-0">{t('history.baht', { amount: variance.amount })}</span>
        </span>
      ) : null}
      {variance.reason ? <span className="pl-5.5 break-words text-ink-muted">{t('history.reason', { reason: variance.reason })}</span> : null}
    </li>
  )
}

export interface LiffReceiptsProps {
  readonly receipts: readonly ReceiptView[]
  readonly closeShort: readonly VarianceView[]
  readonly locale: string
  readonly open: (fileId: string) => Promise<string | null>
}

export function LiffReceipts({ receipts, closeShort, locale, open }: LiffReceiptsProps) {
  const t = useTranslations('receiving')
  const tLiff = useTranslations('liffReceiving')
  const numbered = (name: string, n: number) => tLiff('photoNumbered', { name, n })
  return (
    <>
      <section aria-labelledby="liff-gr-receipts" className="flex flex-col gap-3 border-t border-line pt-5">
        <h2 id="liff-gr-receipts" className="text-lg leading-snug font-semibold">
          {t('history.title')}
        </h2>
        {receipts.length === 0 ? (
          <p className="text-ink-muted">{t('history.empty')}</p>
        ) : (
          <ul aria-label={t('history.label')} className="flex flex-col divide-y divide-line border-y border-line">
            {receipts.map((r) => (
              <li key={r.id} className="flex flex-col gap-2 py-3">
                <div className="flex flex-col gap-0.5">
                  <p className="font-semibold">{r.number ?? t('history.noNumber')}</p>
                  <LiffStatusMark of="receipt" status={r.status} label={t(`status.receipt.${r.status}`)} />
                  <p className="text-ink-muted">{t('history.byWhen', { time: r.when, name: nameIn(locale, r.receiver) || t('history.someone') })}</p>
                  {r.deliveryNoteNo ? <p className="break-words">{t('history.deliveryNote', { number: r.deliveryNoteNo })}</p> : null}
                  {r.reverseReason ? <p className="break-words">{t('history.reversed', { reason: r.reverseReason })}</p> : null}
                </div>
                <ul className="flex flex-col gap-1">
                  {r.lines.map((l) => (
                    <li key={l.poLineId} className="flex flex-col">
                      <span className="break-words">{t('history.line', { description: l.description, received: l.received, accepted: l.accepted, uom: l.uom })}</span>
                      {l.refused ? <span className="text-ink-muted">{t('history.rejected', { quantity: l.refused, uom: l.uom })}</span> : null}
                      {l.remark ? <span className="break-words text-ink-muted">{t('history.remark', { remark: l.remark })}</span> : null}
                    </li>
                  ))}
                </ul>
                {r.variances.length ? (
                  <ul className="flex flex-col gap-1">
                    {r.variances.map((v) => (
                      <VarianceLine key={v.id} variance={v} />
                    ))}
                  </ul>
                ) : null}
                {r.notes ? <p className="break-words whitespace-pre-line">{t('history.notes', { notes: r.notes })}</p> : null}
                {r.photos.length ? (
                  <ul aria-label={t('history.photos', { number: r.number ?? '' })} className="flex flex-col gap-1">
                    {photoNames(r.photos, numbered).map((p) => (
                      <li key={p.fileId}>
                        <LiffPhotoButton fileId={p.fileId} name={p.name} open={open} />
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
        <section aria-labelledby="liff-gr-close-short" className="flex flex-col gap-3 border-t border-line pt-5">
          <h2 id="liff-gr-close-short" className="text-lg leading-snug font-semibold">
            {t('closeShort.requestsTitle')}
          </h2>
          <ul className="flex flex-col gap-2">
            {closeShort.map((v) => (
              <VarianceLine key={v.id} variance={v} />
            ))}
          </ul>
        </section>
      ) : null}
    </>
  )
}
