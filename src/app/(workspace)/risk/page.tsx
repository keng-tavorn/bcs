import Link from 'next/link'
import { getLocale, getTranslations } from 'next-intl/server'
import { systemClock } from '@/lib/clock'
import { ctxFromSession } from '@/server/auth/session'
import { riskOverview, type RiskOverview } from '@/server/services/risk'
import { NoAccess } from '@/ui/admin-settings/no-access'
import { cn } from '@/ui/cn'
import { StatusBadge } from '@/ui/document/badges'
import { ListEmpty, Page, PageBody, PageHeader, Panel } from '@/ui/page/page'
import { isSupplierRiskStatus, SUPPLIER_RISK_BADGES, SUPPLIER_RISK_STATUSES } from '@/ui/risk-file/model'
import { OVERRIDE_BADGES, type OverrideStatus } from '@/ui/risk-override/model'
import { TierBadge } from '@/ui/risk-review/badges'
import { ReviewTabs } from '@/ui/risk-review/review-tabs'
import { buttonVariants } from '@/ui/shadcn/button'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/ui/shadcn/table'
import { getSession } from '../../_lib/session'
import { day, localeOf, type Locale } from '../_tracking/present'

export async function generateMetadata() {
  const t = await getTranslations('risk.overview')
  return { title: t('title') }
}

// /risk (S11-10 · docs/sub-specs/S11.md "หน้าจอ" · BR-RSK-14): the organization's supplier risk at a glance for whoever
// reads the risk files (risk.assessment.view: PROCUREMENT FINANCE EXECUTIVE AUDITOR) — in tabs kept in the address: the
// suppliers that need attention (due soon, overdue, to reassess) or those of the tier and status filtered for, the
// assessments still open, the reviewers' slots still open, the reassessments still open and the overrides being asked
// for or running out. The filters are links (a GET that changes nothing). Each supplier opens its risk file.

const TABS = ['suppliers', 'assessments', 'slots', 'reviews', 'overrides'] as const
type Tab = (typeof TABS)[number]
const TIERS = ['HIGH', 'MEDIUM', 'LOW'] as const
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)
// a filter is a link (a GET), drawn as shadcn's button: filled when chosen, outlined when not
const chip = (active: boolean) => cn(buttonVariants({ variant: active ? 'default' : 'outline' }), 'min-h-11 md:min-h-9')
const rowLink = 'font-semibold break-words text-primary underline underline-offset-4 hover:no-underline'

function hrefOf(tab: Tab, filter: { tier: string | null; status: string | null }) {
  const q = new URLSearchParams()
  if (tab !== 'suppliers') q.set('tab', tab)
  if (filter.tier) q.set('tier', filter.tier)
  if (filter.status) q.set('status', filter.status)
  const s = q.toString()
  return s ? `/risk?${s}` : '/risk'
}

export default async function RiskOverviewPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const ctx = ctxFromSession(await getSession(), 'WEB', systemClock.now())
  if (!ctx) return null
  const query = await searchParams
  const tab: Tab = TABS.find((x) => x === one(query.tab)) ?? 'suppliers'
  const [t, tAdmin, tCommon, locale] = await Promise.all([getTranslations('risk.overview'), getTranslations('risk.admin'), getTranslations('adminSettings'), getLocale().then(localeOf)])
  const view = await riskOverview(ctx, { tier: one(query.tier), status: one(query.status) })
  if (!view.ok) return <NoAccess title={t('title')} message={view.error.code === 'MODULE_DISABLED' ? tAdmin('moduleOff') : tCommon('forbidden')} homeLabel={tCommon('homeLink')} />
  const v = view.data
  const counts: Record<Tab, number> = { suppliers: v.counts.suppliers, assessments: v.counts.openAssessments, slots: v.counts.openSlots, reviews: v.counts.openReviews, overrides: v.counts.overrides }

  return (
    <Page>
      <PageHeader title={t('title')} intro={t('intro')} />
      <PageBody>
        <Panel label={t('tabs')}>
          <ReviewTabs label={t('tabs')} current={tab} tabs={TABS.map((key) => ({ key, label: `${t(`tab.${key}`)} (${counts[key]})`, href: hrefOf(key, v.filter) }))}>
            {tab === 'suppliers' ? <Suppliers v={v} locale={locale} /> : null}
            {tab === 'assessments' ? <Assessments v={v} locale={locale} /> : null}
            {tab === 'slots' ? <Slots v={v} locale={locale} /> : null}
            {tab === 'reviews' ? <Reviews v={v} locale={locale} /> : null}
            {tab === 'overrides' ? <Overrides v={v} locale={locale} /> : null}
          </ReviewTabs>
        </Panel>
      </PageBody>
    </Page>
  )
}

async function More({ shown, total }: { shown: number; total: number }) {
  const t = await getTranslations('risk.overview')
  return shown < total ? <p className="text-ink-muted">{t('more', { shown, total })}</p> : null
}

async function Suppliers({ v, locale }: { v: RiskOverview; locale: Locale }) {
  const [t, tAdmin, tRisk] = await Promise.all([getTranslations('risk.overview'), getTranslations('risk.admin'), getTranslations('risk')])
  const filter = v.filter
  const tierBadge = (tier: (typeof TIERS)[number] | null) => (tier ? <TierBadge tier={tier} label={tAdmin(`tierName.${tier}`)} /> : <span className="text-ink-muted">{t('noTier')}</span>)
  const statusBadge = (status: string) => <StatusBadge look={isSupplierRiskStatus(status) ? SUPPLIER_RISK_BADGES[status] : undefined} label={tRisk(`supplierStatus.${status}` as 'supplierStatus.CURRENT')} />
  return (
    <div className="flex flex-col gap-4">
      <nav aria-label={t('filters')} className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium">{t('filterTier')}</span>
          <Link href={hrefOf('suppliers', { tier: null, status: filter.status })} className={chip(!filter.tier)} aria-current={!filter.tier ? 'page' : undefined}>
            {t('all')}
          </Link>
          {TIERS.map((tier) => (
            <Link key={tier} href={hrefOf('suppliers', { tier, status: filter.status })} className={chip(filter.tier === tier)} aria-current={filter.tier === tier ? 'page' : undefined}>
              {tAdmin(`tierName.${tier}`)}
            </Link>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium">{t('filterStatus')}</span>
          <Link href={hrefOf('suppliers', { tier: filter.tier, status: null })} className={chip(!filter.status)} aria-current={!filter.status ? 'page' : undefined}>
            {filter.tier ? t('all') : t('attention')}
          </Link>
          {SUPPLIER_RISK_STATUSES.map((status) => (
            <Link key={status} href={hrefOf('suppliers', { tier: filter.tier, status })} className={chip(filter.status === status)} aria-current={filter.status === status ? 'page' : undefined}>
              {tRisk(`supplierStatus.${status}`)}
            </Link>
          ))}
        </div>
        {!filter.tier && !filter.status ? <p className="text-base text-ink-muted md:text-sm">{t('attentionHint')}</p> : null}
      </nav>
      {v.suppliers.length === 0 ? (
        <ListEmpty title={t('emptySuppliers')} />
      ) : (
        <>
          <ul aria-label={t('tab.suppliers')} className="flex flex-col divide-y divide-line md:hidden">
            {v.suppliers.map((s) => (
              <li key={s.id} className="flex flex-col gap-1.5 py-3">
                <Link href={`/risk/suppliers/${s.id}`} className={rowLink}>
                  {s.code} {locale === 'en' && s.nameEn ? s.nameEn : s.nameTh}
                </Link>
                <div className="flex flex-wrap items-center gap-2">
                  {tierBadge(s.tier)}
                  {statusBadge(s.status)}
                </div>
                {s.validUntil ? <span className="text-ink-muted">{`${t('columns.validUntil')} ${day(locale, s.validUntil)}`}</span> : null}
              </li>
            ))}
          </ul>
          <div className="hidden md:block">
            <Table aria-label={t('tab.suppliers')}>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('columns.supplier')}</TableHead>
                  <TableHead>{t('columns.tier')}</TableHead>
                  <TableHead>{t('columns.status')}</TableHead>
                  <TableHead>{t('columns.validUntil')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {v.suppliers.map((s) => (
                  <TableRow key={s.id}>
                    <TableCell className="whitespace-normal">
                      <Link href={`/risk/suppliers/${s.id}`} className={rowLink}>
                        {s.code} {locale === 'en' && s.nameEn ? s.nameEn : s.nameTh}
                      </Link>
                    </TableCell>
                    <TableCell>{tierBadge(s.tier)}</TableCell>
                    <TableCell>{statusBadge(s.status)}</TableCell>
                    <TableCell className="tabular">{s.validUntil ? day(locale, s.validUntil) : t('noDate')}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </>
      )}
      <More shown={v.suppliers.length} total={v.counts.suppliers} />
    </div>
  )
}

async function Assessments({ v, locale }: { v: RiskOverview; locale: Locale }) {
  const [t, tAdmin, tRisk] = await Promise.all([getTranslations('risk.overview'), getTranslations('risk.admin'), getTranslations('risk')])
  if (v.openAssessments.length === 0) return <ListEmpty title={t('emptyAssessments')} />
  return (
    <div className="flex flex-col gap-2">
      <ul aria-label={t('tab.assessments')} className="flex flex-col divide-y divide-line">
        {v.openAssessments.map((a) => (
          <li key={a.id} className="flex flex-col gap-1.5 py-3">
            <Link href={`/risk/assessments/${a.id}`} className={rowLink}>
              {t('assessmentRow', { number: a.number ?? '-', supplier: `${a.supplier.code} ${a.supplier.nameTh}` })}
            </Link>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
              <span>{tRisk(`assessment.status.${a.status}` as 'assessment.status.DRAFT')}</span>
              <TierBadge tier={a.inherentTier} label={tAdmin(`tierName.${a.inherentTier}`)} />
              <span className="text-ink-muted">{t('lastActivity', { date: day(locale, a.lastActivityAt) })}</span>
            </div>
          </li>
        ))}
      </ul>
      <More shown={v.openAssessments.length} total={v.counts.openAssessments} />
    </div>
  )
}

async function Slots({ v, locale }: { v: RiskOverview; locale: Locale }) {
  const [t, tAdmin] = await Promise.all([getTranslations('risk.overview'), getTranslations('risk.admin')])
  if (v.openSlots.length === 0) return <ListEmpty title={t('emptySlots')} hint={<Link href="/risk/reviews">{t('toReviews')}</Link>} />
  return (
    <div className="flex flex-col gap-2">
      <ul aria-label={t('tab.slots')} className="flex flex-col divide-y divide-line">
        {v.openSlots.map((x, i) => (
          <li key={`${x.assessmentId}-${i}`} className="flex flex-col gap-1 py-3">
            <Link href={`/risk/assessments/${x.assessmentId}`} className={rowLink}>
              {t('slotRow', { number: x.assessmentNumber ?? '-', supplier: x.supplierName })}
            </Link>
            <span className="text-ink-muted">{t('slotWho', { domains: x.riskDomains.map((d) => tAdmin(`domain.${d}`)).join(', '), name: x.reviewerName, date: day(locale, x.since) })}</span>
          </li>
        ))}
      </ul>
      <More shown={v.openSlots.length} total={v.counts.openSlots} />
    </div>
  )
}

async function Reviews({ v, locale }: { v: RiskOverview; locale: Locale }) {
  const [t, tFile, tAdmin] = await Promise.all([getTranslations('risk.overview'), getTranslations('risk.file'), getTranslations('risk.admin')])
  if (v.openReviews.length === 0) return <ListEmpty title={t('emptyReviews')} />
  return (
    <div className="flex flex-col gap-2">
      <ul aria-label={t('tab.reviews')} className="flex flex-col divide-y divide-line">
        {v.openReviews.map((r) => (
          <li key={r.id} className="flex flex-col gap-1.5 py-3">
            <Link href={`/risk/suppliers/${r.supplier.id}`} className={rowLink}>
              {t('reviewRow', { supplier: `${r.supplier.code} ${r.supplier.nameTh}`, reason: tFile(`reviewReason.${r.reason}` as 'reviewReason.SCHEDULED') })}
            </Link>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
              {r.tier ? <TierBadge tier={r.tier} label={tAdmin(`tierName.${r.tier}`)} /> : null}
              {r.registryFlag ? <span>{tFile(`registry.${r.registryFlag}` as 'registry.NONE')}</span> : null}
              <span className="text-ink-muted">{t('due', { date: day(locale, r.dueAt) })}</span>
            </div>
          </li>
        ))}
      </ul>
      <More shown={v.openReviews.length} total={v.counts.openReviews} />
    </div>
  )
}

async function Overrides({ v, locale }: { v: RiskOverview; locale: Locale }) {
  const [t, tOverride] = await Promise.all([getTranslations('risk.overview'), getTranslations('risk.override')])
  return (
    <div className="flex flex-col gap-2">
      {v.overrides.length === 0 ? (
        <ListEmpty title={t('emptyOverrides')} />
      ) : (
        <ul aria-label={t('tab.overrides')} className="flex flex-col divide-y divide-line">
          {v.overrides.map((o) => (
            <li key={o.id} className="flex flex-col gap-1.5 py-3">
              <Link href={`/risk/overrides/${o.id}`} className={rowLink}>
                {t('overrideRow', { number: o.number ?? '-', supplier: o.supplierName })}
              </Link>
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
                <StatusBadge look={OVERRIDE_BADGES[o.status as OverrideStatus]} label={tOverride(`status.${o.status as OverrideStatus}`)} />
                {o.expiringSoon ? <span className="font-medium text-warn">{t('expiring')}</span> : null}
                <span className="text-ink-muted">{tOverride('list.until', { date: day(locale, o.expiresOn) })}</span>
              </div>
            </li>
          ))}
        </ul>
      )}
      <More shown={v.overrides.length} total={v.counts.overrides} />
      <Link href="/risk/overrides" className="inline-flex min-h-11 items-center self-start font-medium text-primary underline underline-offset-4 hover:no-underline">
        {t('toOverrides')}
      </Link>
    </div>
  )
}
