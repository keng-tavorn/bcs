'use client'

import Link from 'next/link'
import { useLocale, useTranslations } from 'next-intl'
import type { ReactNode } from 'react'
import { formatEnglishBeDate, formatThaiDate } from '@/core/thai/date'
import { PO_BADGES, StatusBadge, type BadgeLook } from '../document/badges'
import { formatDateTime } from '../format'
import { ListEmpty } from '../page/page'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../shadcn/table'

// The "การรับทราบ PO" tab of /suppliers/[id] (S7-09 · BR-SUP ข้อ 14 · ADR-188): the POs sent to the supplier, newest
// first, each with its revision, whether the supplier acknowledged it on the portal, when and by whom, and the delivery
// date it promised. Until a supplier acknowledges anything the empty state says what will appear here and when. A table
// from 768 px; under it the same as a list.

export interface PoAckRowView {
  readonly poId: string
  readonly number: string | null
  readonly status: string
  readonly revisionNo: number
  readonly sentAt: string
  readonly ackStatus: 'NOT_ACKNOWLEDGED' | 'ACKNOWLEDGED' | 'DELIVERY_UPDATED'
  readonly acknowledgedAt: string | null
  readonly promisedDeliveryOn: string | null
  readonly acknowledgedBy: { readonly nameTh: string; readonly nameEn: string | null } | null
}

const ACK_LOOK: Readonly<Record<PoAckRowView['ackStatus'], BadgeLook>> = {
  NOT_ACKNOWLEDGED: { tone: 'warn', icon: 'Hourglass' },
  ACKNOWLEDGED: { tone: 'ok', icon: 'CircleCheck' },
  DELIVERY_UPDATED: { tone: 'info', icon: 'Clock' },
}

const linkClass = 'inline-flex min-h-11 items-center font-medium text-primary underline underline-offset-4 hover:no-underline'

export function PoAcksPanel({ rows, total, limit }: { rows: readonly PoAckRowView[]; total: number; limit: number }) {
  const t = useTranslations('supplierContacts.acks')
  const tPo = useTranslations('purchaseOrder')
  const locale = useLocale()
  const day = (iso: string) => (locale === 'en' ? formatEnglishBeDate(iso) : formatThaiDate(iso))
  const when = (iso: string) => formatDateTime(locale, iso)

  if (rows.length === 0) return <ListEmpty title={t('emptyTitle')} hint={t('emptyHint')} />

  const po = (r: PoAckRowView): ReactNode => (
    <div className="flex flex-col gap-1">
      <Link href={`/procurement/pos/${r.poId}`} className={linkClass}>
        {r.number ?? t('draftNumber')}
      </Link>
      {r.revisionNo > 0 ? <span className="text-base text-ink-muted md:text-sm">{t('revision', { no: r.revisionNo })}</span> : null}
      <StatusBadge look={PO_BADGES[r.status]} label={tPo(`status.${r.status}` as 'status.SENT')} className="self-start" />
    </div>
  )
  const ack = (r: PoAckRowView): ReactNode => {
    const name = r.acknowledgedBy ? (locale === 'en' && r.acknowledgedBy.nameEn ? r.acknowledgedBy.nameEn : r.acknowledgedBy.nameTh) : null
    return (
      <div className="flex flex-col gap-1">
        <StatusBadge look={ACK_LOOK[r.ackStatus]} label={t(`ackStatus.${r.ackStatus}`)} className="self-start" />
        {r.acknowledgedAt ? <span className="text-base text-ink-muted md:text-sm">{when(r.acknowledgedAt)}</span> : null}
        {name ? <span className="text-base text-ink-muted md:text-sm">{t('ackedBy', { name })}</span> : null}
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="text-ink-muted">{t('intro')}</p>
      <div className="hidden md:block">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t('columns.po')}</TableHead>
              <TableHead>{t('columns.sent')}</TableHead>
              <TableHead>{t('columns.ack')}</TableHead>
              <TableHead>{t('columns.promised')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r) => (
              <TableRow key={r.poId}>
                <TableCell className="align-top whitespace-normal">{po(r)}</TableCell>
                <TableCell className="tabular align-top whitespace-normal">{when(r.sentAt)}</TableCell>
                <TableCell className="align-top whitespace-normal">{ack(r)}</TableCell>
                <TableCell className="tabular align-top whitespace-normal">{r.promisedDeliveryOn ? day(r.promisedDeliveryOn) : <span className="text-ink-muted">{t('noPromise')}</span>}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      <ul className="flex flex-col divide-y divide-line md:hidden">
        {rows.map((r) => (
          <li key={r.poId} className="flex flex-col gap-2 py-3 first:pt-0 last:pb-0">
            {po(r)}
            <span className="text-ink">{t('sentLabel', { when: when(r.sentAt) })}</span>
            {ack(r)}
            <span className="text-ink">{t('promisedLabel', { date: r.promisedDeliveryOn ? day(r.promisedDeliveryOn) : t('noPromise') })}</span>
          </li>
        ))}
      </ul>
      {total > rows.length ? <p className="text-base text-ink-muted md:text-sm">{t('more', { limit, total })}</p> : null}
    </div>
  )
}
