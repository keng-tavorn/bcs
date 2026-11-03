import { CalendarClock, Layers, Scale, Tag, type LucideIcon } from 'lucide-react'
import Link from 'next/link'
import { cn } from '../cn'
import { ReportTable, type ReportCellView, type ReportColumnView, type ReportRowView } from '../insight/report-table'
import { Badge } from '../shadcn/badge'
import { Button } from '../shadcn/button'
import { Item, ItemContent, ItemMedia, ItemTitle } from '../shadcn/item'
import { SavingsEvidence } from './savings-evidence'

// The savings the assistant found (NEW-123 · FR-VIS-008 · ADR-081), one row each in the look of every assistant note
// (ADR-078): the icon of the kind of saving on a tinted ground, what was found, why, the amount the code calculated in
// tabular digits, one way to the page where it is dealt with, and the evidence as a table that becomes a list on a
// phone (§9.9). No Sparkles: the rows come from the rules, not from an AI (§12.5 · ADR-078). Strings arrive translated.

export type SavingsKindView = 'PRICE_ABOVE_HISTORY' | 'OFF_AGREEMENT' | 'SAME_ITEM_DEPARTMENTS' | 'AGREEMENT_EXPIRING'

const ICONS: Readonly<Record<SavingsKindView, LucideIcon>> = { PRICE_ABOVE_HISTORY: Tag, OFF_AGREEMENT: Scale, SAME_ITEM_DEPARTMENTS: Layers, AGREEMENT_EXPIRING: CalendarClock }
const GROUND: Readonly<Record<SavingsKindView, string>> = {
  PRICE_ABOVE_HISTORY: 'bg-warn-bg text-warn-ink',
  OFF_AGREEMENT: 'bg-warn-bg text-warn-ink',
  SAME_ITEM_DEPARTMENTS: 'bg-info-bg text-info-ink',
  AGREEMENT_EXPIRING: 'bg-info-bg text-info-ink',
}

export interface SavingsEvidenceView {
  readonly title: string
  readonly columns: readonly ReportColumnView[]
  readonly rows: readonly ReportRowView[]
  /** Under the table, e.g. "แสดง 10 จาก 14 รายการ" or the statistics of the samples */
  readonly notes: readonly string[]
  /** Said instead of a table without rows */
  readonly empty: string
}

export interface SavingsItemView {
  readonly key: string
  readonly kind: SavingsKindView
  readonly title: string
  readonly why: string
  /** A line more, e.g. the requester's reason or the delivery site */
  readonly note: string | null
  readonly amount: string
  /** Where the request waits ("รออนุมัติ" · "รอจัดซื้อ") */
  readonly stage: string | null
  readonly action: { readonly href: string; readonly label: string } | null
  readonly evidence: SavingsEvidenceView
}

function EvidenceCell({ cell }: { cell: ReportCellView | undefined }) {
  if (cell?.text && cell.href)
    return (
      <Link href={cell.href} className="font-medium text-primary underline underline-offset-4 hover:no-underline">
        {cell.text}
      </Link>
    )
  if (cell?.text) return <>{cell.text}</>
  return (
    <>
      <span aria-hidden="true">—</span>
      {cell?.emptyLabel ? <span className="sr-only">{cell.emptyLabel}</span> : null}
    </>
  )
}

/**
 * The evidence: the report table from 768 px; on a phone each row a short list headed by its first column, the label
 * as wide as its words and the value wrapping beside it — a supplier's long name never squeezes the label under it
 */
function Evidence({ view }: { view: SavingsEvidenceView }) {
  const [first, ...rest] = view.columns
  return (
    <>
      <div className="hidden md:block">
        <ReportTable caption={view.title} columns={view.columns} rows={view.rows} rowHeader={0} lead={1} />
      </div>
      <ul aria-label={view.title} className="flex flex-col divide-y divide-line border-y border-line md:hidden">
        {view.rows.map((r) => (
          <li key={r.id} className="flex flex-col gap-1.5 py-3">
            <p className="font-semibold text-ink">{first ? <EvidenceCell cell={r.cells[first.key]} /> : null}</p>
            <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1">
              {rest.map((c) => (
                <div key={c.key} className="contents">
                  <dt className="text-ink-muted">{c.header}</dt>
                  <dd className={c.numeric ? 'text-right tabular-nums' : 'break-words'}>
                    <EvidenceCell cell={r.cells[c.key]} />
                  </dd>
                </div>
              ))}
            </dl>
          </li>
        ))}
      </ul>
    </>
  )
}

export function SavingsList({ items, labels }: { items: readonly SavingsItemView[]; labels: { readonly show: string; readonly hide: string } }) {
  return (
    <div role="list" className="flex flex-col">
      {items.map((item) => (
        <SavingsRow key={item.key} item={item} labels={labels} />
      ))}
    </div>
  )
}

function SavingsRow({ item, labels }: { item: SavingsItemView; labels: { readonly show: string; readonly hide: string } }) {
  const Icon = ICONS[item.kind]
  const evidenceId = `savings-evidence-${item.key.replace(/[^A-Za-z0-9_-]/g, '-')}`
  return (
    <Item role="listitem" size="sm" className="items-start rounded-none border-0 border-b border-line px-1 py-4 last:border-b-0" data-savings={item.key}>
      <ItemMedia>
        <span className={cn('flex size-9 shrink-0 items-center justify-center rounded-md', GROUND[item.kind])}>
          <Icon className="size-5" aria-hidden="true" />
        </span>
      </ItemMedia>
      <ItemContent className="min-w-0 gap-1">
        <div className="flex flex-col gap-1 md:flex-row md:items-start md:justify-between md:gap-4">
          <ItemTitle className="text-base font-medium break-words text-ink md:text-sm">{item.title}</ItemTitle>
          <p className="shrink-0 text-base font-semibold text-ink tabular-nums md:text-right md:text-sm">{item.amount}</p>
        </div>
        <p className="text-base break-words text-ink-muted md:text-sm">{item.why}</p>
        {item.note ? <p className="text-base break-words text-ink-muted md:text-sm">{item.note}</p> : null}
        {item.stage ? (
          <Badge variant="outline" className="self-start">
            {item.stage}
          </Badge>
        ) : null}
      </ItemContent>
      {/* The row's full width below the icon on a phone, under the words from a computer: the way to the page and the
          evidence */}
      <div className="flex min-w-0 basis-full flex-col gap-2 md:pl-12">
        <SavingsEvidence
          id={evidenceId}
          show={labels.show}
          hide={labels.hide}
          action={
            item.action ? (
              <Button asChild variant="outline" className="min-h-11 lg:min-h-9">
                <Link href={item.action.href}>{item.action.label}</Link>
              </Button>
            ) : null
          }
        >
          <h3 className="text-base font-medium md:text-sm">{item.evidence.title}</h3>
          {item.evidence.rows.length ? (
            <Evidence view={item.evidence} />
          ) : (
            <p className="text-base text-ink-muted md:text-sm">{item.evidence.empty}</p>
          )}
          {item.evidence.notes.map((n) => (
            <p key={n} className="text-base text-ink-muted md:text-sm">
              {n}
            </p>
          ))}
        </SavingsEvidence>
      </div>
    </Item>
  )
}
