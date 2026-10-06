'use client'

import Link from 'next/link'
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
/** A code from the authenticator app: six digits (TOTP, RFC 6238) */
const APP_CODE = /^\d{6}$/

/** A plain text link, 44 px tall on a phone (NFR-A11Y-02), underlined, without an arrow (§9.9) */
const LINK = 'inline-flex min-h-11 items-center self-start font-medium text-primary underline underline-offset-4 hover:no-underline'

// Second sign-in step (FR-AUTH-002): a code from the authenticator app, or one of the 10 single-use backup codes, sent
// by the page's script. Nothing is sent before the script runs (/login/2fa opened directly is the server's HTML first):
// the form posts and its button waits for hydration (src/ui/form/hydrated.ts), so a code never goes into the page's
// address (NFR-SEC-09); the switch to a backup code waits too, as a press before the script runs would be lost. Nothing
// is sent that cannot be a code either (§9.9 rule 7): an empty field, or an app code that is not six digits, is said on
// the field, which takes the focus — never "the code is wrong", and never a failed sign-in counted against the account
// (FR-AUTH-001 AC3). A step that waited too long leads back to the sign-in with the page it was going to (next).
export function TwoFactorForm({ next = null }: { next?: string | null }) {
  const t = useTranslations('auth.twoFactor')
  const tAuth = useTranslations('auth')
  const router = useRouter()
  const lockMessage = useLockMessage()
  const hydrated = useHydrated()
  const formRef = useRef<HTMLFormElement>(null)
  const [mode, setMode] = useState<'app' | 'backup'>('app')
  const [error, setError] = useState<string | null>(null)
  /** What is wrong with the field, said on it; a new object at every press, so the field takes the focus every time */
  const [fieldError, setFieldError] = useState<{ readonly text: string } | null>(null)
  const [expired, setExpired] = useState(false)
  const [pending, setPending] = useState(false)

  // The field that says what is wrong with it takes the focus, so a screen reader reads its words with it
  useEffect(() => {
    if (!fieldError) return
    const field = formRef.current?.elements.namedItem('code')
    if (field instanceof HTMLInputElement) field.focus()
  }, [fieldError])

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const code = String(new FormData(event.currentTarget).get('code') ?? '').trim()
    setError(null)
    const problem = !code ? (mode === 'app' ? t('codeRequired') : t('backupRequired')) : mode === 'app' && !APP_CODE.test(code) ? t('codeFormat') : null
    setFieldError(problem ? { text: problem } : null)
    if (problem) return
    setPending(true)
    const { error: failure } =
      mode === 'app' ? await settled(authClient.twoFactor.verifyTotp({ code })) : await settled(authClient.twoFactor.verifyBackupCode({ code }))
    if (failure) {
      setPending(false)
      if (failure.code === 'INVALID_TWO_FACTOR_COOKIE') {
        setExpired(true)
        return
      }
      // No answer, or the server failed: the code was not checked, so it is not called wrong (the sign-in's words)
      if (failedToAnswer(failure)) return setError(tAuth('login.failed'))
      if (errorStatus(failure) === LOCKED_STATUS) return setError(lockMessage(failure))
      setError(mode === 'app' ? t('invalid') : t('invalidBackup'))
      return
    }
    router.replace(next ?? '/')
    router.refresh()
  }

  if (expired) {
    return (
      <div className="flex flex-col gap-4">
        <Notice tone="danger">{t('expired')}</Notice>
        {/* Back to the sign-in, then on to the page this sign-in was for (an e-mail action link, LIFF's web sign-in) */}
        <Link href={next ? `/login?next=${encodeURIComponent(next)}` : '/login'} className={LINK}>
          {tAuth('backToLogin')}
        </Link>
      </div>
    )
  }

  return (
    <form ref={formRef} method="post" onSubmit={onSubmit} className="flex flex-col gap-5" noValidate>
      <p className="text-ink-muted">{t('intro')}</p>
      {error ? <Notice tone="danger">{error}</Notice> : null}
      {mode === 'app' ? (
        <Field
          key="app"
          id="code"
          name="code"
          label={t('code')}
          inputMode="numeric"
          autoComplete="one-time-code"
          pattern="[0-9]{6}"
          maxLength={6}
          required
          className="tabular tracking-widest"
          error={fieldError?.text}
        />
      ) : (
        <Field key="backup" id="code" name="code" label={t('backupCode')} hint={t('backupHint')} autoComplete="off" required error={fieldError?.text} />
      )}
      <Button type="submit" disabled={pending || !hydrated} className="w-full">
        {pending ? t('submitting') : t('submit')}
      </Button>
      {/* A link-looking button that is still a 44 px tap target on a phone (NFR-A11Y-02), as LIFF's twin is */}
      <Button
        variant="link"
        className="min-h-11 self-start"
        disabled={!hydrated}
        onClick={() => {
          setMode(mode === 'app' ? 'backup' : 'app')
          setError(null)
          setFieldError(null)
        }}
      >
        {mode === 'app' ? t('useBackup') : t('useApp')}
      </Button>
    </form>
  )
}
