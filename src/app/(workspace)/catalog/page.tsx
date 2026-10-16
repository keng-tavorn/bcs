import Link from 'next/link'
import { getLocale, getTranslations } from 'next-intl/server'
import { systemClock } from '@/lib/clock'
import { ctxFromSession } from '@/server/auth/session'
import { listCatalog } from '@/server/services/catalog/view'
import { CatalogList } from '@/ui/catalog/catalog-list'
import { lastDayOf } from '@/ui/catalog/model'
import { Notice } from '@/ui/form/notice'
import { FilterBar, FilterSearch, FilterSummary } from '@/ui/page/filters'
import { ListEmpty, Page, PageBody, PageHeader, Panel } from '@/ui/page/page'
import { Button } from '@/ui/shadcn/button'
import { getSession } from '../../_lib/session'
import { day, money } from '../_tracking/present'

export async function generateMetadata() {
  const t = await getTranslations('catalog.list')
  return { title: t('title') }
}

const linkClass = 'inline-flex min-h-11 items-center self-start font-medium text-primary underline underline-offset-4 hover:no-underline'

/** The search box's words: text of up to 100 characters (a longer or repeated parameter is no search) */
function queryOf(value: string | string[] | undefined): string {
  return typeof value === 'string' ? value.trim().slice(0, 100) : ''
}

// The catalogue (spec §9.1 /catalog · S6-10 · FR-INT-102 AC1): every member searches the items PROCUREMENT keeps, each
// with its unit, its reference price and the agreed prices in effect today with their suppliers (before VAT, §9.9
// principle 6). Searched with a plain GET form (it changes nothing). PROCUREMENT also has the way to /catalog/manage.
// The request form picks its lines from the same catalogue. The page's frame (S16-10): the title on the page's white,
// then the search and the list each in its white card on --surface.
export default async function CatalogPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const ctx = ctxFromSession(await getSession(), 'WEB', systemClock.now())
  if (!ctx) return null
  const q = queryOf((await searchParams).q)
  const [t, locale] = await Promise.all([getTranslations('catalog'), getLocale().then((l) => (l === 'en' ? 'en' : 'th') as 'th' | 'en')])
  const result = await listCatalog(ctx, { q })
  if (!result.ok) {
    return (
      <Page>
        <PageHeader title={t('list.forbiddenTitle')} />
        <Notice tone="warning">{t('list.forbidden')}</Notice>
        <Link href="/" className={linkClass}>
          {t('list.home')}
        </Link>
      </Page>
    )
  }
  const list = result.data
  const manage = list.canManage ? (
    <Button asChild variant="outline" className="min-h-11 lg:min-h-10">
      <Link href="/catalog/manage">{t('list.manage')}</Link>
    </Button>
  ) : null

  return (
    <Page>
      <PageHeader title={t('list.title')} intro={t('list.intro')} actions={manage} />
      <PageBody>
        <FilterBar
          action="/catalog"
          label={t('list.filter.label')}
          submit={t('list.filter.submit')}
          footer={
            <FilterSummary
              count={t('list.filter.count', { count: list.total })}
              notes={list.items.length < list.total ? [t('list.filter.limited', { shown: list.items.length })] : []}
              clear={q ? { href: '/catalog', label: t('list.filter.clear') } : null}
            />
          }
        >
          <FilterSearch id="catalog-search" label={t('list.filter.search')} hint={t('list.filter.hint')} defaultValue={q} maxLength={100} />
        </FilterBar>

        <Panel label={t('list.listLabel')}>
          {list.items.length ? (
            <CatalogList
              labels={{ list: t('list.listLabel'), item: t('list.columns.item'), reference: t('list.columns.reference'), agreed: t('list.columns.agreed'), agreedBadge: t('row.agreedBadge') }}
              rows={list.items.map((item) => ({
                id: item.id,
                name: (locale === 'en' ? item.nameEn : null) ?? item.nameTh,
                meta: t('row.meta', { code: item.code, category: item.categoryCode, uom: item.uom }),
                reference: t('row.reference', { amount: money(BigInt(item.refUnitPriceSatang)), uom: item.uom }),
                agreements: item.agreements.map((a) => ({
                  id: a.id,
                  text: t('row.agreed', { supplier: a.supplierName, amount: money(BigInt(a.unitPriceSatang)), uom: item.uom }),
                  until: t('row.until', { date: day(locale, lastDayOf(a.validTo)) }),
                })),
                none: t('row.noAgreement'),
              }))}
            />
          ) : q ? (
            <ListEmpty
              title={t('list.emptyNoMatch', { query: q })}
              hint={t('list.emptyNoMatchHint')}
              actions={
                <Button asChild variant="outline" className="min-h-11 lg:min-h-10">
                  <Link href="/catalog">{t('list.filter.clear')}</Link>
                </Button>
              }
            />
          ) : (
            <ListEmpty title={t('list.emptyNone')} hint={list.canManage ? t('list.emptyNoneManage') : t('list.emptyNoneOther')} actions={manage} />
          )}
        </Panel>
      </PageBody>
    </Page>
  )
}
