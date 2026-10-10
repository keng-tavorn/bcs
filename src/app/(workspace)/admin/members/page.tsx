import Link from 'next/link'
import { getTranslations } from 'next-intl/server'
import { systemClock } from '@/lib/clock'
import { ctxFromSession } from '@/server/auth/session'
import { STORED_ROLES } from '@/server/authz/permissions'
import { listMembersForAdmin } from '@/server/services/members/admin-view'
import { ImportMembersForm } from '@/ui/admin/import-members-form'
import { InviteMemberForm } from '@/ui/admin/invite-member-form'
import { MemberStatus } from '@/ui/admin/member-status'
import { NoAccess } from '@/ui/admin-settings/no-access'
import { Page, PageBody, PageHeader, Panel } from '@/ui/page/page'
import { getSession } from '../../../_lib/session'
import { importMembersAction, inviteMemberAction } from './actions'

export async function generateMetadata() {
  const t = await getTranslations('admin.members')
  return { title: t('title') }
}

// Members and roles (FR-ADM-001 S1, §9.1 /admin/members). Wide screens: the member list on the left, invite and
// import on the right. Phones: invite, then the list, then import (DOM order), so the main action comes first.
export default async function MembersPage() {
  const ctx = ctxFromSession(await getSession(), 'WEB', systemClock.now())
  const [t, tRoles] = await Promise.all([getTranslations('admin.members'), getTranslations('admin.roles')])
  if (!ctx) return null
  const members = await listMembersForAdmin(ctx)
  if (!members.ok) return <NoAccess title={t('title')} message={t('forbidden')} homeLabel={t('homeLink')} />
  const roleOptions = STORED_ROLES.map((r) => ({ value: r, label: tRoles(r) }))

  return (
    <Page>
      <PageHeader title={t('title')} intro={t('intro')} />
      <PageBody>
        {/* Row 1 is as tall as the invite form; the list spans both rows, so import follows invite without a gap */}
        <div className="flex flex-col gap-4 lg:grid lg:grid-cols-[minmax(0,1fr)_24rem] lg:grid-rows-[auto_1fr] lg:items-start lg:gap-6">
          <Panel title={t('inviteTitle')} id="invite" className="lg:col-start-2 lg:row-start-1">
            <InviteMemberForm roles={roleOptions} invite={inviteMemberAction} />
          </Panel>

          <Panel title={t('listTitle', { count: members.data.length })} id="list" className="lg:col-start-1 lg:row-span-2 lg:row-start-1">
            <ul className="flex flex-col divide-y divide-line">
              {members.data.map((m) => (
                <li key={m.id} className="flex flex-col gap-2 py-3 first:pt-0 last:pb-0 sm:flex-row sm:items-start sm:justify-between sm:gap-6">
                  <div className="flex min-w-0 flex-col gap-0.5">
                    <p className="font-medium">
                      {m.displayNameTh}
                      {m.isSelf ? <span className="ml-2 font-normal text-ink-muted">({t('you')})</span> : null}
                    </p>
                    <p className="text-base break-all text-ink-muted md:text-sm">
                      {m.email}
                      {m.employeeCode ? ` · ${m.employeeCode}` : ''}
                    </p>
                    <p className="text-base md:text-sm">{m.roles.length ? m.roles.map((r) => tRoles(r)).join(' · ') : t('noRoles')}</p>
                  </div>
                  <div className="flex shrink-0 flex-col gap-1 sm:items-end">
                    <MemberStatus status={m.status} label={t(`status.${m.status}`)} />
                    <Link href={`/admin/members/${m.id}`} className="inline-flex min-h-11 items-center font-medium text-primary underline underline-offset-4 hover:no-underline">
                      {t('manage', { name: m.displayNameTh })}
                    </Link>
                  </div>
                </li>
              ))}
            </ul>
          </Panel>

          <Panel title={t('importTitle')} id="import" className="lg:col-start-2 lg:row-start-2">
            <ImportMembersForm templateHref="/admin/members/template" importFile={importMembersAction} />
          </Panel>
        </div>
      </PageBody>
    </Page>
  )
}
