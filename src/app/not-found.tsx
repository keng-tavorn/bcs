import { getTranslations } from 'next-intl/server'
import { LightLink } from '@/ui/light-link'

export async function generateMetadata() {
  const t = await getTranslations('app.notFound')
  return { title: t('title') }
}

// Any unknown address, and pages a session may not open (e.g. /platform for members), in Thai or English. It never
// says whether the page exists, and it gives the next step (§9.9 rule 8). The way home is the app's light link
// (src/ui/light-link.tsx), not next/link: the root not-found boundary is part of every page, and a next/link here made
// every page that does not use next/link itself (the LIFF pages) load next/link's client code, some 3.6 KB gzip
// (§9.4: a LIFF page loads at most 200 KB with the LINE SDK).
export default async function NotFound() {
  const [t, tApp] = await Promise.all([getTranslations('app.notFound'), getTranslations('app')])
  return (
    <div className="min-h-dvh bg-bg">
      <header className="border-b border-line bg-surface">
        <div className="mx-auto max-w-2xl px-4 py-4">
          <span className="text-xl font-bold text-ink">{tApp('name')}</span>
        </div>
      </header>
      <main id="content" className="mx-auto flex max-w-2xl flex-col gap-4 px-4 py-10">
        <h1 className="text-2xl font-semibold">{t('title')}</h1>
        <p className="text-ink-muted">{t('body')}</p>
        <LightLink href="/" className="inline-flex min-h-11 items-center self-start font-medium text-primary underline underline-offset-4 hover:no-underline">
          {t('home')}
        </LightLink>
      </main>
    </div>
  )
}
