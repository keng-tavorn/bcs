'use client'

import Link from 'next/link'
import { useLocale, useTranslations } from 'next-intl'
import { StateLine } from '../request-view/status'
import { StatusMark } from './status'
import { nameIn, type NameView } from './types'

// The POs waiting for goods (spec §9.1 /receiving): each one with its number (a link to receive it), supplier and
// delivery site, who asked, when it was sent, its status, and how many lines are still to come. Wide screens line the
// parts up under one header row; phones stack them — never a table that scrolls sideways (§9.9). No amounts: it is the
// list of what to receive, and a RECEIVER sees a PO's prices only once po.view covers them (the receiving page decides).

export interface ReceivingRowView {
  readonly id: string
  readonly href: string
  readonly number: string | null
  readonly status: 'SENT' | 'PARTIALLY_RECEIVED'
  readonly supplier: NameView
  readonly site: NameView | null
  readonly requests: ReadonlyArray<{ readonly number: string | null; readonly requester: NameView | null; readonly department: NameView | null }>
  /** Formatted date and time it went to the supplier */
  readonly sentAt: string | null
  readonly lineCount: number
  readonly outstandingLines: number
  /** Separation of duties refuses this member (BR-SOD-02, BR-SOD-07) */
  readonly sodRule?: string
}

const GRID = 'md:grid md:grid-cols-[minmax(0,1.2fr)_minmax(0,1.4fr)_minmax(0,0.9fr)_minmax(0,0.9fr)] md:items-start md:gap-4'

/** `blocked`: POs separation of duties refuses the member; the last column then says why */
export function ReceivingList({ rows, label, blocked = false }: { rows: readonly ReceivingRowView[]; label: string; blocked?: boolean }) {
  const t = useTranslations('receiving')
  const locale = useLocale()
  return (
    <div className="flex flex-col">
      <div className={`hidden border-b border-line pb-2 text-sm text-ink-muted ${GRID}`} aria-hidden="true">
        <span>{t('list.columns.po')}</span>
        <span>{t('list.columns.where')}</span>
        <span>{t('list.columns.status')}</span>
        <span>{blocked ? t('list.columns.why') : t('list.columns.outstanding')}</span>
      </div>
      <ul aria-label={label} className="flex flex-col divide-y divide-line border-b border-line">
        {rows.map((row) => {
          const number = row.number ?? t('list.noNumber')
          return (
            <li key={row.id} className={`flex flex-col gap-1.5 py-3 ${GRID}`}>
              <div className="flex min-w-0 flex-col">
                <Link href={row.href} className="inline-flex min-h-11 items-center self-start font-semibold break-words text-primary underline underline-offset-4 hover:no-underline md:min-h-0">
                  {row.sodRule ? t('list.openBlocked', { number }) : t('list.open', { number })}
                </Link>
                {row.sentAt ? <span className="text-base text-ink-muted md:text-sm">{t('list.sentOn', { time: row.sentAt })}</span> : null}
              </div>
              <div className="flex min-w-0 flex-col">
                <span className="break-words text-ink">{nameIn(locale, row.supplier)}</span>
                <span className="text-base break-words text-ink-muted md:text-sm">{row.site ? t('list.site', { name: nameIn(locale, row.site) }) : t('list.noSite')}</span>
                {row.requests.map((r, i) => (
                  <span key={`${r.number ?? ''}-${i}`} className="text-base break-words text-ink-muted md:text-sm">
                    {r.department
                      ? t('list.requestedBy', { number: r.number ?? '-', name: nameIn(locale, r.requester), department: nameIn(locale, r.department) })
                      : t('list.requestedByNoDept', { number: r.number ?? '-', name: nameIn(locale, r.requester) })}
                  </span>
                ))}
              </div>
              <div>
                <span className="sr-only">{t('list.columns.status')}: </span>
                <StatusMark of="po" status={row.status} label={t(`status.po.${row.status}`)} />
              </div>
              <div className="flex flex-col">
                <span className="sr-only">{blocked ? t('list.columns.why') : t('list.columns.outstanding')}: </span>
                {row.sodRule ? (
                  <StateLine kind="closed">{row.sodRule === 'BR-SOD-07' ? t('list.sodRequester') : t('list.sodApprover')}</StateLine>
                ) : (
                  <span className="tabular text-ink">{t('list.outstanding', { left: row.outstandingLines, total: row.lineCount })}</span>
                )}
              </div>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
