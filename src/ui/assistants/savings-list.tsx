import { CalendarClock, Layers, Scale, Tag, type LucideIcon } from 'lucide-react'
import Link from 'next/link'
import type { ReactNode } from 'react'
import { cn } from '../cn'
import { ReportTable, type ReportColumnView, type ReportRowView } from '../insight/report-table'
import { Badge } from '../shadcn/badge'
import { Button } from '../shadcn/button'
import { Item, ItemContent, ItemMedia, ItemTitle } from '../shadcn/item'
import { SavingsEvidence } from './savings-evidence'

// The savings the assistant found (NEW-123 · FR-VIS-008 · ADR-081), one row each in the look of every assistant note
// (ADR-078): the icon of the kind of saving on a tinted ground, what was found, why, the amount the code calculated in
// tabular digits, one way to the page where it is dealt with, the evidence as a table that becomes a list on a phone
// (§9.9), and the place where the assistant's own words go when the reader asks for them. No Sparkles here: the rows
// come from the rules; only the explanation an AI wrote carries it (§12.5). Strings arrive translated.

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

export function SavingsList({ items, labels, explain }: { items: readonly SavingsItemView[]; labels: { readonly show: string; readonly hide: string }; explain?: (item: SavingsItemView) => ReactNode }) {
  return (
    <div role="list" className="flex flex-col">
      {items.map((item) => (
        <SavingsRow key={item.key} item={item} labels={labels} explain={explain?.(item) ?? null} />
      ))}
    </div>
  )
}

function SavingsRow({ item, labels, explain }: { item: SavingsItemView; labels: { readonly show: string; readonly hide: string }; explain: ReactNode }) {
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
          <p className="money shrink-0 text-base font-semibold text-ink md:text-right md:text-sm">{item.amount}</p>
        </div>
        <p className="text-base break-words text-ink-muted md:text-sm">{item.why}</p>
        {item.note ? <p className="text-base break-words text-ink-muted md:text-sm">{item.note}</p> : null}
        {item.stage ? (
          <Badge variant="outline" className="self-start">
            {item.stage}
          </Badge>
        ) : null}
        <div className="mt-1 flex flex-wrap items-center gap-2">
          {item.action ? (
            <Button asChild variant="outline" className="min-h-11 lg:min-h-9">
              <Link href={item.action.href}>{item.action.label}</Link>
            </Button>
          ) : null}
          <SavingsEvidence id={evidenceId} show={labels.show} hide={labels.hide}>
            <h3 className="text-base font-medium md:text-sm">{item.evidence.title}</h3>
            {item.evidence.rows.length ? (
              <ReportTable caption={item.evidence.title} columns={item.evidence.columns} rows={item.evidence.rows} rowHeader={0} lead={1} />
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
        {explain}
      </ItemContent>
    </Item>
  )
}
