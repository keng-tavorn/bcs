import Link from 'next/link'
import { getLocale, getTranslations } from 'next-intl/server'
import { systemClock } from '@/lib/clock'
import { ctxFromSession } from '@/server/auth/session'
import { rfxList } from '@/server/services/sourcing/rfx-setup'
import { NoAccess } from '@/ui/admin-settings/no-access'
import { StatusBadge } from '@/ui/document/badges'
import { FilterBar, FilterSelect, FilterSummary } from '@/ui/page/filters'
import { ListEmpty, Page, PageBody, PageHeader, Panel } from '@/ui/page/page'
import { Button } from '@/ui/shadcn/button'
import { isRfxKind, isRfxStatus, RFX_KINDS, RFX_STATUS_LOOK, RFX_STATUSES } from '@/ui/sourcing/rfx-looks'
import { getSession } from '../../_lib/session'
import { localeOf, when } from '../_tracking/present'

export async function generateMetadata() {
  const t = await getTranslations('sourcing.list')
  return { title: t('title') }
}

// /sourcing (S10-12 · docs/sub-specs/S10.md "หน้าจอ"): the RFx of the organization, newest first — kind, title, status
// (badge with icon and word), the close, how many suppliers were invited and how many sent a bid (never a price), who
// made it — filtered by status, category and kind with a plain GET form (it changes nothing). PROCUREMENT, FINANCE,
// EXECUTIVE and AUDITOR see every RFx; any other member only the RFx they evaluate, approve the award of or hold a line
// of (rfx-setup.ts). The button "เปิด RFx" only for sourcing.manage; rfx.create checks it again.

const GRID = 'md:grid md:grid-cols-[minmax(0,1.8fr)_minmax(0,0.9fr)_minmax(0,1fr)_7rem] md:items-start md:gap-4'
const one = (v: string | string[] | undefined): string => (Array.isArray(v) ? (v[0] ?? '') : (v ?? '')).slice(0, 60)

export default async function SourcingListPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const ctx = ctxFromSession(await getSession(), 'WEB', systemClock.now())
  if (!ctx) return null
  const params = await searchParams
  const filter = { status: one(params.status), kind: one(params.kind), category: one(params.category) }
  const [t, tCommon, locale] = await Promise.all([getTranslations('sourcing.list'), getTranslations('adminSettings'), getLocale().then(localeOf)])
  const read = await rfxList(ctx, filter)
  if (!read.ok) return <NoAccess title={t('title')} message={read.error.code === 'MODULE_DISABLED' ? t('moduleOff') : tCommon('forbidden')} homeLabel={tCommon('homeLink')} />
  const { rows, categories, canManage } = read.data
  const filtered = Boolean(filter.status || filter.kind || filter.category)
  const newButton = canManage ? (
    <Button asChild className="min-h-11 lg:min-h-10">
      <Link href="/sourcing/new">{t('new')}</Link>
    </Button>
  ) : null

  return (
    <Page>
      <PageHeader title={t('title')} intro={t('intro')} actions={newButton} />
      <PageBody>
        <div className="flex flex-col gap-4 lg:gap-6">
          <FilterBar
            key={JSON.stringify(filter)}
            action="/sourcing"
            label={t('filter.title')}
            submit={t('filter.submit')}
            footer={<FilterSummary count={t('count', { count: rows.length })} clear={filtered ? { href: '/sourcing', label: t('filter.clear') } : null} />}
          >
            <FilterSelect id="rfx-status" name="status" label={t('filter.status')} all={t('filter.all')} defaultValue={isRfxStatus(filter.status) ? filter.status : ''} options={RFX_STATUSES.map((s) => ({ value: s, label: t(`status.${s}`) }))} />
            <FilterSelect id="rfx-category" name="category" label={t('filter.category')} all={t('filter.all')} defaultValue={filter.category} options={categories.map((c) => ({ value: c, label: c }))} />
            <FilterSelect id="rfx-kind" name="kind" label={t('filter.kind')} all={t('filter.all')} defaultValue={isRfxKind(filter.kind) ? filter.kind : ''} options={RFX_KINDS.map((k) => ({ value: k, label: t(`kind.${k}`) }))} />
          </FilterBar>

          <Panel label={t('title')}>
            {rows.length ? (
              <div className="flex flex-col">
                <div className={`hidden border-b border-line pb-2 text-sm text-ink-muted ${GRID}`} aria-hidden="true">
                  <span>{t('col.rfx')}</span>
                  <span>{t('col.status')}</span>
                  <span>{t('col.closes')}</span>
                  <span className="text-right">{t('col.bids')}</span>
                </div>
                <ul aria-label={t('listLabel')} className="flex flex-col divide-y divide-line">
                  {rows.map((r) => {
                    const status = isRfxStatus(r.status) ? r.status : 'DRAFT'
                    const title = locale === 'en' && r.titleEn ? r.titleEn : r.title
                    return (
                      <li key={r.id} className={`flex flex-col gap-1.5 py-3 ${GRID}`}>
                        <div className="flex min-w-0 flex-col">
                          <Link href={`/sourcing/${r.id}`} className="font-semibold break-words text-primary underline underline-offset-4 hover:no-underline">
                            {r.number ? t('rowTitle', { number: r.number, title }) : title}
                          </Link>
                          <span className="text-base break-words text-ink-muted md:text-sm">{t('rowMeta', { kind: isRfxKind(r.kind) ? t(`kind.${r.kind}`) : r.kind, category: r.categoryCode })}</span>
                          <span className="text-base break-words text-ink-muted md:text-sm">{t('rowBy', { name: locale === 'en' && r.createdBy.en ? r.createdBy.en : r.createdBy.th, time: when(locale, r.createdAt) })}</span>
                        </div>
                        <div>
                          <span className="sr-only">{t('col.status')}: </span>
                          <StatusBadge look={RFX_STATUS_LOOK[status]} label={t(`status.${status}`)} className="text-base md:text-sm" />
                        </div>
                        <p className="text-ink">
                          <span className="text-ink-muted md:sr-only">{t('col.closes')}: </span>
                          {r.closesAt ? when(locale, r.closesAt) : t('notOpened')}
                        </p>
                        <p className="text-ink md:text-right">
                          <span className="text-ink-muted md:sr-only">{t('col.bids')}: </span>
                          <span className="tabular">{t('bids', { bids: r.bidCount, invites: r.inviteCount })}</span>
                        </p>
                      </li>
                    )
                  })}
                </ul>
              </div>
            ) : filtered ? (
              <ListEmpty
                title={t('noMatch')}
                hint={t('noMatchHint')}
                actions={
                  <Button asChild variant="outline" className="min-h-11 lg:min-h-10">
                    <Link href="/sourcing">{t('filter.clear')}</Link>
                  </Button>
                }
              />
            ) : (
              <ListEmpty title={t('empty')} hint={canManage ? t('emptyHintManage') : t('emptyHint')} actions={newButton} />
            )}
          </Panel>
        </div>
      </PageBody>
    </Page>
  )
}
