'use client'

import Link from 'next/link'
import { useTranslations } from 'next-intl'
import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Button } from '../form/button'
import { useHydrated } from '../form/hydrated'
import { Notice } from '../form/notice'
import { resetRefusal } from './answers'
import { authClient, settledWithWait } from './client'
import { PasswordPair, readPasswordPair } from './password-pair'

type FieldErrors = { readonly password?: string; readonly confirm?: string }

// Set a new password from the e-mailed link (FR-AUTH-001 AC2). Better Auth signs out the account's other sessions. The
// new password is sent by the page's script only: the form posts and its button waits for hydration
// (src/ui/form/hydrated.ts), so a password typed before the script runs never goes into the page's address (NFR-SEC-09).
// What went wrong is said for what it is (§9.9 rule 7, ./answers.ts): a password shorter or longer than the rule, or two
// that differ, on the field, which takes the focus — checked here before sending, and by Better Auth before it uses the
// link, which then still works; no answer, a server failure or too many requests above the fields, the link not used
// either; only a link Better Auth does not take is called expired or used, with the way to a new one.
export function ResetForm({ token, min, max }: { token: string | null; min: number; max: number }) {
  const t = useTranslations('auth.reset')
  const tInvite = useTranslations('auth.invite')
  const tAuth = useTranslations('auth')
  const hydrated = useHydrated()
  const formRef = useRef<HTMLFormElement>(null)
  const [errors, setErrors] = useState<FieldErrors>({})
  const [failure, setFailure] = useState<string | null>(null)
  const [state, setState] = useState<'form' | 'done' | 'invalid'>(token ? 'form' : 'invalid')
  const [pending, setPending] = useState(false)

  // The first field that says what is wrong with it takes the focus, so a screen reader reads its words with it
  useEffect(() => {
    const first = errors.password ? 'password' : errors.confirm ? 'confirm' : null
    const field = first ? formRef.current?.elements.namedItem(first) : null
    if (field instanceof HTMLInputElement) field.focus()
  }, [errors])

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!token) return
    const { password, confirm } = readPasswordPair(new FormData(event.currentTarget))
    const tooShort = tInvite('tooShort', { min })
    const tooLong = t('tooLong', { max })
    const next: FieldErrors =
      password.length < min ? { password: tooShort } : password.length > max ? { password: tooLong } : password !== confirm ? { confirm: tInvite('mismatch') } : {}
    setErrors(next)
    setFailure(null)
    if (next.password || next.confirm) return
    setPending(true)
    const { answer, retryAfter } = await settledWithWait((hooks) => authClient.resetPassword({ newPassword: password, token }, hooks))
    setPending(false)
    if (!answer.error) {
      setState('done')
      return
    }
    const refusal = resetRefusal(answer.error)
    if (refusal === 'linkInvalid') setState('invalid')
    // Better Auth's own length rule, read before the link: the link still works
    else if (refusal === 'tooShort') setErrors({ password: tooShort })
    else if (refusal === 'tooLong') setErrors({ password: tooLong })
    // No answer, a server failure or too many requests: the link was not used up, so the form stays and says to send again
    else setFailure(refusal === 'busy' ? t('busy', { seconds: retryAfter ?? 0 }) : t('failed'))
  }

  if (state === 'done') {
    return (
      <div className="flex flex-col gap-4">
        <Notice tone="success">{t('done')}</Notice>
        <Link href="/login" className="font-medium text-primary underline underline-offset-4 hover:no-underline">
          {tAuth('backToLogin')}
        </Link>
      </div>
    )
  }
  if (state === 'invalid') {
    return (
      <div className="flex flex-col gap-4">
        <Notice tone="danger">{t('invalidLink')}</Notice>
        <Link href="/forgot-password" className="font-medium text-primary underline underline-offset-4 hover:no-underline">
          {t('requestNew')}
        </Link>
      </div>
    )
  }
  return (
    <form ref={formRef} method="post" onSubmit={onSubmit} className="flex flex-col gap-5" noValidate>
      {failure ? <Notice tone="danger">{failure}</Notice> : null}
      <PasswordPair min={min} labels={{ password: t('password'), confirm: t('confirm') }} errors={errors} />
      <Button type="submit" disabled={pending || !hydrated} className="w-full">
        {pending ? t('submitting') : t('submit')}
      </Button>
    </form>
  )
}
