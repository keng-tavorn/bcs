import { cookies } from 'next/headers'
import Link from 'next/link'
import { redirect } from 'next/navigation'
import { NextIntlClientProvider } from 'next-intl'
import { getLocale, getTranslations } from 'next-intl/server'
import type { ReactNode } from 'react'
import { systemClock } from '@/lib/clock'
import { SIDEBAR_STATE_COOKIE } from '@/lib/constants'
import { ctxFromSession } from '@/server/auth/session'
import { memberPrincipal } from '@/server/authz'
import { listEnabledModules } from '@/server/queries/organization'
import { listRequestCatalog } from '@/server/queries/request-form'
import { listMyNotifications } from '@/server/services/notifications'
import { SignOutButton } from '@/ui/auth/sign-out-button'
import { TwoFactorSetup } from '@/ui/auth/two-factor-setup'
import { Notice } from '@/ui/form/notice'
import { formatDateTime } from '@/ui/format'
import { LanguageSwitch } from '@/ui/shell/language-switch'
import { PwaRegistration } from '@/ui/pwa/pwa-registration'
import { CommandPalette } from '@/ui/shell/command-palette'
import { NotificationBell } from '@/ui/shell/notification-bell'
import { WorkspaceShell } from '@/ui/shell/workspace-shell'
import { setLocaleAction } from '../_lib/locale-actions'
import { getPlatformSession, getSession } from '../_lib/session'
import { paletteCommands } from './_shell/commands'
import { SIDEBAR_GROUPS, visibleMenu, type MenuGroup } from './_shell/menu'
import { countMyDraftsAction } from './_shell/new-request-actions'
import { markAllNotificationsReadAction, openNotificationAction } from './_shell/notification-actions'

// Every workspace page: signed in, a member, and 2FA set up when the role needs it (FR-AUTH-002 AC1) — otherwise
// only the setup screen shows. The menu lists what the member may open (FR-PLT-002 AC1); services check again.
// The workspace's client components read any namespace, so its provider passes the whole catalogue (no page budget
// here; the LIFF app and the sign-in pages pass only what they read, src/i18n/client-messages.ts). The PWA's service
// worker is registered here and on the sign-in pages (§9.7), and offers to reload when a new version is ready.
export default async function WorkspaceLayout({ children }: { children: ReactNode }) {
  const state = await getSession()
  if (state.kind === 'anonymous') redirect('/login')
  if (state.kind === 'expired') redirect('/login?ended=1')
  // The BCS team signs in on the same page but works at /platform (it is not a member of any organization)
  if (state.kind === 'no-membership') {
    const platform = await getPlatformSession()
    if (platform.kind === 'platform-admin' || platform.kind === 'needs-2fa-setup') redirect('/platform/tenants')
  }

  const [t, tItems, tGroups, tAuth, tSecurity, tApp, tPwa, tBell, tSearch, tRoles, locale] = await Promise.all([
    getTranslations('shell'),
    getTranslations('shell.items'),
    getTranslations('shell.groups'),
    getTranslations('auth'),
    getTranslations('auth.security'),
    getTranslations('app'),
    getTranslations('pwa'),
    getTranslations('shell.notifications'),
    getTranslations('shell.search'),
    getTranslations('admin.roles'),
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
  /** The page with the whole catalogue for its client components, and the PWA's registration after it */
  const withMessages = (page: ReactNode) => (
    <NextIntlClientProvider>
      {page}
      <PwaRegistration labels={{ updateReady: tPwa('updateReady'), updateNow: tPwa('updateNow'), updateLater: tPwa('updateLater') }} />
    </NextIntlClientProvider>
  )

  if (state.kind !== 'member') {
    return withMessages(
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
  const menu = visibleMenu(memberPrincipal(state.member.id, state.roles), modules, true).map((item) => ({
    key: item.key,
    href: item.href,
    group: item.group,
    label: tItems(item.key),
  }))
  // The sidebar holds the groups of §9.10, a heading over the named ones; the hub pages list the rest (/settings, /admin)
  const headingOf = (group: MenuGroup) => (group === 'procurement' || group === 'finance' || group === 'insight' ? tGroups(group) : '')
  const sidebarGroups: readonly MenuGroup[] = SIDEBAR_GROUPS
  const nav = menu.filter((item) => sidebarGroups.includes(item.group)).map((item) => ({ ...item, groupLabel: headingOf(item.group) }))
  // The one door (§9.9 principle 2): only for a member whose menu has it — one who may create requests
  const door = menu.find((item) => item.key === 'newRequest')
  const name = locale === 'en' && state.member.displayNameEn ? state.member.displayNameEn : state.member.displayNameTh
  // The sidebar opens as the member last left it (FR-PLT-013 AC2): its cookie says "false" once collapsed
  const sidebarOpen = (await cookies()).get(SIDEBAR_STATE_COOKIE)?.value !== 'false'
  // The bell (FR-NOTI-001): the member's own notifications in their language
  const ctx = ctxFromSession(state, 'WEB', systemClock.now())
  const notifications = ctx ? await listMyNotifications(ctx, locale === 'en' ? 'en' : 'th') : { items: [], unread: 0 }
  // The ⌘K search (FR-PLT-014): pages are the member's menu; commands only reach what that menu holds (AC4)
  const screen = locale === 'en' ? 'en' : 'th'
  const requestTypes = door && ctx ? await listRequestCatalog(ctx, screen) : []
  const commands = paletteCommands(menu, requestTypes, {
    startRequest: (type) => tSearch('startRequest', { type }),
    delegate: tSearch('delegate'),
    linkLine: tSearch('linkLine'),
    overdue: tSearch('overdue'),
  })
  const search = (
    <CommandPalette
      locale={screen}
      pages={menu.map((item) => ({ id: item.key, label: item.label, href: item.href }))}
      commands={commands}
      labels={{
        trigger: tSearch('trigger'),
        title: tSearch('title'),
        description: tSearch('description'),
        placeholder: tSearch('placeholder'),
        groups: { recent: tSearch('groups.recent'), documents: tSearch('groups.documents'), suppliers: tSearch('groups.suppliers'), pages: tSearch('groups.pages'), commands: tSearch('groups.commands') },
        kinds: { REQUEST: tSearch('kinds.REQUEST'), PURCHASE_ORDER: tSearch('kinds.PURCHASE_ORDER'), GOODS_RECEIPT: tSearch('kinds.GOODS_RECEIPT') },
        draft: tSearch('draft'),
        empty: tSearch('empty'),
        loading: tSearch('loading'),
        failed: tSearch('failed'),
        rateLimited: tSearch('rateLimited'),
        shortcutMac: tSearch('shortcutMac'),
        shortcutOther: tSearch('shortcutOther'),
      }}
    />
  )
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

  return withMessages(
    <WorkspaceShell
      brand={tAuth('brand')}
      orgName={state.member.organizationName}
      labels={{ skipToContent: t('skipToContent'), mainNav: t('mainNav'), account: t('account') }}
      nav={nav}
      pages={menu}
      sidebarOpen={sidebarOpen}
      user={{ name: t('signedInAs', { name }), detail: [state.member.organizationName, ...state.roles.map((r) => tRoles(r))].join(' · ') }}
      bell={bell}
      newRequest={door ? { href: door.href, label: door.label, types: requestTypes, countDrafts: countMyDraftsAction } : undefined}
      search={search}
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
