import { getTranslations } from 'next-intl/server'

// Placeholder until S1-09 builds the work-first home page (§9.9).
export default async function HomePage() {
  const t = await getTranslations('app')
  return (
    <main className="mx-auto max-w-5xl px-4 py-10">
      <h1 className="text-2xl font-semibold">{t('name')}</h1>
      <p className="mt-2 text-ink-muted">{t('comingSoon')}</p>
    </main>
  )
}
