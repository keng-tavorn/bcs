'use client'

import { NextIntlClientProvider, useTranslations } from 'next-intl'
import en from '../../messages/src/en/app.json'
import th from '../../messages/src/th/app.json'
import './globals.css'

// Last resort when the root layout itself fails: no message provider is available, so the text comes straight from
// the message files, in the language the browser prefers (Thai first), through a provider of its own. Only the `app`
// namespace: this component is in the first JavaScript of every page, and the whole catalogue would add some 160 KB gzip
// to it (§9.4: a LIFF page loads at most 200 KB). The files are compiled when the app is built (next.config.ts), so the
// words are formatted by next-intl, never by replacing text in them.
export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const english = typeof navigator !== 'undefined' && !navigator.language.toLowerCase().startsWith('th')
  return (
    <html lang={english ? 'en' : 'th'}>
      <body className="bg-bg text-ink">
        <NextIntlClientProvider locale={english ? 'en' : 'th'} messages={{ app: english ? en : th }}>
          <GlobalErrorContent digest={error.digest} reset={reset} />
        </NextIntlClientProvider>
      </body>
    </html>
  )
}

function GlobalErrorContent({ digest, reset }: { digest: string | undefined; reset: () => void }) {
  const t = useTranslations('app.error')
  return (
    <main className="mx-auto flex max-w-2xl flex-col gap-4 px-4 py-10">
      <h1 className="text-2xl font-semibold">{t('title')}</h1>
      <p>{t('body')}</p>
      {digest ? <p className="text-ink-muted">{t('reference', { reference: digest })}</p> : null}
      <button
        type="button"
        onClick={() => reset()}
        className="inline-flex h-11 items-center self-start rounded-md bg-primary px-4 font-medium text-primary-foreground"
      >
        {t('retry')}
      </button>
    </main>
  )
}
