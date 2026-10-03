'use client'

import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { useState, type FormEvent } from 'react'
import { Button } from '../form/button'
import { Field } from '../form/field'
import { Notice } from '../form/notice'
import { authClient, errorStatus } from './client'
import { useLockMessage } from './lock-message'

const LOCKED_STATUS = 429
const UNAUTHORIZED_STATUS = 401

/** next: a path of this site to open after signing in (checked by safeNextPath on the page) */
export function LoginForm({ sessionEnded = false, next = null }: { sessionEnded?: boolean; next?: string | null }) {
  const t = useTranslations('auth.login')
  const router = useRouter()
  const lockMessage = useLockMessage()
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    setPending(true)
    setError(null)
    const { data, error: failure } = await authClient.signIn.email({
      email: String(form.get('email') ?? ''),
      password: String(form.get('password') ?? ''),
    })
    if (failure) {
      setPending(false)
      const status = errorStatus(failure)
      setError(status === LOCKED_STATUS ? lockMessage(failure) : status === UNAUTHORIZED_STATUS ? t('invalid') : t('failed'))
      return
    }
    if (data && 'twoFactorRedirect' in data && data.twoFactorRedirect) {
      router.push(next ? `/login/2fa?next=${encodeURIComponent(next)}` : '/login/2fa')
      return
    }
    router.replace(next ?? '/')
    router.refresh()
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-5" noValidate>
      {sessionEnded && !error ? <Notice tone="info">{t('sessionEnded')}</Notice> : null}
      {error ? <Notice tone="danger">{error}</Notice> : null}
      <Field id="email" name="email" type="email" autoComplete="username" inputMode="email" required label={t('email')} />
      <Field id="password" name="password" type="password" autoComplete="current-password" required label={t('password')} />
      <Button type="submit" disabled={pending} className="w-full">
        {pending ? t('submitting') : t('submit')}
      </Button>
    </form>
  )
}
