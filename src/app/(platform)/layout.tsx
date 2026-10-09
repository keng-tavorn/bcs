import { cookies } from 'next/headers'
import { notFound, redirect } from 'next/navigation'
import { getLocale, getTranslations } from 'next-intl/server'
import type { ReactNode } from 'react'
import { SIDEBAR_STATE_COOKIE } from '@/lib/constants'
import { SignOutButton } from '@/ui/auth/sign-out-button'
import { TwoFactorSetup } from '@/ui/auth/two-factor-setup'
import { Notice } from '@/ui/form/notice'
import { LanguageSwitch } from '@/ui/shell/language-switch'
import { WorkspaceShell } from '@/ui/shell/workspace-shell'
import { ClientMessages } from '../_lib/client-messages'
import { setLocaleAction } from '../_lib/locale-actions'
import { getPlatformSession } from '../_lib/session'

// Pages of the BCS team (PLATFORM_ADMIN, §2.2 · §9.1): signed in, an active PlatformAdmin row, and TOTP always on
// (BR-AUTH-08). Anyone else gets "not found", so the area is not advertised. Services check the admin again. Its client
// components read the platform's and the security messages only (src/i18n/client-messages.ts).
export default async function PlatformLayout({ children }: { children: ReactNode }) {
  const state = await getPlatformSession()
  if (state.kind === 'anonymous') redirect('/login')
  if (state.kind === 'expired') redirect('/login?ended=1')
  if (state.kind === 'not-platform-admin') notFound()

  const [t, tShell, tItems, tGroups, tAuth, tSecurity, tApp, locale] = await Promise.all([
    getTranslations('platform'),
    getTranslations('shell'),
    getTranslations('shell.items'),
    getTranslations('shell.groups'),
    getTranslations('auth'),
    getTranslations('auth.security'),
    getTranslations('app'),
    getLocale(),
  ])
  const languageSwitch = (
    <LanguageSwitch
      current={locale}
      label={tShell('language')}
      options={[
        { value: 'th', name: tApp('language.th') },
        { value: 'en', name: tApp('language.en') },
      ]}
      action={setLocaleAction}
    />
  )

  if (state.kind === 'needs-2fa-setup') {
    return (
      <ClientMessages scope="platform">
        <div className="min-h-dvh bg-bg">
          <header className="border-b border-line bg-surface">
            <div className="mx-auto max-w-2xl px-4 py-4">
              <span className="text-xl font-bold text-ink">{tAuth('brand')}</span>
            </div>
          </header>
          <main id="content" className="mx-auto flex max-w-2xl flex-col gap-6 px-4 py-8">
            <h1 className="text-2xl font-semibold">{tSecurity('twoFactorTitle')}</h1>
            <Notice tone="info">{t('twoFactorRequired')}</Notice>
            <TwoFactorSetup />
            <div className="flex flex-wrap items-center gap-4 border-t border-line pt-4">
              {languageSwitch}
              <SignOutButton />
            </div>
          </main>
        </div>
      </ClientMessages>
    )
  }

  return (
    <ClientMessages scope="platform">
      <WorkspaceShell
        brand={tAuth('brand')}
        orgName={t('teamName')}
        labels={{ skipToContent: tShell('skipToContent'), mainNav: tShell('mainNav'), account: tShell('account') }}
        nav={[{ key: 'tenants', href: '/platform/tenants', group: 'platform', label: tItems('tenants'), groupLabel: tGroups('platform') }]}
        sidebarOpen={(await cookies()).get(SIDEBAR_STATE_COOKIE)?.value !== 'false'}
        user={{ name: tShell('signedInAs', { name: state.displayName }), detail: t('teamName') }}
        account={
          <div className="flex flex-col items-start gap-3">
            {languageSwitch}
            <SignOutButton />
          </div>
        }
      >
        {children}
      </WorkspaceShell>
    </ClientMessages>
  )
}
