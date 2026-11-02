import { CircleAlert } from 'lucide-react'
import type { getTranslations } from 'next-intl/server'
import Link from 'next/link'
import { formatSatang } from '@/core/money/format'
import { formatEnglishBeDay, formatThaiDay } from '@/core/thai/day'
import { StatusBadge } from '../../document/badges'
import { CommentList } from '../../document/rail'
import { formatDateTime } from '../../format'
import { Panel } from '../../page/page'
import { Badge } from '../../shadcn/badge'
import { MATCH_BADGES, type ApInvoicePageData } from './types'

// The parts of the invoice's split page that only read (NEW-115 · FR-AP-102 AC7 AC8): the bar of what the PO has left,
// its lines against their PO lines, where the invoice came from, and the reasons people wrote on it. Figures come from
// the service as they are (src/server/services/ap/view-invoice.ts); nothing is worked out here but the drawing.

export type InvoiceT = Awaited<ReturnType<typeof getTranslations<'apInvoice'>>>
export type InvoiceLocale = 'th' | 'en'

export const invoiceLinkClass = 'inline-flex min-h-11 items-center self-start font-medium text-primary underline underline-offset-4 hover:no-underline'
export const money = (satang: bigint) => formatSatang(satang)
export const dayText = (locale: InvoiceLocale, day: string) => (locale === 'en' ? formatEnglishBeDay(day) : formatThaiDay(day)) ?? day
export const nameOf = (locale: InvoiceLocale, name: { readonly th: string; readonly en: string | null }) => (locale === 'en' && name.en ? name.en : name.th)

/** One part of the bar in words: a colour square ties it to the bar, and the words say what it is (never colour alone) */
function Part({ label, value, swatch, strong, danger }: { label: string; value: string; swatch?: string; strong?: boolean; danger?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="flex min-w-0 items-center gap-1.5 text-ink-muted">
        {swatch ? <span aria-hidden="true" className={`size-2.5 shrink-0 rounded-sm ${swatch}`} /> : null}
        {danger ? <CircleAlert className="size-4 shrink-0 text-danger-ink" aria-hidden="true" /> : null}
        {label}
      </dt>
      <dd className={`money shrink-0 ${danger ? 'text-danger-ink' : 'text-ink'} ${strong ? 'font-semibold' : ''}`}>{value}</dd>
    </div>
  )
}

/** What the PO has left: the other invoices and this one on a bar against the PO's amount, before VAT (Zip's bar, our words) */
export function PoBalancePanel({ t, data }: { t: InvoiceT; data: ApInvoicePageData }) {
  const b = data.poBalance
  const over = b.remainingSatang < 0n
  const pending = data.status === 'DRAFT' || data.status === 'EXCEPTION'
  const summary = t('poBar.summary', { own: money(b.thisCounts ? b.thisNetSatang : 0n), others: money(b.otherInvoicedSatang), po: money(b.poNetSatang) })
  return (
    <Panel
      title={t('poBar.title')}
      id="invoice-po-bar"
      actions={
        <Link href={`/procurement/pos/${data.po.id}`} className={invoiceLinkClass}>
          {data.po.number ? t('header.poLink', { number: data.po.number }) : t('header.poNoNumber')}
        </Link>
      }
    >
      <div role="img" aria-label={summary} className="flex h-3 w-full overflow-hidden rounded-full bg-neutral-bg">
        <span className="h-full bg-line-strong" style={{ width: `${b.otherBp / 100}%` }} />
        <span className="h-full bg-primary" style={{ width: `${b.thisBp / 100}%` }} />
      </div>
      <dl className="grid gap-x-6 gap-y-1 sm:grid-cols-2">
        <Part label={t('poBar.this')} value={money(b.thisNetSatang)} swatch="bg-primary" />
        <Part label={t('poBar.others')} value={money(b.otherInvoicedSatang)} swatch="bg-line-strong" />
        <Part label={over ? t('poBar.over') : t('poBar.remaining')} value={money(over ? -b.remainingSatang : b.remainingSatang)} strong danger={over} />
        <Part label={t('poBar.po')} value={money(b.poNetSatang)} />
      </dl>
      <p className="text-base text-ink-muted md:text-sm">
        {[t('poBar.unit'), !b.thisCounts ? t('poBar.notCounted') : pending ? t('poBar.pending') : null, b.shortClosed ? t('poBar.shortClosed') : null].filter(Boolean).join(' · ')}
      </p>
    </Panel>
  )
}

/** Each line against its PO line: what was ordered, received and taken by other invoices, its price and the match's result */
export function MatchPanel({ t, locale, data }: { t: InvoiceT; locale: InvoiceLocale; data: ApInvoicePageData }) {
  return (
    <Panel title={t('match.title')} id="invoice-match">
      <p className="text-ink-muted">{data.lastMatchAt ? t('match.checkedAt', { time: formatDateTime(locale, data.lastMatchAt) }) : t('match.notYet')}</p>
      {data.lines.length === 0 ? (
        <p className="text-ink-muted">{t('lines.empty')}</p>
      ) : (
        <ul aria-label={t('match.title')} className="flex flex-col divide-y divide-line border-y border-line">
          {data.lines.map((l) => (
            <li key={l.id} className="flex flex-col gap-2 py-3">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <span className="min-w-0 font-medium break-words text-ink">
                  {t('lines.poLine', { no: l.poLineNo })} · {l.description}
                </span>
                <span className="flex flex-wrap gap-1">
                  <StatusBadge look={MATCH_BADGES[l.matchStatus]} label={t(`lines.match.${l.matchStatus as 'PENDING'}`)} />
                  {l.flags.includes('PRICE_UNDER') ? <Badge variant="info">{t('lines.priceUnder')}</Badge> : null}
                </span>
              </div>
              <dl className="grid gap-x-6 gap-y-1 sm:grid-cols-2">
                <Part label={t('match.ordered')} value={`${l.poLine.ordered} ${l.uom}`} />
                <Part label={t('match.received')} value={`${l.poLine.received} ${l.uom}`} />
                <Part label={t('match.elsewhere')} value={`${l.poLine.invoicedElsewhere} ${l.uom}`} />
                <Part label={t('match.thisInvoice')} value={`${l.quantity} ${l.uom}`} strong />
                <Part label={t('match.poPrice')} value={money(l.poUnitPriceSatang)} />
                <Part label={t('match.thisPrice')} value={money(l.unitPriceSatang)} strong />
                {l.poLine.cancelled !== '0' ? <Part label={t('match.cancelled')} value={`${l.poLine.cancelled} ${l.uom}`} /> : null}
              </dl>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  )
}

/** How the invoice arrived; the e-mail's address and subject only for those the service gives them to */
export function SourcePanel({ t, locale, data }: { t: InvoiceT; locale: InvoiceLocale; data: ApInvoicePageData }) {
  const { source } = data
  const channel = t.has(`sourcePanel.channelValue.${data.channel}` as 'sourcePanel.channelValue.EMAIL') ? t(`sourcePanel.channelValue.${data.channel}` as 'sourcePanel.channelValue.EMAIL') : data.channel
  const prefill = t.has(`sourcePanel.prefillValue.${data.prefill}` as 'sourcePanel.prefillValue.MANUAL') ? t(`sourcePanel.prefillValue.${data.prefill}` as 'sourcePanel.prefillValue.MANUAL') : data.prefill
  const rows: ReadonlyArray<readonly [string, string]> = [
    [t('sourcePanel.channel'), channel],
    [t('sourcePanel.prefill'), prefill],
    [t('sourcePanel.createdBy'), source.createdBy ? nameOf(locale, source.createdBy) : t('history.system')],
    [t('sourcePanel.createdAt'), formatDateTime(locale, source.createdAt)],
    ...(source.email
      ? ([
          [t('sourcePanel.from'), source.email.from],
          [t('sourcePanel.subject'), source.email.subject],
          [t('sourcePanel.receivedAt'), formatDateTime(locale, source.email.receivedAt)],
        ] as const)
      : []),
  ]
  return (
    <Panel title={t('sourcePanel.title')} id="invoice-source">
      <dl className="flex flex-col divide-y divide-line border-y border-line">
        {rows.map(([label, value]) => (
          <div key={label} className="flex flex-col gap-1 py-1.5 md:flex-row md:items-baseline md:justify-between md:gap-4">
            <dt className="shrink-0 text-ink-muted">{label}</dt>
            <dd className="min-w-0 break-words text-ink md:text-right">{value}</dd>
          </div>
        ))}
      </dl>
    </Panel>
  )
}

/** The reasons people wrote on the invoice, oldest first, as on the document page: writing one's own is NEW-78 */
export function InvoiceComments({ t, locale, data, eventText }: { t: InvoiceT; locale: InvoiceLocale; data: ApInvoicePageData; eventText: (type: string) => string }) {
  const comments = data.events.flatMap((e) =>
    e.reason ? [{ key: e.id, kind: eventText(e.type), text: e.reason, by: t('commentsPanel.by', { name: e.actor ? nameOf(locale, e.actor) : t('history.system'), time: formatDateTime(locale, e.occurredAt) }) }] : [],
  )
  return (
    <Panel title={t('commentsPanel.title')} id="invoice-comments">
      <CommentList comments={comments} label={t('commentsPanel.title')} empty={t('commentsPanel.empty')} />
    </Panel>
  )
}

export const commentCount = (data: ApInvoicePageData) => data.events.filter((e) => e.reason).length
