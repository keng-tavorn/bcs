'use client'

import { useTranslations } from 'next-intl'
import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Field } from '../form/field'
import { Notice } from '../form/notice'
import { authClient, errorStatus, settled } from './client'
import { ScriptButton } from './script-button'

/** The address is not an e-mail (Better Auth checks it with z.email() before anything else) */
const BAD_REQUEST_STATUS = 400
/** Better Auth lets an address ask for a link 3 times a minute */
const BUSY_STATUS = 429

// Forgot password (FR-AUTH-001 AC2). The answer is the same whether or not the e-mail has an account,
// so the page cannot be used to find out who has one. The e-mail is sent by the page's script only: the form posts and
// its button waits for hydration (./script-button.tsx), so an address typed before the script runs never goes into
// the page's address, the browser's history or a request log. "Sent" is said only when the server took the request
// (§9.9 rule 7): an empty or unreadable address is said on the field, which takes the focus; too many requests, no
// answer or a server failure in a message above it, with the link not sent.
export function ForgotForm() {
  const t = useTranslations('auth.forgot')
  const tAuth = useTranslations('auth')
  const formRef = useRef<HTMLFormElement>(null)
  const [sent, setSent] = useState(false)
  const [pending, setPending] = useState(false)
  const [fieldErrors, setFieldErrors] = useState<{ readonly email?: string }>({})
  const [failure, setFailure] = useState<string | null>(null)

  // The e-mail field takes the focus when it says what is wrong with it, so a screen reader reads the words with it
  useEffect(() => {
    const field = fieldErrors.email ? formRef.current?.elements.namedItem('email') : null
    if (field instanceof HTMLInputElement) field.focus()
  }, [fieldErrors])

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const email = String(new FormData(event.currentTarget).get('email') ?? '').trim()
    setFailure(null)
    setFieldErrors(email ? {} : { email: t('emailRequired') })
    if (!email) return
    setPending(true)
    const { error } = await settled(authClient.requestPasswordReset({ email, redirectTo: '/reset-password' }))
    setPending(false)
    if (error) {
      const status = errorStatus(error)
      if (status === BAD_REQUEST_STATUS) setFieldErrors({ email: t('emailInvalid') })
      else setFailure(status === BUSY_STATUS ? tAuth('lock.busy') : t('failed'))
      return
    }
    setSent(true)
  }

  if (sent) return <Notice tone="success">{t('sent')}</Notice>
  return (
    <form ref={formRef} method="post" onSubmit={onSubmit} className="flex flex-col gap-5" noValidate>
      <p className="text-ink-muted">{t('intro')}</p>
      {failure ? <Notice tone="danger">{failure}</Notice> : null}
      <Field id="email" name="email" type="email" autoComplete="username" inputMode="email" required label={t('email')} error={fieldErrors.email} />
      <ScriptButton type="submit" disabled={pending} className="w-full">
        {pending ? t('submitting') : t('submit')}
      </ScriptButton>
    </form>
  )
}
