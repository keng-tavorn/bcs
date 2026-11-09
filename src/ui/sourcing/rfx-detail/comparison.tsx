'use client'

import { useTranslations } from 'next-intl'
import { useState } from 'react'
import { StatusBadge } from '../../document/badges'
import type { BadgeLook } from '../../document/badge-looks'
import { Notice } from '../../form/notice'
import { useSubmissionKey } from '../../form/submission-key'
import { Badge } from '../../shadcn/badge'
import { Button } from '../../shadcn/button'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from '../../shadcn/sheet'
import { Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow } from '../../shadcn/table'
import { bahtText, dayText, percentText, whenText } from './format'
import { BID_TAG_KEYS, errorKey, keyIn, PRICE_FLAG_KEYS, REF_SOURCE_KEYS, type Locale, type RfxExportOutcome } from './model'

// The comparison of an RFx's bids once the envelope is open (S10-09 · BR-RFX-08 BR-RFX-11 · FR-SRC-202 AC5): per line and
// bid the amount before VAT (a bid quoted with VAT brought to its amount before VAT), the lowest marked, the price flag
// against the reference (word and icon, never colour alone), the bid's tags and with RISK on its risk tag; the totals
// before VAT, VAT and with VAT. A wide table on a computer (it scrolls inside its frame), a list per bid on a phone. Each
// bid opens its terms and files in a sheet (a file opens only once clean · BR-RFX-07); Excel export with its checksum.

export interface ComparisonLineView {
  readonly id: string
  readonly lineNo: number
  readonly description: string
  readonly quantity: string
  readonly uom: string
}

export interface ComparisonBidView {
  readonly bidId: string
  readonly supplierCode: string
  readonly supplierName: string
  readonly individual: boolean
  readonly net: string
  readonly vat: string
  readonly gross: string
  readonly partial: boolean
  readonly lowest: boolean
  readonly tags: readonly string[]
  readonly risk: { readonly tier: string | null; readonly blocked: boolean } | null
  readonly lines: ReadonlyArray<{
    readonly rfxLineId: string
    readonly offered: boolean
    readonly quotedUnitPrice: string | null
    readonly lineNet: string | null
    readonly reference: { readonly unitPrice: string; readonly source: string } | null
    readonly deviationBp: number | null
    readonly flag: string | null
    readonly lowest: boolean
  }>
}

export interface BidDetailView {
  readonly bidId: string
  readonly submittedAt: string | null
  readonly submitCount: number
  readonly onBehalf: boolean
  readonly priceIncludesVat: boolean
  readonly validUntil: string | null
  readonly deliveryDays: number | null
  readonly promisedDeliveryOn: string | null
  readonly note: string | null
  readonly lines: ReadonlyArray<{ readonly rfxLineId: string; readonly brand: string | null; readonly leadTimeDays: number | null; readonly note: string | null }>
  readonly files: ReadonlyArray<{ readonly id: string; readonly name: string; readonly scan: string; readonly openable: boolean }>
}

export interface ComparisonActions {
  readonly exportFile: (key: string) => Promise<RfxExportOutcome>
  /** The download address of the exported file (null when it may not be opened) */
  readonly openExport: (fileId: string) => Promise<string | null>
  readonly openBidFile: (fileId: string) => Promise<string | null>
}

const FLAG_LOOK: Readonly<Record<(typeof PRICE_FLAG_KEYS)[number], BadgeLook>> = {
  ABOVE_AGREEMENT: { tone: 'warn', icon: 'TrendingUp' },
  HIGH: { tone: 'warn', icon: 'TrendingUp' },
  LOW: { tone: 'info', icon: 'TrendingDown' },
}
const LOWEST_LOOK: BadgeLook = { tone: 'ok', icon: 'CircleCheck' }
const RISK_LOOK: Readonly<Record<'OK' | 'BLOCKED', BadgeLook>> = { OK: { tone: 'neutral', icon: 'Gauge' }, BLOCKED: { tone: 'danger', icon: 'Ban' } }

function useNames() {
  const t = useTranslations('sourcing.detail.bids')
  return (b: Pick<ComparisonBidView, 'individual' | 'supplierCode' | 'supplierName'>) => (b.individual ? t('individual', { code: b.supplierCode }) : b.supplierName)
}

function BidTags({ bid, riskOn }: { readonly bid: ComparisonBidView; readonly riskOn: boolean }) {
  const t = useTranslations('sourcing.detail.bids')
  return (
    <span className="flex flex-wrap gap-1">
      {bid.lowest ? <StatusBadge look={LOWEST_LOOK} label={t('lowestBid')} /> : null}
      {bid.partial ? <Badge variant="outline">{t('partial')}</Badge> : null}
      {bid.tags.map((tag) => (
        <Badge key={tag} variant="outline">
          {t(`tag.${keyIn(BID_TAG_KEYS, tag, 'VAT_INCLUDED')}`)}
        </Badge>
      ))}
      {riskOn && bid.risk ? (
        <StatusBadge look={bid.risk.blocked ? RISK_LOOK.BLOCKED : RISK_LOOK.OK} label={bid.risk.blocked ? t('riskBlocked', { tier: bid.risk.tier ?? t('riskNone') }) : t('risk', { tier: bid.risk.tier ?? t('riskNone') })} />
      ) : null}
    </span>
  )
}

function LineCell({ line }: { readonly line: ComparisonBidView['lines'][number] | undefined }) {
  const t = useTranslations('sourcing.detail.bids')
  if (!line || !line.offered || line.lineNet === null) return <span className="text-ink-muted">{t('notOffered')}</span>
  const flag = line.flag ? keyIn(PRICE_FLAG_KEYS, line.flag, 'HIGH') : null
  return (
    <span className="flex flex-col items-end gap-1">
      <span className={line.lowest ? 'tabular font-semibold' : 'tabular'}>{bahtText(line.lineNet)}</span>
      {line.lowest ? <span className="text-base text-ink-muted md:text-sm">{t('lowestLine')}</span> : null}
      {flag ? <StatusBadge look={FLAG_LOOK[flag]} label={t(`flag.${flag}`, { percent: line.deviationBp === null ? '-' : percentText(line.deviationBp) })} /> : null}
    </span>
  )
}

export function ComparisonView({
  lines,
  bids,
  details,
  locale,
  riskOn,
  actions,
}: {
  readonly lines: readonly ComparisonLineView[]
  readonly bids: readonly ComparisonBidView[]
  readonly details: readonly BidDetailView[]
  readonly locale: Locale
  readonly riskOn: boolean
  readonly actions: ComparisonActions
}) {
  const t = useTranslations('sourcing.detail.bids')
  const name = useNames()
  const detailOf = new Map(details.map((d) => [d.bidId, d]))
  if (!bids.length) return <p className="text-ink-muted">{t('noBids')}</p>
  return (
    <div className="flex flex-col gap-4">
      <p className="text-base text-ink-muted md:text-sm">{t('compareIntro')}</p>
      <ExportButton actions={actions} />
      {/* a computer: lines down, bids across; the frame scrolls, never the page */}
      <div className="hidden overflow-x-auto md:block">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead scope="col">{t('line')}</TableHead>
              {bids.map((b) => (
                <TableHead key={b.bidId} scope="col" className="min-w-48 align-top whitespace-normal">
                  <span className="flex flex-col items-start gap-1 py-2">
                    <span className="font-semibold text-ink">{name(b)}</span>
                    <BidTags bid={b} riskOn={riskOn} />
                    <BidSheet bid={b} detail={detailOf.get(b.bidId)} lines={lines} locale={locale} openFile={actions.openBidFile} />
                  </span>
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {lines.map((l) => {
              const ref = bids.map((b) => b.lines.find((x) => x.rfxLineId === l.id)?.reference).find((r) => r)
              return (
                <TableRow key={l.id}>
                  <TableHead scope="row" className="min-w-56 align-top font-normal whitespace-normal">
                    <span className="flex flex-col gap-1">
                      <span>{t('lineOf', { no: l.lineNo, description: l.description })}</span>
                      <span className="text-base text-ink-muted md:text-sm">{t('qty', { quantity: l.quantity, uom: l.uom })}</span>
                      {ref ? <span className="text-base text-ink-muted md:text-sm">{t('reference', { price: bahtText(ref.unitPrice), source: t(`refSource.${keyIn(REF_SOURCE_KEYS, ref.source, 'MANUAL')}`) })}</span> : null}
                    </span>
                  </TableHead>
                  {bids.map((b) => (
                    <TableCell key={b.bidId} className="text-right align-top">
                      <LineCell line={b.lines.find((x) => x.rfxLineId === l.id)} />
                    </TableCell>
                  ))}
                </TableRow>
              )
            })}
          </TableBody>
          <TableFooter>
            {(['net', 'vat', 'gross'] as const).map((k) => (
              <TableRow key={k}>
                <TableHead scope="row">{t(`total.${k}`)}</TableHead>
                {bids.map((b) => (
                  <TableCell key={b.bidId} className={k === 'gross' ? 'tabular text-right font-semibold' : 'tabular text-right'}>
                    {bahtText(b[k])}
                  </TableCell>
                ))}
              </TableRow>
            ))}
          </TableFooter>
        </Table>
      </div>
      {/* a phone: one bid after another */}
      <ul className="flex flex-col gap-4 md:hidden">
        {bids.map((b) => (
          <li key={b.bidId} className="flex flex-col gap-2 border-b border-line pb-4 last:border-b-0">
            <span className="font-semibold">{name(b)}</span>
            <BidTags bid={b} riskOn={riskOn} />
            <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1">
              {lines.map((l) => (
                <div key={l.id} className="contents">
                  <dt className="break-words">{t('lineOf', { no: l.lineNo, description: l.description })}</dt>
                  <dd className="text-right">
                    <LineCell line={b.lines.find((x) => x.rfxLineId === l.id)} />
                  </dd>
                </div>
              ))}
              {(['net', 'vat', 'gross'] as const).map((k) => (
                <div key={k} className="contents">
                  <dt className="text-ink-muted">{t(`total.${k}`)}</dt>
                  <dd className={k === 'gross' ? 'tabular text-right font-semibold' : 'tabular text-right'}>{bahtText(b[k])}</dd>
                </div>
              ))}
            </dl>
            <BidSheet bid={b} detail={detailOf.get(b.bidId)} lines={lines} locale={locale} openFile={actions.openBidFile} />
          </li>
        ))}
      </ul>
    </div>
  )
}

function ExportButton({ actions }: { readonly actions: ComparisonActions }) {
  const t = useTranslations('sourcing.detail')
  const submission = useSubmissionKey()
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  async function run() {
    setPending(true)
    setError(null)
    let outcome: RfxExportOutcome
    try {
      outcome = await actions.exportFile(submission.key)
      submission.next()
    } catch {
      outcome = { ok: false, code: 'OTHER' }
    }
    if (outcome.ok) {
      const url = await actions.openExport(outcome.fileId).catch(() => null)
      if (url) window.location.assign(url)
      else setError(t('bids.exportOpenFailed'))
    } else setError(t(`errors.${errorKey(outcome)}`))
    setPending(false)
  }
  return (
    <div className="flex flex-col gap-2">
      <Button variant="outline" className="min-h-11 self-start lg:min-h-10" disabled={pending} onClick={() => void run()}>
        {pending ? t('bids.exporting') : t('bids.export')}
      </Button>
      {error ? <Notice tone="danger">{error}</Notice> : null}
    </div>
  )
}

function BidSheet({
  bid,
  detail,
  lines,
  locale,
  openFile,
}: {
  readonly bid: ComparisonBidView
  readonly detail: BidDetailView | undefined
  readonly lines: readonly ComparisonLineView[]
  readonly locale: Locale
  readonly openFile: (fileId: string) => Promise<string | null>
}) {
  const t = useTranslations('sourcing.detail.bids')
  const name = useNames()
  const [failed, setFailed] = useState(false)
  async function open(fileId: string) {
    setFailed(false)
    const url = await openFile(fileId).catch(() => null)
    if (url) window.open(url, '_blank', 'noopener')
    else setFailed(true)
  }
  const dash = '-'
  const terms: Array<[string, string]> = detail
    ? [
        [t('sheet.submittedAt'), detail.submittedAt ? whenText(locale, detail.submittedAt) : dash],
        [t('sheet.submitCount'), String(detail.submitCount)],
        [t('sheet.by'), detail.onBehalf ? t('sheet.onBehalf') : t('sheet.bySupplier')],
        [t('sheet.vat'), detail.priceIncludesVat ? t('sheet.vatIncluded') : t('sheet.vatExcluded')],
        [t('sheet.validUntil'), detail.validUntil ? dayText(locale, detail.validUntil) : dash],
        [t('sheet.deliveryDays'), detail.deliveryDays === null ? dash : t('sheet.days', { days: detail.deliveryDays })],
        [t('sheet.promisedDeliveryOn'), detail.promisedDeliveryOn ? dayText(locale, detail.promisedDeliveryOn) : dash],
      ]
    : []
  return (
    <Sheet>
      <SheetTrigger asChild>
        <Button variant="link" className="h-auto min-h-11 px-0 text-left whitespace-normal lg:min-h-0">
          {t('sheet.open', { supplier: name(bid) })}
        </Button>
      </SheetTrigger>
      <SheetContent className="w-full overflow-y-auto sm:max-w-xl">
        <SheetHeader>
          <SheetTitle>{t('sheet.title', { supplier: name(bid) })}</SheetTitle>
          <SheetDescription>{t('sheet.intro')}</SheetDescription>
        </SheetHeader>
        <div className="flex flex-col gap-4 px-4 pb-6">
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
            {(['net', 'vat', 'gross'] as const).map((k) => (
              <div key={k} className="contents">
                <dt className="text-ink-muted">{t(`total.${k}`)}</dt>
                <dd className="tabular text-right">{bahtText(bid[k])}</dd>
              </div>
            ))}
            {terms.map(([label, value]) => (
              <div key={label} className="contents">
                <dt className="text-ink-muted">{label}</dt>
                <dd className="text-right break-words">{value}</dd>
              </div>
            ))}
          </dl>
          {detail?.note ? (
            <div className="flex flex-col gap-1">
              <h3 className="font-semibold">{t('sheet.note')}</h3>
              <p className="break-words whitespace-pre-line">{detail.note}</p>
            </div>
          ) : null}
          <div className="flex flex-col gap-2">
            <h3 className="font-semibold">{t('sheet.lines')}</h3>
            <ul className="flex flex-col gap-3">
              {lines.map((l) => {
                const line = bid.lines.find((x) => x.rfxLineId === l.id)
                const extra = detail?.lines.find((x) => x.rfxLineId === l.id)
                return (
                  <li key={l.id} className="flex flex-col gap-1 border-b border-line pb-2 last:border-b-0">
                    <span className="break-words">{t('lineOf', { no: l.lineNo, description: l.description })}</span>
                    {line?.offered && line.quotedUnitPrice !== null ? (
                      <span className="tabular text-base text-ink-muted md:text-sm">{t('sheet.unitPrice', { price: bahtText(line.quotedUnitPrice), quantity: l.quantity, uom: l.uom })}</span>
                    ) : (
                      <span className="text-base text-ink-muted md:text-sm">{t('notOffered')}</span>
                    )}
                    {extra?.brand ? <span className="text-base md:text-sm">{t('sheet.brand', { brand: extra.brand })}</span> : null}
                    {extra?.leadTimeDays !== null && extra?.leadTimeDays !== undefined ? <span className="text-base md:text-sm">{t('sheet.leadTime', { days: extra.leadTimeDays })}</span> : null}
                    {extra?.note ? <span className="text-base break-words whitespace-pre-line md:text-sm">{extra.note}</span> : null}
                  </li>
                )
              })}
            </ul>
          </div>
          <div className="flex flex-col gap-2">
            <h3 className="font-semibold">{t('sheet.files')}</h3>
            {failed ? <Notice tone="danger">{t('sheet.fileFailed')}</Notice> : null}
            {detail?.files.length ? (
              <ul className="flex flex-col gap-1">
                {detail.files.map((f) => (
                  <li key={f.id} className="flex flex-wrap items-center gap-2">
                    {f.openable ? (
                      <Button variant="link" className="h-auto min-h-11 px-0 text-left whitespace-normal lg:min-h-0" onClick={() => void open(f.id)}>
                        {t('sheet.openFile', { name: f.name })}
                      </Button>
                    ) : (
                      <span className="break-words">{t('sheet.fileWaiting', { name: f.name })}</span>
                    )}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-ink-muted">{t('sheet.noFiles')}</p>
            )}
          </div>
        </div>
      </SheetContent>
    </Sheet>
  )
}
