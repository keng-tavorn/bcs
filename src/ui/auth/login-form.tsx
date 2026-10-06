'use client'

import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Button } from '../form/button'
import { Field } from '../form/field'
import { useHydrated } from '../form/hydrated'
import { Notice } from '../form/notice'
import { authClient, errorStatus, failedToAnswer, settled } from './client'
import { useLockMessage } from './lock-message'

const LOCKED_STATUS = 429
const BAD_REQUEST_STATUS = 400
/** Better Auth's answer to an e-mail it cannot read as one (z.email(), an empty one included) */
const INVALID_EMAIL = 'INVALID_EMAIL'

// The web sign-in's first step (FR-AUTH-001): the e-mail and the password, sent by the page's script to Better Auth.
// Nothing is sent before the script runs: the form posts and its button waits for hydration (src/ui/form/hydrated.ts),
// so a password typed into the server's HTML on a slow phone never goes into the page's address, the browser's history,
// a request log or a Referer header (NFR-SEC-09). The fields take typing meanwhile; React keeps what was typed.
// What went wrong is said where it is (§9.9 rule 7): an empty field or an e-mail the server cannot read on that field,
// which takes the focus; a refusal or a request that got no answer in one message above the fields.

/** How the form words a first step that did not sign in */
export type SignInRefusal = 'emailInvalid' | 'locked' | 'invalid' | 'failed'

/**
 * Why the first step did not sign in, from Better Auth's answer: no answer or a server failure (check the connection
 * and send again), a lock (its own words, lock-message.ts), an address that is not an e-mail (on the e-mail field), or
 * anything else the server refused — a wrong e-mail or password, a password too long to be anyone's — without saying
 * which part was wrong (FR-AUTH-001 AC3)
 */
export function signInRefusal(failure: { status?: number; code?: string }): SignInRefusal {
  if (failedToAnswer(failure)) return 'failed'
  const status = errorStatus(failure)
  if (status === LOCKED_STATUS) return 'locked'
  if (status === BAD_REQUEST_STATUS && failure.code === INVALID_EMAIL) return 'emailInvalid'
  return 'invalid'
}

type FieldErrors = { readonly email?: string; readonly password?: string }

/** next: a path of this site to open after signing in (checked by safeNextPath on the page) */
export function LoginForm({ sessionEnded = false, next = null }: { sessionEnded?: boolean; next?: string | null }) {
  const t = useTranslations('auth.login')
  const router = useRouter()
  const lockMessage = useLockMessage()
  const hydrated = useHydrated()
  const formRef = useRef<HTMLFormElement>(null)
  const [error, setError] = useState<string | null>(null)
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({})
  const [pending, setPending] = useState(false)

  // The first field that says what is wrong with it takes the focus, so a screen reader reads its words with it
  useEffect(() => {
    const first = fieldErrors.email ? 'email' : fieldErrors.password ? 'password' : null
    const field = first ? formRef.current?.elements.namedItem(first) : null
    if (field instanceof HTMLInputElement) field.focus()
  }, [fieldErrors])

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    const email = String(form.get('email') ?? '').trim()
    const password = String(form.get('password') ?? '')
    setError(null)
    // Nothing is sent without both: the empty field says what to fill in (an empty e-mail would come back refused)
    const missing: FieldErrors = { ...(email ? {} : { email: t('emailRequired') }), ...(password ? {} : { password: t('passwordRequired') }) }
    setFieldErrors(missing)
    if (missing.email || missing.password) return
    setPending(true)
    const { data, error: failure } = await settled(authClient.signIn.email({ email, password }))
    if (failure) {
      setPending(false)
      const refusal = signInRefusal(failure)
      if (refusal === 'emailInvalid') setFieldErrors({ email: t('emailInvalid') })
      else setError(refusal === 'locked' ? lockMessage(failure) : refusal === 'invalid' ? t('invalid') : t('failed'))
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
    <form ref={formRef} method="post" onSubmit={onSubmit} className="flex flex-col gap-5" noValidate>
      {sessionEnded && !error ? <Notice tone="info">{t('sessionEnded')}</Notice> : null}
      {error ? <Notice tone="danger">{error}</Notice> : null}
      <Field id="email" name="email" type="email" autoComplete="username" inputMode="email" required label={t('email')} error={fieldErrors.email} />
      <Field id="password" name="password" type="password" autoComplete="current-password" required label={t('password')} error={fieldErrors.password} />
      {/* A disabled default button also stops Enter in a field from submitting the form before the script runs */}
      <Button type="submit" disabled={pending || !hydrated} className="w-full">
        {pending ? t('submitting') : t('submit')}
      </Button>
    </form>
  )
}
