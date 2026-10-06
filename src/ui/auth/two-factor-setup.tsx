'use client'

import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Button } from '../form/button'
import { Field } from '../form/field'
import { Notice } from '../form/notice'
import { setupCodeRefusal, setupPasswordRefusal, type SetupRefusal } from './answers'
import { authClient, settledWithWait } from './client'
import { QrCode } from './qr-code'
import { ScriptButton } from './script-button'

type Step = { kind: 'password' } | { kind: 'scan'; uri: string; secret: string; backupCodes: string[] } | { kind: 'codes'; backupCodes: string[] }

/** The base32 key from an otpauth:// URI, grouped by four for typing into an app by hand. */
function manualKey(uri: string): string {
  const secret = new URL(uri).searchParams.get('secret') ?? ''
  return secret.replace(/(.{4})/g, '$1 ').trim()
}

// Authenticator setup (FR-AUTH-002 AC1–AC2): confirm the password, scan, confirm a code, keep the 10 backup codes. The
// password and the code are sent by the page's script only. The password step is in the server's HTML (the workspace
// shows it before any work), so both forms post and their buttons wait for hydration (./script-button.tsx): nothing
// typed before the script runs goes into the page's address (NFR-SEC-09). What went wrong is said for what it is (§9.9
// rule 7, ./answers.ts): an empty password on its field, which takes the focus; above the form, a password or a code the
// server refused, and apart from them what never reached that check — no answer, too many requests (Better Auth's limit
// on its two-factor routes, with the seconds to wait it sends), a session that ended, a setup already done elsewhere.
export function TwoFactorSetup() {
  const t = useTranslations('auth.security')
  const router = useRouter()
  const passwordForm = useRef<HTMLFormElement>(null)
  const [step, setStep] = useState<Step>({ kind: 'password' })
  const [error, setError] = useState<string | null>(null)
  const [missing, setMissing] = useState<{ readonly password?: string }>({})
  const [pending, setPending] = useState(false)
  const [copied, setCopied] = useState(false)

  // An empty password field says so and takes the focus, so a screen reader reads its words with it
  useEffect(() => {
    const field = missing.password ? passwordForm.current?.elements.namedItem('password') : null
    if (field instanceof HTMLInputElement) field.focus()
  }, [missing])

  /** What happened to a step that did not go through, and what to do (retryAfter: the seconds the server asked to wait) */
  function refusalText(refusal: SetupRefusal, retryAfter: number | null): string {
    switch (refusal) {
      case 'failed':
        return t('failed')
      case 'busy':
        return t('busy', { seconds: retryAfter ?? 0 })
      case 'signedOut':
        return t('signedOut')
      case 'alreadyOn':
        return t('alreadyOn')
      case 'wrongPassword':
        return t('wrongPassword')
      case 'invalidCode':
        return t('invalidCode')
      case 'refused':
        return t('refused')
    }
  }

  async function start(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const password = String(new FormData(event.currentTarget).get('password') ?? '')
    setError(null)
    // Nothing is sent without it: an empty password is not a wrong one
    setMissing(password ? {} : { password: t('passwordRequired') })
    if (!password) return
    setPending(true)
    const { answer, retryAfter } = await settledWithWait((hooks) => authClient.twoFactor.enable({ password }, hooks))
    setPending(false)
    const { data, error: failure } = answer
    if (failure) {
      setError(refusalText(setupPasswordRefusal(failure), retryAfter))
      return
    }
    // An answer without the authenticator's key sets nothing up, and says nothing about the password
    if (!data || !('totpURI' in data)) {
      setError(t('refused'))
      return
    }
    setStep({ kind: 'scan', uri: data.totpURI, secret: manualKey(data.totpURI), backupCodes: data.backupCodes })
  }

  async function confirm(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (step.kind !== 'scan') return
    const code = String(new FormData(event.currentTarget).get('code') ?? '').trim()
    setPending(true)
    setError(null)
    const { answer, retryAfter } = await settledWithWait((hooks) => authClient.twoFactor.verifyTotp({ code }, hooks))
    setPending(false)
    if (answer.error) {
      setError(refusalText(setupCodeRefusal(answer.error), retryAfter))
      return
    }
    setStep({ kind: 'codes', backupCodes: step.backupCodes })
  }

  if (step.kind === 'codes') {
    return (
      <div className="flex flex-col gap-4">
        <Notice tone="success">{t('enabled')}</Notice>
        <h3 className="text-lg font-semibold">{t('backupTitle')}</h3>
        <p className="text-ink-muted">{t('backupIntro')}</p>
        <ul className="tabular grid grid-cols-2 gap-x-6 gap-y-1 border border-line bg-surface px-4 py-3 text-base">
          {step.backupCodes.map((code) => (
            <li key={code}>{code}</li>
          ))}
        </ul>
        <div className="flex flex-col gap-3 sm:flex-row">
          <Button
            variant="secondary"
            onClick={async () => {
              await navigator.clipboard.writeText(step.backupCodes.join('\n'))
              setCopied(true)
            }}
          >
            {t('copyCodes')}
          </Button>
          <Button
            onClick={() => {
              router.replace('/')
              router.refresh()
            }}
          >
            {t('savedContinue')}
          </Button>
        </div>
        {copied ? <p role="status" className="text-base md:text-sm text-ink-muted">{t('copied')}</p> : null}
      </div>
    )
  }

  if (step.kind === 'scan') {
    return (
      <form method="post" onSubmit={confirm} className="flex flex-col gap-5" noValidate>
        <div className="flex flex-col gap-3">
          <h3 className="font-semibold">{t('stepScan')}</h3>
          <QrCode value={step.uri} label={t('qrLabel')} />
          <p className="text-base md:text-sm text-ink-muted">{t('manualKey')}</p>
          <p className="tabular break-all text-base tracking-wide">{step.secret}</p>
        </div>
        <h3 className="font-semibold">{t('stepConfirm')}</h3>
        {error ? <Notice tone="danger">{error}</Notice> : null}
        <Field id="code" name="code" label={t('code')} inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} required className="tabular tracking-widest" />
        <ScriptButton type="submit" disabled={pending} className="w-full sm:w-auto">
          {pending ? t('confirming') : t('confirm')}
        </ScriptButton>
      </form>
    )
  }

  return (
    <form ref={passwordForm} method="post" onSubmit={start} className="flex flex-col gap-5" noValidate>
      <h3 className="font-semibold">{t('stepPassword')}</h3>
      {error ? <Notice tone="danger">{error}</Notice> : null}
      <Field id="setup-password" name="password" type="password" autoComplete="current-password" required label={t('password')} error={missing.password} />
      <ScriptButton type="submit" disabled={pending} className="w-full sm:w-auto">
        {pending ? t('starting') : t('start')}
      </ScriptButton>
    </form>
  )
}
