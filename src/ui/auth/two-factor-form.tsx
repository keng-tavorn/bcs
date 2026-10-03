'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { useState, type FormEvent } from 'react'
import { Button } from '../form/button'
import { Field } from '../form/field'
import { Notice } from '../form/notice'
import { authClient, errorStatus } from './client'
import { useLockMessage } from './lock-message'

const LOCKED_STATUS = 429

// Second sign-in step (FR-AUTH-002): a code from the authenticator app, or one of the 10 single-use backup codes.
export function TwoFactorForm() {
  const t = useTranslations('auth.twoFactor')
  const tAuth = useTranslations('auth')
  const router = useRouter()
  const lockMessage = useLockMessage()
  const [mode, setMode] = useState<'app' | 'backup'>('app')
  const [error, setError] = useState<string | null>(null)
  const [expired, setExpired] = useState(false)
  const [pending, setPending] = useState(false)

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const code = String(new FormData(event.currentTarget).get('code') ?? '').trim()
    setPending(true)
    setError(null)
    const { error: failure } =
      mode === 'app' ? await authClient.twoFactor.verifyTotp({ code }) : await authClient.twoFactor.verifyBackupCode({ code })
    if (failure) {
      setPending(false)
      if (failure.code === 'INVALID_TWO_FACTOR_COOKIE') {
        setExpired(true)
        return
      }
      if (errorStatus(failure) === LOCKED_STATUS) return setError(lockMessage(failure))
      setError(mode === 'app' ? t('invalid') : t('invalidBackup'))
      return
    }
    router.replace('/')
    router.refresh()
  }

  if (expired) {
    return (
      <div className="flex flex-col gap-4">
        <Notice tone="danger">{t('expired')}</Notice>
        <Link href="/login" className="font-medium text-primary underline underline-offset-4 hover:no-underline">
          {tAuth('backToLogin')}
        </Link>
      </div>
    )
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-5" noValidate>
      <p className="text-ink-muted">{t('intro')}</p>
      {error ? <Notice tone="danger">{error}</Notice> : null}
      {mode === 'app' ? (
        <Field key="app" id="code" name="code" label={t('code')} inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} required className="tabular tracking-widest" />
      ) : (
        <Field key="backup" id="code" name="code" label={t('backupCode')} hint={t('backupHint')} autoComplete="off" required />
      )}
      <Button type="submit" disabled={pending} className="w-full">
        {pending ? t('submitting') : t('submit')}
      </Button>
      <Button
        variant="link"
        className="self-start"
        onClick={() => {
          setMode(mode === 'app' ? 'backup' : 'app')
          setError(null)
        }}
      >
        {mode === 'app' ? t('useBackup') : t('useApp')}
      </Button>
    </form>
  )
}
