import Link from 'next/link'
import { getLocale, getTranslations } from 'next-intl/server'
import { systemClock } from '@/lib/clock'
import { ctxFromSession } from '@/server/auth/session'
import { memberPrincipal } from '@/server/authz'
import { isPoStatus, listPurchaseOrders, PO_STATUSES } from '@/server/queries/purchase-orders'
import { Button } from '@/ui/form/button'
import { Notice } from '@/ui/form/notice'
import { PoList, type PoRow } from '@/ui/purchase-order/po-list'
import { getSession } from '../../../_lib/session'
import { localeOf, money, when } from '../../_tracking/present'
import { canListPos } from './_parts/access'
import { waitingOf } from './_parts/present'

export async function generateMetadata() {
  const t = await getTranslations('purchaseOrder')
  return { title: t('list.metaTitle') }
}

const linkClass = 'inline-flex min-h-11 items-center self-start font-medium text-primary underline underline-offset-4 hover:no-underline'
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)
const SEARCH_MAX = 60

// Purchase orders (spec §9.1 /procurement/pos): every PO of the organization, the ones changed last first, by status —
// each status a link with its count, so every number leads to its list (§9.9) — searched by number or supplier with a
// plain GET form (it changes nothing). Each row says whom the PO waits for and since when. The list is procurement's
// (po.create, checked before anything is read); the services check every action again.
export default async function PurchaseOrdersPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const state = await getSession()
  const ctx = ctxFromSession(state, 'WEB', systemClock.now())
  if (!ctx || state.kind !== 'member') return null
  const [t, tv, locale] = await Promise.all([getTranslations('purchaseOrder'), getTranslations('requestView'), getLocale().then(localeOf)])
  if (!canListPos(memberPrincipal(state.member.id, state.roles))) {
    return (
      <div className="flex max-w-2xl flex-col gap-6">
        <h1 className="text-2xl font-semibold">{t('list.title')}</h1>
        <Notice tone="danger">{t('list.forbidden')}</Notice>
        <Link href="/" className={linkClass}>
          {t('list.homeLink')}
        </Link>
      </div>
    )
  }
  const params = await searchParams
  const q = (one(params.q) ?? '').trim().slice(0, SEARCH_MAX)
  const status = isPoStatus(one(params.status)) ? one(params.status)! : ''
  const list = await listPurchaseOrders(ctx, { q, status })
  const allCount = Object.values(list.counts).reduce((sum, n) => sum + n, 0)
  const query = (next: { status?: string }) => {
    const p = new URLSearchParams()
    if (q) p.set('q', q)
    if (next.status) p.set('status', next.status)
    const s = p.toString()
    return s ? `/procurement/pos?${s}` : '/procurement/pos'
  }

  const rows: PoRow[] = list.rows.map((po) => {
    const waiting = waitingOf(t, tv, locale, po.waiting)
    return {
      id: po.id,
      href: `/procurement/pos/${po.id}`,
      title: po.number ? t('list.rowTitle', { number: po.number, supplier: po.supplier.nameTh }) : t('list.draftTitle', { supplier: po.supplier.nameTh }),
      meta: [
        t('list.meta', { site: po.deliverySite?.nameTh ?? t('list.noSite'), kind: t(`kind.${po.kind}`), lines: po.lineCount }),
        ...(po.requestNumbers.length ? [t('list.requests', { numbers: po.requestNumbers.join(', ') })] : []),
        t('list.updated', { time: when(locale, po.updatedAt) }),
      ],
      tags: po.urgency === 'URGENT' ? [t('list.urgent')] : [],
      status: po.status,
      statusLabel: t(`status.${po.status}`),
      now: waiting.now,
      nowStates: waiting.states,
      amount: money(po.grossSatang),
    }
  })

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex max-w-3xl flex-col gap-1">
          <h1 className="text-2xl font-semibold">{t('list.title')}</h1>
          <p className="text-ink-muted">{t('list.intro')}</p>
        </div>
        <Link href="/procurement/pool" className={linkClass}>
          {t('list.poolLink')}
        </Link>
      </div>

      {list.total > 0 ? (
        <>
          <nav aria-label={t('list.statusNav')}>
            <ul className="flex flex-wrap gap-x-5 gap-y-1">
              <li>
                <Link href={query({})} aria-current={status === '' ? 'page' : undefined} className={`${linkClass} aria-[current=page]:font-semibold aria-[current=page]:text-ink aria-[current=page]:no-underline`}>
                  {t('list.all', { count: allCount })}
                </Link>
              </li>
              {PO_STATUSES.filter((s) => list.counts[s] > 0 || s === status).map((s) => (
                <li key={s}>
                  <Link href={query({ status: s })} aria-current={status === s ? 'page' : undefined} className={`${linkClass} aria-[current=page]:font-semibold aria-[current=page]:text-ink aria-[current=page]:no-underline`}>
                    {t('list.statusCount', { label: t(`status.${s}`), count: list.counts[s] })}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
          <form key={`${status}|${q}`} method="get" action="/procurement/pos" className="flex flex-col gap-3 border-y border-line py-4 md:flex-row md:items-start">
            {status ? <input type="hidden" name="status" value={status} /> : null}
            <div className="flex flex-1 flex-col gap-1.5">
              <label htmlFor="po-search" className="font-medium text-ink">
                {t('list.search')}
              </label>
              <input id="po-search" name="q" type="search" defaultValue={q} maxLength={SEARCH_MAX} aria-describedby="po-search-hint" className="h-11 w-full rounded-md border border-input bg-bg px-3 text-base text-ink" />
              <p id="po-search-hint" className="text-base text-ink-muted md:text-sm">
                {t('list.searchHint')}
              </p>
            </div>
            <div className="flex flex-col gap-1.5">
              <span aria-hidden="true" className="hidden font-medium md:block">
                &nbsp;
              </span>
              <Button type="submit" variant="secondary">
                {t('list.searchSubmit')}
              </Button>
            </div>
          </form>
          <div className="flex flex-wrap items-center gap-x-6 gap-y-1">
            <p className="text-ink" role="status">
              {t('list.count', { matched: list.matched, total: list.total })}
            </p>
            {q || status ? (
              <Link href="/procurement/pos" className={linkClass}>
                {t('list.clear')}
              </Link>
            ) : null}
            {list.rows.length < list.matched ? <p className="basis-full text-ink-muted">{t('list.limited', { shown: list.rows.length })}</p> : null}
          </div>
        </>
      ) : null}

      {rows.length ? (
        <PoList
          rows={rows}
          labels={{ list: t('list.listLabel'), po: t('list.columns.po'), status: t('list.columns.status'), now: t('list.columns.waiting'), amount: t('list.columns.amount'), unit: t('list.unit') }}
        />
      ) : list.total === 0 ? (
        <div className="flex flex-col gap-2 border-y border-line py-6">
          <p className="font-medium text-ink">{t('list.empty')}</p>
          <p className="text-ink-muted">{t('list.emptyHint')}</p>
          <Link href="/procurement/pool" className={linkClass}>
            {t('list.emptyLink')}
          </Link>
        </div>
      ) : (
        <div className="flex flex-col gap-2 border-y border-line py-6">
          <p className="font-medium text-ink">{t('list.noMatch')}</p>
          <p className="text-ink-muted">{t('list.noMatchHint')}</p>
          <Link href="/procurement/pos" className={linkClass}>
            {t('list.clear')}
          </Link>
        </div>
      )}
    </div>
  )
}
