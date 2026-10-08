import { notFound } from 'next/navigation'
import { getTranslations } from 'next-intl/server'
import { getEnv } from '@/lib/env'
import { UiShowcase } from '@/ui/dev/ui-showcase'

// The component sheet of the workspace (S16-02 · FR-PLT-013): every shadcn/ui component of the table in §9.10 drawn
// with the BCS tokens, for developers and the design review of S16-12. Developer machines only: 404 on preview,
// staging and production.
export default async function UiShowcasePage() {
  if (getEnv().APP_ENV !== 'local') notFound()
  const t = await getTranslations('devUi')
  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-8">
      <header className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold">{t('title')}</h1>
        <p className="text-ink-muted">{t('intro')}</p>
      </header>
      <UiShowcase />
    </div>
  )
}
