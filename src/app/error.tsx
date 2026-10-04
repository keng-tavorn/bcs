'use client'

import { useTranslations } from 'next-intl'
import { Button } from '@/ui/form/button'
import { Notice } from '@/ui/form/notice'
import { LightLink } from '@/ui/light-link'

// Unexpected errors while rendering a page (§14.2 INTERNAL): what happened, that saved work is safe, and what to do.
// Only Next.js's error digest is shown as the reference; it matches the server log line, never the error text.
// The way home is the app's light link (src/ui/light-link.tsx: an <a> that moves with the router), not next/link: this
// component is in the first JavaScript of every page, and next/link would add some 4 KB gzip to each (§9.4: a LIFF page
// loads at most 200 KB with the LINE SDK).
export default function ErrorPage({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const t = useTranslations('app.error')
  return (
    <main id="content" className="mx-auto flex max-w-2xl flex-col gap-4 px-4 py-10">
      <h1 className="text-2xl font-semibold">{t('title')}</h1>
      <Notice tone="danger">
        <p>{t('body')}</p>
        {error.digest ? <p className="text-base text-ink-muted md:text-sm">{t('reference', { reference: error.digest })}</p> : null}
      </Notice>
      <div className="flex flex-wrap items-center gap-4">
        <Button onClick={() => reset()}>{t('retry')}</Button>
        <LightLink href="/" className="inline-flex min-h-11 items-center font-medium text-primary underline underline-offset-4 hover:no-underline">
          {t('home')}
        </LightLink>
      </div>
    </main>
  )
}
