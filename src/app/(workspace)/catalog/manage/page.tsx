import Link from 'next/link'
import { getTranslations } from 'next-intl/server'
import { systemClock } from '@/lib/clock'
import { ctxFromSession } from '@/server/auth/session'
import { getCatalogManage } from '@/server/services/catalog/view'
import { AddItemButton, ManageList } from '@/ui/catalog/manage'
import { Notice } from '@/ui/form/notice'
import { FilterBar, FilterSearch, FilterSummary } from '@/ui/page/filters'
import { ListEmpty, Page, PageBody, PageHeader, Panel } from '@/ui/page/page'
import { Button } from '@/ui/shadcn/button'
import { getSession } from '../../../_lib/session'
import { createCatalogItemAction, createPriceAgreementAction, endPriceAgreementAction, updateCatalogItemAction } from './actions'

export async function generateMetadata() {
  const t = await getTranslations('catalog.manage')
  return { title: t('title') }
}

const linkClass = 'inline-flex min-h-11 items-center self-start font-medium text-primary underline underline-offset-4 hover:no-underline'

// /catalog/manage (spec §9.1 · S6-10 · FR-INT-102 AC3 · OQ-114): PROCUREMENT keeps the catalogue and its agreed prices —
// every item, those out of use too, with the agreed prices in effect and still to come. Searched with a plain GET form.
// Anyone else is told the page is PROCUREMENT's and led to the catalogue (catalog.manage, checked by the service: the
// menu and the link only show the way). Every change goes through a command with its event (./actions.ts).
export default async function CatalogManagePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const ctx = ctxFromSession(await getSession(), 'WEB', systemClock.now())
  if (!ctx) return null
  const raw = (await searchParams).q
  const q = typeof raw === 'string' ? raw.trim().slice(0, 100) : ''
  const t = await getTranslations('catalog')
  const result = await getCatalogManage(ctx, { q })
  if (!result.ok) {
    return (
      <Page>
        <PageHeader title={t('manage.forbiddenTitle')} />
        <Notice tone="warning">{result.error.code === 'FORBIDDEN' ? t('manage.forbidden') : t('errors.FAILED')}</Notice>
        <Link href="/catalog" className={linkClass}>
          {t('manage.back')}
        </Link>
      </Page>
    )
  }
  const view = result.data
  const add = <AddItemButton create={createCatalogItemAction} />

  return (
    <Page>
      <PageHeader title={t('manage.title')} intro={t('manage.intro')} actions={add}>
        <Link href="/catalog" className={linkClass}>
          {t('manage.back')}
        </Link>
      </PageHeader>
      <PageBody>
        <FilterBar
          action="/catalog/manage"
          label={t('list.filter.label')}
          submit={t('list.filter.submit')}
          footer={
            <FilterSummary
              count={t('list.filter.count', { count: view.total })}
              notes={view.items.length < view.total ? [t('list.filter.limited', { shown: view.items.length })] : []}
              clear={q ? { href: '/catalog/manage', label: t('list.filter.clear') } : null}
            />
          }
        >
          <FilterSearch id="catalog-manage-search" label={t('list.filter.search')} hint={t('list.filter.hint')} defaultValue={q} maxLength={100} />
        </FilterBar>

        <Panel label={t('manage.listLabel')}>
          {view.items.length ? (
            <ManageList
              items={view.items}
              suppliers={view.suppliers}
              today={view.today}
              actions={{ updateItem: updateCatalogItemAction, createAgreement: createPriceAgreementAction, endAgreement: endPriceAgreementAction }}
            />
          ) : q ? (
            <ListEmpty
              title={t('list.emptyNoMatch', { query: q })}
              hint={t('manage.emptyNoMatchHint')}
              actions={
                <Button asChild variant="outline" className="min-h-11 lg:min-h-10">
                  <Link href="/catalog/manage">{t('list.filter.clear')}</Link>
                </Button>
              }
            />
          ) : (
            <ListEmpty title={t('list.emptyNone')} hint={t('list.emptyNoneManage')} />
          )}
        </Panel>
      </PageBody>
    </Page>
  )
}
