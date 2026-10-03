import Link from 'next/link'
import { getTranslations } from 'next-intl/server'
import { systemClock } from '@/lib/clock'
import { ctxFromSession } from '@/server/auth/session'
import { STORED_ROLES } from '@/server/authz/permissions'
import { listMembersForAdmin } from '@/server/services/members/admin-view'
import { ImportMembersForm } from '@/ui/admin/import-members-form'
import { InviteMemberForm } from '@/ui/admin/invite-member-form'
import { MemberStatus } from '@/ui/admin/member-status'
import { Notice } from '@/ui/form/notice'
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
  if (!members.ok) {
    return (
      <div className="flex max-w-2xl flex-col gap-6">
        <h1 className="text-2xl font-semibold">{t('title')}</h1>
        <Notice tone="danger">{t('forbidden')}</Notice>
        <Link href="/" className="inline-flex min-h-11 items-center self-start font-medium text-primary underline underline-offset-4 hover:no-underline">
          {t('homeLink')}
        </Link>
      </div>
    )
  }
  const roleOptions = STORED_ROLES.map((r) => ({ value: r, label: tRoles(r) }))

  return (
    <div className="flex flex-col gap-8">
      <div className="flex max-w-3xl flex-col gap-2">
        <h1 className="text-2xl font-semibold">{t('title')}</h1>
        <p className="text-ink-muted">{t('intro')}</p>
      </div>

      {/* Row 1 is as tall as the invite form; the list spans both rows, so import follows invite without a gap */}
      <div className="flex flex-col gap-10 lg:grid lg:grid-cols-[minmax(0,1fr)_24rem] lg:grid-rows-[auto_1fr] lg:items-start lg:gap-x-12">
        <section aria-labelledby="invite" className="flex flex-col gap-4 lg:col-start-2 lg:row-start-1">
          <h2 id="invite" className="text-xl font-semibold">
            {t('inviteTitle')}
          </h2>
          <InviteMemberForm roles={roleOptions} invite={inviteMemberAction} />
        </section>

        <section aria-labelledby="list" className="flex flex-col gap-4 lg:col-start-1 lg:row-span-2 lg:row-start-1">
          <h2 id="list" className="text-xl font-semibold">
            {t('listTitle', { count: members.data.length })}
          </h2>
          <ul className="flex flex-col divide-y divide-line border-y border-line">
            {members.data.map((m) => (
              <li key={m.id} className="flex flex-col gap-2 py-3 sm:flex-row sm:items-start sm:justify-between sm:gap-6">
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
                  <MemberStatus status={m.status} label={t(`status.${m.status}`)} className="text-base md:text-sm" />
                  <Link href={`/admin/members/${m.id}`} className="inline-flex min-h-11 items-center font-medium text-primary underline underline-offset-4 hover:no-underline">
                    {t('manage', { name: m.displayNameTh })}
                  </Link>
                </div>
              </li>
            ))}
          </ul>
        </section>

        <section aria-labelledby="import" className="flex flex-col gap-4 lg:col-start-2 lg:row-start-2">
          <h2 id="import" className="text-xl font-semibold">
            {t('importTitle')}
          </h2>
          <ImportMembersForm templateHref="/admin/members/template" importFile={importMembersAction} />
        </section>
      </div>
    </div>
  )
}
