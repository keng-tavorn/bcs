import { getTranslations } from 'next-intl/server'
import { PortalButton, PortalFrame } from '@/ui/portal/frame'
import { pageOrg, Unavailable } from '../../_lib/page'

// /portal/[org]/link/[token] (BR-PORTAL ข้อ 01): the GET of a link only shows this page — a mail scanner that opens the
// link uses nothing; the button POSTs the token, which uses the link and sends the code.

export default async function PortalLinkPage({ params }: { params: Promise<{ org: string; token: string }> }) {
  const { org: code, token } = await params
  const org = await pageOrg(code)
  if (!org) return <Unavailable />
  const t = await getTranslations('portal')
  return (
    <PortalFrame organization={org.nameTh} title={t('link.title')}>
      <p className="text-ink-muted">{t('link.intro')}</p>
      <form method="post" action={`/portal/${org.code}/api/link`}>
        <input type="hidden" name="token" value={token} />
        <PortalButton type="submit" className="w-full">
          {t('link.submit')}
        </PortalButton>
      </form>
    </PortalFrame>
  )
}
