'use server'

import { revalidatePath } from 'next/cache'
import { cookies } from 'next/headers'
import { isLocale, localeCookieName } from '@/i18n/locales'
import { LOCALE_COOKIE_MAX_AGE_SECONDS } from '@/lib/constants'

// Language switch (FR-PLT-002 AC2, ADR-026): Thai by default, English by choice, remembered in a cookie.
// A POST server action, never a GET link, because it changes state.
export async function setLocaleAction(formData: FormData): Promise<void> {
  const locale = String(formData.get('locale') ?? '')
  if (!isLocale(locale)) return
  const store = await cookies()
  store.set(localeCookieName, locale, { path: '/', maxAge: LOCALE_COOKIE_MAX_AGE_SECONDS, sameSite: 'lax' })
  revalidatePath('/', 'layout')
}
