import Link from 'next/link'
import { getLocale, getTranslations } from 'next-intl/server'
import { systemClock } from '@/lib/clock'
import { ctxFromSession } from '@/server/auth/session'
import { listWorkflowVersions, type WorkflowVersionSummaryView } from '@/server/services/workflow/view'
import { VersionStatus, versionLook, type VersionLook } from '@/ui/admin-doa/version-status'
import { nameIn } from '@/ui/admin-org/names'
import { NoAccess } from '@/ui/admin-settings/no-access'
import { CreateDraftButton, CreateFirstDraft } from '@/ui/admin-workflow/create-draft'
import { formatDateTime } from '@/ui/format'
import { ListEmpty, Page, PageBody, PageHeader, Panel } from '@/ui/page/page'
import { getSession } from '../../../_lib/session'
import { draftWorkflowAction } from './actions'

export async function generateMetadata() {
  const t = await getTranslations('adminWorkflow')
  return { title: t('title') }
}

const linkClass = 'inline-flex min-h-11 items-center font-medium text-primary underline underline-offset-4 hover:no-underline'
/** What the admin looks for first: the version in effect, one approved for later, one waiting, drafts, then history */
const ORDER: Readonly<Record<VersionLook, number>> = { IN_EFFECT: 0, UPCOMING: 1, PUBLISHED: 1, PENDING_APPROVAL: 2, DRAFT: 3, SUPERSEDED: 4, REJECTED: 5, WITHDRAWN: 6 }

// Workflow versions (FR-WF-103 AC1, §9.1 /admin/workflows): the parallel reviewers of the organization, versioned like
// the DOA. The main action makes a draft copied from the latest version (or opens the draft not sent yet); the list
// shows every version with its status, period, number of rules and who sent and approved it. Wide screens: the list on
// the left, the draft on the right; phones: the draft first (the page's main task), then the list. A published
// version never changes: a change is a new draft, approved under the DOA_CHANGE rule.
export default async function WorkflowsPage() {
  const ctx = ctxFromSession(await getSession(), 'WEB', systemClock.now())
  const [t, locale] = await Promise.all([getTranslations('adminWorkflow'), getLocale()])
  if (!ctx) return null
  const result = await listWorkflowVersions(ctx)
  if (!result.ok) return <NoAccess title={t('title')} message={t('forbidden')} homeLabel={t('homeLink')} />
  const { sources, openDrafts } = result.data
  const versions = [...result.data.versions].sort((a, b) => ORDER[versionLook(a)] - ORDER[versionLook(b)] || a.code.localeCompare(b.code) || b.versionNo - a.versionNo)
  const when = (iso: string) => formatDateTime(locale, iso)
  const versionName = (v: { code: string; versionNo: number }) => t('versionName', { code: v.code, version: v.versionNo })
  const period = (v: WorkflowVersionSummaryView) => {
    if (v.status === 'DRAFT' || v.status === 'PENDING_APPROVAL' || v.status === 'REJECTED' || v.status === 'WITHDRAWN') return t('planned', { from: when(v.effectiveFrom) })
    return v.effectiveTo ? t('period', { from: when(v.effectiveFrom), to: when(v.effectiveTo) }) : t('periodOpen', { from: when(v.effectiveFrom) })
  }
  const codes = [...new Set([...sources.map((s) => s.code), ...openDrafts.map((d) => d.code)])].sort()

  return (
    <Page>
      <PageHeader title={t('title')} intro={t('intro')} />
      <PageBody>
        <div className="flex flex-col gap-4 lg:grid lg:grid-cols-[minmax(0,1fr)_24rem] lg:items-start lg:gap-6">
          <Panel title={t('list.startTitle')} id="start" className="lg:col-start-2 lg:row-start-1">
            {codes.length === 0 ? (
              <>
                <p className="text-ink-muted">{t('list.firstIntro')}</p>
                <CreateFirstDraft suggestedCode="WF-01" draft={draftWorkflowAction} />
              </>
            ) : (
              codes.map((code) => {
                const draft = openDrafts.filter((d) => d.code === code).sort((a, b) => b.versionNo - a.versionNo)[0]
                const source = sources.find((s) => s.code === code)
                return (
                  <div key={code} className="flex flex-col gap-3 border-t border-line pt-3 first:border-t-0 first:pt-0">
                    {draft ? (
                      <>
                        <p>{t('list.openDraftIntro', { name: versionName(draft) })}</p>
                        <Link href={`/admin/workflows/${draft.id}`} className={`${linkClass} self-start`}>
                          {t('list.openDraft', { name: versionName(draft) })}
                        </Link>
                      </>
                    ) : source ? (
                      <>
                        <p>{t('list.sourceIntro', { name: versionName(source), status: t(`status.${versionLook(source)}`) })}</p>
                        <CreateDraftButton sourceVersionId={source.id} label={t('list.create', { name: versionName(source) })} draft={draftWorkflowAction} />
                      </>
                    ) : (
                      <p className="text-ink-muted">{t('list.noSource', { code })}</p>
                    )}
                  </div>
                )
              })
            )}
          </Panel>

          <Panel title={t('list.title', { count: versions.length })} id="versions" className="lg:col-start-1 lg:row-start-1">
            {versions.length === 0 ? (
              <ListEmpty title={t('list.empty')} hint={t('list.emptyHint')} />
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
                        {v.changeReason ? t('reasonLine', { reason: v.changeReason }) : t('noReason')}
                        {' · '}
                        {t('rulesCount', { count: v.rules })}
                      </p>
                      {v.approvedBy && v.approvedAt ? (
                        <p className="text-base text-ink-muted md:text-sm">{t('approvedBy', { name: nameIn(locale, v.approvedBy), time: when(v.approvedAt) })}</p>
                      ) : v.submittedBy && v.submittedAt ? (
                        <p className="text-base text-ink-muted md:text-sm">{t('submittedBy', { name: nameIn(locale, v.submittedBy), time: when(v.submittedAt) })}</p>
                      ) : null}
                      <Link href={`/admin/workflows/${v.id}`} className={`${linkClass} self-start`}>
                        {v.status === 'DRAFT' ? t('list.edit', { name: versionName(v) }) : t('list.open', { name: versionName(v) })}
                      </Link>
                    </li>
                  )
                })}
              </ul>
            )}
          </Panel>
        </div>
      </PageBody>
    </Page>
  )
}
