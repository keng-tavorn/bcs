import type { getTranslations } from 'next-intl/server'
import type { PriceReferenceDto } from '@/server/services/price-reference'
import { formatBpPercent } from '@/ui/format'
import { NO_FIGURE, type PriceLineView, type PriceReferenceView } from '@/ui/price-reference/view'
import { money } from './present'

// getPriceReference's DTO in the words and figures of the price reference panel (S6-11 · FR-DOA-101 AC1 AC2), for the
// web decision page and the LIFF task page alike. Money stays satang text until formatSatang writes it (BigInt, never a
// JS number); a deviation is whole basis points written as a percent by integer arithmetic (formatBpPercent).

export type PriceRefT = Awaited<ReturnType<typeof getTranslations<'priceReference'>>>

const baht = (satang: string | null): string => (satang === null ? NO_FIGURE : money(BigInt(satang)))

export function priceReferenceView(t: PriceRefT, ref: PriceReferenceDto): PriceReferenceView {
  const lines = ref.lines.map((l): PriceLineView => {
    const deviation = ref.requestIncludesVat ? t('deviation.vat') : l.deviationBp === null ? t('deviation.none') : formatBpPercent(l.deviationBp)
    const counted = t('samples', { count: l.count })
    return {
      key: `${l.lineNo}`,
      title: l.description,
      unitPrice: baht(l.unitPriceSatang),
      median: baht(l.medianSatang),
      min: baht(l.minSatang),
      max: baht(l.maxSatang),
      last: baht(l.lastSatang),
      deviation,
      alert: l.alert ? { kind: l.alert, label: t(`alert.${l.alert}`) } : null,
      samples: l.excludedVatIncluded > 0 ? `${counted} · ${t('excluded', { count: l.excludedVatIncluded })}` : counted,
      few: l.status === 'FEW_SAMPLES' ? t('few', { min: ref.minSamples }) : null,
      agreement: l.agreement ? t('agreement', { supplier: l.agreement.supplierName, price: baht(l.agreement.unitPriceSatang), uom: l.uom }) : null,
    }
  })
  const q = ref.quotes
  const quotes = q
    ? {
        title: t('quotes.title'),
        rows: [
          { label: t('quotes.count'), value: t('quotes.countValue', { count: q.count }) },
          { label: t('quotes.lowest'), value: baht(q.lowestSatang) },
          { label: t('quotes.highest'), value: baht(q.highestSatang) },
          { label: t('quotes.selected'), value: baht(q.selectedSatang) },
        ],
        note:
          q.selectedSatang === null
            ? t('quotes.noneSelected')
            : q.selectedIsLowest
              ? t('quotes.lowestChosen')
              : q.nonLowestReason
                ? t('quotes.notLowest', { reason: q.nonLowestReason })
                : t('quotes.notLowestNoReason'),
      }
    : null
  return {
    title: t('title'),
    intro: t('intro', { days: ref.windowDays, threshold: formatBpPercent(ref.alertBp, { signed: false }) }),
    vatNote: ref.requestIncludesVat ? t('vatNote') : null,
    lines,
    quotes,
    labels: {
      list: t('list'),
      item: t('columns.item'),
      unitPrice: t('columns.unitPrice'),
      median: t('columns.median'),
      min: t('columns.min'),
      max: t('columns.max'),
      range: t('columns.range'),
      last: t('columns.last'),
      deviation: t('columns.deviation'),
      unit: t('unit'),
    },
  }
}
