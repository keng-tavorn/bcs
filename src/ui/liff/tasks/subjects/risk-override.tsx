import { getLocale, getTranslations } from 'next-intl/server'
import { formatSatang } from '@/core/money/format'
import { formatEnglishBeDate, formatThaiDate } from '@/core/thai'
import { LiffSection } from '../../content'

// The LIFF summary of an approval task on a risk override (S11-08 · FR-RSK-203 AC2 · BR-RSK-11 · ADR-052): the supplier,
// its tier and where it comes from, how far its assessment is, the registry flag, the cap with VAT (cumulative), the last
// day, the PO it names, the reason and who asked — no answer of the assessment. No workspace component: a plain list of
// label and value in the LIFF type sizes. The LIFF task page renders it with the view it read.

export interface LiffRiskOverrideView {
  readonly supplier: { readonly code: string; readonly nameTh: string; readonly registryFlag: 'NONE' | 'CEASED' | 'VAT_CANCELLED' | 'NOT_FOUND' }
  readonly po: { readonly number: string | null; readonly grossSatang: bigint } | null
  readonly reason: string
  readonly capGrossSatang: bigint
  readonly expiresOn: string
  readonly requestedBy: { readonly nameTh: string; readonly nameEn: string | null }
  readonly tier: 'LOW' | 'MEDIUM' | 'HIGH' | null
  readonly tierSource: 'SCREENING' | 'ASSESSMENT' | null
  readonly assessment:
    | { readonly state: 'NONE' }
    | { readonly state: 'IN_PROGRESS'; readonly number: string | null; readonly answered: number; readonly total: number }
    | { readonly state: 'CURRENT' | 'OVERDUE'; readonly number: string | null; readonly validUntil: string }
}

export async function LiffRiskOverrideSummary({ override }: { override: LiffRiskOverrideView | null }) {
  if (!override) return null
  const [t, locale] = await Promise.all([getTranslations('risk.override.facts'), getLocale()])
  const day = (d: string) => (locale === 'en' ? formatEnglishBeDate(d) : formatThaiDate(d))
  const a = override.assessment
  const rows = [
    { label: t('supplier'), value: `${override.supplier.code} ${override.supplier.nameTh}` },
    { label: t('tier'), value: override.tier ? `${t(`tierName.${override.tier}`)}${override.tierSource ? ` · ${t(`tierSource.${override.tierSource}`)}` : ''}` : t('tierNone') },
    {
      label: t('assessment.label'),
      value:
        a.state === 'NONE'
          ? t('assessment.NONE')
          : a.state === 'IN_PROGRESS'
            ? t('assessment.IN_PROGRESS', { number: a.number ?? '-', answered: a.answered, total: a.total })
            : t(`assessment.${a.state}`, { number: a.number ?? '-', date: day(a.validUntil) }),
    },
    { label: t('registry'), value: t(`registryFlag.${override.supplier.registryFlag}`) },
    { label: t('cap'), value: t('capValue', { amount: formatSatang(override.capGrossSatang) }) },
    { label: t('expiresOn'), value: day(override.expiresOn) },
    { label: t('po'), value: override.po ? t('poValue', { number: override.po.number ?? t('poDraft'), amount: formatSatang(override.po.grossSatang) }) : t('poAll') },
    { label: t('reason'), value: override.reason },
    { label: t('requestedBy'), value: locale === 'en' && override.requestedBy.nameEn ? override.requestedBy.nameEn : override.requestedBy.nameTh },
  ]
  return (
    <LiffSection id="risk-override-summary" title={t('heading')}>
      <dl className="flex flex-col gap-3">
        {rows.map((r) => (
          <div key={r.label} className="flex flex-col">
            <dt className="text-ink-muted">{r.label}</dt>
            <dd className="tabular break-words whitespace-pre-line text-ink">{r.value}</dd>
          </div>
        ))}
      </dl>
    </LiffSection>
  )
}
