import type { getTranslations } from 'next-intl/server'
import { amountToSatang } from '@/core/money/dto'
import { formatEnglishBeDate, formatThaiDate } from '@/core/thai/date'
import type { BudgetFiguresDto, BudgetLineChangesDto } from '@/server/services/budget/dashboard'
import type { AmountLink, AmountLinks, Bucket, FigureLinks, FigureView, LineChangesView } from '@/ui/budgets/budget-table'
import type { LineFigureView, LineSharesView } from '@/ui/budgets/line-detail'
import { leftPercentText, moneyText, percentText } from '@/ui/budgets/format'

// Turns the budget services' DTOs into the translated, formatted strings of the budget screens (spec §11.2): money with
// thousands separators and two decimals from its decimal text, shares with one decimal (the share left rounded down,
// so the warning never reads as at its threshold), names in the reader's language when the organization has one,
// dates in the Buddhist era, and the link of every figure to what makes it up (FR-BUD-005 AC2, §9.9 every number opens
// its list): each amount, each share, and the number in a warning.

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

/**
 * Nothing is left of what was planned: every baht is reserved, held or spent, so a new request on it is refused
 * (BUDGET_INSUFFICIENT, BR-BUD-02). The amount itself is tested, not the share left, which rounds down to 0.0% while a
 * little is still there.
 */
export const usedUp = (f: BudgetFiguresDto): boolean => amountToSatang(f.planned.amount) > 0n && amountToSatang(f.available.amount) <= 0n

/**
 * The warning of some figures, or null: "งบหมด เหลือ 0.00 บาท" once nothing is left (drawn in --danger, the token of
 * งบไม่พอ, §9.9), "ใกล้หมด เหลือ 8.7%" below the warning (in --warn)
 */
export const lowText = (t: BudgetsT, f: BudgetFiguresDto): string | null =>
  usedUp(f) ? t('low.out', { amount: moneyText(f.available) }) : f.low ? t('low.badge', { left: leftPercentText(f.availableBp) ?? '0.0' }) : null

/** The item of the low notice: the line, then how low it is, in the words of its warning */
export const lowItemText = (t: BudgetsT, l: BudgetFiguresDto & { readonly code: string; readonly nameTh: string }): string =>
  usedUp(l) ? t('low.itemOut', { code: l.code, name: l.nameTh, amount: moneyText(l.available) }) : t('low.item', { code: l.code, name: l.nameTh, left: leftPercentText(l.availableBp) ?? '0.0' })

/** The section of a drill-down page each amount leads to */
const SECTION: Readonly<Record<Bucket, string>> = { planned: 'planned', available: 'movements', reserved: 'reserved', committed: 'committed', actual: 'actual' }

/**
 * The link of each amount of a line, a department or a total (`of` names it) to the section of its drill-down page
 * (`page`; '' on that page itself) that makes the amount up: the imports, the ledger's movements, or the documents of a
 * bucket. Every amount leads there, 0.00 too (§9.9: every number opens its list, as the dashboard's intro promises): an
 * empty section says what will show there and when, so no amount is a plain number beside the links.
 */
export function amountLinks(t: BudgetsT, f: BudgetFiguresDto, of: string, page: string): AmountLinks {
  const link = (bucket: Bucket): AmountLink => {
    const amount = moneyText(f[bucket])
    const label =
      bucket === 'planned'
        ? t('table.plannedLink', { amount, code: of })
        : bucket === 'available'
          ? t('table.availableLink', { amount, code: of })
          : t('table.amountLink', { bucket: t(`columns.${bucket}`), amount, code: of })
    return { href: `${page}#${SECTION[bucket]}`, label }
  }
  return { planned: link('planned'), available: link('available'), reserved: link('reserved'), committed: link('committed'), actual: link('actual') }
}

/** "ใช้แล้ว 18.0%" and "รวมที่จองแล้ว 26.0%", or none when nothing is planned */
function sharesText(t: BudgetsT, f: BudgetFiguresDto): { used: string; held: string } | null {
  const used = percentText(f.usedBp)
  const held = percentText(f.heldBp)
  return used === null || held === null ? null : { used: t('columns.used', { pct: used }), held: t('columns.held', { pct: held }) }
}

/**
 * The links of the shares and of the warning of a line, a department or a total (`of` names it) to the sections of its
 * drill-down page (`page`; '' on that page itself) that make them up: "ใช้แล้ว" — held and spent, (ถือ + ตัดจ่ายจริง) ÷
 * งบตั้งต้น — to the POs that commit it, followed by the actual; "รวมที่จองแล้ว" — everything taken, (จอง + ถือ +
 * ตัดจ่ายจริง) ÷ งบตั้งต้น — to the documents that reserve it, followed by the rest; and the warning ("ใกล้หมด เหลือ 8.3%",
 * "งบหมด เหลือ 0.00 บาท") to the ledger's movements behind what is left. Each is named with its words as shown first,
 * then what it is of and where it leads; null where there is no share or no warning.
 */
export function shareLinks(t: BudgetsT, f: BudgetFiguresDto, of: string, page: string): Pick<FigureLinks, 'used' | 'held' | 'low'> {
  const shares = sharesText(t, f)
  const low = lowText(t, f)
  return {
    used: shares ? { href: `${page}#${SECTION.committed}`, label: t('table.usedLink', { share: shares.used, code: of }) } : null,
    held: shares ? { href: `${page}#${SECTION.reserved}`, label: t('table.heldLink', { share: shares.held, code: of }) } : null,
    low: low ? { href: `${page}#${SECTION.available}`, label: t('table.lowLink', { warning: low, code: of }) } : null,
  }
}

/** Every link of a row of the dashboard: its amounts, its shares and its warning (FigureView.links) */
export const figureLinks = (t: BudgetsT, f: BudgetFiguresDto, of: string, page: string): FigureLinks => ({ ...amountLinks(t, f, of, page), ...shareLinks(t, f, of, page) })

export function figureView(t: BudgetsT, f: BudgetFiguresDto, links: FigureLinks): FigureView {
  const shares = sharesText(t, f)
  return {
    planned: moneyText(f.planned),
    available: moneyText(f.available),
    reserved: moneyText(f.reserved),
    committed: moneyText(f.committed),
    actual: moneyText(f.actual),
    used: shares?.used ?? null,
    held: shares?.held ?? null,
    heldBp: f.heldBp,
    low: lowText(t, f),
    out: usedUp(f),
    links,
  }
}

/** The amounts strip of a drill-down page: every amount links to its section on the same page, 0.00 too */
export function figureStrip(t: BudgetsT, f: BudgetFiguresDto, of: string): LineFigureView[] {
  const links = amountLinks(t, f, of, '')
  return (['planned', 'available', 'reserved', 'committed', 'actual'] as const).map((b) => ({
    key: b,
    term: t(`columns.${b}`),
    amount: moneyText(f[b]),
    href: links[b].href,
    linkLabel: links[b].label,
  }))
}

/** The shares under the strip of a drill-down page, each linking to its sections on the same page; none when nothing is planned */
export function shareStrip(t: BudgetsT, f: BudgetFiguresDto, of: string): LineSharesView | null {
  const shares = sharesText(t, f)
  const links = shareLinks(t, f, of, '')
  return shares && links.used && links.held && f.heldBp !== null ? { ...shares, usedLink: links.used, heldLink: links.held, heldBp: f.heldBp, low: f.low, out: usedUp(f) } : null
}

/** The warning of a drill-down page in its header, linking to the movements on the same page; none when it has no warning */
export function lowBadge(t: BudgetsT, f: BudgetFiguresDto, of: string): { label: string; out: boolean; link: AmountLink } | null {
  const low = lowText(t, f)
  const link = shareLinks(t, f, of, '').low
  return low && link ? { label: low, out: usedUp(f), link } : null
}

/**
 * How a line came to its planned amount (S6-15 · FR-BUD-103 AC3 · BR-BUD-09): the initial budget — to the imports — the
 * transfers in and out, the increases and decreases and what over-budget approvals funded (S6-16) — to the ledger's
 * movements that hold them — and the planned amount they make, last. The amounts are the ledger's (budgetDashboard), never added up here.
 */
export function changesView(t: BudgetsT, changes: BudgetLineChangesDto, planned: BudgetFiguresDto['planned'], code: string, page: string): LineChangesView {
  const moved = (key: Exclude<keyof BudgetLineChangesDto, 'initial'>) => {
    const amount = moneyText(changes[key])
    const term = t(`changes.${key}`)
    return { key, term, amount, link: { href: `${page}#${SECTION.available}`, label: t('changes.link', { term, amount, code }) } }
  }
  const initial = moneyText(changes.initial)
  const current = moneyText(planned)
  return {
    toggle: t('changes.toggle'),
    rows: [
      { key: 'initial', term: t('changes.initial'), amount: initial, link: { href: `${page}#${SECTION.planned}`, label: t('changes.initialLink', { amount: initial, code }) } },
      moved('transferredIn'),
      moved('transferredOut'),
      moved('increased'),
      moved('decreased'),
      // S6-16: what over-budget approvals funded and kept (BR-BUD-13 to BR-BUD-15, BR-BUD-18)
      moved('overrun'),
      { key: 'current', term: t('changes.current'), amount: current, link: { href: `${page}#${SECTION.planned}`, label: t('table.plannedLink', { amount: current, code }) }, total: true },
    ],
  }
}

/** Where the dashboard's rows lead: a line, a department or everything shown, in the fiscal year shown */
export const budgetHref = {
  line: (id: string) => `/budgets/${id}`,
  department: (id: string, fiscalYearId: string) => `/budgets/departments/${id}?fy=${fiscalYearId}`,
  total: (fiscalYearId: string) => `/budgets/total?fy=${fiscalYearId}`,
}
