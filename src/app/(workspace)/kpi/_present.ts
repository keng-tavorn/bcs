import { getTranslations } from 'next-intl/server'
import { formatEnglishBeDate, formatThaiDate } from '@/core/thai'
import type { KpiResult, Ratio } from '@/server/services/reports/kpi'
import type { KpiBaseline, KpiBaselineValue, KpiDetailDto, KpiItemDto, KpiMeasure } from '@/server/services/reports/screens'
import { formatDateTime } from '@/ui/format'
import { hoursText, percentText } from '@/ui/insight/format'
import type { KpiGoalView, KpiMeasureView } from '@/ui/insight/kpi-table'
import type { KpiItemView } from '@/ui/insight/kpi-items'
import { documentHref, doaVersionHref, type LinkRights } from '@/ui/insight/links'

// The KPI page's figures in words (spec §11.4, FR-VIS-003 AC2): each measure of G-1 to G-5 with what it counts in plain
// words, its value for the period (a share with one decimal and "x of y", a time in business hours, a count), the Phase 0
// baseline or that none is recorded yet, the target the spec proposes, and the link to the documents it counts.

// The translators' types come from calls: an instantiation expression over the namespace costs the checker far more
const _kpiTranslator = () => getTranslations('kpi')
const _timelineTranslator = () => getTranslations('timeline')
export type KpiT = Awaited<ReturnType<typeof _kpiTranslator>>
export type TimelineT = Awaited<ReturnType<typeof _timelineTranslator>>

/** The KPI page opens on the 60 days of the review (FR-VIS-003 AC3) */
export const KPI_REVIEW_DAYS = 60

/** A calendar day "YYYY-MM-DD" as each language shows it */
export const dayText = (locale: string, day: string): string => (locale === 'en' ? formatEnglishBeDate(`${day}T00:00:00+07:00`) : formatThaiDate(`${day}T00:00:00+07:00`))

const KINDS = ['PURCHASE_REQUEST', 'PURCHASE_ORDER', 'VARIANCE', 'DOA_VERSION', 'ORG_AUTHORITY_CHANGE'] as const
export type KpiKind = (typeof KINDS)[number]
export const isKind = (kind: string): kind is KpiKind => (KINDS as readonly string[]).includes(kind)

function ratioValue(t: KpiT, r: Ratio, unit: 'decisions' | 'tasks'): { value: string; detail: string | null; empty: boolean } {
  const pct = percentText(r.numerator, r.denominator)
  // nothing counted in the period: no share and no list to open — words only, as an empty median reads, never a bare
  // "0 จาก 0" that would look like a number leading nowhere (§9.9: every number opens its list)
  if (pct === null) return { value: t('values.noneYet'), detail: null, empty: true }
  return { value: t('values.percent', { value: pct }), detail: t(`values.of.${unit}`, { numerator: r.numerator, denominator: r.denominator ?? 0 }), empty: false }
}

const timeValue = (t: KpiT, minutes: number | null) => ({ value: minutes === null ? t('values.noneYet') : t('values.hours', { value: hoursText(minutes) }), detail: null, empty: minutes === null })

/**
 * A count, a number like every other: it opens its list even when it is 0 (§9.9 every number opens its list), and the
 * list then says nothing was counted in the period. Only words with no number ("ยังไม่มีข้อมูลในช่วงนี้": a share of
 * nothing, a time with no data) lead nowhere.
 */
const countValue = (t: KpiT, count: number) => ({ value: t('values.count', { count }) })

function baselineText(t: KpiT, value: KpiBaselineValue | undefined, baseline: KpiBaseline | null, locale: string): string {
  if (!baseline || !value) return t('baseline.notRecorded')
  const on = dayText(locale, baseline.measuredOn)
  if (value.kind === 'ratio') {
    const pct = percentText(value.numerator, value.denominator)
    // a share of nothing is no value: never shown as 0.0%
    return pct === null ? t('baseline.notRecorded') : t('baseline.value', { value: t('values.percent', { value: pct }), date: on })
  }
  if (value.kind === 'minutes') return t('baseline.value', { value: t('values.hours', { value: hoursText(value.minutes) }), date: on })
  return t('baseline.value', { value: t('values.count', { count: value.count }), date: on })
}

export function kpiGoals(t: KpiT, locale: string, kpi: KpiResult, baseline: KpiBaseline | null, query: string): KpiGoalView[] {
  const measure = (
    id: KpiMeasure,
    figure: { value: string; detail: string | null; empty?: boolean },
    extra: { href?: string; name?: string; formula?: string; baseline?: KpiBaselineValue } = {},
  ): KpiMeasureView => {
    const name = extra.name ?? t(`measures.${id}.name`)
    return {
      id: extra.href ?? id,
      name,
      formula: extra.formula ?? t(`measures.${id}.formula`),
      value: figure.value,
      detail: figure.detail,
      // words with no number behind them ("no data in this period") lead nowhere; every number does, 0 too
      href: figure.empty ? null : (extra.href ?? `/kpi/${id}${query}`),
      linkLabel: t('linkLabel', { name, value: figure.detail ? `${figure.value} (${figure.detail})` : figure.value }),
      // a row of one kind of document compares with that kind's baseline only, never the total's
      baseline: baselineText(t, extra.href ? extra.baseline : baseline?.values[id], baseline, locale),
      target: t(`measures.${id}.target`),
    }
  }
  const kinds = Object.entries(kpi.g5.bySubject)
    .filter(([kind]) => isKind(kind))
    .sort(([a], [b]) => KINDS.indexOf(a as KpiKind) - KINDS.indexOf(b as KpiKind))
  const amp = query ? '&' : '?'
  return [
    { code: 'G-1', title: t('goals.G-1'), measures: [measure('g1', { ...countValue(t, kpi.g1.numerator), detail: t('values.noDenominator') })] },
    {
      code: 'G-2',
      title: t('goals.G-2'),
      measures: [
        // its list holds every decision it checked, the misrouted ones counted: "0 รายการ" opens them, and says none was
        // checked when none was
        measure('g2a', { ...countValue(t, kpi.g2.misrouted), detail: t('values.checked', { count: kpi.g2.checked }) }),
        measure('g2b', ratioValue(t, kpi.g2.withDoaReference, 'decisions')),
      ],
    },
    {
      code: 'G-3',
      title: t('goals.G-3'),
      measures: [measure('g3a', timeValue(t, kpi.g3.submitToPoMedianMinutes)), measure('g3b', timeValue(t, kpi.g3.decisionMedianMinutes)), measure('g3c', ratioValue(t, kpi.g3.pastDue, 'tasks'))],
    },
    { code: 'G-4', title: t('goals.G-4'), measures: [measure('g4', { ...countValue(t, kpi.g4.tasksOnFailedBudgetCheck), detail: null })] },
    {
      code: 'G-5',
      title: t('goals.G-5'),
      measures: [
        measure('g5', ratioValue(t, kpi.g5.total, 'decisions')),
        ...kinds.map(([kind, r]) =>
          measure('g5', ratioValue(t, r, 'decisions'), {
            href: `/kpi/g5${query}${amp}kind=${kind}`,
            name: t('measures.g5.byKind', { kind: t(`kinds.${kind as KpiKind}`) }),
            formula: t('measures.g5.byKindFormula', { kind: t(`kinds.${kind as KpiKind}`) }),
            baseline: baseline?.g5ByKind?.[kind],
          }),
        ),
      ],
    },
  ]
}

/** The figure a list stands behind, in a sentence: "นับ 3 จาก 5 รายการ" for a list of items counted or not, else "5 รายการ" */
export function detailSentence(t: KpiT, d: KpiDetailDto): string {
  if (d.measure === 'g2a' || d.measure === 'g2b' || d.measure === 'g5') return t('items.countedOf', { counted: d.counted, total: d.total })
  return t('items.count', { count: d.total })
}

/** A list cut short says so, and which items it kept: the newest, or for G-2 (a) the misrouted ones first */
export function cappedSentence(t: KpiT, d: KpiDetailDto): string | null {
  if (d.items.length >= d.total) return null
  return t(d.measure === 'g2a' ? 'items.cappedCountedFirst' : 'items.capped', { shown: d.items.length, total: d.total })
}

const DECISIONS = ['APPROVE', 'RETURN', 'REJECT'] as const
const CHANNELS = ['WEB', 'LIFF', 'LINE_CHAT', 'PWA', 'EMAIL', 'PORTAL', 'SYSTEM', 'API', 'MCP'] as const
const DOCUMENTS = ['REQUEST', 'PURCHASE_ORDER', 'VARIANCE', 'DOA_VERSION', 'ORG_AUTHORITY_CHANGE'] as const
const MARK_KIND = {
  MOBILE: 'done',
  NOT_MOBILE: 'closed',
  WITH_DOA: 'done',
  WITHOUT_DOA: 'overdue',
  MISROUTED: 'overdue',
  DOA_MATCHED: 'done',
  PAST_DUE_DECIDED: 'overdue',
  PAST_DUE_OPEN: 'overdue',
} as const

export function kpiItemViews(t: KpiT, tl: TimelineT, locale: string, measure: KpiMeasure, items: readonly KpiItemDto[], rights: LinkRights): KpiItemView[] {
  const nameOf = (p: { nameTh: string; nameEn: string | null } | null) => (p ? (locale === 'en' && p.nameEn ? p.nameEn : p.nameTh) : '')
  return items.map((item) => {
    const doc = item.document
    const title = doc && (DOCUMENTS as readonly string[]).includes(doc.type) ? t(`items.document.${doc.type as (typeof DOCUMENTS)[number]}`, { label: doc.label }) : t('items.document.unknown')
    const lines: string[] = []
    const channel = item.channel && (CHANNELS as readonly string[]).includes(item.channel) ? tl(`channel.${item.channel as (typeof CHANNELS)[number]}`) : null
    if (item.decision) {
      const decision = (DECISIONS as readonly string[]).includes(item.decision) ? t(`items.decision.${item.decision as (typeof DECISIONS)[number]}`) : item.decision
      lines.push(t('items.decidedBy', { decision, name: nameOf(item.person) }) + (item.onBehalfOf ? ` · ${t('items.onBehalfOf', { name: nameOf(item.onBehalfOf) })}` : ''))
      lines.push(channel ? t('items.atVia', { time: formatDateTime(locale, item.at), channel }) : t('items.at', { time: formatDateTime(locale, item.at) }))
    } else if (measure === 'g1') lines.push(t('items.poApprovedAt', { time: formatDateTime(locale, item.at) }))
    else if (measure === 'g3a') lines.push(t('items.firstPoAt', { time: formatDateTime(locale, item.at), hours: hoursText(item.minutes ?? 0) }))
    else {
      lines.push(t('items.heldBy', { name: nameOf(item.person) }))
      if (item.minutes !== null) lines.push(t('items.decidedAfter', { time: formatDateTime(locale, item.at), hours: hoursText(item.minutes) }))
      else lines.push(t('items.assignedAt', { time: formatDateTime(locale, item.at) }))
      if (item.dueAt) lines.push(t('items.dueAt', { time: formatDateTime(locale, item.dueAt) }))
    }
    return {
      id: item.key,
      title,
      href: doc ? documentHref({ type: doc.type, id: doc.id, poId: doc.poId }, rights) : null,
      lines,
      doa: item.doaRef ? { text: tl('doaRef', { code: item.doaRef.code, version: item.doaRef.versionNo, rule: item.doaRef.ruleCode }), href: doaVersionHref(item.doaRef.versionId, rights) } : null,
      mark: item.mark ? { kind: MARK_KIND[item.mark], text: t(`items.mark.${item.mark}`, { channel: channel ?? '-' }) } : null,
    }
  })
}
