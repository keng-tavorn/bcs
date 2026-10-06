import { getLocale, getTranslations } from 'next-intl/server'
import { listMyOpenDrafts, listRequestCatalog } from '@/server/queries/request-form'
import { formatDateTime } from '@/ui/format'
import { LiffContent, LiffFrame, LiffSection } from '@/ui/liff/frame'
import { LiffGate } from '@/ui/liff/liff-gate'
import { LiffLink } from '@/ui/liff/liff-link'
import { LiffCatalog } from '@/ui/liff/requests/catalog'
import { liffHref } from '../../../_lib/links'
import { liffPage } from '../../../_lib/session'
import { LIFF_FORM_PATHS, liffDraftHref } from '../../_lib/form'
import { screenOf } from '../../_lib/principal'

export async function generateMetadata() {
  const t = await getTranslations('request.catalog')
  return { title: t('title') }
}

/** How many of the requester's own drafts the catalogue offers to go on with (as on the web) */
const OPEN_DRAFTS_SHOWN = 5

// /liff/requests/new (§9.4 "แคตตาล็อกและฟอร์มแบบย่อ", the rich menu's "ขอซื้อ": FR-INT-001 AC3, FR-LINE-004 AC2): the one
// door every request starts from in LINE — the request types the organization switched on, each saying when to use it,
// with a search (FR-INT-001 AC1 AC2); a type opens its short form (../[type]/page.tsx). The requester's drafts and
// returned requests are here too, from whichever device they began on (FR-INT-006 AC2). The same queries as the
// workspace's catalogue. A member only: without a session the gate signs in with LINE first.
export default async function LiffNewRequestPage() {
  const [t, tl, locale, page] = await Promise.all([getTranslations('request.catalog'), getTranslations('liffRequests.catalog'), getLocale(), liffPage()])
  if (page.kind !== 'member') {
    return (
      <LiffFrame title={t('title')}>
        <LiffContent>
          <LiffGate mode="member" state={page.kind} />
        </LiffContent>
      </LiffFrame>
    )
  }
  const screen = screenOf(locale)
  const [types, drafts] = await Promise.all([listRequestCatalog(page.ctx, screen), listMyOpenDrafts(page.ctx, screen, OPEN_DRAFTS_SHOWN)])
  const track = liffHref('/requests')
  return (
    <LiffFrame title={t('title')}>
      <LiffContent>
        <p>{t('intro')}</p>
        <LiffCatalog types={types} formBase={LIFF_FORM_PATHS.catalog} />
        <LiffSection id="liff-drafts" title={t('draftsTitle')}>
          {drafts.length === 0 ? (
            <p className="text-ink-muted">{t('draftsEmpty')}</p>
          ) : (
            <ul className="flex flex-col divide-y divide-line border-y border-line">
              {drafts.map((d) => (
                <li key={d.id} className="flex flex-col gap-0.5 py-2">
                  <LiffLink href={liffDraftHref(d.id)}>{t('continue', { title: d.title })}</LiffLink>
                  <span className="text-ink-muted">
                    {t('draftLine', { type: d.typeName, status: d.status === 'RETURNED' ? t('statusReturned') : t('statusDraft'), time: formatDateTime(locale, d.updatedAt) })}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </LiffSection>
        {track ? <LiffLink href={track}>{tl('track')}</LiffLink> : null}
      </LiffContent>
    </LiffFrame>
  )
}
