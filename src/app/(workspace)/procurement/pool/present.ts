import type { getTranslations } from 'next-intl/server'
import { formatSatang } from '@/core/money/format'
import type { PoolLineDto } from '@/server/services/procurement'
import type { PoolRequestView } from '@/ui/procurement/pool-board'
import { day, type Locale } from '../../_tracking/present'

// The procurement pool in words and figures (spec FR-P2P-001, FR-P2P-002): the lines of each request together, oldest
// approval first, each with what is left to order, its unit price and amount on the request's own VAT basis (formatted
// from satang, nothing converted) and why no round drafts it yet; and how many lines a round drafts now, how many need a
// supplier first (BR-CONS-03) and how many no round drafts yet whatever their supplier, because their request's prices
// include VAT (NEW-50). The pool page and the "รวมเป็นร่าง PO ตอนนี้" command both count with poolCounts.

export type PoolT = Awaited<ReturnType<typeof getTranslations<'procurement.pool'>>>

/** The lines of each request together, in the pool's order (oldest approval first) */
export function requestsOf(t: PoolT, locale: Locale, lines: readonly PoolLineDto[], supplierName: (id: string | null) => string | null): PoolRequestView[] {
  const groups = new Map<string, PoolLineDto[]>()
  for (const l of lines) groups.set(l.requestId, [...(groups.get(l.requestId) ?? []), l])
  return [...groups.values()].map((group) => {
    const first = group[0]!
    return {
      id: first.requestId,
      number: first.requestNo,
      title: `${first.requestNo} · ${first.requestTitle}`,
      href: `/requests/${first.requestId}`,
      meta: [
        t('request.requester', { name: locale === 'en' && first.requesterNameEn ? first.requesterNameEn : first.requesterName }),
        first.deliverySite ? t('request.site', { site: first.deliverySite.nameTh }) : t('request.noSite'),
        `${t('request.approved', { date: day(locale, first.approvedAt) })} · ${first.ageDays > 0 ? t('request.ageDays', { days: first.ageDays }) : t('request.ageToday')}`,
      ],
      urgent: first.urgency === 'URGENT',
      suggested: supplierName(first.suggestedSupplierId),
      // The VAT basis is the request's, so its lines are blocked alike (NEW-50)
      blocked: group.find((l) => l.draftBlock)?.draftBlock ?? null,
      lines: group.map((l) => ({
        id: l.requestLineId,
        no: l.lineNo,
        description: l.description,
        kind: t(`kind.${l.kind}`),
        quantity: t('line.qty', { quantity: l.quantity, uom: l.uom }),
        unitPrice: formatSatang(l.unitPriceSatang),
        amount: formatSatang(l.amountSatang),
        includesVat: l.priceIncludesVat,
        supplierName: l.supplier?.nameTh ?? null,
      })),
    }
  })
}

export interface PoolCounts {
  /** With a supplier and nothing blocking them: what a round puts on drafts now (read after a round: chosen while it ran) */
  readonly ready: number
  /** Without a supplier, and put on a draft by the round after they get one (BR-CONS-03) */
  readonly needSupplier: number
  /** No round drafts them yet, with a supplier or without: their request's prices include VAT (NEW-50) */
  readonly blocked: number
}

/** Counts pool lines by what keeps them from a draft PO; every line falls in exactly one count */
export function poolCounts(lines: readonly PoolLineDto[]): PoolCounts {
  let ready = 0
  let needSupplier = 0
  let blocked = 0
  for (const l of lines) {
    if (l.draftBlock) blocked += 1
    else if (l.needsSupplier) needSupplier += 1
    else ready += 1
  }
  return { ready, needSupplier, blocked }
}
