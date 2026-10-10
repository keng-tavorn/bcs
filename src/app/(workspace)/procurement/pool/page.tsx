import Link from 'next/link'
import { getLocale, getTranslations } from 'next-intl/server'
import { systemClock } from '@/lib/clock'
import { ctxFromSession } from '@/server/auth/session'
import { consolidationSchedule, poolOptions, type NextRoundDto, type RoundDto } from '@/server/queries/procurement'
import { listPool } from '@/server/services/procurement'
import { Notice } from '@/ui/form/notice'
import { FilterBar, FilterSelect, FilterSummary } from '@/ui/page/filters'
import { ListEmpty, Page, PageBody, PageHeader, Panel } from '@/ui/page/page'
import { ConsolidatePanel } from '@/ui/procurement/consolidate-panel'
import { PoolBoard } from '@/ui/procurement/pool-board'
import { Button } from '@/ui/shadcn/button'
import { getSession } from '../../../_lib/session'
import { localeOf, when, type Locale } from '../../_tracking/present'
import { loadPoolFilters, POOL_AGES, poolFilterOf } from './_filters'
import { assignSupplierAction, consolidateNowAction } from './actions'
import { poolCounts, requestsOf, type PoolT } from './present'

export async function generateMetadata() {
  const t = await getTranslations('procurement.pool')
  return { title: t('metaTitle') }
}

const linkClass = 'inline-flex min-h-11 items-center self-start font-medium text-primary underline underline-offset-4 hover:no-underline'

function nextText(t: PoolT, locale: Locale, next: NextRoundDto): string {
  if (next.kind === 'AT') return t('round.next', { time: when(locale, next.at) })
  return next.kind === 'CRON_INVALID' ? t('round.cronInvalid') : t('round.none')
}

function roundTitle(t: PoolT, locale: Locale, round: RoundDto): string {
  const time = when(locale, round.ranAt)
  if (round.trigger === 'MANUAL') return round.by ? t('rounds.MANUAL', { name: locale === 'en' && round.by.name.en ? round.by.name.en : round.by.name.th, time }) : t('rounds.MANUAL_UNKNOWN', { time })
  return t(`rounds.${round.trigger}`, { time })
}

// The procurement pool (spec §9.1 /procurement/pool, FR-P2P-001, FR-P2P-002): approved request lines nobody has ordered,
// grouped by request, filtered by supplier, delivery site, urgency and age with a plain GET form (it changes nothing);
// choosing the supplier of many lines at once; "รวมเป็นร่าง PO ตอนนี้" with when the next automatic round runs and the
// rounds that ran last. listPool checks procurement.pool.view before anything is read (§2.4: PROCUREMENT only).
// The page's frame (S16-10): the filters (in the address, ./_filters.ts) and the pool in white cards on the left, the
// round and the rounds that ran on the right.
export default async function PoolPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const ctx = ctxFromSession(await getSession(), 'WEB', systemClock.now())
  if (!ctx) return null
  const filter = poolFilterOf(await loadPoolFilters(searchParams))
  const filtered = Object.keys(filter).length > 0
  const [t, locale] = await Promise.all([getTranslations('procurement.pool'), getLocale().then(localeOf)])

  const pool = await listPool(ctx, filter)
  if (!pool.ok) {
    return (
      <Page>
        <PageHeader title={t('title')} />
        <div className="flex max-w-2xl flex-col gap-3">
          <Notice tone="danger">{t('forbidden')}</Notice>
          <Link href="/" className={linkClass}>
            {t('homeLink')}
          </Link>
        </div>
      </Page>
    )
  }
  const [everything, options, schedule] = await Promise.all([filtered ? listPool(ctx) : Promise.resolve(pool), poolOptions(ctx), consolidationSchedule(ctx)])
  const all = everything.ok ? everything.data : pool.data
  const total = all.length
  // The round panel counts the whole pool, whatever the filter shows
  const counts = poolCounts(all)
  const supplierName = (id: string | null) => (id ? (options.suppliers.find((s) => s.id === id)?.nameTh ?? null) : null)
  const requests = requestsOf(t, locale, pool.data, supplierName)

  return (
    <Page>
      <PageHeader
        title={t('title')}
        intro={t('intro')}
        actions={
          <Button asChild variant="outline" className="min-h-11 lg:min-h-10">
            <Link href="/procurement/pos">{t('posLink')}</Link>
          </Button>
        }
      />
      <PageBody>
        <div className="flex flex-col gap-4 lg:grid lg:grid-cols-[minmax(0,1fr)_22rem] lg:grid-rows-[auto_1fr] lg:items-start lg:gap-6">
          <div className="lg:col-start-2 lg:row-start-1">
            <Panel>
              <ConsolidatePanel next={nextText(t, locale, schedule.next)} ready={counts.ready} blocked={counts.blocked} consolidate={consolidateNowAction} />
            </Panel>
          </div>

          <div className="flex min-w-0 flex-col gap-4 lg:col-start-1 lg:row-span-2 lg:row-start-1 lg:gap-6">
            {total > 0 ? (
              // A new filter remounts the form, so its fields show the filter in effect (defaultValue applies on mount only)
              <FilterBar
                key={JSON.stringify(filter)}
                action="/procurement/pool"
                label={t('filter.title')}
                submit={t('filter.submit')}
                footer={
                  <FilterSummary
                    count={t('count', { lines: pool.data.length, requests: requests.length })}
                    clear={filtered ? { href: '/procurement/pool', label: t('filter.clear') } : null}
                  />
                }
              >
                <FilterSelect
                  id="pool-supplier"
                  name="supplier"
                  label={t('filter.supplier')}
                  all={t('filter.supplierAll')}
                  defaultValue={filter.supplierId ?? ''}
                  options={[{ value: 'NONE', label: t('filter.supplierNone') }, ...options.suppliers.map((s) => ({ value: s.id, label: `${s.code} · ${s.nameTh}` }))]}
                />
                <FilterSelect
                  id="pool-site"
                  name="site"
                  label={t('filter.site')}
                  all={t('filter.siteAll')}
                  defaultValue={filter.deliverySiteId ?? ''}
                  options={options.sites.map((s) => ({ value: s.id, label: s.nameTh }))}
                />
                <FilterSelect
                  id="pool-urgency"
                  name="urgency"
                  label={t('filter.urgency')}
                  all={t('filter.urgencyAll')}
                  defaultValue={filter.urgency ?? ''}
                  options={[
                    { value: 'NORMAL', label: t('urgency.NORMAL') },
                    { value: 'URGENT', label: t('urgency.URGENT') },
                  ]}
                />
                <FilterSelect
                  id="pool-age"
                  name="age"
                  label={t('filter.age')}
                  all={t('filter.ageAll')}
                  defaultValue={filter.minAgeDays !== undefined ? String(filter.minAgeDays) : ''}
                  options={POOL_AGES.map((days) => ({ value: String(days), label: t('filter.ageDays', { days }) }))}
                />
              </FilterBar>
            ) : null}

            {/* The board keeps its supplier bar in view while the list scrolls: the card lets it stick (overflow visible) */}
            <Panel label={t('title')} className="overflow-visible">
              {requests.length ? (
                <PoolBoard requests={requests} suppliers={options.suppliers.map((s) => ({ id: s.id, label: `${s.code} · ${s.nameTh}` }))} assign={assignSupplierAction} />
              ) : total === 0 ? (
                <ListEmpty
                  title={t('empty')}
                  hint={t('emptyHint')}
                  actions={
                    <Button asChild variant="outline" className="min-h-11 lg:min-h-10">
                      <Link href="/procurement/pos">{t('emptyLink')}</Link>
                    </Button>
                  }
                />
              ) : (
                <ListEmpty
                  title={t('noMatch')}
                  hint={t('noMatchHint')}
                  actions={
                    <Button asChild variant="outline" className="min-h-11 lg:min-h-10">
                      <Link href="/procurement/pool">{t('filter.clear')}</Link>
                    </Button>
                  }
                />
              )}
            </Panel>
          </div>

          <div className="lg:col-start-2 lg:row-start-2">
            <Panel title={t('rounds.title')} id="pool-rounds">
              {schedule.recent.length ? (
                <ul aria-label={t('rounds.label')} className="flex flex-col divide-y divide-line">
                  {schedule.recent.map((round) => (
                    <li key={round.id} className="flex flex-col gap-0.5 py-2.5 first:pt-0">
                      <p className="font-medium text-ink">{roundTitle(t, locale, round)}</p>
                      {/* What the round did: body text at the body's size, as the round's own notice says it (§9.9: 15 px on the web) */}
                      <p className="text-ink-muted">{round.drafts.length ? t('rounds.drafts', { count: round.drafts.length }) : t('rounds.noDrafts')}</p>
                      {round.drafts.map((d) => (
                        <Link key={d.id} href={`/procurement/pos/${d.id}`} className="inline-flex min-h-11 items-center self-start font-medium break-words text-primary underline underline-offset-4 hover:no-underline">
                          {t('rounds.draftLink', { label: d.number ?? t('rounds.draftLabel'), supplier: d.supplierName, site: d.siteName ?? t('round.draftNoSite'), kind: t(`kind.${d.kind}`) })}
                        </Link>
                      ))}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-ink-muted">{t('rounds.empty')}</p>
              )}
            </Panel>
          </div>
        </div>
      </PageBody>
    </Page>
  )
}
