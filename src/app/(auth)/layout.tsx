import { getTranslations } from 'next-intl/server'
import type { ReactNode } from 'react'

// Sign-in pages: one narrow column, the product name on top, nothing decorative (§9.9).
export default async function AuthLayout({ children }: { children: ReactNode }) {
  const t = await getTranslations('auth')
  return (
    <div className="min-h-dvh bg-bg">
      <header className="border-b border-line bg-surface">
        <div className="mx-auto flex max-w-md flex-col px-4 py-4">
          <span className="text-xl font-bold text-ink">{t('brand')}</span>
          <span className="text-base md:text-sm text-ink-muted">{t('brandTagline')}</span>
        </div>
      </header>
      <main className="mx-auto max-w-md px-4 pt-8 pb-16">{children}</main>
    </div>
  )
}
