import type { getTranslations } from 'next-intl/server'
import { formatThaiDate } from '@/core/thai'
import type { PortalInvoiceRow } from '@/server/portal/queries-invoices'

// S7-12 (FR-AP-103 AC5): the stage of an invoice in the supplier's words — a difference found is "being checked", never
// what differed or by how much

type PortalT = Awaited<ReturnType<typeof getTranslations<'portal'>>>

export function invoiceStageText(t: PortalT, row: Pick<PortalInvoiceRow, 'stage' | 'dueDate' | 'paidOn' | 'rejectReason'>): string {
  switch (row.stage) {
    case 'DRAFT':
      return t('invoices.stage.DRAFT')
    case 'IN_REVIEW':
      return t('invoices.stage.IN_REVIEW')
    case 'READY':
      return row.dueDate ? t('invoices.stage.READY', { date: formatThaiDate(row.dueDate) }) : t('invoices.stage.READY_NO_DATE')
    case 'PAID':
      return row.paidOn ? t('invoices.stage.PAID', { date: formatThaiDate(row.paidOn) }) : t('invoices.stage.PAID_NO_DATE')
    case 'REJECTED':
      return t('invoices.stage.REJECTED', { reason: row.rejectReason ?? '-' })
    default:
      return row.rejectReason ? t('invoices.stage.CANCELLED_REASON', { reason: row.rejectReason }) : t('invoices.stage.CANCELLED')
  }
}
