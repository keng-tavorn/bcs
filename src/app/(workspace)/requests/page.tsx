import Link from 'next/link'
import { getLocale, getTranslations } from 'next-intl/server'
import { systemClock } from '@/lib/clock'
import { ctxFromSession } from '@/server/auth/session'
import { listMyRequests, REQUEST_STATUSES } from '@/server/queries/requests'
import { Button } from '@/ui/form/button'
import { RequestList } from '@/ui/request-view/request-list'
import { getSession } from '../../_lib/session'
import { localeOf } from '../_tracking/present'
import { requestRows } from '../_tracking/rows'

export async function generateMetadata() {
  const t = await getTranslations('requestView')
  return { title: t('listTitle') }
}

const linkClass = 'inline-flex min-h-11 items-center self-start font-medium text-primary underline underline-offset-4 hover:no-underline'
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)

// "My requests" (spec §9.1 /requests, FR-INT-008 AC3): the member's own and followed requests, newest first, each with
// its status, where it is now and for how long, and its total; filtered by status and searched by document number with
// a plain GET form (it changes nothing). The query reads only the member's own and followed requests.
export default async function RequestsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const ctx = ctxFromSession(await getSession(), 'WEB', systemClock.now())
  if (!ctx) return null
  const params = await searchParams
  const q = (one(params.q) ?? '').trim()
  const status = one(params.status) ?? ''
  const [tv, locale] = await Promise.all([getTranslations('requestView'), getLocale().then(localeOf)])
  const list = await listMyRequests(ctx, { q, status })
  const filtered = Boolean(q) || (REQUEST_STATUSES as readonly string[]).includes(status)

  return (
    <div className="flex flex-col gap-6">
      {/* The door to a new request is the shell's, on every page (§9.9 principle 2) */}
      <div className="flex max-w-3xl flex-col gap-1">
        <h1 className="text-2xl font-semibold">{tv('listTitle')}</h1>
        <p className="text-ink-muted">{tv('listIntro')}</p>
      </div>

      {list.total > 0 ? (
        <form method="get" action="/requests" className="flex flex-col gap-3 border-y border-line py-4 md:flex-row md:items-start">
          <div className="flex flex-1 flex-col gap-1.5">
            <label htmlFor="request-search" className="font-medium text-ink">
              {tv('filter.search')}
            </label>
            <input
              id="request-search"
              name="q"
              type="search"
              defaultValue={q}
              maxLength={60}
              aria-describedby="request-search-hint"
              className="h-11 w-full rounded-md border border-input bg-bg px-3 text-base text-ink"
            />
            <p id="request-search-hint" className="text-base text-ink-muted md:text-sm">
              {tv('filter.searchHint')}
            </p>
          </div>
          <div className="flex flex-col gap-1.5 md:w-56">
            <label htmlFor="request-status" className="font-medium text-ink">
              {tv('filter.status')}
            </label>
            <select id="request-status" name="status" defaultValue={status} className="h-11 w-full rounded-md border border-input bg-bg px-3 text-base text-ink">
              <option value="">{tv('filter.allStatuses')}</option>
              {REQUEST_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {tv(`status.${s}`)}
                </option>
              ))}
            </select>
          </div>
          <div className="flex flex-col gap-1.5">
            {/* Lines the button up with the fields on wide screens, under a label-sized gap */}
            <span aria-hidden="true" className="hidden font-medium md:block">
              &nbsp;
            </span>
            <Button type="submit" variant="secondary">
              {tv('filter.submit')}
            </Button>
          </div>
        </form>
      ) : null}

      {list.total > 0 ? (
        <div className="flex flex-wrap items-center gap-x-6 gap-y-1">
          <p className="text-ink" role="status">
            {tv('filter.count', { matched: list.matched, total: list.total })}
          </p>
          {filtered ? (
            <Link href="/requests" className={linkClass}>
              {tv('filter.clear')}
            </Link>
          ) : null}
          {/* The list stops at the newest ones; the search and the status filter reach the rest */}
          {list.rows.length < list.matched ? <p className="basis-full text-ink-muted">{tv('filter.limited', { shown: list.rows.length })}</p> : null}
        </div>
      ) : null}

      {list.rows.length ? (
        <RequestList
          rows={requestRows(tv, locale, list.rows)}
          labels={{ list: tv('listTitle'), request: tv('columns.request'), status: tv('columns.status'), now: tv('columns.now'), amount: tv('columns.amount'), unit: tv('amounts.currency') }}
        />
      ) : list.total === 0 ? (
        <div className="flex flex-col gap-2 border-y border-line py-6">
          <p className="font-medium text-ink">{tv('emptyNone')}</p>
          <p className="text-ink-muted">{tv('emptyNoneHint')}</p>
          <Link href="/requests/new" className={linkClass}>
            {tv('newRequest')}
          </Link>
        </div>
      ) : (
        <div className="flex flex-col gap-2 border-y border-line py-6">
          <p className="font-medium text-ink">{tv('emptyNoMatch')}</p>
          <p className="text-ink-muted">{tv('emptyNoMatchHint')}</p>
          <Link href="/requests" className={linkClass}>
            {tv('filter.clear')}
          </Link>
        </div>
      )}
    </div>
  )
}
