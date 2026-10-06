import { getTranslations } from 'next-intl/server'
import { z } from 'zod'
import { AUDIT_CHANNELS, type AuditFilter, type AuditRowDto } from '@/server/services/audit'
import { formatDateTime } from '@/ui/format'
import type { AuditRowView } from '@/ui/insight/audit-results'
import { daysBefore } from '@/ui/insight/format'
import { documentHref, doaVersionHref, type LinkRights } from '@/ui/insight/links'

// The audit page's search (GET) and rows (spec §4.5, FR-VIS-004 AC1): the address carries the document number, the
// actor, the period in Thai days, the event type and the channel; anything that is not one of these is left out. Rows
// are translated: the event in words, the document by its number, the actor and on whose behalf, the channel, and the
// DOA version and rule as "DOA-DEMO ฉบับ 1 ข้อ PR-02".

// The translators' types come from calls: an instantiation expression over the namespace costs the checker far more
const _auditTranslator = () => getTranslations('audit')
const _timelineTranslator = () => getTranslations('timeline')
export type AuditT = Awaited<ReturnType<typeof _auditTranslator>>
export type TimelineT = Awaited<ReturnType<typeof _timelineTranslator>>
type Params = Record<string, string | string[] | undefined>

/** Thai days begin at 00:00 in Thai time; the organization's days are read the same way by the reports (periodOf) */
const THAI_OFFSET = '+07:00'
const DOCUMENT_MAX = 60
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)
const DAY = z.iso.date()
const TYPE = /^[a-z][a-z0-9_]*\.[a-z0-9][a-z0-9_]*$/

export interface AuditForm {
  readonly document: string
  readonly actor: string
  readonly from: string
  readonly to: string
  readonly type: string
  readonly channel: string
}

/**
 * The search of the address. `reversed`: its period ends before it starts ("ถึงวันที่" before "ตั้งแต่วันที่"), so it
 * holds no event — the page says so at the field and shows no results rather than "ไม่พบบันทึก…" (§9.9 rules 7, 8)
 */
export function auditQuery(params: Params): { filter: AuditFilter; form: AuditForm; before: string | undefined; searched: boolean; reversed: boolean } {
  const document = (one(params.document) ?? '').trim().slice(0, DOCUMENT_MAX)
  const actor = one(params.actor) ?? ''
  const from = one(params.from) ?? ''
  const to = one(params.to) ?? ''
  const type = one(params.type) ?? ''
  const channel = one(params.channel) ?? ''
  const before = one(params.before)
  const form: AuditForm = {
    document,
    actor: z.uuid().safeParse(actor).success ? actor : '',
    from: DAY.safeParse(from).success ? from : '',
    to: DAY.safeParse(to).success ? to : '',
    type: TYPE.test(type) ? type : '',
    channel: (AUDIT_CHANNELS as readonly string[]).includes(channel) ? channel : '',
  }
  const filter: AuditFilter = {
    ...(form.document ? { document: form.document } : {}),
    ...(form.actor ? { actorMemberId: form.actor } : {}),
    ...(form.from ? { from: `${form.from}T00:00:00${THAI_OFFSET}` } : {}),
    // the "to" day is included: up to 00:00 of the day after
    ...(form.to ? { to: `${daysBefore(form.to, -1)}T00:00:00${THAI_OFFSET}` } : {}),
    ...(form.type ? { types: [form.type] } : {}),
    ...(form.channel ? { channel: form.channel as (typeof AUDIT_CHANNELS)[number] } : {}),
  }
  return {
    filter,
    form,
    before: before && /^\d{1,19}$/.test(before) ? before : undefined,
    searched: Object.values(form).some(Boolean),
    // days of the form yyyy-mm-dd compare as text
    reversed: form.from !== '' && form.to !== '' && form.from > form.to,
  }
}

/** The search again as a query string, with the page to continue from */
export function auditHref(form: AuditForm, before?: string): string {
  const q = new URLSearchParams()
  for (const [k, v] of Object.entries(form)) if (v) q.set(k, v)
  if (before) q.set('before', before)
  const s = q.toString()
  return s ? `/audit?${s}` : '/audit'
}

type Labels = Readonly<Record<string, Readonly<Record<string, string>>>>

/** An event type in words ("ตัดสินงานอนุมัติ"), or the type itself when no words are written for it */
export function eventLabel(events: Labels, type: string): string {
  const [group, verb] = type.split('.')
  return (group && verb && events[group]?.[verb]) || type
}

const DECISIONS = ['APPROVE', 'RETURN', 'REJECT'] as const
const DOCUMENTS = ['REQUEST', 'PURCHASE_ORDER', 'GOODS_RECEIPT', 'VARIANCE', 'INVOICE', 'EXPORT', 'DOA_VERSION', 'ORG_AUTHORITY_CHANGE', 'BUDGET_LINE', 'MEMBER', 'SUPPLIER'] as const
const EXPORT_KINDS = ['AUDIT', 'REPORT', 'EXPRESS_AP'] as const

export function auditRowViews(t: AuditT, tl: TimelineT, locale: string, rows: readonly AuditRowDto[], events: Labels, aggregates: Readonly<Record<string, string>>, rights: LinkRights): AuditRowView[] {
  return rows.map((r) => {
    const decision = (r.data as { decision?: unknown } | null)?.decision
    const decided = typeof decision === 'string' && (DECISIONS as readonly string[]).includes(decision) ? t(`decision.${decision as (typeof DECISIONS)[number]}`) : null
    const label = eventLabel(events, r.type)
    const doc = r.document
    let document: AuditRowView['document'] = null
    if (doc && (DOCUMENTS as readonly string[]).includes(doc.type)) {
      const kind = doc.type === 'EXPORT' ? ((EXPORT_KINDS as readonly string[]).includes(doc.label) ? t(`exportKind.${doc.label as (typeof EXPORT_KINDS)[number]}`) : doc.label) : doc.label
      document = { text: t(`document.${doc.type}`, { label: kind, version: doc.versionNo ?? '-' }), href: documentHref({ type: doc.type, id: doc.id, poId: doc.poId }, rights) }
    } else if (aggregates[r.aggregateType]) document = { text: aggregates[r.aggregateType]!, href: null }
    const actor = r.actorType === 'USER' ? (r.actorName ?? t('actor.unknown')) : r.actorType === 'SYSTEM' ? t('actor.SYSTEM') : r.actorType === 'PLATFORM_ADMIN' ? t('actor.PLATFORM_ADMIN') : t('actor.other')
    const channel = (AUDIT_CHANNELS as readonly string[]).includes(r.channel) ? tl(`channel.${r.channel as (typeof AUDIT_CHANNELS)[number]}`) : r.channel
    return {
      id: r.seq,
      seq: t('seq', { seq: r.seq }),
      when: formatDateTime(locale, r.occurredAt),
      event: decided ? t('eventWithDecision', { event: label, decision: decided }) : label,
      document,
      actor,
      onBehalfOf: r.onBehalfOfName ? t('onBehalfOf', { name: r.onBehalfOfName }) : null,
      channel,
      doa:
        r.doaRuleCode && r.doaVersion && r.doaVersionId
          ? { text: tl('doaRef', { code: r.doaVersion.code, version: r.doaVersion.versionNo, rule: r.doaRuleCode }), href: doaVersionHref(r.doaVersionId, rights) }
          : r.doaRuleCode
            ? { text: r.doaRuleCode, href: null }
            : null,
    }
  })
}
