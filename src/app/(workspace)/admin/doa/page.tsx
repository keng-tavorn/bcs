import Link from 'next/link'
import { getLocale, getTranslations } from 'next-intl/server'
import { systemClock } from '@/lib/clock'
import { DOA_YAML_MAX_CHARS } from '@/lib/constants'
import { ctxFromSession } from '@/server/auth/session'
import { getDoaOverviewForAdmin, type DoaVersionSummaryView } from '@/server/services/doa/view'
import { ImportDoaForm } from '@/ui/admin-doa/import-form'
import { VersionStatus, versionLook, type VersionLook } from '@/ui/admin-doa/version-status'
import { nameIn } from '@/ui/admin-org/names'
import { NoAccess } from '@/ui/admin-settings/no-access'
import { Notice } from '@/ui/form/notice'
import { formatDateTime } from '@/ui/format'
import { ListEmpty, Page, PageBody, PageHeader, Panel } from '@/ui/page/page'
import { Button } from '@/ui/shadcn/button'
import { doaDrafterFor } from '../../../_lib/ai-read'
import { getSession } from '../../../_lib/session'
import { importDoaAction } from './actions'

export async function generateMetadata() {
  const t = await getTranslations('adminDoa')
  return { title: t('title') }
}

const linkClass = 'inline-flex min-h-11 items-center font-medium text-primary underline underline-offset-4 hover:no-underline'
/** What the admin looks for first: the version in effect, one approved for later, one waiting, drafts, then history */
const ORDER: Readonly<Record<VersionLook, number>> = { IN_EFFECT: 0, UPCOMING: 1, PUBLISHED: 1, PENDING_APPROVAL: 2, DRAFT: 3, SUPERSEDED: 4, REJECTED: 5, WITHDRAWN: 6 }
/** The import reads at most DOA_YAML_MAX_CHARS characters; a file of at most that many bytes never has more (UTF-8), so
 *  the browser, the server action and the service share one limit — well under the 1 MB body Next.js takes for an
 *  action. A DOA of any real organization is a few kilobytes. */
const MAX_FILE_BYTES = DOA_YAML_MAX_CHARS

// DOA versions (FR-DOA-001 AC1–AC3, §9.1 /admin/doa): the way into the editor — a copy of the latest version, edited as
// a table and saved as a new draft — every version with its status and effective period, and the import of a new draft
// from YAML. Wide screens: the versions on the left, editing and import on the right; phones: editing first (the page's
// main task), then the versions, then the import. Published versions never change: a change is a new version,
// approved under the DOA_CHANGE rule.
export default async function DoaPage() {
  const ctx = ctxFromSession(await getSession(), 'WEB', systemClock.now())
  const [t, locale] = await Promise.all([getTranslations('adminDoa'), getLocale()])
  if (!ctx) return null
  const overview = await getDoaOverviewForAdmin(ctx)
  if (!overview.ok) return <NoAccess title={t('title')} message={t('forbidden')} homeLabel={t('homeLink')} />
  const { initial, copySources } = overview.data
  // FR-AI-308: the DOA drafter, only while it is available to this member
  const [drafter, tAi] = await Promise.all([doaDrafterFor(ctx), getTranslations('aiAssist.doa')])
  const versions = [...overview.data.versions].sort((a, b) => ORDER[versionLook(a)] - ORDER[versionLook(b)] || a.code.localeCompare(b.code) || b.versionNo - a.versionNo)
  const when = (iso: string) => formatDateTime(locale, iso)
  const versionName = (v: DoaVersionSummaryView) => t('versionName', { code: v.code, version: v.versionNo })
  const period = (v: DoaVersionSummaryView) => {
    if (v.status === 'DRAFT' || v.status === 'PENDING_APPROVAL' || v.status === 'REJECTED' || v.status === 'WITHDRAWN') return t('planned', { from: when(v.effectiveFrom) })
    return v.effectiveTo ? t('period', { from: when(v.effectiveFrom), to: when(v.effectiveTo) }) : t('periodOpen', { from: when(v.effectiveFrom) })
  }

  return (
    <Page>
      <PageHeader title={t('title')} intro={t('intro')} />
      <PageBody>
        {initial ? <Notice tone="info">{t('initialNotice')}</Notice> : null}
        {drafter ? (
          <Link href="/admin/doa/ai-draft" className="inline-flex min-h-11 items-center self-start font-medium text-primary underline underline-offset-4 hover:no-underline">
            {tAi('title')}
          </Link>
        ) : null}

        <div className="flex flex-col gap-4 lg:grid lg:grid-cols-[minmax(0,1fr)_24rem] lg:items-start lg:gap-6">
          {copySources.length ? (
            <Panel title={t('start.title')} id="edit" className="lg:col-start-2 lg:row-start-1">
              <p className="text-ink-muted">{t('start.intro')}</p>
              {copySources.map((source) => (
                <div key={source.id} className="flex flex-col gap-3 border-t border-line pt-3">
                  <p>{t('start.source', { code: source.code, name: versionName(source), status: t(`status.${versionLook(source)}`) })}</p>
                  {/* The page's main action: it opens the editor and changes nothing */}
                  <Button asChild className="min-h-11 self-start lg:min-h-10">
                    <Link href={`/admin/doa/${source.id}/edit`}>{t('start.link', { name: versionName(source) })}</Link>
                  </Button>
                </div>
              ))}
            </Panel>
          ) : null}

          <Panel title={t('listTitle', { count: versions.length })} id="versions" className="lg:col-start-1 lg:row-span-2 lg:row-start-1">
            {versions.length === 0 ? (
              <ListEmpty title={t('empty')} />
            ) : (
              <ul className="flex flex-col divide-y divide-line">
                {versions.map((v) => {
                  const look = versionLook(v)
                  return (
                    <li key={v.id} className="flex flex-col gap-2 py-4 first:pt-0 last:pb-0">
                      <div className="flex flex-col gap-1 sm:flex-row sm:items-start sm:justify-between sm:gap-6">
                        <p className="text-lg font-semibold">{versionName(v)}</p>
                        <VersionStatus look={look} label={t(`status.${look}`)} className="shrink-0" />
                      </div>
                      <p className="tabular">{period(v)}</p>
                      <p className="text-base text-ink-muted md:text-sm">
                        {v.changeReason ? t('reason', { reason: v.changeReason }) : t('noReason')}
                        {' · '}
                        {t('rulesCount', { count: v.rules })}
                      </p>
                      {v.approvedBy && v.approvedAt ? (
                        <p className="text-base text-ink-muted md:text-sm">{t('approvedBy', { name: nameIn(locale, v.approvedBy), time: when(v.approvedAt) })}</p>
                      ) : v.submittedBy && v.submittedAt ? (
                        <p className="text-base text-ink-muted md:text-sm">{t('submittedBy', { name: nameIn(locale, v.submittedBy), time: when(v.submittedAt) })}</p>
                      ) : null}
                      <div className="flex flex-wrap gap-x-6 gap-y-1">
                        <Link href={`/admin/doa/${v.id}`} className={linkClass}>
                          {t('open', { name: versionName(v) })}
                        </Link>
                        <a href={`/admin/doa/${v.id}/export`} download className={linkClass}>
                          {t('download', { name: versionName(v) })}
                        </a>
                      </div>
                    </li>
                  )
                })}
              </ul>
            )}
          </Panel>

          <Panel title={t('import.title')} id="import" className={`lg:col-start-2 ${copySources.length ? 'lg:row-start-2' : 'lg:row-start-1'}`}>
            <ImportDoaForm importFile={importDoaAction} maxBytes={MAX_FILE_BYTES} />
          </Panel>
        </div>
      </PageBody>
    </Page>
  )
}
