'use client'

import { useState } from 'react'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../shadcn/table'
import { ToggleGroup, ToggleGroupItem } from '../shadcn/toggle-group'

// The history tab of a document (FR-INT-012 AC5, FR-PLT-003 AC3): what happened to it, from its Events, as a table of
// date (Buddhist era), who (and for whom, when a delegate acted), the event in words and the channel, filtered by kind.
// The rows arrive translated and already limited to what the reader may see (BR-AUTH-04: the views behind them never
// carry masked data). Phones get a list instead of the table, so nothing scrolls sideways (§9.9).

export const HISTORY_KINDS = ['DECISION', 'DOCUMENT', 'QUESTION', 'GOODS'] as const
export type HistoryKind = (typeof HISTORY_KINDS)[number]

export interface HistoryRowView {
  readonly key: string
  readonly kind: HistoryKind
  readonly when: string
  readonly actor: string
  readonly onBehalfOf?: string
  readonly event: string
  readonly note?: string
  readonly channel: string
}

export interface HistoryLabels {
  readonly table: string
  readonly filter: string
  readonly all: string
  readonly kinds: Readonly<Record<HistoryKind, string>>
  readonly columns: { readonly when: string; readonly actor: string; readonly event: string; readonly channel: string }
  readonly empty: string
}

export function HistoryTable({ rows, labels }: { rows: readonly HistoryRowView[]; labels: HistoryLabels }) {
  const [kind, setKind] = useState<'ALL' | HistoryKind>('ALL')
  const present = HISTORY_KINDS.filter((k) => rows.some((r) => r.kind === k))
  const shown = kind === 'ALL' ? rows : rows.filter((r) => r.kind === kind)
  return (
    <div className="flex flex-col gap-4">
      {present.length > 1 ? (
        <ToggleGroup
          type="single"
          value={kind}
          onValueChange={(value) => setKind(value ? (value as typeof kind) : 'ALL')}
          aria-label={labels.filter}
          variant="outline"
          className="flex-wrap"
        >
          <ToggleGroupItem value="ALL" className="min-h-11 px-3">
            {labels.all}
          </ToggleGroupItem>
          {present.map((k) => (
            <ToggleGroupItem key={k} value={k} className="min-h-11 px-3">
              {labels.kinds[k]}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      ) : null}
      {shown.length === 0 ? (
        <p className="text-ink-muted">{labels.empty}</p>
      ) : (
        <>
          <Table aria-label={labels.table} className="hidden text-base md:table md:text-sm">
            <TableHeader>
              <TableRow>
                <TableHead>{labels.columns.when}</TableHead>
                <TableHead>{labels.columns.actor}</TableHead>
                <TableHead>{labels.columns.event}</TableHead>
                <TableHead>{labels.columns.channel}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {shown.map((r) => (
                <TableRow key={r.key}>
                  <TableCell className="tabular align-top">{r.when}</TableCell>
                  <TableCell className="align-top whitespace-normal">
                    {r.actor}
                    {r.onBehalfOf ? <span className="block text-ink-muted">{r.onBehalfOf}</span> : null}
                  </TableCell>
                  <TableCell className="align-top whitespace-normal">
                    {r.event}
                    {r.note ? <span className="block break-words whitespace-pre-line text-ink-muted">{r.note}</span> : null}
                  </TableCell>
                  <TableCell className="align-top">{r.channel}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <ul aria-label={labels.table} className="flex flex-col divide-y divide-line border-y border-line md:hidden">
            {shown.map((r) => (
              <li key={r.key} className="flex flex-col gap-0.5 py-2.5">
                <span className="font-medium text-ink">{r.event}</span>
                {r.note ? <span className="break-words whitespace-pre-line text-ink">{r.note}</span> : null}
                <span className="text-ink">
                  {r.actor}
                  {r.onBehalfOf ? ` · ${r.onBehalfOf}` : ''}
                </span>
                <span className="tabular text-ink-muted">{[r.when, r.channel].filter(Boolean).join(' · ')}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  )
}
