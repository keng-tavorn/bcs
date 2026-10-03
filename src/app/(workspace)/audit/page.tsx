import Link from 'next/link'
import { getLocale, getMessages, getTranslations } from 'next-intl/server'
import { systemClock } from '@/lib/clock'
import { ctxFromSession } from '@/server/auth/session'
import { auditView } from '@/server/services/audit'
import { Button } from '@/ui/form/button'
import { Field } from '@/ui/form/field'
import { AuditResults } from '@/ui/insight/audit-results'
import { ExportPanel } from '@/ui/insight/export-panel'
import { EmptyState, Refused } from '@/ui/insight/refused'
import { downloadUrlAction } from '../../_lib/file-actions'
import { getSession } from '../../_lib/session'
import { linkRights } from '../board/_rights'
import { dayText } from '../kpi/_present'
import { auditHref, auditQuery, auditRowViews, eventLabel } from './_present'

export async function generateMetadata() {
  const t = await getTranslations('audit')
  return { title: t('title') }
}

const linkClass = 'inline-flex min-h-11 items-center self-start font-medium text-primary underline underline-offset-4 hover:no-underline'
const selectClass = 'h-11 w-full rounded-md border border-input bg-bg px-3 text-base text-ink'
const labelClass = 'font-medium text-ink'

type Labels = Readonly<Record<string, Readonly<Record<string, string>>>>

// The audit trail (spec §9.1 /audit, §4.5, FR-VIS-004 AC1 AC2, FR-DOA-005 AC3, demo scene 9): the AUDITOR — and
// ORG_ADMIN, who may look — searches the events by document, actor, period, type and channel, newest first, 100 a page;
// every row names the DOA version and rule of a decision, the channel, the actor and on whose behalf. Only the AUDITOR
// exports the search as Excel or CSV, with the same columns in every row and the file's checksum; the export is an
// event of its own. auditView checks audit.view; the export route checks audit.export (BR-AUTH-05).
export default async function AuditPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const state = await getSession()
  const ctx = ctxFromSession(state, 'WEB', systemClock.now())
  if (!ctx || state.kind !== 'member') return null
  const [t, tl, locale, messages] = await Promise.all([getTranslations('audit'), getTranslations('timeline'), getLocale(), getMessages()])
  const { filter, form, before, searched } = auditQuery(await searchParams)
  const result = await auditView(ctx, filter, before ? { beforeSeq: before } : {})
  if (!result.ok) return <Refused title={t('title')} message={t('forbidden')} href="/" linkLabel={t('home')} />

  const audit = (messages as unknown as { audit: { events: Labels; groups: Readonly<Record<string, string>>; aggregate: Readonly<Record<string, string>> } }).audit
  const view = result.data
  const rows = auditRowViews(t, tl, locale, view.rows, audit.events, audit.aggregate, linkRights(state.member.id, state.roles))
  const groups = [...new Set(view.eventTypes.map((type) => type.split('.')[0]!))]
  const memberName = (m: { nameTh: string; nameEn: string | null }) => (locale === 'en' && m.nameEn ? m.nameEn : m.nameTh)
  // the browser's date fields may show Christian-era years: the period searched is said again in Buddhist-era days
  const period =
    form.from && form.to
      ? t('search.period.both', { from: dayText(locale, form.from), to: dayText(locale, form.to) })
      : form.from
        ? t('search.period.from', { from: dayText(locale, form.from) })
        : form.to
          ? t('search.period.to', { to: dayText(locale, form.to) })
          : null

  return (
    <div className="flex flex-col gap-6">
      <div className="flex max-w-4xl flex-col gap-2">
        <h1 className="text-2xl font-semibold">{t('title')}</h1>
        <p className="text-ink-muted">{t('intro')}</p>
      </div>

      {/* keyed on the search: a link to another search (or "clear") shows its own values, not the ones last typed */}
      <form key={auditHref(form)} method="get" action="/audit" aria-labelledby="audit-search" className="flex flex-col gap-4 border-y border-line py-4">
        <h2 id="audit-search" className="text-xl font-semibold">
          {t('search.title')}
        </h2>
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          <Field id="audit-document" name="document" label={t('search.document')} hint={t('search.documentHint')} defaultValue={form.document} maxLength={60} autoComplete="off" />
          <div className="flex flex-col gap-1.5">
            <label htmlFor="audit-actor" className={labelClass}>
              {t('search.actor')}
            </label>
            <select id="audit-actor" name="actor" defaultValue={form.actor} className={selectClass}>
              <option value="">{t('search.anyone')}</option>
              {view.members.map((m) => (
                <option key={m.id} value={m.id}>
                  {memberName(m)}
                </option>
              ))}
            </select>
          </div>
          <div className="flex flex-col gap-1.5">
            <label htmlFor="audit-type" className={labelClass}>
              {t('search.type')}
            </label>
            <select id="audit-type" name="type" defaultValue={form.type} className={selectClass}>
              <option value="">{t('search.anyType')}</option>
              {groups.map((group) => (
                <optgroup key={group} label={audit.groups[group] ?? group}>
                  {view.eventTypes
                    .filter((type) => type.startsWith(`${group}.`))
                    .map((type) => (
                      <option key={type} value={type}>
                        {eventLabel(audit.events, type)}
                      </option>
                    ))}
                </optgroup>
              ))}
            </select>
          </div>
          <div className="flex flex-col gap-1.5">
            <label htmlFor="audit-channel" className={labelClass}>
              {t('search.channel')}
            </label>
            <select id="audit-channel" name="channel" defaultValue={form.channel} className={selectClass}>
              <option value="">{t('search.anyChannel')}</option>
              {view.channels.map((c) => (
                <option key={c} value={c}>
                  {tl(`channel.${c}`)}
                </option>
              ))}
            </select>
          </div>
          <Field id="audit-from" name="from" type="date" label={t('search.from')} defaultValue={form.from} />
          <Field id="audit-to" name="to" type="date" label={t('search.to')} defaultValue={form.to} />
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <Button type="submit">{t('search.submit')}</Button>
          {searched ? (
            <Link href="/audit" className={linkClass}>
              {t('search.clear')}
            </Link>
          ) : null}
        </div>
      </form>

      {rows.length ? (
        <section aria-labelledby="audit-export" className="flex max-w-4xl flex-col gap-3">
          <h2 id="audit-export" className="text-xl font-semibold">
            {t('export.title')}
          </h2>
          {view.canExport ? (
            <>
              <p className="text-ink-muted">{t('export.hint')}</p>
              <ExportPanel endpoint="/audit/export" payload={{ filter }} formats={['xlsx', 'csv']} open={downloadUrlAction} />
            </>
          ) : (
            <p className="text-ink-muted">{t('export.auditorOnly')}</p>
          )}
        </section>
      ) : null}

      <section aria-labelledby="audit-results" className="flex flex-col gap-3">
        <h2 id="audit-results" className="text-xl font-semibold">
          {t('results.title')}
        </h2>
        {period ? <p className="font-medium text-ink">{period}</p> : null}
        {rows.length === 0 ? (
          searched ? (
            <EmptyState title={form.document ? t('results.noDocument', { document: form.document }) : t('results.none')} hint={t('results.noneHint')} href="/audit" linkLabel={t('search.clear')} />
          ) : (
            <EmptyState title={t('results.empty')} hint={t('results.emptyHint')} />
          )
        ) : (
          <>
            <p className="text-ink">{before ? t('results.countOlder', { count: rows.length }) : t('results.count', { count: rows.length })}</p>
            <AuditResults
              rows={rows}
              labels={{
                caption: t('results.caption'),
                when: t('results.when'),
                event: t('results.event'),
                document: t('results.document'),
                actor: t('results.actor'),
                channel: t('results.channel'),
                doa: t('results.doa'),
                none: t('results.noneCell'),
              }}
            />
            <nav aria-label={t('results.pages')} className="flex flex-wrap gap-x-6">
              {before ? (
                <Link href={auditHref(form)} className={linkClass}>
                  {t('results.newest')}
                </Link>
              ) : null}
              {view.nextBeforeSeq ? (
                <Link href={auditHref(form, view.nextBeforeSeq)} className={linkClass}>
                  {t('results.older')}
                </Link>
              ) : null}
            </nav>
          </>
        )}
      </section>
    </div>
  )
}
