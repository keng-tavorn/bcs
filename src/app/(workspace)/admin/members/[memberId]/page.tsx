import Link from 'next/link'
import { notFound } from 'next/navigation'
import { getTranslations } from 'next-intl/server'
import { systemClock } from '@/lib/clock'
import { ctxFromSession } from '@/server/auth/session'
import { STORED_ROLES } from '@/server/authz/permissions'
import { getMemberForAdmin } from '@/server/services/members/admin-view'
import { MemberManage } from '@/ui/admin/member-manage'
import { MemberStatus } from '@/ui/admin/member-status'
import { Notice } from '@/ui/form/notice'
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
  if (!result.ok) {
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
  const m = result.data
  const option = (r: (typeof STORED_ROLES)[number]) => ({ value: r, label: tRoles(r) })

  return (
    <div className="flex max-w-3xl flex-col gap-8">
      <Link href="/admin/members" className="inline-flex min-h-11 items-center self-start font-medium text-primary underline underline-offset-4 hover:no-underline">
        {t('back')}
      </Link>
      <div className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold">
          {m.displayNameTh}
          {m.isSelf ? <span className="ml-2 text-xl font-normal text-ink-muted">({t('you')})</span> : null}
        </h1>
        <p className="break-all text-ink-muted">
          {m.email}
          {m.employeeCode ? ` · ${m.employeeCode}` : ''}
        </p>
        <MemberStatus status={m.status} label={t(`status.${m.status}`)} />
      </div>
      {m.status === 'DEACTIVATED' ? <Notice tone="info">{t('deactivatedNotice')}</Notice> : null}
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
    </div>
  )
}
