'use client'

import Link from 'next/link'
import { useTranslations } from 'next-intl'
import { useState, type FormEvent } from 'react'
import { Button } from '../form/button'
import { Notice } from '../form/notice'
import { PasswordPair, readPasswordPair } from './password-pair'

export type AcceptInvitationOutcome = { ok: true } | { ok: false; code: string }
export type AcceptInvitationAction = (token: string, password: string) => Promise<AcceptInvitationOutcome>

// Invitation acceptance (FR-AUTH-001 AC1–AC2): the one-time link sets a password and activates the member.
export function InviteForm({ token, min, accept }: { token: string; min: number; accept: AcceptInvitationAction }) {
  const t = useTranslations('auth.invite')
  const [errors, setErrors] = useState<{ password?: string; confirm?: string }>({})
  const [failure, setFailure] = useState<string | null>(null)
  const [done, setDone] = useState(false)
  const [pending, setPending] = useState(false)

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const { password, confirm } = readPasswordPair(new FormData(event.currentTarget))
    const next: typeof errors = {}
    if (password.length < min) next.password = t('tooShort', { min })
    else if (password !== confirm) next.confirm = t('mismatch')
    setErrors(next)
    setFailure(null)
    if (next.password || next.confirm) return
    setPending(true)
    const outcome = await accept(token, password)
    setPending(false)
    if (outcome.ok) {
      setDone(true)
      return
    }
    const messages: Record<string, string> = { TOKEN_INVALID: t('invalid'), TOKEN_USED: t('used'), TOKEN_EXPIRED: t('expired') }
    if (outcome.code === 'VALIDATION_FAILED') setErrors({ password: t('tooShort', { min }) })
    else setFailure(messages[outcome.code] ?? t('failed'))
  }

  if (done) {
    return (
      <div className="flex flex-col gap-4">
        <Notice tone="success">{t('done')}</Notice>
        <Link href="/login" className="font-medium text-primary underline underline-offset-4 hover:no-underline">
          {t('goLogin')}
        </Link>
      </div>
    )
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-5" noValidate>
      <p className="text-ink-muted">{t('intro')}</p>
      {failure ? <Notice tone="danger">{failure}</Notice> : null}
      <PasswordPair min={min} labels={{ password: t('password'), confirm: t('confirm') }} errors={errors} />
      <Button type="submit" disabled={pending} className="w-full">
        {pending ? t('submitting') : t('submit')}
      </Button>
    </form>
  )
}
