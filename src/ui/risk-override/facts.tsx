import { getLocale, getTranslations } from 'next-intl/server'
import { formatSatang } from '@/core/money/format'
import { formatEnglishBeDate, formatThaiDate } from '@/core/thai'
import { Facts, type Fact } from '@/ui/request-view/facts'
import { TierBadge } from '../risk-review/badges'

// What an approver decides a risk override on (S11-08 · FR-RSK-203 AC2 · BR-RSK-11), on /risk/overrides/[id] and the
// task page of the web and the app: the supplier and its code, the tier and where it comes from (the screening of the
// work, or the supplier's assessment), how far its assessment is (none · being answered x of n · valid until · lapsed),
// the registry flag, the cap with VAT that counts every PO it lets out, the last day, the PO it names (or every PO of the
// supplier), the reason, who asked and when. The LIFF summary is src/ui/liff/tasks/subjects/risk-override.tsx.

/** The view the pages read (riskOverrideView of src/server/services/risk/overrides.ts has this shape) */
export interface RiskOverrideFactsView {
  readonly number: string | null
  readonly supplier: { readonly code: string; readonly nameTh: string; readonly registryFlag: 'NONE' | 'CEASED' | 'VAT_CANCELLED' | 'NOT_FOUND' }
  readonly po: { readonly number: string | null; readonly grossSatang: bigint } | null
  readonly reason: string
  readonly capGrossSatang: bigint
  readonly expiresOn: string
  readonly usedCount: number
  readonly usedGrossSatang: bigint
  readonly requestedBy: { readonly nameTh: string; readonly nameEn: string | null }
  readonly submittedAt: Date | null
  readonly tier: 'LOW' | 'MEDIUM' | 'HIGH' | null
  readonly tierSource: 'SCREENING' | 'ASSESSMENT' | null
  readonly assessment:
    | { readonly state: 'NONE' }
    | { readonly state: 'IN_PROGRESS'; readonly number: string | null; readonly answered: number; readonly total: number }
    | { readonly state: 'CURRENT' | 'OVERDUE'; readonly number: string | null; readonly validUntil: string }
}

export async function RiskOverrideFacts({ view, used = false }: { view: RiskOverrideFactsView; used?: boolean }) {
  const [t, locale] = await Promise.all([getTranslations('risk.override.facts'), getLocale()])
  const day = (d: string | Date) => (locale === 'en' ? formatEnglishBeDate(d) : formatThaiDate(d))
  const a = view.assessment
  const assessment =
    a.state === 'NONE'
      ? t('assessment.NONE')
      : a.state === 'IN_PROGRESS'
        ? t('assessment.IN_PROGRESS', { number: a.number ?? '-', answered: a.answered, total: a.total })
        : t(`assessment.${a.state}`, { number: a.number ?? '-', date: day(a.validUntil) })
  const items: Fact[] = [
    { label: t('supplier'), value: `${view.supplier.code} ${view.supplier.nameTh}` },
    {
      label: t('tier'),
      value: view.tier ? (
        <span className="flex flex-wrap items-center gap-2">
          <TierBadge tier={view.tier} label={t(`tierName.${view.tier}`)} />
          {view.tierSource ? <span className="text-ink-muted">{t(`tierSource.${view.tierSource}`)}</span> : null}
        </span>
      ) : (
        t('tierNone')
      ),
    },
    { label: t('assessment.label'), value: assessment },
    { label: t('registry'), value: t(`registryFlag.${view.supplier.registryFlag}`) },
    { label: t('cap'), value: <span className="money font-semibold">{t('capValue', { amount: formatSatang(view.capGrossSatang) })}</span> },
    { label: t('expiresOn'), value: day(view.expiresOn) },
    { label: t('po'), value: view.po ? t('poValue', { number: view.po.number ?? t('poDraft'), amount: formatSatang(view.po.grossSatang) }) : t('poAll') },
    ...(used ? [{ label: t('used'), value: <span className="money">{t('usedValue', { count: view.usedCount, amount: formatSatang(view.usedGrossSatang) })}</span> }] : []),
    { label: t('reason'), value: <span className="break-words whitespace-pre-line">{view.reason}</span> },
    { label: t('requestedBy'), value: locale === 'en' && view.requestedBy.nameEn ? view.requestedBy.nameEn : view.requestedBy.nameTh },
    ...(view.submittedAt ? [{ label: t('submittedAt'), value: day(view.submittedAt) }] : []),
  ]
  return <Facts items={items} />
}
