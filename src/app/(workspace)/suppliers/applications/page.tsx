import { AlarmClock } from 'lucide-react'
import Link from 'next/link'
import { getLocale, getTranslations } from 'next-intl/server'
import { systemClock } from '@/lib/clock'
import { ctxFromSession } from '@/server/auth/session'
import { listSupplierApplicationsForScreen } from '@/server/services/suppliers/applications-view'
import { formatDateTime } from '@/ui/format'
import { Notice } from '@/ui/form/notice'
import { FilterBar, FilterSearch, FilterSelect, FilterSummary } from '@/ui/page/filters'
import { ListEmpty, Page, PageBody, PageHeader, Panel } from '@/ui/page/page'
import { Badge } from '@/ui/shadcn/badge'
import { Button } from '@/ui/shadcn/button'
import { SupplierSectionTabs } from '@/ui/supplier-applications/section-tabs'
import { getSession } from '../../../_lib/session'

// /suppliers/applications (S7-09 · docs/sub-specs/S7.md): the applications of the organization for PROCUREMENT FINANCE
// AUDITOR, newest first, each with its state and — when escalated and still waiting for the supplier — "ค้างเกินกำหนด"
// (BR-SUP ข้อ 12, with an icon, never colour alone). Filtered with a plain GET form. PROCUREMENT invites from here.

export async function generateMetadata() {
  const t = await getTranslations('supplierApplications.list')
  return { title: t('title') }
}

const STATUSES = ['INVITED', 'DRAFT', 'SUBMITTED', 'PENDING_APPROVAL', 'RETURNED', 'APPROVED', 'REJECTED', 'EXPIRED', 'CANCELLED'] as const
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)

export default async function ApplicationsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const ctx = ctxFromSession(await getSession(), 'WEB', systemClock.now())
  if (!ctx) return null
  const q = await searchParams
  const search = (one(q.q) ?? '').trim()
  const status = one(q.status) ?? ''
  const overdueOnly = one(q.overdue) === '1'
  const [t, ts, locale] = await Promise.all([getTranslations('supplierApplications'), getTranslations('suppliers'), getLocale()])
  const result = await listSupplierApplicationsForScreen(ctx, { q: search, status, overdue: overdueOnly })
  const tabs = (note?: string) => (
    <SupplierSectionTabs
      label={t('tabs.label')}
      current="applications"
      items={[
        { key: 'suppliers', href: '/suppliers', label: t('tabs.suppliers') },
        { key: 'applications', href: '/suppliers/applications', label: t('tabs.applications'), ...(note ? { note } : {}) },
      ]}
    />
  )
  if (!result.ok) {
    return (
      <Page>
        <PageHeader title={t('list.title')} />
        <PageBody>
          <Notice tone="warning">{result.error.code === 'MODULE_DISABLED' ? t('list.moduleOff') : t('list.forbidden')}</Notice>
          <Link href="/suppliers" className="inline-flex min-h-11 items-center self-start font-medium text-primary underline underline-offset-4 hover:no-underline">
            {ts('list.title')}
          </Link>
        </PageBody>
      </Page>
    )
  }
  const list = result.data
  const filtered = Boolean(search) || status !== '' || overdueOnly
  return (
    <Page>
      <PageHeader
        title={t('list.title')}
        intro={t('list.intro')}
        actions={
          list.canInvite ? (
            <Button asChild className="min-h-11 lg:min-h-10">
              <Link href="/suppliers/invite">{t('list.invite')}</Link>
            </Button>
          ) : null
        }
      >
        {tabs(list.overdue ? t('list.overdueCount', { count: list.overdue }) : undefined)}
      </PageHeader>
      <PageBody>
        {list.total > 0 ? (
          <FilterBar
            action="/suppliers/applications"
            label={t('list.filterLabel')}
            submit={t('list.submit')}
            footer={<FilterSummary count={t('list.count', { matched: list.rows.length, total: list.total })} notes={[]} clear={filtered ? { href: '/suppliers/applications', label: t('list.clear') } : null} />}
          >
            <FilterSearch id="application-search" label={t('list.search')} defaultValue={search} />
            <FilterSelect id="application-status" name="status" label={t('list.status')} all={t('list.allStatuses')} defaultValue={status} options={STATUSES.map((s) => ({ value: s, label: t(`status.${s}`) }))} />
            <div className="flex flex-col gap-1.5">
              <span aria-hidden="true" className="hidden font-medium md:block">
                &nbsp;
              </span>
              <label className="flex min-h-11 items-center gap-3 lg:min-h-10">
                <input type="checkbox" name="overdue" value="1" defaultChecked={overdueOnly} className="size-5 shrink-0 accent-primary" />
                <span>{t('list.overdueOnly')}</span>
              </label>
            </div>
          </FilterBar>
        ) : null}
        <Panel label={t('list.title')}>
          {list.rows.length === 0 ? (
            list.total === 0 ? (
              <ListEmpty title={t('list.emptyTitle')} hint={t('list.emptyHint')} />
            ) : (
              <ListEmpty title={t('list.noMatchTitle')} hint={t('list.noMatchHint')} />
            )
          ) : (
            <ul aria-label={t('list.title')} className="flex flex-col divide-y divide-line">
              {list.rows.map((r) => (
                <li key={r.id} className="flex flex-col gap-1 py-3 md:flex-row md:items-start md:justify-between md:gap-4">
                  <div className="flex min-w-0 flex-col gap-0.5">
                    <Link href={`/suppliers/applications/${r.id}`} className="inline-flex min-h-11 items-center font-medium text-primary underline-offset-4 hover:underline lg:min-h-0">
                      {/* an individual's label is already "ผู้ขายบุคคลธรรมดา · number" (BR-NOTI-10): its number once (S7-18) */}
                      {r.number && !r.label.includes(r.number) ? `${r.number} · ${r.label}` : r.label}
                    </Link>
                    <span className="text-ink-muted">
                      {t('list.invitedBy', { name: r.inviterName ?? '-', date: formatDateTime(locale, r.invitedAt) })}
                      {r.kind === 'EXISTING' ? ` · ${t('list.kindExisting')}` : ''}
                      {r.filledOnBehalf ? ` · ${t('list.filledOnBehalf')}` : ''}
                    </span>
                    <span className="text-ink-muted">{t('list.lastActivity', { date: formatDateTime(locale, r.lastActivityAt) })}</span>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant={r.status === 'APPROVED' ? 'ok' : ['REJECTED', 'CANCELLED', 'EXPIRED'].includes(r.status) ? 'neutral' : 'info'}>{t(`status.${r.status}`)}</Badge>
                    {r.overdue ? (
                      <Badge variant="warn">
                        <AlarmClock aria-hidden="true" />
                        {t('overdue')}
                      </Badge>
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </PageBody>
    </Page>
  )
}
