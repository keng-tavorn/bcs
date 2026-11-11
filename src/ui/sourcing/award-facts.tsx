import { getLocale, getTranslations } from 'next-intl/server'
import { amountToSatang } from '@/core/money/dto'
import { formatSatang } from '@/core/money/format'
import { formatEnglishBeDate, formatThaiDate } from '@/core/thai'
import { StatusBadge } from '../document/badges'
import type { BadgeLook } from '../document/badge-looks'
import { Notice } from '../form/notice'
import { Amounts, Facts, Section, type Fact } from '../request-view/facts'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../shadcn/table'
import { AWARD_FLAG_KEYS, AWARD_REASON_KEYS, keyOf, oneOf, type AwardReasonKey } from './award-model'
import { scoreText } from './score-model'

// The facts of an award (S10-10 · FR-SRC-204 AC3 · BR-RFX-12 · ADR-202): what its approver decides on and what procurement
// sees before sending it — the RFx, how many suppliers were invited and bid, the amounts before VAT, VAT and with VAT,
// what the source requests approved and how far above it the award goes, the tags that call for a reason, the reason,
// each winner with its live flags (foreign, not VAT registered, quoted with VAT, bid expired, registry flag, required
// documents, RISK), the comparison in short with ranks and totals, and the unusual prices of the awarded lines. Used by
// /tasks/[id] and /sourcing/[id]/award; the LIFF summary is src/ui/liff/tasks/subjects/award.tsx. An individual
// supplier is named by its code (BR-AI-32). Flat sections, amounts right-aligned in tabular digits (§9.9).

/** The view the pages read (AwardFactsDto of src/server/services/sourcing/award-view.ts has this shape) */
export interface AwardFactsView {
  readonly number: string | null
  readonly poStatus: string
  readonly rfx: { readonly number: string | null; readonly title: string }
  readonly net: string
  readonly vat: string
  readonly gross: string
  readonly isSplit: boolean
  readonly reason: string | null
  readonly reasonCodes: readonly string[]
  readonly sourceApprovedNet: string | null
  readonly aboveRequestBy: string | null
  readonly bids: ReadonlyArray<{ readonly supplierCode: string; readonly supplierName: string | null; readonly net: string; readonly rank: number | null; readonly totalBp: number | null; readonly lowest: boolean; readonly partial: boolean; readonly winner: boolean }>
  readonly winners: ReadonlyArray<{
    readonly supplierCode: string
    readonly supplierName: string | null
    readonly net: string
    readonly vat: string
    readonly lineCount: number
    readonly foreign: boolean
    readonly vatRegistered: boolean
    readonly priceIncludesVat: boolean
    readonly registryFlag: string
    readonly requiredDocumentsOk: boolean
    readonly bidExpired: boolean
    readonly validUntil: string | null
    readonly risk: { readonly tier: string | null; readonly cleared: boolean } | null
  }>
  readonly priceFlags: ReadonlyArray<{ readonly lineNo: number; readonly supplierCode: string; readonly flag: string; readonly deviationBp: number | null }>
  readonly invited: number
  readonly submitted: number
  readonly evaluatorsAddedAfterClose: ReadonlyArray<{ readonly name: { readonly th: string; readonly en: string | null } }>
  readonly requestingDepartment: { readonly name: { readonly th: string; readonly en: string | null } } | null
  readonly sourceDepartments: ReadonlyArray<{ readonly name: { readonly th: string; readonly en: string | null } }>
}

const REASON_LOOK: Readonly<Record<string, BadgeLook>> = {
  NOT_TOP_SCORE: { tone: 'warn', icon: 'TrendingDown' },
  SPLIT: { tone: 'warn', icon: 'Split' },
  FOREIGN: { tone: 'warn', icon: 'Gauge' },
  BID_EXPIRED: { tone: 'warn', icon: 'AlarmClock' },
  SUPPLIER_FLAGGED: { tone: 'danger', icon: 'Ban' },
  DOCS_INCOMPLETE: { tone: 'warn', icon: 'FilePen' },
  ABOVE_REQUEST: { tone: 'warn', icon: 'TrendingUp' },
  RISK_NOT_CLEARED: { tone: 'danger', icon: 'Gauge' },
}
const FLAGGED = new Set(['CEASED', 'VAT_CANCELLED', 'NOT_FOUND'])
const baht = (amount: string) => formatSatang(amountToSatang(amount))
/** Basis points as a signed percent with two decimals: 2605 → "+26.05", -2436 → "-24.36" (a display of a ratio, not money) */
const percentOf = (bp: number) => `${bp > 0 ? '+' : ''}${(bp / 100).toFixed(2)}`

export async function AwardFacts({ award, comparison = true }: { award: AwardFactsView; comparison?: boolean }) {
  const [t, locale] = await Promise.all([getTranslations('sourcing.award'), getLocale()])
  const en = locale === 'en'
  const name = (n: { th: string; en: string | null }) => (en && n.en ? n.en : n.th)
  const supplier = (s: { supplierCode: string; supplierName: string | null }) => s.supplierName ?? t('individual', { code: s.supplierCode })
  const day = (d: string) => (en ? formatEnglishBeDate(d) : formatThaiDate(d))
  const facts: Fact[] = [
    { label: t('rfx'), value: `${award.rfx.number ?? ''} ${award.rfx.title}`.trim() },
    { label: t('bidCount'), value: t('bidCountValue', { invited: award.invited, submitted: award.submitted }) },
    ...(award.isSplit ? [{ label: t('split'), value: t('splitValue', { winners: award.winners.length }) }] : []),
    ...(award.requestingDepartment ? [{ label: t('department'), value: name(award.requestingDepartment.name) }] : []),
    ...(award.sourceDepartments.length ? [{ label: t('sourceDepartments'), value: award.sourceDepartments.map((d) => name(d.name)).join(', ') }] : []),
    ...(award.evaluatorsAddedAfterClose.length ? [{ label: t('evaluatorsAdded'), value: award.evaluatorsAddedAfterClose.map((m) => name(m.name)).join(', ') }] : []),
    ...(award.reason ? [{ label: t('reason'), value: <span className="whitespace-pre-line">{award.reason}</span> }] : []),
  ]
  return (
    <div className="@container flex flex-col gap-6">
      <Facts items={facts} />
      {award.reasonCodes.length ? (
        <div className="flex flex-col gap-2">
          <p className="text-base text-ink-muted md:text-sm">{t('reasonCodesTitle')}</p>
          <ul className="flex flex-wrap gap-2">
            {award.reasonCodes.filter((c): c is AwardReasonKey => oneOf(AWARD_REASON_KEYS, c)).map((c) => (
              <li key={c}>
                <StatusBadge look={REASON_LOOK[c] ?? { tone: 'warn', icon: null }} label={t(`reasonCode.${c}`)} />
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <Section id="award-amounts" title={t('amountsTitle')}>
        <Amounts
          heading={t('unit')}
          unit={t('unit')}
          rows={[
            ...(award.sourceApprovedNet !== null ? [{ label: t('sourceApproved'), value: baht(award.sourceApprovedNet) }] : []),
            { label: t('net'), value: baht(award.net) },
            { label: t('vat'), value: baht(award.vat) },
            { label: t('gross'), value: baht(award.gross), total: true },
          ]}
        />
        {award.aboveRequestBy ? <Notice tone="warning">{t('aboveRequest', { amount: baht(award.aboveRequestBy) })}</Notice> : null}
        {award.poStatus === 'PENDING_PRICE' ? <Notice tone="info">{t('pendingPrice')}</Notice> : null}
      </Section>
      {award.winners.length ? (
        <Section id="award-winners" title={t('winnersTitle')}>
          <ul className="flex flex-col gap-3">
            {award.winners.map((w) => {
              const tags = [
                ...(w.foreign ? [t('tag.FOREIGN')] : []),
                ...(!w.vatRegistered ? [t('tag.NOT_VAT_REGISTERED')] : []),
                ...(w.priceIncludesVat ? [t('tag.VAT_INCLUDED')] : []),
                ...(w.bidExpired && w.validUntil ? [t('tag.BID_EXPIRED', { date: day(w.validUntil) })] : []),
                ...(FLAGGED.has(w.registryFlag) ? [t('tag.REGISTRY', { flag: w.registryFlag })] : []),
                ...(!w.requiredDocumentsOk ? [t('tag.DOCS')] : []),
                ...(w.risk && !w.risk.cleared ? [t('tag.RISK', { tier: w.risk.tier ?? '-' })] : []),
              ]
              return (
                <li key={w.supplierCode} className="flex flex-col gap-1 border-b border-line pb-3 last:border-b-0 last:pb-0">
                  <div className="flex flex-wrap items-baseline justify-between gap-x-4">
                    <span className="break-words font-medium text-ink">{supplier(w)}</span>
                    <span className="tabular text-ink">
                      {baht(w.net)} + {baht(w.vat)} {t('unit')}
                    </span>
                  </div>
                  <span className="text-base text-ink-muted md:text-sm">{t('winnerLines', { count: w.lineCount })}</span>
                  {tags.length ? <span className="text-base text-warn-ink md:text-sm">{tags.join(' · ')}</span> : null}
                </li>
              )
            })}
          </ul>
        </Section>
      ) : null}
      {comparison && award.bids.length ? (
        <Section id="award-comparison" title={t('comparisonTitle')}>
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead scope="col">{t('rank')}</TableHead>
                  <TableHead scope="col">{t('supplier')}</TableHead>
                  <TableHead scope="col" className="text-right">
                    {t('net')}
                  </TableHead>
                  <TableHead scope="col" className="text-right">
                    {t('total')}
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {award.bids.map((b) => (
                  <TableRow key={b.supplierCode}>
                    <TableCell className="tabular">{b.rank ?? '-'}</TableCell>
                    <TableCell className="break-words">
                      {supplier(b)}
                      {b.winner ? <span className="ml-2 font-medium text-ok-ink">· {t('winnerMark')}</span> : null}
                    </TableCell>
                    <TableCell className="tabular text-right">{baht(b.net)}</TableCell>
                    <TableCell className="tabular text-right">{b.totalBp === null ? '-' : scoreText(b.totalBp)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </Section>
      ) : null}
      {award.priceFlags.length ? (
        <Section id="award-price-flags" title={t('priceFlagsTitle')}>
          <ul className="flex flex-col gap-1">
            {award.priceFlags.map((f) => (
              <li key={`${f.lineNo}:${f.supplierCode}`} className="tabular break-words text-ink">
                {t('priceFlag', { line: f.lineNo, supplier: f.supplierCode, flag: t(`flag.${keyOf(AWARD_FLAG_KEYS, f.flag, 'HIGH')}`), percent: f.deviationBp === null ? '-' : percentOf(f.deviationBp) })}
              </li>
            ))}
          </ul>
        </Section>
      ) : null}
    </div>
  )
}
