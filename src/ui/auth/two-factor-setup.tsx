'use client'

import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { useState, type FormEvent } from 'react'
import { Button } from '../form/button'
import { Field } from '../form/field'
import { useHydrated } from '../form/hydrated'
import { Notice } from '../form/notice'
import { authClient } from './client'
import { QrCode } from './qr-code'

type Step = { kind: 'password' } | { kind: 'scan'; uri: string; secret: string; backupCodes: string[] } | { kind: 'codes'; backupCodes: string[] }

/** The base32 key from an otpauth:// URI, grouped by four for typing into an app by hand. */
function manualKey(uri: string): string {
  const secret = new URL(uri).searchParams.get('secret') ?? ''
  return secret.replace(/(.{4})/g, '$1 ').trim()
}

// Authenticator setup (FR-AUTH-002 AC1–AC2): confirm the password, scan, confirm a code, keep the 10 backup codes. The
// password and the code are sent by the page's script only. The password step is in the server's HTML (the workspace
// shows it before any work), so both forms post and their buttons wait for hydration (src/ui/form/hydrated.ts): nothing
// typed before the script runs goes into the page's address (NFR-SEC-09).
export function TwoFactorSetup() {
  const t = useTranslations('auth.security')
  const router = useRouter()
  const hydrated = useHydrated()
  const [step, setStep] = useState<Step>({ kind: 'password' })
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const [copied, setCopied] = useState(false)

  async function start(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const password = String(new FormData(event.currentTarget).get('password') ?? '')
    setPending(true)
    setError(null)
    const { data, error: failure } = await authClient.twoFactor.enable({ password })
    setPending(false)
    if (failure || !data || !('totpURI' in data)) {
      setError(t('wrongPassword'))
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
    const { error: failure } = await authClient.twoFactor.verifyTotp({ code })
    setPending(false)
    if (failure) {
      setError(t('invalidCode'))
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
        <Button type="submit" disabled={pending || !hydrated} className="w-full sm:w-auto">
          {pending ? t('confirming') : t('confirm')}
        </Button>
      </form>
    )
  }

  return (
    <form method="post" onSubmit={start} className="flex flex-col gap-5" noValidate>
      <h3 className="font-semibold">{t('stepPassword')}</h3>
      {error ? <Notice tone="danger">{error}</Notice> : null}
      <Field id="setup-password" name="password" type="password" autoComplete="current-password" required label={t('password')} />
      <Button type="submit" disabled={pending || !hydrated} className="w-full sm:w-auto">
        {pending ? t('starting') : t('start')}
      </Button>
    </form>
  )
}
