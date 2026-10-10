import { useTranslations } from 'next-intl'
import { PO_BADGES } from '../../document/badge-looks'
import { nameIn, type NameView } from '../../receiving/types'
import { LiffStatusBadge } from '../status-badge'

// Which PO the LIFF receiving page is about (/liff/gr/[poId]): its status as the PO badge of §9.10, the supplier, where the
// goods go, when it went to the supplier and the requests it orders for — so the receiver on site checks the delivery
// against the right PO. The PO number is the page's title. Rendered by the server (no JavaScript); the words are the
// workspace's receiving page's own (messages receiving.*, and document.badge for the status).

export const LIFF_PO_STATUSES = ['DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'SENT', 'PARTIALLY_RECEIVED', 'RECEIVED', 'CLOSED', 'CANCELLED', 'REJECTED'] as const
export type LiffPoStatus = (typeof LIFF_PO_STATUSES)[number]
/** PurchaseOrder.status as a message key of receiving.status.po */
export const liffPoStatus = (status: string): LiffPoStatus => ((LIFF_PO_STATUSES as readonly string[]).includes(status) ? (status as LiffPoStatus) : 'DRAFT')

export interface LiffPoSummaryView {
  readonly status: LiffPoStatus
  readonly supplier: NameView
  readonly site: NameView | null
  /** When it went to the supplier, formatted in the reader's language */
  readonly sentAt: string | null
  readonly requests: ReadonlyArray<{ readonly id: string; readonly number: string | null; readonly requester: NameView | null; readonly department: NameView | null }>
}

export function LiffPoSummary({ po, locale }: { readonly po: LiffPoSummaryView; readonly locale: string }) {
  const t = useTranslations('receiving')
  const td = useTranslations('document.badge')
  return (
    <div className="flex flex-col gap-1">
      <LiffStatusBadge look={PO_BADGES[po.status]} label={td(`po.${po.status}`)} />
      <p className="break-words">{t('detail.supplier', { name: nameIn(locale, po.supplier) })}</p>
      <p className="break-words text-ink-muted">{po.site ? t('detail.site', { name: nameIn(locale, po.site) }) : t('list.noSite')}</p>
      {po.sentAt ? <p className="text-ink-muted">{t('list.sentOn', { time: po.sentAt })}</p> : null}
      {po.requests.map((r) => (
        <p key={r.id} className="break-words text-ink-muted">
          {r.department
            ? t('list.requestedBy', { number: r.number ?? '-', name: nameIn(locale, r.requester), department: nameIn(locale, r.department) })
            : t('list.requestedByNoDept', { number: r.number ?? '-', name: nameIn(locale, r.requester) })}
        </p>
      ))}
    </div>
  )
}
