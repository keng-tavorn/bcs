import { StatusBadge, PRICE_BADGES } from '../document/badges'
import { Notice } from '../form/notice'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../shadcn/table'
import { PriceLineList, PriceLineNotes, PriceQuotes } from './list'
import type { PriceAlert, PriceReferenceView } from './view'

// The price reference panel of the web decision page (S6-11 · FR-DOA-101 AC1 AC2, §9.9 principle 5): what the figures
// are, then one row per line of the request — the requested unit price, the median of the past prices, their range and
// the latest, the difference from the median with a badge when it is far (an icon and words, never colour alone) — and
// the request's quotations. A table (shadcn/ui Table) where the panel itself is wide enough for its columns (a container
// query: the decision page's column on a wide screen); on a phone or a narrow column — a laptop, beside the menu and the
// aside — the lines stack (./list.tsx), so nothing scrolls sideways (§9.9). Strings and numbers arrive translated and
// formatted (src/app/(workspace)/_tracking/price-reference.ts).

const badge = (alert: { kind: PriceAlert; label: string }) => <StatusBadge look={PRICE_BADGES[alert.kind]} label={alert.label} />

export function PriceReferencePanel({ view }: { view: PriceReferenceView }) {
  const { labels } = view
  // Headers wrap under their figures, so the columns are as wide as the figures and the badge
  const head = 'h-auto py-2 align-bottom text-right text-ink-muted font-normal whitespace-normal'
  const figure = 'money align-top text-ink'
  return (
    <div className="@container flex flex-col gap-4">
      <p className="text-ink-muted">{view.intro}</p>
      {view.vatNote ? <Notice tone="info">{view.vatNote}</Notice> : null}
      {/* 45rem: the item keeps about 10rem beside the five columns of figures (the range takes two lines) */}
      <div className="hidden @min-[45rem]:block">
        <Table aria-label={labels.list}>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead className="h-auto py-2 align-bottom text-ink-muted font-normal">{labels.item}</TableHead>
              <TableHead className={head}>{`${labels.unitPrice} (${labels.unit})`}</TableHead>
              <TableHead className={head}>{labels.median}</TableHead>
              <TableHead className={head}>{labels.range}</TableHead>
              <TableHead className={head}>{labels.last}</TableHead>
              <TableHead className={head}>{labels.deviation}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {view.lines.map((line) => (
              <TableRow key={line.key} className="hover:bg-transparent">
                <TableCell className="min-w-40 align-top whitespace-normal">
                  <p className="font-medium break-words text-ink">{line.title}</p>
                  <PriceLineNotes line={line} />
                </TableCell>
                <TableCell className={`${figure} font-semibold`}>{line.unitPrice}</TableCell>
                <TableCell className={figure}>{line.median}</TableCell>
                <TableCell className={figure}>
                  {line.min === line.max ? (
                    line.min
                  ) : (
                    <>
                      <span className="block">{`${line.min} –`}</span> <span className="block">{line.max}</span>
                    </>
                  )}
                </TableCell>
                <TableCell className={figure}>{line.last}</TableCell>
                <TableCell className={`${figure} whitespace-normal`}>
                  <span className="flex flex-col items-end gap-1">
                    <span>{line.deviation}</span>
                    {line.alert ? badge(line.alert) : null}
                  </span>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      <div className="@min-[45rem]:hidden">
        <PriceLineList lines={view.lines} labels={labels} badge={badge} />
      </div>
      {view.quotes ? <PriceQuotes quotes={view.quotes} unit={labels.unit} /> : null}
    </div>
  )
}
