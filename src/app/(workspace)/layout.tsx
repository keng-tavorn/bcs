import Link from 'next/link'
import { redirect } from 'next/navigation'
import { getLocale, getTranslations } from 'next-intl/server'
import type { ReactNode } from 'react'
import { memberPrincipal } from '@/server/authz'
import { listEnabledModules } from '@/server/queries/organization'
import { SignOutButton } from '@/ui/auth/sign-out-button'
import { TwoFactorSetup } from '@/ui/auth/two-factor-setup'
import { Notice } from '@/ui/form/notice'
import { LanguageSwitch } from '@/ui/shell/language-switch'
import { WorkspaceShell } from '@/ui/shell/workspace-shell'
import { setLocaleAction } from '../_lib/locale-actions'
import { getPlatformSession, getSession } from '../_lib/session'
import { visibleMenu } from './_shell/menu'

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

  const [t, tItems, tGroups, tAuth, tSecurity, tApp, tPwa, locale] = await Promise.all([
    getTranslations('shell'),
    getTranslations('shell.items'),
    getTranslations('shell.groups'),
    getTranslations('auth'),
    getTranslations('auth.security'),
    getTranslations('app'),
    getTranslations('pwa'),
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

  return (
    <WorkspaceShell
      brand={tAuth('brand')}
      orgName={state.member.organizationName}
      userLine={t('signedInAs', { name })}
      labels={{ skipToContent: t('skipToContent'), menu: t('menu'), mainNav: t('mainNav') }}
      nav={nav}
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
