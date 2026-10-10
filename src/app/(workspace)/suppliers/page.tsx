import Link from 'next/link'
import { getLocale, getTranslations } from 'next-intl/server'
import { systemClock } from '@/lib/clock'
import { ctxFromSession } from '@/server/auth/session'
import { listSuppliersForScreen, type SupplierListRowDto } from '@/server/services/suppliers/view'
import { Notice } from '@/ui/form/notice'
import { FilterBar, FilterSearch, FilterSelect, FilterSummary } from '@/ui/page/filters'
import { ListEmpty, Page, PageBody, PageHeader, Panel } from '@/ui/page/page'
import { Button } from '@/ui/shadcn/button'
import { formatTaxId, HEAD_OFFICE } from '@/ui/suppliers/model'
import { SupplierList, type SupplierRow } from '@/ui/suppliers/supplier-list'
import { getSession } from '../../_lib/session'
import { day, money } from '../_tracking/present'
import { loadSupplierFilters } from './_filters'

export async function generateMetadata() {
  const t = await getTranslations('suppliers.list')
  return { title: t('title') }
}

const linkClass = 'inline-flex min-h-11 items-center self-start font-medium text-primary underline underline-offset-4 hover:no-underline'

type T = Awaited<ReturnType<typeof getTranslations<'suppliers'>>>

/** One row as the list shows it: names in the reader's language, the tax id with dashes, states in words */
function rowOf(t: T, locale: 'th' | 'en', s: SupplierListRowDto): SupplierRow {
  const name = (locale === 'en' ? s.nameEn : null) ?? s.nameTh
  const branch = s.branchCode === HEAD_OFFICE ? t('branch.head') : t('branch.number', { code: s.branchCode })
  const meta = [t('row.codeBranch', { code: s.code, branch }), ...(s.category ? [s.category] : []), ...(s.isForeign ? [t('row.foreign')] : [])]
  const full = s.full
  return {
    id: s.id,
    href: `/suppliers/${s.id}`,
    name,
    meta,
    status: s.status,
    statusLabel: t(`status.${s.status}`),
    vat: s.isVatRegistered ? t('vat.yes') : t('vat.no'),
    full: full
      ? {
          taxId: full.taxId ? (full.taxIdMasked ? t('row.taxIdMasked', { taxId: formatTaxId(full.taxId) }) : t('row.taxId', { taxId: formatTaxId(full.taxId) })) : null,
          express: full.expressVendorCode ? { text: t('row.express', { code: full.expressVendorCode }), missing: false } : { text: t('row.expressMissing'), missing: true },
          check: s.isForeign ? t('check.FOREIGN') : t(`check.${full.registrySource ?? 'NONE'}`),
        }
      : null,
    prices: s.prices
      ? {
          label: t('prices.label'),
          items: s.prices.map((p) => ({
            key: `${p.poId}|${p.description}`,
            text: p.description,
            price: t('prices.price', { amount: money(p.unitPriceSatang), uom: p.uom }),
            source: t('prices.source', { number: p.poNumber ?? '-', date: day(locale, p.approvedAt) }),
          })),
          none: t('prices.none'),
        }
      : null,
  }
}

// The supplier register (spec §9.1 /suppliers, S4-02, §2.4 supplier.view): every member sees names and basic details;
// PROCUREMENT, FINANCE and AUDITOR also the tax id, the Express vendor code (BR-EXP-04) and how the identity was checked.
// Readers of every PO (po.view ORG) see each supplier's latest prices and find suppliers by an item they sold — the
// home's chip "ผู้ขายและราคา" opens it (FR-VIS-006 AC1).
// Searched and filtered with a plain GET form (it changes nothing), its fields in the address (./_filters, nuqs).
// PROCUREMENT adds suppliers from here. The page's frame (S16-10): the title and the way to add on the page's white,
// then the filters and the list each in its white card on --surface.
export default async function SuppliersPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const ctx = ctxFromSession(await getSession(), 'WEB', systemClock.now())
  if (!ctx) return null
  const filters = await loadSupplierFilters(searchParams)
  const q = (filters.q ?? '').trim()
  const status = filters.status ?? ''
  const missing = filters.missing === '1'
  const [t, locale] = await Promise.all([getTranslations('suppliers'), getLocale().then((l) => (l === 'en' ? 'en' : 'th') as 'th' | 'en')])
  const result = await listSuppliersForScreen(ctx, { q, status, missingExpressCode: missing })
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
  const full = list.level === 'FULL'
  const filtered = Boolean(q) || status !== '' || (full && missing)
  const searchHint = `${list.taxIdMatch === 'WHOLE_FOR_INDIVIDUALS' ? t('list.filter.searchHintMasked') : full ? t('list.filter.searchHintFull') : t('list.filter.searchHintBasic')}${list.seesPrices ? ` ${t('list.filter.searchHintItems')}` : ''}`
  const addButton = (variant: 'default' | 'outline') => (
    <Button asChild variant={variant} className="min-h-11 lg:min-h-10">
      <Link href="/suppliers/new">{t('list.add')}</Link>
    </Button>
  )

  return (
    <Page>
      <PageHeader title={t('list.title')} intro={full ? t('list.introFull') : t('list.introBasic')} actions={list.canManage ? addButton('default') : null}>
        {list.seesPrices ? <p className="text-ink-muted">{t('prices.intro')}</p> : null}
      </PageHeader>
      <PageBody>
        {list.total > 0 ? (
          <FilterBar
            action="/suppliers"
            label={t('list.filter.label')}
            submit={t('list.filter.submit')}
            footer={
              <FilterSummary
                count={t('list.filter.count', { matched: list.matched, total: list.total })}
                notes={list.rows.length < list.matched ? [t('list.filter.limited', { shown: list.rows.length })] : []}
                clear={filtered ? { href: '/suppliers', label: t('list.filter.clear') } : null}
              />
            }
          >
            <FilterSearch id="supplier-search" label={t('list.filter.search')} hint={searchHint} defaultValue={q} />
            <FilterSelect
              id="supplier-status"
              name="status"
              label={t('list.filter.status')}
              all={t('list.filter.allStatuses')}
              defaultValue={status}
              options={(['ACTIVE', 'INACTIVE'] as const).map((s) => ({ value: s, label: t(`status.${s}`) }))}
            />
            {full ? (
              <div className="flex flex-col gap-1.5">
                {/* Lines the box up with the fields on wide screens, under a label-sized gap */}
                <span aria-hidden="true" className="hidden font-medium md:block">
                  &nbsp;
                </span>
                <label className="flex min-h-11 items-center gap-3 lg:min-h-10">
                  <input type="checkbox" name="missing" value="1" defaultChecked={missing} className="size-5 shrink-0 accent-primary" />
                  <span>{t('list.filter.missingExpress')}</span>
                </label>
              </div>
            ) : null}
          </FilterBar>
        ) : null}

        <Panel label={t('list.listLabel')}>
          {list.rows.length ? (
            <SupplierList
              full={full}
              rows={list.rows.map((s) => rowOf(t, locale, s))}
              labels={{ list: t('list.listLabel'), supplier: t('list.columns.supplier'), status: t('list.columns.status'), account: t('list.columns.account') }}
            />
          ) : list.total === 0 ? (
            <ListEmpty title={t('list.emptyNone')} hint={list.canManage ? t('list.emptyNoneManage') : t('list.emptyNoneOther')} actions={list.canManage ? addButton('outline') : null} />
          ) : (
            <ListEmpty
              title={t('list.emptyNoMatch')}
              hint={t('list.emptyNoMatchHint')}
              actions={
                <Button asChild variant="outline" className="min-h-11 lg:min-h-10">
                  <Link href="/suppliers">{t('list.filter.clear')}</Link>
                </Button>
              }
            />
          )}
        </Panel>
      </PageBody>
    </Page>
  )
}
