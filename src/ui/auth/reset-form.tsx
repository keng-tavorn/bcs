'use client'

import Link from 'next/link'
import { useTranslations } from 'next-intl'
import { useState, type FormEvent } from 'react'
import { Button } from '../form/button'
import { useHydrated } from '../form/hydrated'
import { Notice } from '../form/notice'
import { authClient } from './client'
import { PasswordPair, readPasswordPair } from './password-pair'

// Set a new password from the e-mailed link (FR-AUTH-001 AC2). Better Auth signs out the account's other sessions. The
// new password is sent by the page's script only: the form posts and its button waits for hydration
// (src/ui/form/hydrated.ts), so a password typed before the script runs never goes into the page's address (NFR-SEC-09).
export function ResetForm({ token, min }: { token: string | null; min: number }) {
  const t = useTranslations('auth.reset')
  const tInvite = useTranslations('auth.invite')
  const tAuth = useTranslations('auth')
  const hydrated = useHydrated()
  const [errors, setErrors] = useState<{ password?: string; confirm?: string }>({})
  const [state, setState] = useState<'form' | 'done' | 'invalid'>(token ? 'form' : 'invalid')
  const [pending, setPending] = useState(false)

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!token) return
    const { password, confirm } = readPasswordPair(new FormData(event.currentTarget))
    const next: typeof errors = {}
    if (password.length < min) next.password = tInvite('tooShort', { min })
    else if (password !== confirm) next.confirm = tInvite('mismatch')
    setErrors(next)
    if (next.password || next.confirm) return
    setPending(true)
    const { error } = await authClient.resetPassword({ newPassword: password, token })
    setPending(false)
    setState(error ? 'invalid' : 'done')
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
    <form method="post" onSubmit={onSubmit} className="flex flex-col gap-5" noValidate>
      <PasswordPair min={min} labels={{ password: t('password'), confirm: t('confirm') }} errors={errors} />
      <Button type="submit" disabled={pending || !hydrated} className="w-full">
        {pending ? t('submitting') : t('submit')}
      </Button>
    </form>
  )
}
