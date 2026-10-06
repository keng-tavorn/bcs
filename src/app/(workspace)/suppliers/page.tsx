import Link from 'next/link'
import { getLocale, getTranslations } from 'next-intl/server'
import { systemClock } from '@/lib/clock'
import { ctxFromSession } from '@/server/auth/session'
import { listSuppliersForScreen, type SupplierListRowDto } from '@/server/services/suppliers/view'
import { Button } from '@/ui/form/button'
import { Notice } from '@/ui/form/notice'
import { formatTaxId, HEAD_OFFICE } from '@/ui/suppliers/model'
import { SupplierList, type SupplierRow } from '@/ui/suppliers/supplier-list'
import { getSession } from '../../_lib/session'

export async function generateMetadata() {
  const t = await getTranslations('suppliers.list')
  return { title: t('title') }
}

const linkClass = 'inline-flex min-h-11 items-center self-start font-medium text-primary underline underline-offset-4 hover:no-underline'
const primaryLink = 'inline-flex h-11 shrink-0 items-center justify-center self-start rounded-md bg-primary px-4 font-medium text-primary-foreground underline-offset-4 hover:underline'
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)

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
  }
}

// The supplier register (spec §9.1 /suppliers, S4-02, §2.4 supplier.view): every member sees names and basic details;
// PROCUREMENT, FINANCE and AUDITOR also the tax id, the Express vendor code (BR-EXP-04) and how the identity was checked.
// Searched and filtered with a plain GET form (it changes nothing). PROCUREMENT adds suppliers from here.
export default async function SuppliersPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const ctx = ctxFromSession(await getSession(), 'WEB', systemClock.now())
  if (!ctx) return null
  const params = await searchParams
  const q = (one(params.q) ?? '').trim()
  const status = one(params.status) ?? ''
  const missing = one(params.missing) === '1'
  const [t, locale] = await Promise.all([getTranslations('suppliers'), getLocale().then((l) => (l === 'en' ? 'en' : 'th') as 'th' | 'en')])
  const result = await listSuppliersForScreen(ctx, { q, status, missingExpressCode: missing })
  if (!result.ok) {
    return (
      <div className="flex max-w-2xl flex-col gap-6">
        <h1 className="text-2xl font-semibold">{t('list.forbiddenTitle')}</h1>
        <Notice tone="warning">{t('list.forbidden')}</Notice>
        <Link href="/" className={linkClass}>
          {t('list.home')}
        </Link>
      </div>
    )
  }
  const list = result.data
  const full = list.level === 'FULL'
  const filtered = Boolean(q) || status === 'ACTIVE' || status === 'INACTIVE' || (full && missing)

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex max-w-3xl flex-col gap-1">
          <h1 className="text-2xl font-semibold">{t('list.title')}</h1>
          <p className="text-ink-muted">{full ? t('list.introFull') : t('list.introBasic')}</p>
        </div>
        {list.canManage ? (
          <Link href="/suppliers/new" className={primaryLink}>
            {t('list.add')}
          </Link>
        ) : null}
      </div>

      {list.total > 0 ? (
        <form method="get" action="/suppliers" className="flex flex-col gap-3 border-y border-line py-4 md:flex-row md:flex-wrap md:items-start">
          <div className="flex flex-col gap-1.5 md:min-w-72 md:flex-1">
            <label htmlFor="supplier-search" className="font-medium text-ink">
              {t('list.filter.search')}
            </label>
            <input
              id="supplier-search"
              name="q"
              type="search"
              defaultValue={q}
              maxLength={60}
              aria-describedby="supplier-search-hint"
              className="h-11 w-full rounded-md border border-input bg-bg px-3 text-base text-ink"
            />
            <p id="supplier-search-hint" className="text-base text-ink-muted md:text-sm">
              {list.taxIdMatch === 'WHOLE_FOR_INDIVIDUALS' ? t('list.filter.searchHintMasked') : full ? t('list.filter.searchHintFull') : t('list.filter.searchHintBasic')}
            </p>
          </div>
          <div className="flex flex-col gap-1.5 md:w-48">
            <label htmlFor="supplier-status" className="font-medium text-ink">
              {t('list.filter.status')}
            </label>
            <select id="supplier-status" name="status" defaultValue={status} className="h-11 w-full rounded-md border border-input bg-bg px-3 text-base text-ink">
              <option value="">{t('list.filter.allStatuses')}</option>
              <option value="ACTIVE">{t('status.ACTIVE')}</option>
              <option value="INACTIVE">{t('status.INACTIVE')}</option>
            </select>
          </div>
          {full ? (
            <div className="flex flex-col gap-1.5 md:pt-8">
              <label className="flex min-h-11 items-center gap-3">
                <input type="checkbox" name="missing" value="1" defaultChecked={missing} className="size-5 shrink-0" />
                <span>{t('list.filter.missingExpress')}</span>
              </label>
            </div>
          ) : null}
          <div className="flex flex-col gap-1.5">
            {/* Lines the button up with the fields on wide screens, under a label-sized gap */}
            <span aria-hidden="true" className="hidden font-medium md:block">
              &nbsp;
            </span>
            <Button type="submit" variant="secondary">
              {t('list.filter.submit')}
            </Button>
          </div>
        </form>
      ) : null}

      {list.total > 0 ? (
        <div className="flex flex-wrap items-center gap-x-6 gap-y-1">
          <p className="text-ink" role="status">
            {t('list.filter.count', { matched: list.matched, total: list.total })}
          </p>
          {filtered ? (
            <Link href="/suppliers" className={linkClass}>
              {t('list.filter.clear')}
            </Link>
          ) : null}
          {list.rows.length < list.matched ? <p className="basis-full text-ink-muted">{t('list.filter.limited', { shown: list.rows.length })}</p> : null}
        </div>
      ) : null}

      {list.rows.length ? (
        <SupplierList
          full={full}
          rows={list.rows.map((s) => rowOf(t, locale, s))}
          labels={{ list: t('list.listLabel'), supplier: t('list.columns.supplier'), status: t('list.columns.status'), account: t('list.columns.account') }}
        />
      ) : list.total === 0 ? (
        <div className="flex flex-col gap-2 border-y border-line py-6">
          <p className="font-medium text-ink">{t('list.emptyNone')}</p>
          <p className="text-ink-muted">{list.canManage ? t('list.emptyNoneManage') : t('list.emptyNoneOther')}</p>
          {list.canManage ? (
            <Link href="/suppliers/new" className={linkClass}>
              {t('list.add')}
            </Link>
          ) : null}
        </div>
      ) : (
        <div className="flex flex-col gap-2 border-y border-line py-6">
          <p className="font-medium text-ink">{t('list.emptyNoMatch')}</p>
          <p className="text-ink-muted">{t('list.emptyNoMatchHint')}</p>
          <Link href="/suppliers" className={linkClass}>
            {t('list.filter.clear')}
          </Link>
        </div>
      )}
    </div>
  )
}
