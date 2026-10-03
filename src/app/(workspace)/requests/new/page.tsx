import { getLocale, getTranslations } from 'next-intl/server'
import { systemClock } from '@/lib/clock'
import { ctxFromSession } from '@/server/auth/session'
import { listMyOpenDrafts, listRequestCatalog } from '@/server/queries/request-form'
import { RequestCatalog } from '@/ui/request-form/catalog'
import { getSession } from '../../../_lib/session'

export async function generateMetadata() {
  const t = await getTranslations('request.catalog')
  return { title: t('title') }
}

/** How many of the requester's own drafts the catalog offers to go on with */
const OPEN_DRAFTS_SHOWN = 5

// "ขอซื้อ / ขอจ้าง" (§9.1 /requests/new, FR-INT-001): the one door every request starts from — choose a request type,
// then the form asks only what that type needs. The requester's drafts are here too, from whichever device they began on.
export default async function NewRequestPage() {
  const ctx = ctxFromSession(await getSession(), 'WEB', systemClock.now())
  if (!ctx) return null
  const [t, locale] = await Promise.all([getTranslations('request.catalog'), getLocale()])
  const screen = locale === 'en' ? 'en' : 'th'
  const [types, drafts] = await Promise.all([listRequestCatalog(ctx, screen), listMyOpenDrafts(ctx, screen, OPEN_DRAFTS_SHOWN)])
  return (
    <div className="flex flex-col gap-6">
      <div className="flex max-w-3xl flex-col gap-2">
        <h1 className="text-2xl font-semibold">{t('title')}</h1>
        <p className="text-ink-muted">{t('intro')}</p>
      </div>
      <RequestCatalog types={types} drafts={drafts} locale={screen} />
    </div>
  )
}
