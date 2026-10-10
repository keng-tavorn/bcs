import { getLocale, getTranslations } from 'next-intl/server'
import { systemClock } from '@/lib/clock'
import { ctxFromSession } from '@/server/auth/session'
import { listMyOpenDrafts, listRequestCatalog } from '@/server/queries/request-form'
import { Page, PageBody, PageHeader, Panel } from '@/ui/page/page'
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
// The catalogue is the door's own content, so the shell's door steps aside while it shows (RequestCatalog, DOOR_ASIDE).
// The page's frame (S16-10): the title and what the page is for, then the catalogue and the drafts in one white card.
export default async function NewRequestPage() {
  const ctx = ctxFromSession(await getSession(), 'WEB', systemClock.now())
  if (!ctx) return null
  const [t, locale] = await Promise.all([getTranslations('request.catalog'), getLocale()])
  const screen = locale === 'en' ? 'en' : 'th'
  const [types, drafts] = await Promise.all([listRequestCatalog(ctx, screen), listMyOpenDrafts(ctx, screen, OPEN_DRAFTS_SHOWN)])
  return (
    <Page>
      <PageHeader title={t('title')} intro={t('intro')} />
      <PageBody>
        <Panel>
          <RequestCatalog types={types} drafts={drafts} locale={screen} />
        </Panel>
      </PageBody>
    </Page>
  )
}
