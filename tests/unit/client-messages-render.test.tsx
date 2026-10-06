import { NextIntlClientProvider, useFormatter, useTranslations } from 'next-intl'
import type { ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import ErrorPage from '@/app/error'
import { CLIENT_MESSAGES, pickMessages, type ClientMessagesScope } from '@/i18n/client-messages'
import en from '../../messages/en.json'
import th from '../../messages/th.json'

// §9.4 · NFR-I18N-01: the providers of src/app/_lib/client-messages.tsx as client components see them. A LIFF part's
// provider holds the gate's words and its own, so both reach its components; and the root error boundary reads the
// root's messages only, in Thai and in English.

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: () => undefined, refresh: () => undefined, replace: () => undefined }) }))

const WHEN = new Date('2026-10-04T03:00:00Z')

/** A client component under the provider of one scope, as its layout renders it */
function under(scope: ClientMessagesScope, locale: 'th' | 'en', node: ReactNode) {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale={locale} timeZone="Asia/Bangkok" messages={pickMessages(locale === 'th' ? th : en, CLIENT_MESSAGES[scope])}>
      {node}
    </NextIntlClientProvider>,
  )
}

function TaskWords() {
  const gate = useTranslations('liff.gate')
  const decide = useTranslations('tasks.decide')
  const format = useFormatter()
  return (
    <p>
      {gate('signingIn')} | {decide('approve')} | {format.dateTime(WHEN, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })}
    </p>
  )
}

describe('[NFR-I18N-01] [§9.4] a LIFF part’s provider holds the gate’s words and its own', () => {
  it('shows the gate’s words and the decision’s on /liff/tasks/[id], in Thai and in English, in the time zone of the request', () => {
    for (const [locale, catalogue] of [['th', th] as const, ['en', en] as const]) {
      const html = under('liffTask', locale, <TaskWords />)
      expect(html).toContain(catalogue.liff.gate.signingIn)
      expect(html).toContain(catalogue.tasks.decide.approve)
      // 03:00 UTC is 10:00 in Bangkok
      expect(html).toContain('10:00')
    }
  })

  it('every LIFF part passes the gate’s words, so a page signed out still says what is happening', () => {
    for (const scope of Object.keys(CLIENT_MESSAGES) as ClientMessagesScope[]) {
      if (!scope.startsWith('liff')) continue
      expect(under(scope, 'th', <GateWords />), scope).toContain(th.liff.gate.signingIn)
    }
  })
})

function GateWords() {
  return <span>{useTranslations('liff.gate')('signingIn')}</span>
}

describe('[NFR-I18N-01] [§9.4] the root error boundary with the root’s messages only', () => {
  const page = (locale: 'th' | 'en') =>
    under('root', locale, <ErrorPage error={Object.assign(new Error('boom'), { digest: 'abc123' })} reset={() => undefined} />)

  it('says what happened, that saved work is safe, the reference, and what to do — in Thai and in English', () => {
    for (const [locale, catalogue] of [['th', th] as const, ['en', en] as const]) {
      const html = page(locale)
      expect(html).toContain(`<h1 class="text-2xl font-semibold">${catalogue.app.error.title}</h1>`)
      expect(html).toContain(catalogue.app.error.body)
      expect(html).toContain(catalogue.app.error.reference.replace('{reference}', 'abc123'))
      expect(html).toContain(catalogue.app.error.retry)
      expect(html).toContain(catalogue.app.error.home)
      // Never the error's own text
      expect(html).not.toContain('boom')
    }
  })

  it('announces the problem at once and keeps the actions 44 px high (§9.9, NFR-A11Y-02)', () => {
    const html = page('th')
    expect(html).toContain('role="alert"')
    expect(html).toMatch(/<button type="button" class="[^"]*\bh-11\b/)
    expect(html).toMatch(/<a href="\/" class="[^"]*\bmin-h-11\b/)
    // The icon is decoration: the words say it
    expect(html).toMatch(/<svg[^>]*aria-hidden="true"/)
  })
})
