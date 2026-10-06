'use client'

import { NextIntlClientProvider, useLocale, useMessages } from 'next-intl'
import { useMemo, type ReactNode } from 'react'
import enFiles from '../../../../messages/src/en/files.json'
import enLiffRequests from '../../../../messages/src/en/liffRequests.json'
import enRequestForm from '../../../../messages/src/en/requestForm.json'
import thFiles from '../../../../messages/src/th/files.json'
import thLiffRequests from '../../../../messages/src/th/liffRequests.json'
import thRequestForm from '../../../../messages/src/th/requestForm.json'

// The words of steps 2 and 3 of the LIFF request form (§9.4: a LIFF page's first JavaScript is at most 200 KB gzip with
// the LINE SDK and the page data in its HTML, where the messages its client components read are written). The form's
// page passes the shell and step 1 only the words they read (src/i18n/client-messages.ts liffRequestForm); the parts the
// form loads on demand (./request-form.tsx) — the workspace's items and documents steps, the review, the confirmation
// once sent, why a save was refused — read the whole requestForm namespace, the file words and the LIFF form's own
// (liffRequests), and these come with them: each part is a module that draws it inside this provider
// (./items-with-words.tsx, ./review-with-words.tsx), so the words are in its chunk and never in the page's HTML. The
// provider holds the page's messages and these, in the page's language, and keeps the time zone and formats of the one
// above it. The files are compiled when the app is built (next.config.ts), as the catalogue the server hands the page
// is: next-intl formats both the same.

const WORDS = {
  th: { requestForm: thRequestForm, files: thFiles, liffRequests: thLiffRequests },
  en: { requestForm: enRequestForm, files: enFiles, liffRequests: enLiffRequests },
} as const

export function StepWords({ children }: { readonly children: ReactNode }) {
  const locale = useLocale()
  const page = useMessages()
  const messages = useMemo(() => ({ ...page, ...WORDS[locale] }), [page, locale])
  return (
    <NextIntlClientProvider locale={locale} messages={messages}>
      {children}
    </NextIntlClientProvider>
  )
}
