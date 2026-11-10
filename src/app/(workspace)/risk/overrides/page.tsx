import Link from 'next/link'
import { getLocale, getTranslations } from 'next-intl/server'
import { formatSatang } from '@/core/money/format'
import { systemClock } from '@/lib/clock'
import { ctxFromSession } from '@/server/auth/session'
import { listRiskOverrides, type OverrideListFilter } from '@/server/services/risk'
import { NoAccess } from '@/ui/admin-settings/no-access'
import { StatusBadge } from '@/ui/document/badges'
import { ListEmpty, Page, PageBody, PageHeader, Panel } from '@/ui/page/page'
import { ReviewTabs } from '@/ui/risk-review/review-tabs'
import { OVERRIDE_BADGES, type OverrideStatus } from '@/ui/risk-override/model'
import { getSession } from '../../../_lib/session'
import { day, localeOf } from '../../_tracking/present'

export async function generateMetadata() {
  const t = await getTranslations('risk.override.list')
  return { title: t('title') }
}

// /risk/overrides (S11-08 · FR-RSK-203 AC2 AC3 · BR-RSK-10): the organization's overrides of the risk gate — open ones
// (asked, sent, returned), approved ones and the closed ones, each with its supplier, the PO it names (or every PO of the
// supplier), its cap with VAT and how much of it POs already took, its last day and its state. Whoever reads the risk
// files sees the list (risk.assessment.view); PROCUREMENT asks for one from a supplier's PO (the PO page's band) — the
// list's button opens the form for a supplier picked there. Approvers decide on /tasks.

const TABS: readonly { key: 'open' | 'approved' | 'closed' | 'all'; filter: OverrideListFilter }[] = [
  { key: 'open', filter: 'OPEN' },
  { key: 'approved', filter: 'APPROVED' },
  { key: 'closed', filter: 'CLOSED' },
  { key: 'all', filter: 'ALL' },
]

export default async function RiskOverridesPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const ctx = ctxFromSession(await getSession(), 'WEB', systemClock.now())
  if (!ctx) return null
  const wanted = (await searchParams).tab
  const tab = TABS.find((x) => x.key === (Array.isArray(wanted) ? wanted[0] : wanted)) ?? TABS[0]!
  const [t, tAdmin, tCommon, locale] = await Promise.all([getTranslations('risk.override'), getTranslations('risk.admin'), getTranslations('adminSettings'), getLocale().then(localeOf)])
  const listed = await listRiskOverrides(ctx, tab.filter)
  if (!listed.ok) return <NoAccess title={t('list.title')} message={listed.error.code === 'MODULE_DISABLED' ? tAdmin('moduleOff') : tCommon('forbidden')} homeLabel={tCommon('homeLink')} />
  const rows = listed.data.items

  return (
    <Page>
      <PageHeader title={t('list.title')} intro={t('list.intro')} />
      <PageBody>
        <Panel label={t('list.tabs')}>
          <ReviewTabs label={t('list.tabs')} current={tab.key} tabs={TABS.map((x) => ({ key: x.key, label: t(`list.tab.${x.key}`), href: x.key === 'open' ? '/risk/overrides' : `/risk/overrides?tab=${x.key}` }))}>
            {rows.length ? (
              <ul aria-label={t(`list.tab.${tab.key}`)} className="flex flex-col divide-y divide-line">
                {rows.map((r) => (
                  <li key={r.id} className="flex flex-col gap-1.5 py-3">
                    <div className="flex min-w-0 flex-col">
                      <Link href={`/risk/overrides/${r.id}`} className="font-semibold break-words text-primary underline underline-offset-4 hover:no-underline">
                        {t('list.row', { number: r.number ?? t('list.draft'), supplier: `${r.supplier.code} ${r.supplier.nameTh}` })}
                      </Link>
                      <span className="text-ink-muted">{r.poNumber ? t('list.forPo', { number: r.poNumber }) : t('list.forSupplier')}</span>
                    </div>
                    <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
                      <StatusBadge look={OVERRIDE_BADGES[r.status as OverrideStatus]} label={t(`status.${r.status as OverrideStatus}`)} className="text-base md:text-sm" />
                      <span className="money text-ink">{t('list.cap', { cap: formatSatang(r.capGrossSatang), used: formatSatang(r.usedGrossSatang) })}</span>
                      <span className="text-ink-muted">{t('list.until', { date: day(locale, r.expiresOn) })}</span>
                      <span className="text-ink-muted">{t('list.by', { name: locale === 'en' && r.requestedBy.nameEn ? r.requestedBy.nameEn : r.requestedBy.nameTh })}</span>
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <ListEmpty title={t('list.empty')} hint={listed.data.canRequest ? t('list.emptyHintRequest') : t('list.emptyHint')} />
            )}
          </ReviewTabs>
        </Panel>
      </PageBody>
    </Page>
  )
}
