import Link from 'next/link'
import { getLocale, getTranslations } from 'next-intl/server'
import { systemClock } from '@/lib/clock'
import { ctxFromSession } from '@/server/auth/session'
import { consolidationSchedule, poolOptions, type NextRoundDto, type RoundDto } from '@/server/queries/procurement'
import { listPool, type PoolFilter } from '@/server/services/procurement'
import { Button } from '@/ui/form/button'
import { Notice } from '@/ui/form/notice'
import { ConsolidatePanel } from '@/ui/procurement/consolidate-panel'
import { PoolBoard } from '@/ui/procurement/pool-board'
import { getSession } from '../../../_lib/session'
import { localeOf, when, type Locale } from '../../_tracking/present'
import { assignSupplierAction, consolidateNowAction } from './actions'
import { poolCounts, requestsOf, type PoolT } from './present'

export async function generateMetadata() {
  const t = await getTranslations('procurement.pool')
  return { title: t('metaTitle') }
}

const linkClass = 'inline-flex min-h-11 items-center self-start font-medium text-primary underline underline-offset-4 hover:no-underline'
const selectClass = 'h-11 w-full rounded-md border border-input bg-bg px-3 text-base text-ink'
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
/** The age filter's choices, in whole days since approval */
const AGES = [1, 3, 7] as const

function filterOf(params: Record<string, string | string[] | undefined>): PoolFilter {
  const supplier = one(params.supplier) ?? ''
  const site = one(params.site) ?? ''
  const urgency = one(params.urgency) ?? ''
  const age = Number(one(params.age) ?? '')
  return {
    ...(supplier === 'NONE' || UUID.test(supplier) ? { supplierId: supplier } : {}),
    ...(UUID.test(site) ? { deliverySiteId: site } : {}),
    ...(urgency === 'NORMAL' || urgency === 'URGENT' ? { urgency } : {}),
    ...((AGES as readonly number[]).includes(age) ? { minAgeDays: age } : {}),
  }
}

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
export default async function PoolPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const ctx = ctxFromSession(await getSession(), 'WEB', systemClock.now())
  if (!ctx) return null
  const params = await searchParams
  const filter = filterOf(params)
  const filtered = Object.keys(filter).length > 0
  const [t, locale] = await Promise.all([getTranslations('procurement.pool'), getLocale().then(localeOf)])

  const pool = await listPool(ctx, filter)
  if (!pool.ok) {
    return (
      <div className="flex max-w-2xl flex-col gap-6">
        <h1 className="text-2xl font-semibold">{t('title')}</h1>
        <Notice tone="danger">{t('forbidden')}</Notice>
        <Link href="/" className={linkClass}>
          {t('homeLink')}
        </Link>
      </div>
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
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex max-w-3xl flex-col gap-1">
          <h1 className="text-2xl font-semibold">{t('title')}</h1>
          <p className="text-ink-muted">{t('intro')}</p>
        </div>
        <Link href="/procurement/pos" className={linkClass}>
          {t('posLink')}
        </Link>
      </div>

      <div className="flex flex-col gap-8 lg:grid lg:grid-cols-[minmax(0,1fr)_22rem] lg:grid-rows-[auto_1fr] lg:items-start lg:gap-x-10">
        <div className="lg:col-start-2 lg:row-start-1">
          <ConsolidatePanel next={nextText(t, locale, schedule.next)} ready={counts.ready} blocked={counts.blocked} consolidate={consolidateNowAction} />
        </div>

        <div className="flex min-w-0 flex-col gap-4 lg:col-start-1 lg:row-span-2 lg:row-start-1">
          {total > 0 ? (
            // A new filter remounts the form, so its fields show the filter in effect (defaultValue applies on mount only)
            <form key={JSON.stringify(filter)} method="get" action="/procurement/pool" aria-labelledby="pool-filter" className="flex flex-col gap-3 border-y border-line py-4">
              <h2 id="pool-filter" className="text-lg font-semibold text-ink">
                {t('filter.title')}
              </h2>
              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                <div className="flex flex-col gap-1.5">
                  <label htmlFor="pool-supplier" className="font-medium text-ink">
                    {t('filter.supplier')}
                  </label>
                  <select id="pool-supplier" name="supplier" defaultValue={filter.supplierId ?? ''} className={selectClass}>
                    <option value="">{t('filter.supplierAll')}</option>
                    <option value="NONE">{t('filter.supplierNone')}</option>
                    {options.suppliers.map((s) => (
                      <option key={s.id} value={s.id}>
                        {`${s.code} · ${s.nameTh}`}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="flex flex-col gap-1.5">
                  <label htmlFor="pool-site" className="font-medium text-ink">
                    {t('filter.site')}
                  </label>
                  <select id="pool-site" name="site" defaultValue={filter.deliverySiteId ?? ''} className={selectClass}>
                    <option value="">{t('filter.siteAll')}</option>
                    {options.sites.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.nameTh}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="flex flex-col gap-1.5">
                  <label htmlFor="pool-urgency" className="font-medium text-ink">
                    {t('filter.urgency')}
                  </label>
                  <select id="pool-urgency" name="urgency" defaultValue={filter.urgency ?? ''} className={selectClass}>
                    <option value="">{t('filter.urgencyAll')}</option>
                    <option value="NORMAL">{t('urgency.NORMAL')}</option>
                    <option value="URGENT">{t('urgency.URGENT')}</option>
                  </select>
                </div>
                <div className="flex flex-col gap-1.5">
                  <label htmlFor="pool-age" className="font-medium text-ink">
                    {t('filter.age')}
                  </label>
                  <select id="pool-age" name="age" defaultValue={filter.minAgeDays !== undefined ? String(filter.minAgeDays) : ''} className={selectClass}>
                    <option value="">{t('filter.ageAll')}</option>
                    {AGES.map((days) => (
                      <option key={days} value={days}>
                        {t('filter.ageDays', { days })}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
                <Button type="submit" variant="secondary">
                  {t('filter.submit')}
                </Button>
                {filtered ? (
                  <Link href="/procurement/pool" className={linkClass}>
                    {t('filter.clear')}
                  </Link>
                ) : null}
              </div>
            </form>
          ) : null}

          {requests.length ? (
            <>
              <p className="text-ink" role="status">
                {t('count', { lines: pool.data.length, requests: requests.length })}
              </p>
              <PoolBoard
                requests={requests}
                suppliers={options.suppliers.map((s) => ({ id: s.id, label: `${s.code} · ${s.nameTh}` }))}
                assign={assignSupplierAction}
              />
            </>
          ) : total === 0 ? (
            <div className="flex flex-col gap-2 border-y border-line py-6">
              <p className="font-medium text-ink">{t('empty')}</p>
              <p className="text-ink-muted">{t('emptyHint')}</p>
              <Link href="/procurement/pos" className={linkClass}>
                {t('emptyLink')}
              </Link>
            </div>
          ) : (
            <div className="flex flex-col gap-2 border-y border-line py-6">
              <p className="font-medium text-ink">{t('noMatch')}</p>
              <p className="text-ink-muted">{t('noMatchHint')}</p>
              <Link href="/procurement/pool" className={linkClass}>
                {t('filter.clear')}
              </Link>
            </div>
          )}
        </div>

        <section aria-labelledby="pool-rounds" className="flex flex-col gap-3 lg:col-start-2 lg:row-start-2">
          <h2 id="pool-rounds" className="text-lg font-semibold text-ink">
            {t('rounds.title')}
          </h2>
          {schedule.recent.length ? (
            <ul aria-label={t('rounds.label')} className="flex flex-col divide-y divide-line border-y border-line">
              {schedule.recent.map((round) => (
                <li key={round.id} className="flex flex-col gap-0.5 py-2.5">
                  <p className="font-medium text-ink">{roundTitle(t, locale, round)}</p>
                  <p className="text-base text-ink-muted md:text-sm">{round.drafts.length ? t('rounds.drafts', { count: round.drafts.length }) : t('rounds.noDrafts')}</p>
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
        </section>
      </div>
    </div>
  )
}
