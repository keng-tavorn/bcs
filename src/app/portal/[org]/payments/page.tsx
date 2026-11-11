import { randomUUID } from 'node:crypto'
import { redirect } from 'next/navigation'
import { getTranslations } from 'next-intl/server'
import { formatSatang } from '@/core/money/format'
import { formatThaiDate } from '@/core/thai'
import { getPortalHome } from '@/server/portal/queries'
import { listPortalPayments } from '@/server/portal/queries-invoices'
import { PortalButton, PortalFrame, PortalNotice } from '@/ui/portal/frame'
import { one, pageOrg, pageSession, portalNav, Unavailable, type SearchParams } from '../_lib/page'

// /portal/[org]/payments (S7-12 · FR-PAY-103 AC8): what was paid to the supplier, or failed, read from S9's payment runs —
// the run's number, the day it was paid, the amount of the invoices, the tax withheld, the amount transferred, the
// invoices it covers and the last four digits of the account (never the number or the bank's reference); a failed one
// shows the reason finance gave. The 50 ทวิ downloads by a POST (an address of five minutes, logged).

export default async function PortalPaymentsPage({ params, searchParams }: { params: Promise<{ org: string }>; searchParams: SearchParams }) {
  const org = await pageOrg((await params).org)
  if (!org) return <Unavailable />
  const session = await pageSession(org)
  if (!session) redirect(`/portal/${org.code}/login`)
  const { ctx } = session.state
  const [t, home, q] = await Promise.all([getTranslations('portal'), getPortalHome(ctx), searchParams])
  if (home.privacyNoticeDue) redirect(`/portal/${org.code}`)
  if (!home.supplier) redirect(`/portal/${org.code}/apply`)
  const nav = portalNav(org.code, t, 'payments', 'SUPPLIER', session.invoices)
  if (!session.invoices) {
    return (
      <PortalFrame organization={org.nameTh} title={t('payments.title')} nav={nav} navLabel={t('nav.label')}>
        <PortalNotice tone="info">{t('invoices.off')}</PortalNotice>
      </PortalFrame>
    )
  }
  const payments = await listPortalPayments(ctx)
  const baht = (s: string) => formatSatang(BigInt(s))
  return (
    <PortalFrame organization={org.nameTh} title={t('payments.title')} nav={nav} navLabel={t('nav.label')}>
      {one(q.error) ? <PortalNotice tone="danger">{t('payments.error')}</PortalNotice> : null}
      <p className="text-ink-muted">{t('payments.intro')}</p>
      {payments.length ? (
        <ul className="flex flex-col divide-y divide-line border-y border-line">
          {payments.map((p) => (
            <li key={p.id} className="flex flex-col gap-1 py-3">
              <span className="font-medium">
                {p.status === 'PAID' ? t('payments.paid', { date: p.paidOn ? formatThaiDate(p.paidOn) : '-' }) : t('payments.failed')} · {t('payments.run', { number: p.runNumber ?? '-' })}
              </span>
              <span className="tabular">{t('payments.transfer', { amount: baht(p.transferSatang) })}</span>
              <span className="tabular text-ink-muted">{t('payments.amounts', { payable: baht(p.payableSatang), wht: baht(p.whtSatang) })}</span>
              {p.last4 ? <span className="text-ink-muted">{t('payments.account', { bank: p.bankName ?? '-', last4: p.last4 })}</span> : null}
              {p.invoices.length ? <span className="text-ink-muted">{t('payments.invoices', { list: p.invoices.join(', ') })}</span> : null}
              {p.failureReason ? <span>{t('payments.reason', { reason: p.failureReason })}</span> : null}
              {p.certificate ? (
                <form method="post" action={`/portal/${org.code}/api/payments/${p.certificate.id}/wht`}>
                  <input type="hidden" name="csrf" value={session.csrf} />
                  <input type="hidden" name="key" value={randomUUID()} />
                  <PortalButton type="submit" variant="secondary" className="w-full">
                    {t('payments.wht', { number: p.certificate.number })}
                  </PortalButton>
                </form>
              ) : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-ink-muted">{t('payments.empty')}</p>
      )}
    </PortalFrame>
  )
}
