import { getTranslations } from 'next-intl/server'
import type { InsightItemDto, InsightList, InsightsFiltersDto } from '@/server/services/reports/insights'
import { formatDateTime } from '@/ui/format'
import { hoursText, percentText } from '@/ui/insight/format'
import type { KpiItemView } from '@/ui/insight/kpi-items'
import { documentHref, type LinkRights } from '@/ui/insight/links'
import { showMoney } from '@/ui/request-form/money'
import { dayText } from '../kpi/_present'

// The words and links of /insights (spec §9.10, FR-VIS-007): the filters as the address carries them, so every list
// opens with the same period, department and type as the card it came from (AC1 AC3), shares of basis points with one
// decimal, and the documents of a list as rows that link to their pages for readers who may open them.

const _insightsTranslator = () => getTranslations('insights')
export type InsightsT = Awaited<ReturnType<typeof _insightsTranslator>>

const BP_PER_PERCENT = 100
const PERCENT = 100

/** Basis points as a percent with one decimal ("42.5") */
export const bpText = (bp: number): string => percentText(bp, PERCENT * BP_PER_PERCENT) ?? '0.0'

export { dayText, hoursText, percentText }

/** The address of the filters (only what differs from the default), with extra parameters of a list */
export function queryOf(filters: InsightsFiltersDto, extra: Readonly<Record<string, string | null>> = {}): string {
  const p = new URLSearchParams()
  if (filters.range !== '30d') p.set('range', filters.range)
  if (filters.range === 'custom') {
    p.set('from', filters.from)
    p.set('to', filters.to)
  }
  if (filters.departmentId) p.set('dept', filters.departmentId)
  if (filters.requestTypeId) p.set('type', filters.requestTypeId)
  for (const [k, v] of Object.entries(extra)) {
    if (v === null) p.delete(k)
    else p.set(k, v)
  }
  const q = p.toString()
  return q ? `?${q}` : ''
}

export const listHref = (list: InsightList, filters: InsightsFiltersDto, extra: Readonly<Record<string, string | null>> = {}) => `/insights/${list}${queryOf(filters, extra)}`

export const nameIn = (locale: string, x: { nameTh: string; nameEn: string | null }) => (locale === 'en' ? (x.nameEn ?? x.nameTh) : x.nameTh)

// Each key is written out: a key built from a template makes next-intl's key types too deep for the checker
function personLine(t: InsightsT, kind: NonNullable<InsightItemDto['personKind']>, name: string): string {
  if (kind === 'DECIDER') return t('list.lines.decidedBy', { name })
  if (kind === 'REQUESTER') return t('list.lines.requester', { name })
  return t('list.lines.assignee', { name })
}

function timeLine(t: InsightsT, kind: NonNullable<InsightItemDto['atKind']>, time: string): string {
  if (kind === 'DECIDED') return t('list.lines.decidedAt', { time })
  if (kind === 'ASSIGNED') return t('list.lines.assignedAt', { time })
  if (kind === 'APPROVED') return t('list.lines.approvedAt', { time })
  if (kind === 'FIRST_PO') return t('list.lines.firstPo', { time })
  if (kind === 'LAST_ACTIVITY') return t('list.lines.lastActivity', { time })
  return t('list.lines.changedAt', { time })
}

function markText(t: InsightsT, mark: NonNullable<InsightItemDto['mark']>): string {
  if (mark === 'PRICE_ALERT') return t('list.marks.PRICE_ALERT')
  if (mark === 'WITH_DOA') return t('list.marks.WITH_DOA')
  if (mark === 'WITHOUT_DOA') return t('list.marks.WITHOUT_DOA')
  return t('list.marks.LOW')
}

/** A document's title with its kind in words (an authority change has no number, so its kind's name alone) */
function documentTitle(t: InsightsT, doc: InsightItemDto['document']): string {
  if (!doc) return t('list.document.unknown')
  const label = doc.label
  if (doc.type === 'REQUEST') return t('list.document.REQUEST', { label })
  if (doc.type === 'PURCHASE_ORDER') return t('list.document.PURCHASE_ORDER', { label })
  if (doc.type === 'VARIANCE') return t('list.document.VARIANCE', { label })
  if (doc.type === 'DOA_VERSION') return t('list.document.DOA_VERSION', { label })
  if (doc.type === 'ORG_AUTHORITY_CHANGE') return t('list.document.ORG_AUTHORITY_CHANGE')
  if (doc.type === 'BUDGET_LINE') return t('list.document.BUDGET_LINE', { label })
  return t('list.document.SUPPLIER', { label })
}

/** A list's title */
export function listTitle(t: InsightsT, list: InsightList): string {
  const titles: Record<InsightList, () => string> = {
    spend: () => t('list.titles.spend'),
    'price-alerts': () => t('list.titles.price-alerts'),
    budget: () => t('list.titles.budget'),
    'budget-low': () => t('list.titles.budget-low'),
    'submit-to-po': () => t('list.titles.submit-to-po'),
    'decision-time': () => t('list.titles.decision-time'),
    overdue: () => t('list.titles.overdue'),
    'idle-pos': () => t('list.titles.idle-pos'),
    'doa-ref': () => t('list.titles.doa-ref'),
    'doa-missing': () => t('list.titles.doa-missing'),
    'over-budget': () => t('list.titles.over-budget'),
    channel: () => t('list.titles.channel'),
    'supplier-changes': () => t('list.titles.supplier-changes'),
  }
  return titles[list]()
}

const MARK_KIND = { PRICE_ALERT: 'overdue', WITH_DOA: 'done', WITHOUT_DOA: 'overdue', LOW: 'overdue' } as const

/** The rows of a list: the document, then who, when, how long or how much, and why it is marked */
export function itemViews(t: InsightsT, locale: string, items: readonly InsightItemDto[], rights: LinkRights): KpiItemView[] {
  const time = (at: string) => formatDateTime(locale, at)
  return items.map((item) => {
    const doc = item.document
    const href = !doc
      ? null
      : doc.type === 'BUDGET_LINE'
        ? `/budgets/${doc.id}`
        : doc.type === 'SUPPLIER'
          ? `/suppliers/${doc.id}`
          : documentHref({ type: doc.type, id: doc.id, poId: doc.poId }, rights)
    const lines: string[] = []
    if (item.person && item.personKind) lines.push(personLine(t, item.personKind, nameIn(locale, item.person)))
    if (item.at && item.atKind) lines.push(timeLine(t, item.atKind, time(item.at)))
    if (item.dueAt) lines.push(t('list.lines.due', { time: time(item.dueAt) }))
    if (item.minutes !== null) lines.push(t('list.lines.hours', { hours: hoursText(item.minutes) }))
    if (item.amount) lines.push(t('list.lines.amount', { amount: showMoney(item.amount) }))
    if (item.channel) lines.push(t('list.lines.channel', { channel: channelText(t, item.channel) }))
    if (item.budget) lines.push(t('list.lines.budget', { used: bpText(item.budget.usedBp ?? 0), available: showMoney(item.budget.available), planned: showMoney(item.budget.planned) }))
    if (item.status) lines.push(t('list.lines.status', { from: item.status.from ?? t('list.lines.unknownStatus'), to: item.status.to }))
    return {
      id: item.key,
      title: documentTitle(t, doc),
      href,
      lines,
      doa: null,
      mark: item.mark ? { kind: MARK_KIND[item.mark], text: markText(t, item.mark) } : null,
    }
  })
}

// The channels the control card counts one by one (DECISION_CHANNELS of src/server/services/reports/insights.ts)
const DECISION_CHANNELS = ['WEB', 'APP', 'LIFF', 'LINE_CHAT', 'EMAIL'] as const

export function channelText(t: InsightsT, channel: string): string {
  return (DECISION_CHANNELS as readonly string[]).includes(channel) ? t(`control.channels.${channel as (typeof DECISION_CHANNELS)[number]}`) : t('control.channels.OTHER')
}
