import { getTranslations } from 'next-intl/server'
import { PortalButton, PortalFrame, portalInputClass } from '@/ui/portal/frame'
import { ErrorNotice, one, pageOrg, Unavailable, type SearchParams } from '../_lib/page'

// /portal/[org]/otp (BR-PORTAL ข้อ 02): the six-digit code, typed on the device that used the link

export default async function PortalOtpPage({ params, searchParams }: { params: Promise<{ org: string }>; searchParams: SearchParams }) {
  const org = await pageOrg((await params).org)
  if (!org) return <Unavailable />
  const [t, q] = await Promise.all([getTranslations('portal'), searchParams])
  return (
    <PortalFrame organization={org.nameTh} title={t('otp.title')}>
      <p className="text-ink-muted">{t('otp.intro')}</p>
      <ErrorNotice code={one(q.error)} remaining={one(q.remaining)} until={one(q.until)} />
      <form method="post" action={`/portal/${org.code}/api/otp`} className="flex flex-col gap-3">
        <label htmlFor="code" className="font-medium">
          {t('otp.code')}
        </label>
        <input id="code" name="code" required inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} className={portalInputClass} />
        <PortalButton type="submit">{t('otp.submit')}</PortalButton>
      </form>
    </PortalFrame>
  )
}
