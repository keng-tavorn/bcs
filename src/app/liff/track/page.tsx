import { getLocale, getTranslations } from 'next-intl/server'
import { listMyRequests } from '@/server/queries/requests'
import { LiffContent, LiffFrame } from '@/ui/liff/frame'
import { LiffGate } from '@/ui/liff/liff-gate'
import { LiffLink } from '@/ui/liff/liff-link'
import { LiffTrackList } from '@/ui/liff/requests/track-list'
import { localeOf } from '../../(workspace)/_tracking/present'
import { requestRows } from '../../(workspace)/_tracking/rows'
import { liffHref } from '../_lib/links'
import { liffPage } from '../_lib/session'

export async function generateMetadata() {
  const t = await getTranslations('requestView')
  return { title: t('listTitle') }
}

/** A link that looks like the primary button: the next step of someone with no request yet (§9.9 rule 8) */
const PRIMARY_LINK =
  'inline-flex h-11 w-full items-center justify-center rounded-md bg-primary px-4 font-medium text-primary-foreground underline-offset-4 transition-colors duration-150 hover:underline'

// /liff/track (§9.4 "คำขอของฉันและไทม์ไลน์", the rich menu's "ติดตามสถานะ", FR-LINE-004 AC2): the member's own and
// followed requests, newest first, each with its status, where it is now — who it waits for and for how long — and its
// total, as on the workspace's "my requests" (the same query and rows, FR-INT-008 AC2); each opens /liff/requests/[id]
// with its timeline. The query reads only the member's own and followed requests. A member only: without a session the
// gate signs in with LINE first and shows nothing of the page.
export default async function LiffTrackPage() {
  const [tv, tl, td, locale, page] = await Promise.all([
    getTranslations('requestView'),
    getTranslations('liffRequests.track'),
    getTranslations('document.badge'),
    getLocale(),
    liffPage(),
  ])
  if (page.kind !== 'member') {
    return (
      <LiffFrame title={tv('listTitle')}>
        <LiffContent>
          <LiffGate mode="member" state={page.kind} />
        </LiffContent>
      </LiffFrame>
    )
  }
  const screen = localeOf(locale)
  const list = await listMyRequests(page.ctx, {})
  // The rows of the workspace's list with the words of its badges (§9.10), each leading to the request's LIFF page
  // instead of the workspace's
  const rows = requestRows(tv, screen, list.rows).map((row) => ({ ...row, statusLabel: td(`request.${row.status}` as 'request.DRAFT'), href: liffHref(row.href) ?? row.href }))
  const newRequest = liffHref('/requests/new')
  return (
    <LiffFrame title={tv('listTitle')}>
      <LiffContent>
        <p className="text-ink-muted">{tv('listIntro')}</p>
        {rows.length ? (
          <>
            <LiffTrackList
              rows={rows}
              labels={{ list: tv('listTitle'), status: tv('columns.status'), now: tv('columns.now'), amount: tv('columns.amount'), unit: tv('amounts.currency') }}
            />
            {/* The list stops at the newest ones; the workspace's list searches the rest */}
            {list.rows.length < list.total ? <p className="text-ink-muted">{tl('limited', { shown: list.rows.length, total: list.total })}</p> : null}
            {newRequest ? <LiffLink href={newRequest}>{tl('newRequest')}</LiffLink> : null}
          </>
        ) : (
          <div className="flex flex-col gap-3 border-y border-line py-5">
            <p className="font-medium text-ink">{tv('emptyNone')}</p>
            <p className="text-ink-muted">{tl('emptyHint')}</p>
            {newRequest ? (
              <LiffLink href={newRequest} className={PRIMARY_LINK}>
                {tl('newRequest')}
              </LiffLink>
            ) : null}
          </div>
        )}
      </LiffContent>
    </LiffFrame>
  )
}
