import { getTranslations } from 'next-intl/server'
import { amountToSatang } from '@/core/money/dto'
import { formatSatang } from '@/core/money/format'
import { AWARD_REASON_KEYS, oneOf, type AwardReasonKey } from '../../../sourcing/award-model'
import { LiffSection } from '../../content'

// The LIFF summary of an approval task on an award (S10-10 · ADR-052 · BR-NOTI-01): the award's number and RFx, the
// amounts before VAT and with VAT, the bids invited and sent, the winners by name (an individual by its code) and the
// tags that called for a reason with the reason itself — nothing per line and no unit price; the web task page has the
// comparison. No workspace component: a plain list of label and value in the LIFF type sizes.

export interface LiffAwardView {
  readonly number: string | null
  readonly rfx: { readonly number: string | null; readonly title: string }
  readonly net: string
  readonly gross: string
  readonly invited: number
  readonly submitted: number
  readonly reason: string | null
  readonly reasonCodes: readonly string[]
  readonly aboveRequestBy: string | null
  readonly winners: ReadonlyArray<{ readonly supplierCode: string; readonly supplierName: string | null }>
}

const baht = (amount: string) => formatSatang(amountToSatang(amount))

export async function LiffAwardSummary({ award }: { award: LiffAwardView | null }) {
  if (!award) return null
  const t = await getTranslations('sourcing.award')
  const rows = [
    { label: t('rfx'), value: `${award.rfx.number ?? ''} ${award.rfx.title}`.trim() },
    { label: t('net'), value: `${baht(award.net)} ${t('unit')}` },
    { label: t('gross'), value: `${baht(award.gross)} ${t('unit')}` },
    { label: t('bidCount'), value: t('bidCountValue', { invited: award.invited, submitted: award.submitted }) },
    { label: t('winnersTitle'), value: award.winners.map((w) => w.supplierName ?? t('individual', { code: w.supplierCode })).join(', ') },
    ...(award.reasonCodes.length ? [{ label: t('reasonCodesTitle'), value: award.reasonCodes.filter((c) => oneOf(AWARD_REASON_KEYS, c)).map((c) => t(`reasonCode.${c as AwardReasonKey}`)).join(' · ') }] : []),
    ...(award.aboveRequestBy ? [{ label: t('sourceApproved'), value: t('aboveRequest', { amount: baht(award.aboveRequestBy) }) }] : []),
    ...(award.reason ? [{ label: t('reason'), value: award.reason }] : []),
  ]
  return (
    <LiffSection id="award-summary" title={t('factsTitle')}>
      <dl className="flex flex-col gap-3">
        {rows.map((r) => (
          <div key={r.label} className="flex flex-col">
            <dt className="text-ink-muted">{r.label}</dt>
            <dd className="tabular whitespace-pre-line break-words text-ink">{r.value}</dd>
          </div>
        ))}
      </dl>
    </LiffSection>
  )
}
