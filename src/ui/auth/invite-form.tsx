'use client'

import Link from 'next/link'
import { useTranslations } from 'next-intl'
import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Notice } from '../form/notice'
import { PasswordPair, readPasswordPair } from './password-pair'
import { ScriptButton } from './script-button'

/** A refusal's field: what the server could not read (VALIDATION_FAILED) — 'token', the link itself, or 'password' */
export type AcceptInvitationOutcome = { ok: true } | { ok: false; code: string; field?: string }
export type AcceptInvitationAction = (token: string, password: string) => Promise<AcceptInvitationOutcome>

type FieldErrors = { readonly password?: string; readonly confirm?: string }

// Invitation acceptance (FR-AUTH-001 AC1–AC2): the one-time link sets a password and activates the member. The password
// is sent by the page's script only (the server action): the form posts and its button waits for hydration
// (./script-button.tsx), so a password typed before the script runs never goes into the page's address (NFR-SEC-09).
// What went wrong is said for what it is (§9.9 rule 7), as on the new-password form (./reset-form.tsx): a password
// shorter or longer than the rule, or two that differ, on the field, which takes the focus — checked here before sending,
// and by the server, whose refusal names the field; a link the server cannot read as one (cut short when it was copied)
// is an invalid link, never a password too short.
export function InviteForm({ token, min, max, accept }: { token: string; min: number; max: number; accept: AcceptInvitationAction }) {
  const t = useTranslations('auth.invite')
  const tReset = useTranslations('auth.reset')
  const formRef = useRef<HTMLFormElement>(null)
  const [errors, setErrors] = useState<FieldErrors>({})
  const [failure, setFailure] = useState<string | null>(null)
  const [done, setDone] = useState(false)
  const [pending, setPending] = useState(false)

  // The first field that says what is wrong with it takes the focus, so a screen reader reads its words with it
  useEffect(() => {
    const first = errors.password ? 'password' : errors.confirm ? 'confirm' : null
    const field = first ? formRef.current?.elements.namedItem(first) : null
    if (field instanceof HTMLInputElement) field.focus()
  }, [errors])

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const { password, confirm } = readPasswordPair(new FormData(event.currentTarget))
    const tooShort = t('tooShort', { min })
    const tooLong = tReset('tooLong', { max })
    const next: FieldErrors =
      password.length < min ? { password: tooShort } : password.length > max ? { password: tooLong } : password !== confirm ? { confirm: t('mismatch') } : {}
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
    // The server's own length rule, on the field it names; anything else it cannot read is the link's token
    if (outcome.code === 'VALIDATION_FAILED' && outcome.field === 'password') {
      setErrors({ password: password.length > max ? tooLong : tooShort })
      return
    }
    const messages: Record<string, string> = { VALIDATION_FAILED: t('invalid'), TOKEN_INVALID: t('invalid'), TOKEN_USED: t('used'), TOKEN_EXPIRED: t('expired') }
    setFailure(messages[outcome.code] ?? t('failed'))
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
    <form ref={formRef} method="post" onSubmit={onSubmit} className="flex flex-col gap-5" noValidate>
      <p className="text-ink-muted">{t('intro')}</p>
      {failure ? <Notice tone="danger">{failure}</Notice> : null}
      <PasswordPair min={min} labels={{ password: t('password'), confirm: t('confirm') }} errors={errors} />
      <ScriptButton type="submit" disabled={pending} className="w-full">
        {pending ? t('submitting') : t('submit')}
      </ScriptButton>
    </form>
  )
}
