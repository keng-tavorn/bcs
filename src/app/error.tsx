'use client'

import Link from 'next/link'
import { useTranslations } from 'next-intl'
import { Button } from '@/ui/form/button'
import { Notice } from '@/ui/form/notice'

// Unexpected errors while rendering a page (§14.2 INTERNAL): what happened, that saved work is safe, and what to do.
// Only Next.js's error digest is shown as the reference; it matches the server log line, never the error text.
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
        <Link href="/" className="inline-flex min-h-11 items-center font-medium text-primary underline underline-offset-4 hover:no-underline">
          {t('home')}
        </Link>
      </div>
    </main>
  )
}
