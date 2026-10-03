'use client'

import en from '../../messages/en.json'
import th from '../../messages/th.json'
import './globals.css'

// Last resort when the root layout itself fails: no message provider is available, so the text comes straight from
// the built message files, in the language the browser prefers (Thai first).
export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const english = typeof navigator !== 'undefined' && !navigator.language.toLowerCase().startsWith('th')
  const t = (english ? en : th).app.error
  return (
    <html lang={english ? 'en' : 'th'}>
      <body className="bg-bg text-ink">
        <main className="mx-auto flex max-w-2xl flex-col gap-4 px-4 py-10">
          <h1 className="text-2xl font-semibold">{t.title}</h1>
          <p>{t.body}</p>
          {error.digest ? <p className="text-ink-muted">{t.reference.replace('{reference}', error.digest)}</p> : null}
          <button
            type="button"
            onClick={() => reset()}
            className="inline-flex h-11 items-center self-start rounded-md bg-primary px-4 font-medium text-primary-foreground"
          >
            {t.retry}
          </button>
        </main>
      </body>
    </html>
  )
}
