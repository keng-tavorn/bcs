'use client'

import { useTranslations } from 'next-intl'
import { useId, useState } from 'react'
import { StatusBadge } from '../../document/badges'
import { Button } from '../../form/button'
import { Notice } from '../../form/notice'
import { ListEmpty } from '../../page/page'
import { Badge } from '../../shadcn/badge'
import { Input } from '../../shadcn/input'
import { Label } from '../../shadcn/label'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../../shadcn/table'
import type { ApOutcome } from './outcome'
import { MATCH_BADGES } from './types'
import { useApAction, useApErrorText } from './use-ap-action'

/** One line as the page shows it: amounts formatted on the server, the editable values as typed text */
export interface LineView {
  readonly id: string
  readonly lineNo: number
  readonly poLineId: string
  readonly poLineNo: number
  readonly description: string
  readonly quantity: string
  readonly uom: string
  readonly unitPrice: string
  readonly poUnitPrice: string
  readonly amount: string
  /** null until the match ran */
  readonly expected: string | null
  readonly over: string | null
  readonly matchStatus: string
  readonly priceUnder: boolean
}

/**
 * The lines of a tier-2 invoice with the match result (FR-AP-102, BR-MATCH-06): the PO line, what was invoiced, the
 * amount at the PO price and what is over it, and the result as a badge (an icon and a word) with the PRICE_UNDER flag.
 * A table from a tablet up and a list on a phone (§9.9: no table that scrolls the page sideways). While the invoice is a
 * draft FINANCE changes the quantity and unit price of each line and saves them together (invoice.update with the
 * version read).
 */
export function InvoiceLines({
  invoiceId,
  version,
  lines,
  editable,
  update,
}: {
  invoiceId: string
  version: number
  lines: readonly LineView[]
  editable: boolean
  update?: (input: unknown, idempotencyKey: string) => Promise<ApOutcome>
}) {
  const t = useTranslations('apInvoice')
  const errorText = useApErrorText()
  const action = useApAction()
  const id = useId()
  const [typed, setTyped] = useState(() => Object.fromEntries(lines.map((l) => [l.poLineId, { quantity: l.quantity, unitPrice: l.unitPrice }])))
  const [saved, setSaved] = useState(false)

  if (lines.length === 0) return <ListEmpty title={t('lines.empty')} hint={t('lines.emptyHint')} />

  const set = (poLineId: string, field: 'quantity' | 'unitPrice', value: string) => {
    setTyped((all) => ({ ...all, [poLineId]: { ...all[poLineId]!, [field]: value } }))
    setSaved(false)
  }

  async function onSave() {
    if (!update) return
    const outcome = await action.run((key) => update({ invoiceId, version, lines: lines.map((l) => ({ poLineId: l.poLineId, ...typed[l.poLineId]! })) }, key))
    setSaved(outcome.ok)
  }

  const match = (l: LineView) => (
    <span className="flex flex-wrap gap-1">
      <StatusBadge look={MATCH_BADGES[l.matchStatus]} label={t(`lines.match.${l.matchStatus as 'PENDING'}`)} />
      {l.priceUnder ? <Badge variant="info">{t('lines.priceUnder')}</Badge> : null}
    </span>
  )
  const quantityInput = (l: LineView, suffix: string) => (
    <>
      <Label htmlFor={`${id}-q-${l.lineNo}-${suffix}`} className="sr-only">
        {t('lines.quantityOf', { no: l.lineNo })}
      </Label>
      <Input id={`${id}-q-${l.lineNo}-${suffix}`} inputMode="decimal" value={typed[l.poLineId]?.quantity ?? ''} onChange={(e) => set(l.poLineId, 'quantity', e.target.value)} className="money h-11 w-28 text-base" />
    </>
  )
  const priceInput = (l: LineView, suffix: string) => (
    <>
      <Label htmlFor={`${id}-p-${l.lineNo}-${suffix}`} className="sr-only">
        {t('lines.unitPriceOf', { no: l.lineNo })}
      </Label>
      <Input id={`${id}-p-${l.lineNo}-${suffix}`} inputMode="decimal" value={typed[l.poLineId]?.unitPrice ?? ''} onChange={(e) => set(l.poLineId, 'unitPrice', e.target.value)} className="money h-11 w-32 text-base" />
    </>
  )

  return (
    <div className="flex flex-col gap-3">
      <p className="text-ink-muted">{t('lines.hint')}</p>
      <div className="hidden md:block">
        <Table aria-label={t('lines.title')}>
          <TableHeader>
            <TableRow>
              <TableHead>{t('lines.columns.poLine')}</TableHead>
              <TableHead>{t('lines.columns.description')}</TableHead>
              <TableHead className="text-right">{t('lines.columns.quantity')}</TableHead>
              <TableHead className="text-right">{t('lines.columns.unitPrice')}</TableHead>
              <TableHead className="text-right">{t('lines.columns.amount')}</TableHead>
              <TableHead className="text-right">{t('lines.columns.expected')}</TableHead>
              <TableHead className="text-right">{t('lines.columns.over')}</TableHead>
              <TableHead>{t('lines.columns.match')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {lines.map((l) => (
              <TableRow key={l.id}>
                <TableCell>{t('lines.poLine', { no: l.poLineNo })}</TableCell>
                <TableCell className="whitespace-normal">{l.description}</TableCell>
                <TableCell className="money text-right">{editable ? quantityInput(l, 't') : `${l.quantity} ${l.uom}`}</TableCell>
                <TableCell className="money text-right">
                  {editable ? priceInput(l, 't') : l.unitPrice}
                  <span className="block text-ink-muted">{t('lines.poPrice', { price: l.poUnitPrice })}</span>
                </TableCell>
                <TableCell className="money text-right">{l.amount}</TableCell>
                <TableCell className="money text-right">{l.expected ?? t('lines.notMatched')}</TableCell>
                <TableCell className="money text-right">{l.over ?? t('lines.notMatched')}</TableCell>
                <TableCell>{match(l)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      <ul aria-label={t('lines.title')} className="flex flex-col divide-y divide-line border-y border-line md:hidden">
        {lines.map((l) => (
          <li key={l.id} className="flex flex-col gap-2 py-3">
            <span className="font-medium break-words text-ink">
              {t('lines.poLine', { no: l.poLineNo })} · {l.description}
            </span>
            {match(l)}
            {editable ? (
              <div className="flex flex-wrap gap-3">
                <div className="flex flex-col gap-1">
                  <span className="text-ink-muted">{t('lines.columns.quantity')}</span>
                  {quantityInput(l, 'm')}
                </div>
                <div className="flex flex-col gap-1">
                  <span className="text-ink-muted">{t('lines.columns.unitPrice')}</span>
                  {priceInput(l, 'm')}
                </div>
              </div>
            ) : null}
            <dl className="flex flex-col">
              {editable ? null : (
                <>
                  <Row label={t('lines.columns.quantity')} value={`${l.quantity} ${l.uom}`} />
                  <Row label={t('lines.columns.unitPrice')} value={l.unitPrice} />
                </>
              )}
              <Row label={t('lines.poPriceLabel')} value={l.poUnitPrice} />
              <Row label={t('lines.columns.amount')} value={l.amount} />
              <Row label={t('lines.columns.expected')} value={l.expected ?? t('lines.notMatched')} />
              <Row label={t('lines.columns.over')} value={l.over ?? t('lines.notMatched')} />
            </dl>
          </li>
        ))}
      </ul>
      {editable && update ? (
        <>
          <Button className="self-start" disabled={action.pending} aria-busy={action.pending || undefined} onClick={() => void onSave()}>
            {action.pending ? t('lines.saving') : t('lines.save')}
          </Button>
          {action.outcome && !action.outcome.ok ? <Notice tone="danger">{errorText(action.outcome)}</Notice> : null}
          {saved ? <Notice tone="success">{t('lines.saved')}</Notice> : null}
        </>
      ) : null}
    </div>
  )
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt className="text-ink-muted">{label}</dt>
      <dd className="money text-ink">{value}</dd>
    </div>
  )
}
