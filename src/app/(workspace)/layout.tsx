import Link from 'next/link'
import { redirect } from 'next/navigation'
import { getLocale, getTranslations } from 'next-intl/server'
import type { ReactNode } from 'react'
import { systemClock } from '@/lib/clock'
import { ctxFromSession } from '@/server/auth/session'
import { memberPrincipal } from '@/server/authz'
import { listEnabledModules } from '@/server/queries/organization'
import { listMyNotifications } from '@/server/services/notifications'
import { SignOutButton } from '@/ui/auth/sign-out-button'
import { TwoFactorSetup } from '@/ui/auth/two-factor-setup'
import { Notice } from '@/ui/form/notice'
import { formatDateTime } from '@/ui/format'
import { LanguageSwitch } from '@/ui/shell/language-switch'
import { NotificationBell } from '@/ui/shell/notification-bell'
import { WorkspaceShell } from '@/ui/shell/workspace-shell'
import { setLocaleAction } from '../_lib/locale-actions'
import { getPlatformSession, getSession } from '../_lib/session'
import { visibleMenu } from './_shell/menu'
import { markAllNotificationsReadAction, openNotificationAction } from './_shell/notification-actions'

// Every workspace page: signed in, a member, and 2FA set up when the role needs it (FR-AUTH-002 AC1) — otherwise
// only the setup screen shows. The menu lists what the member may open (FR-PLT-002 AC1); services check again.
export default async function WorkspaceLayout({ children }: { children: ReactNode }) {
  const state = await getSession()
  if (state.kind === 'anonymous') redirect('/login')
  if (state.kind === 'expired') redirect('/login?ended=1')
  // The BCS team signs in on the same page but works at /platform (it is not a member of any organization)
  if (state.kind === 'no-membership') {
    const platform = await getPlatformSession()
    if (platform.kind === 'platform-admin' || platform.kind === 'needs-2fa-setup') redirect('/platform/tenants')
  }

  const [t, tItems, tGroups, tAuth, tSecurity, tApp, tPwa, tBell, locale] = await Promise.all([
    getTranslations('shell'),
    getTranslations('shell.items'),
    getTranslations('shell.groups'),
    getTranslations('auth'),
    getTranslations('auth.security'),
    getTranslations('app'),
    getTranslations('pwa'),
    getTranslations('shell.notifications'),
    getLocale(),
  ])
  const languageSwitch = (
    <LanguageSwitch
      current={locale}
      label={t('language')}
      options={[
        { value: 'th', name: tApp('language.th') },
        { value: 'en', name: tApp('language.en') },
      ]}
      action={setLocaleAction}
    />
  )

  if (state.kind !== 'member') {
    return (
      <div className="min-h-dvh bg-bg">
        <header className="border-b border-line bg-surface">
          <div className="mx-auto max-w-2xl px-4 py-4">
            <span className="text-xl font-bold text-ink">{tAuth('brand')}</span>
          </div>
        </header>
        <main id="content" className="mx-auto flex max-w-2xl flex-col gap-6 px-4 py-8">
          {state.kind === 'no-membership' ? (
            <Notice tone="danger">{tSecurity('noMembership')}</Notice>
          ) : (
            <>
              <h1 className="text-2xl font-semibold">{tSecurity('twoFactorTitle')}</h1>
              <Notice tone="info">{tSecurity('required')}</Notice>
              <TwoFactorSetup />
            </>
          )}
          <div className="flex flex-wrap items-center gap-4 border-t border-line pt-4">
            {languageSwitch}
            <SignOutButton />
          </div>
        </main>
      </div>
    )
  }

  const modules = await listEnabledModules(state.member.organizationId)
  const nav = visibleMenu(memberPrincipal(state.member.id, state.roles), modules, true).map((item) => ({
    key: item.key,
    href: item.href,
    group: item.group,
    label: tItems(item.key),
    groupLabel: tGroups(item.group),
  }))
  const name = locale === 'en' && state.member.displayNameEn ? state.member.displayNameEn : state.member.displayNameTh
  // The bell (FR-NOTI-001): the member's own notifications in their language
  const ctx = ctxFromSession(state, 'WEB', systemClock.now())
  const notifications = ctx ? await listMyNotifications(ctx, locale === 'en' ? 'en' : 'th') : { items: [], unread: 0 }
  const bell = (
    <NotificationBell
      items={notifications.items.map((i) => ({ id: i.id, title: i.title, body: i.body, href: i.href, unread: i.unread, when: formatDateTime(locale, i.createdAt) }))}
      unread={notifications.unread}
      labels={{
        button: tBell('button'),
        unreadCount: tBell('unreadCount', { count: notifications.unread }),
        panelTitle: tBell('panelTitle'),
        newItem: tBell('newItem'),
        markAllRead: tBell('markAllRead'),
        empty: tBell('empty'),
        emptyHint: tBell('emptyHint'),
      }}
      openAction={openNotificationAction}
      markAllReadAction={markAllNotificationsReadAction}
    />
  )

  return (
    <WorkspaceShell
      brand={tAuth('brand')}
      orgName={state.member.organizationName}
      userLine={t('signedInAs', { name })}
      labels={{ skipToContent: t('skipToContent'), menu: t('menu'), mainNav: t('mainNav') }}
      nav={nav}
      bell={bell}
      account={
        <div className="flex flex-col items-start gap-3">
          {languageSwitch}
          <Link href="/install" className="font-medium text-primary underline underline-offset-4 hover:no-underline">
            {tPwa('installLink')}
          </Link>
          <SignOutButton />
        </div>
      }
    >
      {children}
    </WorkspaceShell>
  )
}
