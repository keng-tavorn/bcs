import Link from 'next/link'
import { useLocale, useTranslations } from 'next-intl'
import { formatSatang } from '@/core/money/format'
import { formatDateTime } from '../format'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../shadcn/table'

// The parts of /admin/ai that NEW-125 adds (ADR-081), drawn on the server from what the AI module's report service
// read: the month's results (every number a link to the history it counts, §9.9), the history of the settings, and the
// history of the work (a table on a computer, a list on a phone, §9.9). The values the AI read and what the person typed
// instead come only when the service gave them (AUDITOR and the member who asked).

type Name = { readonly th: string; readonly en: string | null }

export const ACTIVITY_SHOWS = ['ALL', 'FILLED', 'EDITED', 'FLAGGED', 'HELPFUL', 'NOT_HELPFUL', 'FAILED'] as const
export type ActivityShow = (typeof ACTIVITY_SHOWS)[number]

/** The history of the work with a filter: the link of a number of the month's results */
export function activityHref(filter: { show?: ActivityShow; month?: string | null; agent?: string | null; before?: string | null }): string {
  const q = new URLSearchParams()
  if (filter.show && filter.show !== 'ALL') q.set('show', filter.show)
  if (filter.month) q.set('month', filter.month)
  if (filter.agent) q.set('agent', filter.agent)
  if (filter.before) q.set('before', filter.before)
  const query = q.toString()
  return `/admin/ai${query ? `?${query}` : ''}#ai-activity`
}

/** "YYYY-MM" as each language names a month, with the Buddhist year (FR-PLT-002 AC3) */
export function monthLabel(locale: string, month: string): string {
  const at = new Date(`${month}-01T00:00:00Z`)
  if (locale !== 'en') return new Intl.DateTimeFormat('th-TH', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(at)
  return `${new Intl.DateTimeFormat('en-US', { month: 'long', timeZone: 'UTC' }).format(at)} ${at.getUTCFullYear() + 543}`
}

const nameIn = (locale: string, n: Name) => (locale === 'en' ? (n.en ?? n.th) : n.th)
const NUMBER = (locale: string) => new Intl.NumberFormat(locale === 'en' ? 'en-US' : 'th-TH')
const linkClass = 'font-medium text-primary underline underline-offset-4 hover:no-underline'

// ---------- the month's results ----------

export interface MonthResultsView {
  readonly month: string
  readonly calls: { readonly total: number; readonly failed: number }
  readonly agents: ReadonlyArray<{ readonly agent: string; readonly calls: number; readonly credits: number }>
  readonly fields: { readonly documents: number; readonly filled: number; readonly kept: number; readonly changed: number; readonly editedDocuments: number }
  readonly checks: { readonly flagged: number; readonly decided: number }
  readonly feedback: { readonly helpful: number; readonly notHelpful: number }
  readonly credits: { readonly used: number; readonly granted: number }
  readonly found: { readonly satang: bigint; readonly invoices: number; readonly list: ReadonlyArray<{ readonly invoiceId: string; readonly number: string | null; readonly supplier: Name; readonly satang: bigint; readonly types: readonly string[] }> } | null
}

export function AiMonthResults({ data, agentNames }: { data: MonthResultsView; agentNames: Readonly<Record<string, string>> }) {
  const t = useTranslations('admin.ai.results')
  const tx = useTranslations('apInvoice.exceptions.type')
  const locale = useLocale()
  const n = NUMBER(locale).format
  const href = (show: ActivityShow, agent?: string) => activityHref({ show, month: data.month, agent: agent ?? null })
  return (
    <div className="flex flex-col gap-4">
      <p className="text-ink-muted">{t('intro')}</p>
      <ul className="flex flex-col gap-3">
        <li className="flex flex-col gap-0.5">
          <Link href={href('ALL')} className={linkClass}>
            {t('calls', { count: n(data.calls.total) })}
          </Link>
          {data.calls.failed > 0 ? (
            <Link href={href('FAILED')} className={`${linkClass} self-start text-base md:text-sm`}>
              {t('callsFailed', { count: n(data.calls.failed) })}
            </Link>
          ) : null}
        </li>
        <li className="flex flex-col gap-0.5">
          <Link href={href('FILLED')} className={linkClass}>
            {t('fields', { filled: n(data.fields.filled), documents: n(data.fields.documents) })}
          </Link>
          <Link href={href('FILLED')} className={`${linkClass} self-start text-base md:text-sm`}>
            {t('fieldsKept', { kept: n(data.fields.kept) })}
          </Link>
          <Link href={href('EDITED')} className={`${linkClass} self-start text-base md:text-sm`}>
            {t('fieldsChanged', { changed: n(data.fields.changed), documents: n(data.fields.editedDocuments) })}
          </Link>
        </li>
        <li className="flex flex-col gap-0.5">
          <Link href={href('FLAGGED')} className={linkClass}>
            {t('checks', { count: n(data.checks.flagged) })}
          </Link>
          <Link href={href('FLAGGED')} className={`${linkClass} self-start text-base md:text-sm`}>
            {t('checksDecided', { count: n(data.checks.decided) })}
          </Link>
        </li>
        <li className="flex flex-col gap-0.5">
          <span>{t('feedback')}</span>
          <span className="flex flex-wrap gap-x-4 gap-y-1">
            <Link href={href('HELPFUL')} className={linkClass}>
              {t('helpful', { count: n(data.feedback.helpful) })}
            </Link>
            <Link href={href('NOT_HELPFUL')} className={linkClass}>
              {t('notHelpful', { count: n(data.feedback.notHelpful) })}
            </Link>
          </span>
        </li>
        {data.found ? (
          <li className="flex flex-col gap-0.5">
            {data.found.invoices > 0 ? (
              <Link href="#ai-found" className={linkClass}>
                {t('found', { amount: formatSatang(data.found.satang), count: n(data.found.invoices) })}
              </Link>
            ) : (
              <span>{t('foundNone')}</span>
            )}
            <span className="text-base text-ink-muted md:text-sm">{t('foundNote')}</span>
          </li>
        ) : null}
        <li>
          <Link href={href('ALL')} className={linkClass}>
            {t('credits', { used: n(data.credits.used), granted: n(data.credits.granted) })}
          </Link>
        </li>
      </ul>
      <section aria-labelledby="ai-results-agents" className="flex flex-col gap-2">
        <h3 id="ai-results-agents" className="font-semibold">
          {t('agentsTitle')}
        </h3>
        <ul className="flex flex-col divide-y divide-line border-y border-line">
          {data.agents.map((a) => (
            <li key={a.agent} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 py-2">
              <span>{agentNames[a.agent] ?? a.agent}</span>
              <span className="flex gap-4 tabular-nums">
                <Link href={href('ALL', a.agent)} className={linkClass}>
                  {t('agentCalls', { calls: n(a.calls) })}
                </Link>
                <Link href={href('ALL', a.agent)} className={linkClass}>
                  {t('agentCredits', { credits: n(a.credits) })}
                </Link>
              </span>
            </li>
          ))}
        </ul>
      </section>
      {data.found && data.found.list.length > 0 ? (
        <section aria-labelledby="ai-found" className="flex flex-col gap-2">
          <h3 id="ai-found" className="font-semibold">
            {t('foundTitle')}
          </h3>
          {data.found.invoices > data.found.list.length ? <p className="text-base text-ink-muted md:text-sm">{t('foundMore', { shown: n(data.found.list.length), total: n(data.found.invoices) })}</p> : null}
          <ul aria-label={t('foundTitle')} className="flex flex-col divide-y divide-line border-y border-line md:hidden">
            {data.found.list.map((f) => (
              <li key={f.invoiceId} className="flex flex-col gap-1 py-3">
                <span className="flex items-baseline justify-between gap-3">
                  <span className="font-medium break-words">{f.number ?? '-'}</span>
                  <span className="text-right tabular-nums">{formatSatang(f.satang)}</span>
                </span>
                <span className="text-ink-muted">{nameIn(locale, f.supplier)}</span>
                <span className="text-ink-muted">{f.types.map((x) => tx(x as 'PRICE_OVER')).join(' · ')}</span>
              </li>
            ))}
          </ul>
          <div className="hidden md:block">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('foundColumns.invoice')}</TableHead>
                  <TableHead>{t('foundColumns.supplier')}</TableHead>
                  <TableHead>{t('foundColumns.reason')}</TableHead>
                  <TableHead className="text-right">{t('foundColumns.amount')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.found.list.map((f) => (
                  <TableRow key={f.invoiceId}>
                    <TableCell>{f.number ?? '-'}</TableCell>
                    <TableCell className="whitespace-normal">{nameIn(locale, f.supplier)}</TableCell>
                    <TableCell className="whitespace-normal">{f.types.map((x) => tx(x as 'PRICE_OVER')).join(' · ')}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatSatang(f.satang)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </section>
      ) : null}
    </div>
  )
}

// ---------- the history of the settings ----------

export interface SettingChangeView {
  readonly type: 'ai_agent.enabled' | 'ai_agent.disabled' | 'ai_agent.updated'
  readonly agent: string
  readonly minConfidenceBp: number
  readonly version: number
  readonly by: Name | null
  readonly at: string
}

const BP_PER_PERCENT = 100

export function AiSettingChanges({ changes, agentNames }: { changes: readonly SettingChangeView[]; agentNames: Readonly<Record<string, string>> }) {
  const t = useTranslations('admin.ai.changes')
  const locale = useLocale()
  if (changes.length === 0) return <p className="text-ink-muted">{t('empty')}</p>
  const what = { 'ai_agent.enabled': 'enabled', 'ai_agent.disabled': 'disabled', 'ai_agent.updated': 'updated' } as const
  return (
    <ul aria-label={t('title')} className="flex flex-col divide-y divide-line">
      {changes.map((c, i) => {
        const at = formatDateTime(locale, c.at)
        return (
          <li key={`${c.agent}-${c.version}-${i}`} className="flex flex-col gap-0.5 py-3 first:pt-0 last:pb-0">
            <span className="font-medium">{t(what[c.type], { name: agentNames[c.agent] ?? c.agent })}</span>
            <span className="text-base text-ink-muted md:text-sm">{t('detail', { version: c.version + 1, percent: c.minConfidenceBp / BP_PER_PERCENT })}</span>
            <span className="text-base text-ink-muted md:text-sm">{c.by ? t('by', { name: nameIn(locale, c.by), at }) : t('bySystem', { at })}</span>
          </li>
        )
      })}
    </ul>
  )
}

// ---------- the history of the work ----------

export type DataUsedView = { readonly kind: 'FILES'; readonly count: number } | { readonly kind: 'REQUEST_TYPE'; readonly code: string } | { readonly kind: 'APPROVAL_TASK' } | { readonly kind: 'TOOL'; readonly name: string }

export interface ActivityRowView {
  readonly id: string
  readonly createdAt: string
  readonly agent: string
  readonly purpose: string
  readonly level: string
  readonly status: string
  readonly channel: string
  readonly requester: Name | null
  readonly subject: { readonly type: string; readonly number: string | null } | null
  readonly dataUsed: readonly DataUsedView[]
  readonly filled: number
  readonly changedPaths: readonly string[]
  readonly changes: ReadonlyArray<{ readonly path: string; readonly ai: string | null; readonly final: string | null }> | null
  readonly checks: 'WARN' | 'FAIL' | null
  readonly feedback: 'HELPFUL' | 'NOT_HELPFUL' | null
  readonly costCredits: number
  readonly errorCode: string | null
}

export interface ActivityView {
  readonly filter: { readonly show: ActivityShow; readonly month: string | null; readonly agent: string | null }
  readonly rows: readonly ActivityRowView[]
  readonly before: string | null
  /** The page was read from an older id (a "newest" link is shown) */
  readonly paged: boolean
}

const FIELD_NAMES = ['supplierInvoiceNo', 'invoiceDate', 'statedVat', 'discount', 'priceIncludesVat', 'includesVat', 'quantity', 'qty', 'unitPrice', 'amount', 'received', 'supplierId', 'supplierName', 'description', 'title'] as const
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function useActivityCells({ row }: { row: ActivityRowView }) {
  const t = useTranslations('admin.ai.activity')
  const tf = useTranslations('admin.ai.activity.fields')
  const locale = useLocale()
  const n = NUMBER(locale).format
  // A form path in words: its last named part (a line's index or id is not a name), as the field it is
  const field = (path: string) => {
    const parts = path.split('.')
    const leaf = [...parts].reverse().find((p) => !/^\d+$/.test(p) && !UUID.test(p)) ?? path
    const index = parts.find((p) => /^\d+$/.test(p))
    const named = (FIELD_NAMES as readonly string[]).includes(leaf) ? tf(leaf as (typeof FIELD_NAMES)[number]) : leaf
    return index === undefined ? named : tf('line', { field: named, line: Number(index) + 1 })
  }
  const status = row.level === 'L0' && row.status === 'DRAFT' ? t('statusDone') : t(`statuses.${row.status as 'DRAFT'}`)
  const data = row.dataUsed.map((d) =>
    d.kind === 'FILES' ? t('data.FILES', { count: n(d.count) }) : d.kind === 'REQUEST_TYPE' ? t('data.REQUEST_TYPE', { code: d.code }) : d.kind === 'APPROVAL_TASK' ? t('data.APPROVAL_TASK') : t('data.TOOL', { tool: t.has(`tools.${d.name}` as `tools.search_documents`) ? t(`tools.${d.name as 'search_documents'}`) : d.name }),
  )
  return {
    when: formatDateTime(locale, row.createdAt),
    who: (
      <span className="flex flex-col">
        <span>{row.requester ? nameIn(locale, row.requester) : t('system')}</span>
        <span className="text-base text-ink-muted md:text-sm">{t('via', { channel: t.has(`channels.${row.channel}` as `channels.WEB`) ? t(`channels.${row.channel as 'WEB'}`) : row.channel })}</span>
      </span>
    ),
    what: (
      <span className="flex flex-col">
        <span>{t(`purposes.${row.purpose as 'QUESTION'}`)}</span>
        <span className="text-base text-ink-muted md:text-sm">{row.subject ? `${t(`subjects.${row.subject.type as 'REQUEST'}`)}${row.subject.number ? ` ${row.subject.number}` : ''} · ${status}` : status}</span>
        {row.errorCode ? <span className="text-base text-ink-muted md:text-sm">{t('error', { code: row.errorCode })}</span> : null}
      </span>
    ),
    data: data.length ? data.join(' · ') : t('nothing'),
    changes: (
      <span className="flex flex-col gap-0.5">
        {row.filled > 0 ? <span>{t('filled', { count: n(row.filled) })}</span> : null}
        {row.changedPaths.length ? (
          <span>{t('changed', { count: n(row.changedPaths.length), fields: row.changedPaths.map(field).join(', ') })}</span>
        ) : row.filled > 0 && (row.status === 'ACCEPTED' || row.status === 'EDITED') ? (
          <span className="text-ink-muted">{t('kept')}</span>
        ) : null}
        {row.changes?.map((c) => (
          <span key={c.path} className="text-base text-ink-muted md:text-sm">
            {t('change', { field: field(c.path), ai: c.ai ?? t('blank'), final: c.final ?? t('blank') })}
          </span>
        ))}
        {row.checks ? <span className="text-base text-ink-muted md:text-sm">{t(row.checks === 'FAIL' ? 'checksFAIL' : 'checksWARN')}</span> : null}
        {row.feedback ? <span className="text-base text-ink-muted md:text-sm">{t(row.feedback === 'HELPFUL' ? 'helpful' : 'notHelpful')}</span> : null}
        {row.filled === 0 && !row.checks && !row.feedback ? <span className="text-ink-muted">{t('nothing')}</span> : null}
      </span>
    ),
    credits: t('creditsValue', { credits: n(row.costCredits) }),
  }
}

function ActivityTableRow({ row }: { row: ActivityRowView }) {
  const c = useActivityCells({ row })
  return (
    <TableRow>
      <TableCell className="align-top">{c.when}</TableCell>
      <TableCell className="align-top whitespace-normal">{c.who}</TableCell>
      <TableCell className="align-top whitespace-normal">{c.what}</TableCell>
      <TableCell className="align-top whitespace-normal">{c.data}</TableCell>
      <TableCell className="align-top whitespace-normal">{c.changes}</TableCell>
      <TableCell className="text-right align-top tabular-nums">{c.credits}</TableCell>
    </TableRow>
  )
}

function ActivityListItem({ row }: { row: ActivityRowView }) {
  const c = useActivityCells({ row })
  const t = useTranslations('admin.ai.activity.columns')
  return (
    <li className="flex flex-col gap-1 py-3">
      <span className="flex items-baseline justify-between gap-3">
        <span className="text-ink-muted">{c.when}</span>
        <span className="text-right tabular-nums text-ink-muted">{c.credits}</span>
      </span>
      {c.what}
      {c.who}
      <span className="text-base md:text-sm">
        <span className="text-ink-muted">{`${t('data')}: `}</span>
        {c.data}
      </span>
      {c.changes}
    </li>
  )
}

export function AiActivity({ data, agentNames }: { data: ActivityView; agentNames: Readonly<Record<string, string>> }) {
  const t = useTranslations('admin.ai.activity')
  const locale = useLocale()
  const { show, month, agent } = data.filter
  const filtered = show !== 'ALL' || month !== null || agent !== null
  const what = [t(`filters.${show}`), agent ? t('ofAgent', { name: agentNames[agent] ?? agent }) : null, month ? t('inMonth', { month: monthLabel(locale, month) }) : null].filter(Boolean).join(' ')
  return (
    <div className="flex flex-col gap-3">
      <p className="text-ink-muted">{t('intro')}</p>
      {filtered ? (
        <p className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <span>{t('showing', { filter: what })}</span>
          <Link href="/admin/ai#ai-activity" className={linkClass}>
            {t('clear')}
          </Link>
        </p>
      ) : null}
      {data.rows.length === 0 ? (
        <p className="text-ink-muted">{filtered || data.paged ? t('emptyFiltered') : t('empty')}</p>
      ) : (
        <>
          <ul aria-label={t('title')} className="flex flex-col divide-y divide-line border-y border-line lg:hidden">
            {data.rows.map((r) => (
              <ActivityListItem key={r.id} row={r} />
            ))}
          </ul>
          <div className="hidden lg:block">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('columns.when')}</TableHead>
                  <TableHead>{t('columns.who')}</TableHead>
                  <TableHead>{t('columns.what')}</TableHead>
                  <TableHead>{t('columns.data')}</TableHead>
                  <TableHead>{t('columns.changes')}</TableHead>
                  <TableHead className="text-right">{t('columns.credits')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.rows.map((r) => (
                  <ActivityTableRow key={r.id} row={r} />
                ))}
              </TableBody>
            </Table>
          </div>
        </>
      )}
      {data.before || data.paged ? (
        <p className="flex flex-wrap gap-x-4 gap-y-1">
          {data.before ? (
            <Link href={activityHref({ show, month, agent, before: data.before })} className={linkClass}>
              {t('older')}
            </Link>
          ) : null}
          {data.paged ? (
            <Link href={activityHref({ show, month, agent })} className={linkClass}>
              {t('newest')}
            </Link>
          ) : null}
        </p>
      ) : null}
    </div>
  )
}
