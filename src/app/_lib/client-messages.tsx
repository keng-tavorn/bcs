import { NextIntlClientProvider } from 'next-intl'
import { getMessages } from 'next-intl/server'
import type { ReactNode } from 'react'
import { CLIENT_MESSAGES, pickMessages, type ClientMessagesScope } from '@/i18n/client-messages'

/**
 * The message provider of one part of the app: its client components read only the messages CLIENT_MESSAGES lists
 * for the part (src/i18n/client-messages.ts), in the request's language. It replaces the provider above it.
 */
export async function ClientMessages({ scope, children }: { readonly scope: ClientMessagesScope; readonly children: ReactNode }) {
  const messages = await getMessages()
  return <NextIntlClientProvider messages={pickMessages(messages, CLIENT_MESSAGES[scope])}>{children}</NextIntlClientProvider>
}
