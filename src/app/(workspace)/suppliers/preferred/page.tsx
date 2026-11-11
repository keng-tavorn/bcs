import Link from 'next/link'
import { getTranslations } from 'next-intl/server'
import { createLoader, parseAsString, parseAsStringLiteral } from 'nuqs/server'
import { systemClock } from '@/lib/clock'
import { ctxFromSession } from '@/server/auth/session'
import { preferredSupplierPage } from '@/server/services/sourcing/preferred-view'
import { NoAccess } from '@/ui/admin-settings/no-access'
import { Notice } from '@/ui/form/notice'
import { FilterBar, FilterSelect, FilterSummary } from '@/ui/page/filters'
import { ListEmpty, Page, PageBody, PageHeader, Panel } from '@/ui/page/page'
import { Button } from '@/ui/shadcn/button'
import { Toaster } from '@/ui/shadcn/sonner'
import { PreferredList, SetPreferredButton } from '@/ui/sourcing/preferred-suppliers'
import { getSession } from '../../../_lib/session'
import { createPreferredSupplierAction, endPreferredSupplierAction } from './actions'

export async function generateMetadata() {
  const t = await getTranslations('preferredSuppliers')
  return { title: t('title') }
}

// The filters, kept in the address with nuqs (spec §9.10 "ตัวกรอง"): the category — the expiry notice of the job
// preferred-supplier-expiry links here with ?category=<code> — and whether the rows that ended or are over show too
const loadFilters = createLoader({ category: parseAsString, show: parseAsStringLiteral(['current', 'all'] as const) })

const linkClass = 'inline-flex min-h-11 items-center self-start font-medium text-primary underline underline-offset-4 hover:no-underline'

const hrefOf = (category: string | null, show: 'current' | 'all') => {
  const params = new URLSearchParams()
  if (category) params.set('category', category)
  if (show === 'all') params.set('show', 'all')
  const query = params.toString()
  return query ? `/suppliers/preferred?${query}` : '/suppliers/preferred'
}

// /suppliers/preferred (S10-13 · BR-RFX-14 · ADR-207 · docs/sub-specs/S10.md "หน้าจอ"): the preferred suppliers per
// category — from an approved award (AWD-…) or set by procurement with a reason — with their period, how they stand
// today (ending soon within 30 days) and, with RISK on, the supplier's risk and "แนะนำแต่ติดความเสี่ยง". Every member
// reads it (supplier.view); PROCUREMENT sets one while SOURCING is on and ends one at any time
// (sourcing.preferred.manage) — the service and the commands check both again; the buttons only show the way. The
// page's frame (S16-10): the title, its one main button and the way back on the page's white, then the filters and the
// list each in its white card on --surface.
export default async function PreferredSuppliersPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const ctx = ctxFromSession(await getSession(), 'WEB', systemClock.now())
  if (!ctx) return null
  const filters = await loadFilters(searchParams)
  const category = (filters.category ?? '').trim().slice(0, 50)
  const show = filters.show ?? 'current'
  const t = await getTranslations('preferredSuppliers')
  const result = await preferredSupplierPage(ctx, { ...(category ? { category } : {}), show })
  if (!result.ok) return <NoAccess title={t('title')} message={result.error.code === 'FORBIDDEN' ? t('forbidden') : t('failed')} homeLabel={t('home')} />
  const view = result.data
  const setButton =
    view.canManage && view.sourcingOn ? (
      <SetPreferredButton categories={view.categories} suppliers={view.suppliers} today={view.today} defaultDays={view.defaultDays} initialCategory={view.category} create={createPreferredSupplierAction} />
    ) : null
  const filtered = view.category !== null || view.show === 'all'
  // a category from a link that no row or source names any more still shows as chosen
  const categoryOptions = view.category && !view.filterCategories.includes(view.category) ? [view.category, ...view.filterCategories] : view.filterCategories
  const outline = (href: string, label: string) => (
    <Button asChild variant="outline" className="min-h-11 lg:min-h-10">
      <Link href={href}>{label}</Link>
    </Button>
  )

  return (
    <Page>
      <PageHeader title={t('title')} intro={t('intro')} actions={setButton}>
        {view.riskOn ? <p className="text-ink-muted">{t('riskIntro')}</p> : null}
        {view.canManage && !view.sourcingOn ? <Notice tone="info">{t('sourcingOff')}</Notice> : null}
        <Link href="/suppliers" className={linkClass}>
          {t('back')}
        </Link>
      </PageHeader>
      <PageBody>
        <FilterBar
          key={`${view.category ?? ''}|${view.show}`}
          action="/suppliers/preferred"
          label={t('filter.label')}
          submit={t('filter.submit')}
          footer={
            <FilterSummary
              count={t('filter.count', { count: view.rows.length })}
              notes={view.limited ? [t('filter.limited', { shown: view.rows.length })] : []}
              clear={filtered ? { href: '/suppliers/preferred', label: t('filter.clear') } : null}
            />
          }
        >
          <FilterSelect
            id="preferred-category"
            name="category"
            label={t('filter.category')}
            all={t('filter.allCategories')}
            defaultValue={view.category ?? ''}
            options={categoryOptions.map((c) => ({ value: c, label: c }))}
          />
          <FilterSelect
            id="preferred-show"
            name="show"
            label={t('filter.show')}
            defaultValue={view.show}
            options={[
              { value: 'current', label: t('filter.current') },
              { value: 'all', label: t('filter.all') },
            ]}
          />
        </FilterBar>

        <Panel label={t('listLabel')}>
          {view.rows.length ? (
            <PreferredList rows={view.rows} riskOn={view.riskOn} awardLinks={view.awardLinks} end={view.canManage ? endPreferredSupplierAction : null} />
          ) : view.category ? (
            <ListEmpty
              title={t('empty.noMatch', { category: view.category })}
              hint={t('empty.noMatchHint')}
              actions={
                <>
                  {view.show === 'current' ? outline(hrefOf(view.category, 'all'), t('empty.showAll')) : null}
                  {outline('/suppliers/preferred', t('filter.clear'))}
                </>
              }
            />
          ) : view.show === 'current' ? (
            <ListEmpty title={t('empty.current')} hint={setButton ? t('empty.currentHintManage') : t('empty.currentHint')} actions={outline(hrefOf(null, 'all'), t('empty.showAll'))} />
          ) : (
            <ListEmpty title={t('empty.all')} hint={setButton ? t('empty.currentHintManage') : t('empty.currentHint')} />
          )}
        </Panel>
      </PageBody>
      <Toaster position="top-center" />
    </Page>
  )
}
