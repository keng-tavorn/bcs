import Link from 'next/link'
import { getLocale, getTranslations } from 'next-intl/server'
import { systemClock } from '@/lib/clock'
import { ctxFromSession } from '@/server/auth/session'
import { isAllowed, memberPrincipal } from '@/server/authz'
import { mayListVarianceExceptions } from '@/server/services/ap/view-invoice'
import { isPoStatus, listPurchaseOrders, PO_STATUSES } from '@/server/queries/purchase-orders'
import { Notice } from '@/ui/form/notice'
import { FilterBar, FilterSearch, FilterSummary } from '@/ui/page/filters'
import { ListEmpty, Page, PageBody, PageHeader, Panel } from '@/ui/page/page'
import { PoList, type PoRow } from '@/ui/purchase-order/po-list'
import { Button } from '@/ui/shadcn/button'
import { getSession } from '../../../_lib/session'
import { loadPoFilters, posHref } from '../../_tracking/list-filters'
import { localeOf, money, when } from '../../_tracking/present'
import { canListPos } from './_parts/access'
import { waitingOf } from './_parts/present'

export async function generateMetadata() {
  const t = await getTranslations('purchaseOrder')
  return { title: t('list.metaTitle') }
}

const linkClass = 'inline-flex min-h-11 items-center self-start font-medium text-primary underline underline-offset-4 hover:no-underline'
const SEARCH_MAX = 60

// Purchase orders (spec §9.1 /procurement/pos): every PO of the organization, the ones changed last first, by status —
// each status a link with its count, so every number leads to its list (§9.9) — searched by number or supplier with a
// plain GET form (it changes nothing). Each row says whom the PO waits for and since when, its status as the badge of
// §9.10. The list opens for who may see every PO (po.view ORG: PROCUREMENT, FINANCE, EXECUTIVE, AUDITOR), checked
// before anything is read; the way to the pool shows only to who may open it; the services check every action again.
export default async function PurchaseOrdersPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const state = await getSession()
  const ctx = ctxFromSession(state, 'WEB', systemClock.now())
  if (!ctx || state.kind !== 'member') return null
  const [t, tv, td, locale] = await Promise.all([getTranslations('purchaseOrder'), getTranslations('requestView'), getTranslations('document.badge'), getLocale().then(localeOf)])
  const principal = memberPrincipal(state.member.id, state.roles)
  if (!canListPos(principal)) {
    return (
      <Page>
        <PageHeader title={t('list.title')} />
        <div className="flex max-w-2xl flex-col gap-3">
          <Notice tone="danger">{t('list.forbidden')}</Notice>
          <Link href="/" className={linkClass}>
            {t('list.homeLink')}
          </Link>
        </div>
      </Page>
    )
  }
  // The filters live in the address (../../_tracking/list-filters.ts): a status in any case, written in lower case
  const filters = await loadPoFilters(searchParams)
  const q = (filters.q ?? '').trim().slice(0, SEARCH_MAX)
  const status = filters.status ?? ''
  const list = await listPurchaseOrders(ctx, { q, status })
  const allCount = Object.values(list.counts).reduce((sum, n) => sum + n, 0)
  const query = (next: { status?: string }) => posHref('/procurement/pos', { q: q || null, status: isPoStatus(next.status) ? next.status : null })

  // The pool is procurement's (procurement.pool.view): FINANCE, EXECUTIVE and AUDITOR read this list but are never
  // sent to a page that refuses them
  const canPool = isAllowed(principal, 'procurement.pool.view')
  // S8-13: with PAY on, the invoices whose price or quantity is over the PO wait for procurement on a page of their own
  const canExceptions = await mayListVarianceExceptions(ctx)
  const statusLabel = (s: string) => td(`po.${s}` as 'po.DRAFT')

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
      urgent: po.urgency === 'URGENT' ? td('urgency.URGENT') : null,
      status: po.status,
      statusLabel: statusLabel(po.status),
      now: waiting.now,
      nowStates: waiting.states,
      amount: money(po.grossSatang),
    }
  })
  const navLink = 'inline-flex min-h-11 items-center font-medium text-primary underline underline-offset-4 hover:no-underline aria-[current=page]:font-semibold aria-[current=page]:text-ink aria-[current=page]:no-underline lg:min-h-10'

  return (
    <Page>
      <PageHeader
        title={t('list.title')}
        intro={t('list.intro')}
        actions={
          canPool || canExceptions ? (
            <>
              {canExceptions ? (
                <Button asChild variant="outline" className="min-h-11 lg:min-h-10">
                  <Link href="/procurement/invoice-exceptions">{t('list.invoiceExceptionsLink')}</Link>
                </Button>
              ) : null}
              {canPool ? (
                <Button asChild variant="outline" className="min-h-11 lg:min-h-10">
                  <Link href="/procurement/pool">{t('list.poolLink')}</Link>
                </Button>
              ) : null}
            </>
          ) : undefined
        }
      />
      <PageBody>
        {list.total > 0 ? (
          <FilterBar
            key={`${status}|${q}`}
            action="/procurement/pos"
            label={t('list.filterLabel')}
            submit={t('list.searchSubmit')}
            hidden={{ status: status ? status.toLowerCase() : null }}
            footer={
              <>
                {/* Each status a link with its count, so every number leads to its list (§9.9) */}
                <nav aria-label={t('list.statusNav')} className="border-t border-line pt-3">
                  <ul className="flex flex-wrap gap-x-5 gap-y-1">
                    <li>
                      <Link href={query({})} aria-current={status === '' ? 'page' : undefined} className={navLink}>
                        {t('list.all', { count: allCount })}
                      </Link>
                    </li>
                    {PO_STATUSES.filter((s) => list.counts[s] > 0 || s === status).map((s) => (
                      <li key={s}>
                        <Link href={query({ status: s })} aria-current={status === s ? 'page' : undefined} className={navLink}>
                          {t('list.statusCount', { label: statusLabel(s), count: list.counts[s] })}
                        </Link>
                      </li>
                    ))}
                  </ul>
                </nav>
                <FilterSummary
                  count={t('list.count', { matched: list.matched, total: list.total })}
                  notes={list.rows.length < list.matched ? [t('list.limited', { shown: list.rows.length })] : []}
                  clear={q || status ? { href: '/procurement/pos', label: t('list.clear') } : null}
                />
              </>
            }
          >
            <FilterSearch id="po-search" label={t('list.search')} hint={t('list.searchHint')} defaultValue={q} maxLength={SEARCH_MAX} />
          </FilterBar>
        ) : null}

        <Panel label={t('list.listLabel')}>
          {rows.length ? (
            <PoList
              rows={rows}
              labels={{ list: t('list.listLabel'), po: t('list.columns.po'), status: t('list.columns.status'), now: t('list.columns.waiting'), amount: t('list.columns.amount'), unit: t('list.unit') }}
            />
          ) : list.total === 0 ? (
            <ListEmpty
              title={t('list.empty')}
              hint={t('list.emptyHint')}
              actions={
                canPool ? (
                  <Button asChild variant="outline" className="min-h-11 lg:min-h-10">
                    <Link href="/procurement/pool">{t('list.emptyLink')}</Link>
                  </Button>
                ) : undefined
              }
            />
          ) : (
            <ListEmpty
              title={t('list.noMatch')}
              hint={t('list.noMatchHint')}
              actions={
                <Button asChild variant="outline" className="min-h-11 lg:min-h-10">
                  <Link href="/procurement/pos">{t('list.clear')}</Link>
                </Button>
              }
            />
          )}
        </Panel>
      </PageBody>
    </Page>
  )
}
