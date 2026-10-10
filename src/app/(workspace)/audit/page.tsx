import Link from 'next/link'
import { getLocale, getMessages, getTranslations } from 'next-intl/server'
import { systemClock } from '@/lib/clock'
import { ctxFromSession } from '@/server/auth/session'
import { auditView } from '@/server/services/audit'
import { Field } from '@/ui/form/field'
import { AuditPeriod } from '@/ui/insight/audit-period'
import { AuditResults } from '@/ui/insight/audit-results'
import { ExportPanel } from '@/ui/insight/export-panel'
import { Refused } from '@/ui/insight/refused'
import { ListEmpty, Page, PageBody, PageHeader, Panel } from '@/ui/page/page'
import { Button } from '@/ui/shadcn/button'
import { NativeSelect, NativeSelectOptGroup, NativeSelectOption } from '@/ui/shadcn/native-select'
import { downloadUrlAction } from '../../_lib/file-actions'
import { getSession } from '../../_lib/session'
import { linkRights } from '../board/_rights'
import { dayText } from '../kpi/_present'
import { readAuditParams } from './_filters'
import { auditHref, auditQuery, auditRowViews, eventLabel } from './_present'

export async function generateMetadata() {
  const t = await getTranslations('audit')
  return { title: t('title') }
}

const linkClass = 'inline-flex min-h-11 items-center self-start font-medium text-primary underline underline-offset-4 hover:no-underline'
const selectClass = 'w-full [&_select]:h-11 [&_select]:bg-bg [&_select]:text-base lg:[&_select]:h-10'
const labelClass = 'font-medium text-ink'

type Labels = Readonly<Record<string, Readonly<Record<string, string>>>>

// The audit trail (spec §9.1 /audit, §4.5, FR-VIS-004 AC1 AC2, FR-DOA-005 AC3, demo scene 9): the AUDITOR — and
// ORG_ADMIN, who may look — searches the events by document, actor, period, type and channel, newest first, 100 a page;
// every row names the DOA version and rule of a decision, the channel, the actor and on whose behalf. Only the AUDITOR
// exports the search as Excel or CSV, with the same columns in every row and the file's checksum; the export is an
// event of its own. auditView checks audit.view; the export route checks audit.export (BR-AUTH-05). A period that ends
// before it starts is held in the browser before the search, and refused here for an address that carries one: the
// field "ถึงวันที่" says how to fix it, and no results, no export and no "nothing found" show until it is fixed.
// The search lives in the address (./_filters, nuqs). The page's frame (S16-10): the title on the page's white, then
// the search, the export and the results each in a white card on --surface.
export default async function AuditPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const state = await getSession()
  const ctx = ctxFromSession(state, 'WEB', systemClock.now())
  if (!ctx || state.kind !== 'member') return null
  const [t, tl, locale, messages] = await Promise.all([getTranslations('audit'), getTranslations('timeline'), getLocale(), getMessages()])
  const { filter, form, before, searched, reversed } = auditQuery(await readAuditParams(searchParams))
  const result = await auditView(ctx, filter, before ? { beforeSeq: before } : {})
  if (!result.ok) return <Refused title={t('title')} message={t('forbidden')} href="/" linkLabel={t('home')} />

  const audit = (messages as unknown as { audit: { events: Labels; groups: Readonly<Record<string, string>>; aggregate: Readonly<Record<string, string>> } }).audit
  const view = result.data
  const rows = auditRowViews(t, tl, locale, view.rows, audit.events, audit.aggregate, linkRights(state.member.id, state.roles))
  const groups = [...new Set(view.eventTypes.map((type) => type.split('.')[0]!))]
  const memberName = (m: { nameTh: string; nameEn: string | null }) => (locale === 'en' && m.nameEn ? m.nameEn : m.nameTh)
  // the period searched, said again in Buddhist-era days with the results
  const period =
    form.from && form.to
      ? t('search.period.both', { from: dayText(locale, form.from), to: dayText(locale, form.to) })
      : form.from
        ? t('search.period.from', { from: dayText(locale, form.from) })
        : form.to
          ? t('search.period.to', { to: dayText(locale, form.to) })
          : null

  const clearButton = (
    <Button asChild variant="outline" className="min-h-11 lg:min-h-10">
      <Link href="/audit">{t('search.clear')}</Link>
    </Button>
  )

  return (
    <Page>
      <PageHeader title={t('title')} intro={t('intro')} />
      <PageBody>
        <Panel id="audit-search" title={t('search.title')}>
          {/* keyed on the search: a link to another search (or "clear") shows its own values, not the ones last typed */}
          <form key={auditHref(form)} method="get" action="/audit" aria-labelledby="audit-search" className="flex flex-col gap-4">
            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
              <Field id="audit-document" name="document" label={t('search.document')} hint={t('search.documentHint')} defaultValue={form.document} maxLength={60} autoComplete="off" />
              <div className="flex flex-col gap-1.5">
                <label htmlFor="audit-actor" className={labelClass}>
                  {t('search.actor')}
                </label>
                <NativeSelect id="audit-actor" name="actor" defaultValue={form.actor} className={selectClass}>
                  <NativeSelectOption value="">{t('search.anyone')}</NativeSelectOption>
                  {view.members.map((m) => (
                    <NativeSelectOption key={m.id} value={m.id}>
                      {memberName(m)}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
              </div>
              <div className="flex flex-col gap-1.5">
                <label htmlFor="audit-type" className={labelClass}>
                  {t('search.type')}
                </label>
                <NativeSelect id="audit-type" name="type" defaultValue={form.type} className={selectClass}>
                  <NativeSelectOption value="">{t('search.anyType')}</NativeSelectOption>
                  {groups.map((group) => (
                    <NativeSelectOptGroup key={group} label={audit.groups[group] ?? group}>
                      {view.eventTypes
                        .filter((type) => type.startsWith(`${group}.`))
                        .map((type) => (
                          <NativeSelectOption key={type} value={type}>
                            {eventLabel(audit.events, type)}
                          </NativeSelectOption>
                        ))}
                    </NativeSelectOptGroup>
                  ))}
                </NativeSelect>
              </div>
              <div className="flex flex-col gap-1.5">
                <label htmlFor="audit-channel" className={labelClass}>
                  {t('search.channel')}
                </label>
                <NativeSelect id="audit-channel" name="channel" defaultValue={form.channel} className={selectClass}>
                  <NativeSelectOption value="">{t('search.anyChannel')}</NativeSelectOption>
                  {view.channels.map((c) => (
                    <NativeSelectOption key={c} value={c}>
                      {tl(`channel.${c}`)}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
              </div>
              {/* Each day is picked as day, month and Buddhist-era year, or left out, and read back in words (DateField); a
                  period that ends before it starts is not searched, and "ถึงวันที่" says so (AuditPeriod) */}
              <AuditPeriod fromLabel={t('search.from')} toLabel={t('search.to')} from={form.from} to={form.to} reversed={reversed} />
            </div>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
              <Button type="submit" className="min-h-11 lg:min-h-10">
                {t('search.submit')}
              </Button>
              {searched ? (
                <Link href="/audit" className={linkClass}>
                  {t('search.clear')}
                </Link>
              ) : null}
            </div>
          </form>
        </Panel>

        {/* A period that ends before it starts was not searched: no export, no results and no "nothing found" below until
            "ถึงวันที่" is fixed */}
        {!reversed && rows.length ? (
          <Panel id="audit-export" title={t('export.title')}>
            {view.canExport ? (
              <>
                <p className="text-ink-muted">{t('export.hint')}</p>
                <ExportPanel endpoint="/audit/export" payload={{ filter }} formats={['xlsx', 'csv']} open={downloadUrlAction} />
              </>
            ) : (
              <p className="text-ink-muted">{t('export.auditorOnly')}</p>
            )}
          </Panel>
        ) : null}

        {reversed ? null : (
          <Panel id="audit-results" title={t('results.title')}>
            {period ? <p className="font-medium text-ink">{period}</p> : null}
            {rows.length === 0 ? (
              searched ? (
                <ListEmpty title={form.document ? t('results.noDocument', { document: form.document }) : t('results.none')} hint={t('results.noneHint')} actions={clearButton} />
              ) : (
                <ListEmpty title={t('results.empty')} hint={t('results.emptyHint')} />
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
          </Panel>
        )}
      </PageBody>
    </Page>
  )
}
