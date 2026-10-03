import type { getTranslations } from 'next-intl/server'
import { formatEnglishBeDate, formatThaiDate } from '@/core/thai/date'
import type { BudgetFiguresDto } from '@/server/services/budget/dashboard'
import type { AmountLinks, Bucket, FigureView } from '@/ui/budgets/budget-table'
import type { LineFigureView } from '@/ui/budgets/line-detail'
import { isZero, leftPercentText, moneyText, percentText } from '@/ui/budgets/format'

// Turns the budget services' DTOs into the translated, formatted strings of the budget screens (spec §11.2): money with
// thousands separators and two decimals from its decimal text, shares with one decimal (the share left rounded down,
// so the warning never reads as at its threshold), names in the reader's language when the organization has one,
// dates in the Buddhist era, and the link of every amount to what makes it up (FR-BUD-005 AC2).

export type BudgetsT = Awaited<ReturnType<typeof getTranslations<'budgets'>>>
export type Locale = 'th' | 'en'

export const localeOf = (value: string): Locale => (value === 'en' ? 'en' : 'th')

/** A name in the reader's language when the organization gave one */
export const nameIn = (locale: Locale, name: { th?: string; nameTh?: string; en?: string | null; nameEn?: string | null }): string => {
  const th = name.th ?? name.nameTh ?? ''
  const en = name.en ?? name.nameEn ?? null
  return locale === 'en' && en ? en : th
}

/** A calendar day "YYYY-MM-DD" as each language shows it */
export const dayText = (locale: Locale, day: string): string => (locale === 'en' ? formatEnglishBeDate(day) : formatThaiDate(day))

/** "ใกล้หมด เหลือ 8.7%" for figures below the warning, else null */
export const lowText = (t: BudgetsT, f: BudgetFiguresDto): string | null => (f.low ? t('low.badge', { left: leftPercentText(f.availableBp) ?? '0.0' }) : null)

/** The section of a drill-down page each amount leads to */
const SECTION: Readonly<Record<Bucket, string>> = { planned: 'planned', available: 'movements', reserved: 'reserved', committed: 'committed', actual: 'actual' }

/**
 * The link of each amount of a line, a department or a total (`of` names it) to the section of its drill-down page
 * (`page`; '' on that page itself) that makes the amount up: the imports, the ledger's movements, or the documents of a
 * bucket. Planned and available lead somewhere once anything was imported; a bucket that holds nothing leads nowhere.
 */
export function amountLinks(t: BudgetsT, f: BudgetFiguresDto, of: string, page: string): AmountLinks {
  const funded = !isZero(f.planned)
  const link = (bucket: Bucket, show: boolean) => {
    if (!show) return null
    const amount = moneyText(f[bucket])
    const label =
      bucket === 'planned'
        ? t('table.plannedLink', { amount, code: of })
        : bucket === 'available'
          ? t('table.availableLink', { amount, code: of })
          : t('table.amountLink', { bucket: t(`columns.${bucket}`), amount, code: of })
    return { href: `${page}#${SECTION[bucket]}`, label }
  }
  return {
    planned: link('planned', funded),
    available: link('available', funded),
    reserved: link('reserved', !isZero(f.reserved)),
    committed: link('committed', !isZero(f.committed)),
    actual: link('actual', !isZero(f.actual)),
  }
}

export function figureView(t: BudgetsT, f: BudgetFiguresDto, links: AmountLinks): FigureView {
  const used = percentText(f.usedBp)
  const held = percentText(f.heldBp)
  return {
    planned: moneyText(f.planned),
    available: moneyText(f.available),
    reserved: moneyText(f.reserved),
    committed: moneyText(f.committed),
    actual: moneyText(f.actual),
    used: used === null ? null : t('columns.used', { pct: used }),
    held: held === null ? null : t('columns.held', { pct: held }),
    heldBp: f.heldBp,
    low: lowText(t, f),
    links,
  }
}

/** The amounts strip of a drill-down page: every amount links to its section on the same page */
export function figureStrip(t: BudgetsT, f: BudgetFiguresDto, of: string): LineFigureView[] {
  const links = amountLinks(t, f, of, '')
  return (['planned', 'available', 'reserved', 'committed', 'actual'] as const).map((b) => ({
    key: b,
    term: t(`columns.${b}`),
    amount: moneyText(f[b]),
    href: links[b]?.href ?? null,
    linkLabel: links[b]?.label ?? null,
  }))
}

/** The shares under the strip, or none when nothing is planned */
export function shareStrip(t: BudgetsT, f: BudgetFiguresDto): { used: string; held: string; heldBp: number; low: boolean } | null {
  const used = percentText(f.usedBp)
  const held = percentText(f.heldBp)
  return used && held && f.heldBp !== null ? { used: t('columns.used', { pct: used }), held: t('columns.held', { pct: held }), heldBp: f.heldBp, low: f.low } : null
}

/** Where the dashboard's rows lead: a line, a department or everything shown, in the fiscal year shown */
export const budgetHref = {
  line: (id: string) => `/budgets/${id}`,
  department: (id: string, fiscalYearId: string) => `/budgets/departments/${id}?fy=${fiscalYearId}`,
  total: (fiscalYearId: string) => `/budgets/total?fy=${fiscalYearId}`,
}
