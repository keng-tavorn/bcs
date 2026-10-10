import Link from 'next/link'
import { notFound } from 'next/navigation'
import { getTranslations } from 'next-intl/server'
import { systemClock } from '@/lib/clock'
import { ctxFromSession } from '@/server/auth/session'
import { STORED_ROLES } from '@/server/authz/permissions'
import { getMemberForAdmin } from '@/server/services/members/admin-view'
import { MemberManage } from '@/ui/admin/member-manage'
import { MemberStatus } from '@/ui/admin/member-status'
import { NoAccess } from '@/ui/admin-settings/no-access'
import { Notice } from '@/ui/form/notice'
import { Page, PageBody, PageHeader, Panel } from '@/ui/page/page'
import { getSession } from '../../../../_lib/session'
import { deactivateMemberAction, grantRoleAction, inviteMemberAction, resetTwoFactorAction, revokeRoleAction } from '../actions'

export async function generateMetadata() {
  const t = await getTranslations('admin.members')
  return { title: t('title') }
}

// One member (FR-ADM-001 AC1–AC2): roles held and grantable, resend the invitation, reset 2FA, deactivate.
export default async function MemberPage({ params }: { params: Promise<{ memberId: string }> }) {
  const { memberId } = await params
  const ctx = ctxFromSession(await getSession(), 'WEB', systemClock.now())
  const [t, tRoles] = await Promise.all([getTranslations('admin.members'), getTranslations('admin.roles')])
  if (!ctx) return null
  const result = await getMemberForAdmin(ctx, memberId)
  if (!result.ok && result.error.code === 'NOT_FOUND') notFound()
  if (!result.ok) return <NoAccess title={t('title')} message={t('forbidden')} homeLabel={t('homeLink')} />
  const m = result.data
  const option = (r: (typeof STORED_ROLES)[number]) => ({ value: r, label: tRoles(r) })

  return (
    <Page>
      <Link href="/admin/members" className="-mb-4 inline-flex min-h-11 items-center self-start font-medium text-primary underline underline-offset-4 hover:no-underline">
        {t('back')}
      </Link>
      <PageHeader title={m.isSelf ? `${m.displayNameTh} (${t('you')})` : m.displayNameTh}>
        <p className="break-all text-ink-muted">
          {m.email}
          {m.employeeCode ? ` · ${m.employeeCode}` : ''}
        </p>
        <MemberStatus status={m.status} label={t(`status.${m.status}`)} />
      </PageHeader>
      <PageBody>
        {m.status === 'DEACTIVATED' ? <Notice tone="info">{t('deactivatedNotice')}</Notice> : null}
        <Panel label={m.displayNameTh} className="max-w-3xl">
          <MemberManage
            member={{ id: m.id, email: m.email, displayNameTh: m.displayNameTh, status: m.status, isSelf: m.isSelf }}
            held={m.roles.map(option)}
            grantable={STORED_ROLES.filter((r) => !m.roles.includes(r)).map(option)}
            actions={{
              grant: grantRoleAction,
              revoke: revokeRoleAction,
              deactivate: deactivateMemberAction,
              resetTwoFactor: resetTwoFactorAction,
              resendInvitation: inviteMemberAction,
            }}
          />
        </Panel>
      </PageBody>
    </Page>
  )
}
