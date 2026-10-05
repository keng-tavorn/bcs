'use client'

import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { useState, type FormEvent } from 'react'
import { Button } from '../form/button'
import { Field } from '../form/field'
import { useHydrated } from '../form/hydrated'
import { Notice } from '../form/notice'
import { authClient, errorStatus } from './client'
import { useLockMessage } from './lock-message'

const LOCKED_STATUS = 429
const UNAUTHORIZED_STATUS = 401

// The web sign-in's first step (FR-AUTH-001): the e-mail and the password, sent by the page's script to Better Auth.
// Nothing is sent before the script runs: the form posts and its button waits for hydration (src/ui/form/hydrated.ts),
// so a password typed into the server's HTML on a slow phone never goes into the page's address, the browser's history,
// a request log or a Referer header (NFR-SEC-09). The fields take typing meanwhile; React keeps what was typed.

/** next: a path of this site to open after signing in (checked by safeNextPath on the page) */
export function LoginForm({ sessionEnded = false, next = null }: { sessionEnded?: boolean; next?: string | null }) {
  const t = useTranslations('auth.login')
  const router = useRouter()
  const lockMessage = useLockMessage()
  const hydrated = useHydrated()
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
    // method="post": a submission before hydration never puts the e-mail or the password in the address (see the top)
    <form method="post" onSubmit={onSubmit} className="flex flex-col gap-5" noValidate>
      {sessionEnded && !error ? <Notice tone="info">{t('sessionEnded')}</Notice> : null}
      {error ? <Notice tone="danger">{error}</Notice> : null}
      <Field id="email" name="email" type="email" autoComplete="username" inputMode="email" required label={t('email')} />
      <Field id="password" name="password" type="password" autoComplete="current-password" required label={t('password')} />
      {/* A disabled default button also stops Enter in a field from submitting the form before the script runs */}
      <Button type="submit" disabled={pending || !hydrated} className="w-full">
        {pending ? t('submitting') : t('submit')}
      </Button>
    </form>
  )
}
