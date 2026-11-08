import { redirect } from 'next/navigation'
import { getTranslations } from 'next-intl/server'
import { formatSatang } from '@/core/money/format'
import { formatThaiDate } from '@/core/thai'
import { getPortalHome } from '@/server/portal/queries'
import { listPortalInvoices } from '@/server/portal/queries-invoices'
import { PortalFrame, PortalNotice, portalPrimaryLinkClass } from '@/ui/portal/frame'
import { pageOrg, pageSession, portalNav, Unavailable } from '../_lib/page'
import { invoiceStageText } from './stage'

// /portal/[org]/invoices (S7-12 · FR-AP-103 AC5 · BR-SUP ข้อ 15): the supplier's invoices — sent on the portal, or numbered
// by finance from any channel — each with where it stands in the supplier's words: a draft finance is checking, received
// with BCS's number, being checked (never what differed or by how much), ready with its due date, paid, or rejected with
// the reason. Hidden (and not available) when the organization does not take invoices on the portal.

export default async function PortalInvoicesPage({ params }: { params: Promise<{ org: string }> }) {
  const org = await pageOrg((await params).org)
  if (!org) return <Unavailable />
  const session = await pageSession(org)
  if (!session) redirect(`/portal/${org.code}/login`)
  const { ctx } = session.state
  const [t, home] = await Promise.all([getTranslations('portal'), getPortalHome(ctx)])
  if (home.privacyNoticeDue) redirect(`/portal/${org.code}`)
  if (!home.supplier) redirect(`/portal/${org.code}/apply`)
  const nav = portalNav(org.code, t, 'invoices', 'SUPPLIER', session.invoices)
  if (!session.invoices) {
    return (
      <PortalFrame organization={org.nameTh} title={t('invoices.title')} nav={nav} navLabel={t('nav.label')}>
        <PortalNotice tone="info">{t('invoices.off')}</PortalNotice>
      </PortalFrame>
    )
  }
  const invoices = await listPortalInvoices(ctx)
  return (
    <PortalFrame organization={org.nameTh} title={t('invoices.title')} nav={nav} navLabel={t('nav.label')}>
      <p className="text-ink-muted">{t('invoices.intro')}</p>
      <a href={`/portal/${org.code}/invoices/new`} className={portalPrimaryLinkClass}>
        {t('invoices.new')}
      </a>
      {invoices.length ? (
        <ul className="flex flex-col divide-y divide-line border-y border-line">
          {invoices.map((i) => (
            <li key={i.id} className="flex flex-col gap-1 py-3">
              <a href={`/portal/${org.code}/invoices/${i.id}`} className="inline-flex min-h-11 items-center font-medium text-primary underline-offset-4 hover:underline">
                {i.supplierInvoiceNo ?? i.number ?? t('invoices.noNumber')}
              </a>
              <span className="tabular text-ink-muted">{t('invoices.row', { po: i.poNumber ?? '-', date: i.invoiceDate ? formatThaiDate(i.invoiceDate) : '-', amount: formatSatang(BigInt(i.grossSatang)) })}</span>
              <span>
                {invoiceStageText(t, i)}
                {i.number ? ` · ${t('invoices.received', { number: i.number })}` : ''}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-ink-muted">{t('invoices.empty')}</p>
      )}
    </PortalFrame>
  )
}
