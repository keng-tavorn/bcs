import Link from 'next/link'
import { getLocale, getTranslations } from 'next-intl/server'
import { systemClock } from '@/lib/clock'
import { DOA_YAML_MAX_CHARS } from '@/lib/constants'
import { ctxFromSession } from '@/server/auth/session'
import { getDoaOverviewForAdmin, type DoaVersionSummaryView } from '@/server/services/doa/view'
import { ImportDoaForm } from '@/ui/admin-doa/import-form'
import { VersionStatus, versionLook, type VersionLook } from '@/ui/admin-doa/version-status'
import { nameIn } from '@/ui/admin-org/names'
import { Notice } from '@/ui/form/notice'
import { formatDateTime } from '@/ui/format'
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

// DOA versions (FR-DOA-001 AC2–AC3, §9.1 /admin/doa): every version with its status and effective period, and the
// import of a new draft from YAML. Wide screens: the versions on the left, the import on the right; phones: versions
// first. Published versions never change: a change is a new version, approved under the DOA_CHANGE rule.
export default async function DoaPage() {
  const ctx = ctxFromSession(await getSession(), 'WEB', systemClock.now())
  const [t, locale] = await Promise.all([getTranslations('adminDoa'), getLocale()])
  if (!ctx) return null
  const overview = await getDoaOverviewForAdmin(ctx)
  if (!overview.ok) {
    return (
      <div className="flex max-w-2xl flex-col gap-6">
        <h1 className="text-2xl font-semibold">{t('title')}</h1>
        <Notice tone="danger">{t('forbidden')}</Notice>
        <Link href="/" className={`${linkClass} self-start`}>
          {t('homeLink')}
        </Link>
      </div>
    )
  }
  const { initial } = overview.data
  const versions = [...overview.data.versions].sort((a, b) => ORDER[versionLook(a)] - ORDER[versionLook(b)] || a.code.localeCompare(b.code) || b.versionNo - a.versionNo)
  const when = (iso: string) => formatDateTime(locale, iso)
  const versionName = (v: DoaVersionSummaryView) => t('versionName', { code: v.code, version: v.versionNo })
  const period = (v: DoaVersionSummaryView) => {
    if (v.status === 'DRAFT' || v.status === 'PENDING_APPROVAL' || v.status === 'REJECTED' || v.status === 'WITHDRAWN') return t('planned', { from: when(v.effectiveFrom) })
    return v.effectiveTo ? t('period', { from: when(v.effectiveFrom), to: when(v.effectiveTo) }) : t('periodOpen', { from: when(v.effectiveFrom) })
  }

  return (
    <div className="flex flex-col gap-8">
      <div className="flex max-w-3xl flex-col gap-2">
        <h1 className="text-2xl font-semibold">{t('title')}</h1>
        <p className="text-ink-muted">{t('intro')}</p>
      </div>
      {initial ? <Notice tone="info">{t('initialNotice')}</Notice> : null}

      <div className="flex flex-col gap-10 lg:grid lg:grid-cols-[minmax(0,1fr)_24rem] lg:items-start lg:gap-x-12">
        <section aria-labelledby="versions" className="flex min-w-0 flex-col gap-4">
          <h2 id="versions" className="text-xl font-semibold">
            {t('listTitle', { count: versions.length })}
          </h2>
          {versions.length === 0 ? (
            <p className="border-y border-line py-4 text-ink-muted">{t('empty')}</p>
          ) : (
            <ul className="flex flex-col divide-y divide-line border-y border-line">
              {versions.map((v) => {
                const look = versionLook(v)
                return (
                  <li key={v.id} className="flex flex-col gap-2 py-4">
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
        </section>

        <section aria-labelledby="import" className="flex flex-col gap-4">
          <h2 id="import" className="text-xl font-semibold">
            {t('import.title')}
          </h2>
          <ImportDoaForm importFile={importDoaAction} maxBytes={MAX_FILE_BYTES} />
        </section>
      </div>
    </div>
  )
}
