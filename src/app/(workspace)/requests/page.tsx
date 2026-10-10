import Link from 'next/link'
import { getLocale, getTranslations } from 'next-intl/server'
import { systemClock } from '@/lib/clock'
import { ctxFromSession } from '@/server/auth/session'
import { listMyRequests, REQUEST_STATUSES } from '@/server/queries/requests'
import { FilterBar, FilterSearch, FilterSelect, FilterSummary } from '@/ui/page/filters'
import { ListEmpty, Page, PageBody, PageHeader, Panel } from '@/ui/page/page'
import { RequestList } from '@/ui/request-view/request-list'
import { Button } from '@/ui/shadcn/button'
import { getSession } from '../../_lib/session'
import { loadRequestFilters } from '../_tracking/list-filters'
import { localeOf } from '../_tracking/present'
import { requestRows } from '../_tracking/rows'

export async function generateMetadata() {
  const t = await getTranslations('requestView')
  return { title: t('listTitle') }
}

// "My requests" (spec §9.1 /requests, FR-INT-008 AC3): the member's own and followed requests, newest first, each with
// its status badge (§9.10), where it is now and for how long, and its total; filtered by status and searched by
// document number with a plain GET form (it changes nothing). The query reads only the member's own and followed
// requests. The home's rows and cards open it narrowed (§9.10, the filters in the address: ../_tracking/list-filters.ts):
// ?scope=mine to the requests the member made, ?scope=following to theirs and followed without drafts, ?info=open to
// those with a question waiting for the requester's answer; the search keeps them, and "clear" lets them go.
export default async function RequestsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const ctx = ctxFromSession(await getSession(), 'WEB', systemClock.now())
  if (!ctx) return null
  const filters = await loadRequestFilters(searchParams)
  const q = (filters.q ?? '').trim()
  const status = filters.status ?? ''
  const [tv, td, locale] = await Promise.all([getTranslations('requestView'), getTranslations('document.badge'), getLocale().then(localeOf)])
  const list = await listMyRequests(ctx, {
    q,
    status,
    scope: filters.scope === 'mine' ? 'MINE' : filters.scope === 'following' ? 'FOLLOWING' : 'ALL',
    openQuestion: filters.info === 'open',
  })
  const filtered = Boolean(q) || status !== '' || filters.scope !== null || filters.info !== null
  const narrowed = [filters.scope === 'mine' ? tv('filter.scopeMine') : filters.scope === 'following' ? tv('filter.scopeFollowing') : null, filters.info === 'open' ? tv('filter.infoOpen') : null].filter((x) => x !== null)
  // The words of the badges of §9.10, the same as on the request's own page
  const rows = requestRows(tv, locale, list.rows).map((row) => ({ ...row, statusLabel: td(`request.${row.status}` as 'request.DRAFT') }))

  return (
    <Page>
      {/* The door to a new request is the shell's, on every page (§9.9 principle 2) */}
      <PageHeader title={tv('listTitle')} intro={tv('listIntro')} />
      <PageBody>
        {list.total > 0 ? (
          <FilterBar
            action="/requests"
            label={tv('filter.label')}
            submit={tv('filter.submit')}
            hidden={{ scope: filters.scope, info: filters.info }}
            footer={
              <FilterSummary
                count={tv('filter.count', { matched: list.matched, total: list.total })}
                notes={[...narrowed, ...(list.rows.length < list.matched ? [tv('filter.limited', { shown: list.rows.length })] : [])]}
                clear={filtered ? { href: '/requests', label: tv('filter.clear') } : null}
              />
            }
          >
            <FilterSearch id="request-search" label={tv('filter.search')} hint={tv('filter.searchHint')} defaultValue={q} />
            <FilterSelect
              id="request-status"
              name="status"
              label={tv('filter.status')}
              all={tv('filter.allStatuses')}
              defaultValue={status.toLowerCase()}
              options={REQUEST_STATUSES.map((s) => ({ value: s.toLowerCase(), label: td(`request.${s}` as 'request.DRAFT') }))}
            />
          </FilterBar>
        ) : null}

        <Panel label={tv('listTitle')}>
          {rows.length ? (
            <RequestList
              rows={rows}
              labels={{ list: tv('listTitle'), request: tv('columns.request'), status: tv('columns.status'), now: tv('columns.now'), amount: tv('columns.amount'), unit: tv('amounts.currency') }}
            />
          ) : list.total === 0 ? (
            <ListEmpty
              title={tv('emptyNone')}
              hint={tv('emptyNoneHint')}
              actions={
                <Button asChild className="min-h-11 lg:min-h-10">
                  <Link href="/requests/new">{tv('newRequest')}</Link>
                </Button>
              }
            />
          ) : (
            <ListEmpty
              title={tv('emptyNoMatch')}
              hint={tv('emptyNoMatchHint')}
              actions={
                <Button asChild variant="outline" className="min-h-11 lg:min-h-10">
                  <Link href="/requests">{tv('filter.clear')}</Link>
                </Button>
              }
            />
          )}
        </Panel>
      </PageBody>
    </Page>
  )
}
