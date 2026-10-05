'use client'

import { useTranslations } from 'next-intl'
import { useState, type FormEvent } from 'react'
import { Button } from '../form/button'
import { Field } from '../form/field'
import { useHydrated } from '../form/hydrated'
import { Notice } from '../form/notice'
import { authClient } from './client'

// Forgot password (FR-AUTH-001 AC2). The answer is the same whether or not the e-mail has an account,
// so the page cannot be used to find out who has one. The e-mail is sent by the page's script only: the form posts and
// its button waits for hydration (src/ui/form/hydrated.ts), so an address typed before the script runs never goes into
// the page's address, the browser's history or a request log.
export function ForgotForm() {
  const t = useTranslations('auth.forgot')
  const hydrated = useHydrated()
  const [sent, setSent] = useState(false)
  const [pending, setPending] = useState(false)

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const email = String(new FormData(event.currentTarget).get('email') ?? '').trim()
    setPending(true)
    await authClient.requestPasswordReset({ email, redirectTo: '/reset-password' })
    setPending(false)
    setSent(true)
  }

  if (sent) return <Notice tone="success">{t('sent')}</Notice>
  return (
    <form method="post" onSubmit={onSubmit} className="flex flex-col gap-5" noValidate>
      <p className="text-ink-muted">{t('intro')}</p>
      <Field id="email" name="email" type="email" autoComplete="username" inputMode="email" required label={t('email')} />
      <Button type="submit" disabled={pending || !hydrated} className="w-full">
        {pending ? t('submitting') : t('submit')}
      </Button>
    </form>
  )
}
