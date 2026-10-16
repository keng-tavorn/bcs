import type { getTranslations } from 'next-intl/server'
import type { OverrunDto, OverrunOfferDto } from '@/server/services/budget/overrun-view'
import { moneyText } from '@/ui/budgets/format'
import { overrunCancellable, type OverrunPanelView } from '@/ui/budgets/overrun-model'

// Turns over-budget approvals (OverrunDto, OverrunOfferDto) into the words of their screens (S6-16 · FR-BUD-101): the
// source request by its number (its title while it has none), the line as "CON-OPEX · งบดำเนินงาน", the request page's
// panel — what is short, and each overrun asked with its state — and nothing at all when nothing was asked and the reader
// may not ask (the button shows only with an OVER_BUDGET rule in effect, BR-BUD-12).

export type OverrunT = Awaited<ReturnType<typeof getTranslations<'budgetOverrun'>>>

export const overrunLineText = (l: OverrunDto['budgetLine']): string => `${l.code} · ${l.nameTh}`

/** The source request's number, or its title while it has none */
export const overrunRequestLabel = (r: OverrunDto['request']): string => r.number ?? r.title

/**
 * The request page's over-budget panel; null — the page shows nothing — when nothing was asked and the reader may not
 * ask (no OVER_BUDGET rule in effect, the line has enough, or the reader is not the requester). `day` writes a date.
 */
export function overrunPanelView(t: OverrunT, offer: OverrunOfferDto, day: (iso: string) => string): OverrunPanelView | null {
  if (!offer.canAsk && offer.overruns.length === 0) return null
  const short =
    offer.canAsk && offer.line && offer.need && offer.available && offer.shortfall
      ? {
          headline: t('panel.short', { line: `${offer.line.code} · ${offer.line.nameTh}` }),
          amounts: [
            { label: t('panel.need'), value: moneyText(offer.need) },
            { label: t('panel.available'), value: moneyText(offer.available) },
            { label: t('panel.shortfall'), value: moneyText(offer.shortfall), total: true },
          ],
          unit: t('panel.unit'),
          hint: t('panel.hint'),
        }
      : null
  return {
    title: t('panel.title'),
    short,
    canAsk: offer.canAsk,
    shortfall: offer.canAsk && offer.shortfall ? moneyText(offer.shortfall) : null,
    listLabel: t('panel.list'),
    rows: offer.overruns.map((o) => ({
      id: o.id,
      number: o.number,
      href: `/budgets/overruns/${o.id}`,
      status: o.status,
      statusLabel: t(`status.${o.status}`),
      shortfall: t('panel.rowShortfall', { amount: moneyText(o.shortfall) }),
      hint: o.status === 'PENDING_APPROVAL' ? t('panel.pendingHint') : o.status === 'APPROVED' && o.lapsesAt ? t('panel.approvedHint', { date: day(o.lapsesAt) }) : null,
      cancel: overrunCancellable(o.status, o.mine),
      mine: o.mine,
    })),
  }
}

/** The facts of one overrun's page, in the order its reader asks them: what, for which request and line, then the money, then who and when */
export function overrunFacts(t: OverrunT, o: OverrunDto, when: (iso: string) => string): Array<{ readonly key: string; readonly label: string; readonly value: string; readonly money?: boolean }> {
  const amount = (m: { amount: string }) => t('money', { amount: moneyText(m) })
  const zero = (m: { amount: string }) => moneyText(m) === '0.00'
  return [
    { key: 'request', label: t('detail.request'), value: o.request.number ? t('detail.requestValue', { number: o.request.number, title: o.request.title }) : o.request.title },
    { key: 'line', label: t('detail.line'), value: overrunLineText(o.budgetLine) },
    { key: 'requestNet', label: t('detail.requestNet'), value: amount(o.requestNet), money: true },
    { key: 'shortfall', label: t('detail.shortfall'), value: amount(o.shortfall), money: true },
    // What it funded went where: used by the request's submit, back to the line at use or lapse, back after use
    ...(o.status === 'CONSUMED' || !zero(o.used) ? [{ key: 'used', label: t('detail.used'), value: amount(o.used), money: true }] : []),
    ...(o.status === 'CONSUMED' || o.status === 'LAPSED' || !zero(o.returned) ? [{ key: 'returned', label: t('detail.returned'), value: amount(o.returned), money: true }] : []),
    ...(!zero(o.returnedAfterUse) ? [{ key: 'returnedAfterUse', label: t('detail.returnedAfterUse'), value: amount(o.returnedAfterUse), money: true }] : []),
    { key: 'reason', label: t('detail.reason'), value: o.reason },
    { key: 'submittedBy', label: t('detail.submittedBy'), value: o.submittedBy.nameTh },
    { key: 'submittedAt', label: t('detail.submittedAt'), value: when(o.submittedAt) },
    ...(o.approvedAt ? [{ key: 'approvedAt', label: t('detail.approvedAt'), value: when(o.approvedAt) }] : []),
    ...(o.lapsesAt && o.status === 'APPROVED' ? [{ key: 'lapsesAt', label: t('detail.lapsesAt'), value: when(o.lapsesAt) }] : []),
    ...(o.consumedAt ? [{ key: 'consumedAt', label: t('detail.consumedAt'), value: when(o.consumedAt) }] : []),
  ]
}
