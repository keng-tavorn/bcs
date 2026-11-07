import { redirect } from 'next/navigation'
import { getTranslations } from 'next-intl/server'
import { formatSatang } from '@/core/money/format'
import { formatThaiDate } from '@/core/thai'
import { getPortalHome, listPortalPos } from '@/server/portal/queries'
import { PortalFrame } from '@/ui/portal/frame'
import { pageOrg, pageSession, portalNav, Unavailable } from '../_lib/page'

// /portal/[org]/pos (S7-11 · FR-SUP-105 AC1): the POs sent to the contact's supplier — number, date sent, total, state and
// whether it was acknowledged — each a link to its page. Never a draft, one waiting for approval, or another supplier's.

const ACK = ['NOT_ACKNOWLEDGED', 'ACKNOWLEDGED', 'DELIVERY_UPDATED'] as const
const STATUS = ['SENT', 'PARTIALLY_RECEIVED', 'RECEIVED', 'CLOSED'] as const

export default async function PortalPosPage({ params }: { params: Promise<{ org: string }> }) {
  const org = await pageOrg((await params).org)
  if (!org) return <Unavailable />
  const session = await pageSession(org)
  if (!session) redirect(`/portal/${org.code}/login`)
  const { ctx } = session.state
  const [t, home, pos] = await Promise.all([getTranslations('portal'), getPortalHome(ctx), listPortalPos(ctx)])
  if (home.privacyNoticeDue) redirect(`/portal/${org.code}`)
  if (!home.supplier) redirect(`/portal/${org.code}/apply`)
  return (
    <PortalFrame organization={org.nameTh} title={t('pos.title')} nav={portalNav(org.code, t, 'pos', 'SUPPLIER')} navLabel={t('nav.label')}>
      <p className="text-ink-muted">{t('pos.intro')}</p>
      {pos.length ? (
        <ul className="flex flex-col divide-y divide-line border-y border-line">
          {pos.map((p) => (
            <li key={p.id} className="flex flex-col gap-1 py-3">
              <a href={`/portal/${org.code}/pos/${p.id}`} className="inline-flex min-h-11 items-center font-medium text-primary underline-offset-4 hover:underline">
                {p.number ?? t('pos.noNumber')}
              </a>
              <span className="text-ink-muted">{t('pos.row', { date: p.sentAt ? formatThaiDate(p.sentAt) : '-', amount: formatSatang(BigInt(p.grossSatang)) })}</span>
              <span>
                {(STATUS as readonly string[]).includes(p.status) ? t(`pos.status.${p.status as (typeof STATUS)[number]}`) : p.status} · {(ACK as readonly string[]).includes(p.ackStatus) ? t(`pos.ack.${p.ackStatus as (typeof ACK)[number]}`) : p.ackStatus}
                {p.promisedDeliveryOn ? ` · ${t('pos.promised', { date: formatThaiDate(p.promisedDeliveryOn) })}` : ''}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-ink-muted">{t('pos.empty')}</p>
      )}
    </PortalFrame>
  )
}
