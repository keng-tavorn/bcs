import Link from 'next/link'
import { getTranslations } from 'next-intl/server'
import { systemClock } from '@/lib/clock'
import { ctxFromSession } from '@/server/auth/session'
import { getOrgChangeFormForAdmin } from '@/server/services/org-authority/view'
import { CHANGE_KINDS, type ChangeKind } from '@/ui/admin-org/kinds'
import { OrgChangeForm } from '@/ui/admin-org/org-change-form'
import { NoAccess } from '@/ui/admin-settings/no-access'
import { Page, PageBody, PageHeader, Panel } from '@/ui/page/page'
import { getSession } from '../../../../_lib/session'
import { previewOrgChangeAction, proposeOrgChangeAction } from '../actions'

export async function generateMetadata() {
  const t = await getTranslations('adminOrg.authority.new')
  return { title: t('title') }
}

const linkClass = 'inline-flex min-h-11 items-center font-medium text-primary underline underline-offset-4 hover:no-underline'
const isKind = (v: unknown): v is ChangeKind => typeof v === 'string' && (CHANGE_KINDS as readonly string[]).includes(v)
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)

// Proposing an authority change (FR-DOA-010 AC1): step 1 picks one of the five kinds; steps 2 and 3 (details, then the
// impact and the send) are the form. Links from /admin/org fill in the position, department or member.
export default async function NewOrgChangePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const query = await searchParams
  const ctx = ctxFromSession(await getSession(), 'WEB', systemClock.now())
  const [t, tAuthority] = await Promise.all([getTranslations('adminOrg.authority.new'), getTranslations('adminOrg.authority')])
  if (!ctx) return null
  const form = await getOrgChangeFormForAdmin(ctx)
  if (!form.ok) return <NoAccess title={t('title')} message={tAuthority('forbidden')} homeLabel={tAuthority('homeLink')} />
  const kind = one(query.kind)

  return (
    <Page>
      <Link href="/admin/org-authority" className={`${linkClass} -mb-4 self-start`}>
        {t('back')}
      </Link>
      <PageHeader title={isKind(kind) ? t('titleOf', { kind: tAuthority(`kinds.${kind}`) }) : t('title')} intro={t('intro')} />

      <PageBody>
        {isKind(kind) ? (
          <Panel label={t('titleOf', { kind: tAuthority(`kinds.${kind}`) })} className="max-w-3xl">
            <OrgChangeForm
              key={kind}
              kind={kind}
              data={form.data}
              initial={{
                ...(one(query.position) ? { positionCode: one(query.position) } : {}),
                ...(one(query.department) ? { departmentId: one(query.department) } : {}),
                ...(one(query.member) ? { memberId: one(query.member) } : {}),
              }}
              preview={previewOrgChangeAction}
              propose={proposeOrgChangeAction}
            />
          </Panel>
        ) : (
          <Panel title={t('chooseKind')} id="choose" className="max-w-3xl">
            <ol aria-label={t('steps.label')} className="flex flex-wrap gap-x-6 gap-y-1 border-b border-line">
              <li aria-current="step" className="-mb-px border-b-2 border-primary py-2 font-semibold text-ink">
                {t('stepLabel', { n: 1, name: t('steps.kind') })}
              </li>
              <li className="py-2 text-ink-muted">{t('stepLabel', { n: 2, name: t('steps.details') })}</li>
              <li className="py-2 text-ink-muted">{t('stepLabel', { n: 3, name: t('steps.review') })}</li>
            </ol>
            <ul className="flex flex-col divide-y divide-line">
              {CHANGE_KINDS.map((k) => (
                <li key={k} className="flex flex-col gap-1 py-3 last:pb-0">
                  <Link href={`/admin/org-authority/new?kind=${k}`} className={`${linkClass} self-start text-lg`}>
                    {tAuthority(`kinds.${k}`)}
                  </Link>
                  <p className="text-ink-muted">{tAuthority(`kindHints.${k}`)}</p>
                </li>
              ))}
            </ul>
          </Panel>
        )}
      </PageBody>
    </Page>
  )
}
