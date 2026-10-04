'use client'

import { useTranslations } from 'next-intl'

// Unexpected errors while rendering a page (§14.2 INTERNAL): what happened, that saved work is safe, and what to do.
// Only Next.js's error digest is shown as the reference; it matches the server log line, never the error text.
// This boundary is in the first JavaScript of every page, the LIFF pages included (§9.4: at most 200 KB gzip with the
// LINE SDK and the page data). So it is drawn with plain elements in the look of the danger notice and the main button
// (src/ui/form/notice.tsx, src/ui/form/button.tsx) rather than with them: their icon library and class merging added
// some 2 KB gzip to every page. The icon is the danger notice's (a circle with an exclamation mark).

/** The way home is an ordinary link, no client code: after an error the home page loads afresh (new code, clean state) */
const HOME_PATH = '/'

export default function ErrorPage({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const t = useTranslations('app.error')
  return (
    <main id="content" className="mx-auto flex max-w-2xl flex-col gap-4 px-4 py-10">
      <h1 className="text-2xl font-semibold">{t('title')}</h1>
      <div role="alert" className="flex items-start gap-2 border-l-4 border-danger bg-surface px-3 py-2.5 text-ink">
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
          className="mt-1 size-4 shrink-0 text-danger"
        >
          <circle cx="12" cy="12" r="10" />
          <line x1="12" x2="12" y1="8" y2="12" />
          <line x1="12" x2="12.01" y1="16" y2="16" />
        </svg>
        <div>
          <p>{t('body')}</p>
          {error.digest ? <p className="text-base text-ink-muted md:text-sm">{t('reference', { reference: error.digest })}</p> : null}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-4">
        <button
          type="button"
          onClick={() => reset()}
          className="inline-flex h-11 items-center justify-center gap-2 rounded-md bg-primary px-4 font-medium text-primary-foreground transition-colors duration-150 hover:bg-[color-mix(in_oklab,var(--primary)_85%,black)]"
        >
          {t('retry')}
        </button>
        <a href={HOME_PATH} className="inline-flex min-h-11 items-center font-medium text-primary underline underline-offset-4 hover:no-underline">
          {t('home')}
        </a>
      </div>
    </main>
  )
}
