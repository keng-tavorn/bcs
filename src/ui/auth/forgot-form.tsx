'use client'

import { useTranslations } from 'next-intl'
import { useState, type FormEvent } from 'react'
import { Button } from '../form/button'
import { Field } from '../form/field'
import { Notice } from '../form/notice'
import { authClient } from './client'

// Forgot password (FR-AUTH-001 AC2). The answer is the same whether or not the e-mail has an account,
// so the page cannot be used to find out who has one.
export function ForgotForm() {
  const t = useTranslations('auth.forgot')
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
    <form onSubmit={onSubmit} className="flex flex-col gap-5" noValidate>
      <p className="text-ink-muted">{t('intro')}</p>
      <Field id="email" name="email" type="email" autoComplete="username" inputMode="email" required label={t('email')} />
      <Button type="submit" disabled={pending} className="w-full">
        {pending ? t('submitting') : t('submit')}
      </Button>
    </form>
  )
}
