'use client'

import { useRouter } from 'next/navigation'
import { useFormatter, useTranslations } from 'next-intl'
import { useId, useState, type FormEvent, type InputHTMLAttributes } from 'react'
import { LOGIN_FAILURE_LIMIT, LOGIN_FAILURE_WINDOW_MS, MS_PER_MINUTE } from '@/lib/constants'
import { cn } from '../cn'
import { Button } from '../form/button'
import { useHydrated } from '../form/hydrated'
import { LIFF_LINK_CLASS } from './liff-link'
import { LiffNotice } from './notice'

// FR-LINE-001 AC2, the LIFF half: a LINE account that is not linked yet signs in to BCS inside LIFF with the work e-mail
// and password and then the authenticator code — Better Auth's own web sign-in endpoints (POST /api/auth/sign-in/email,
// /two-factor/verify-totp and /two-factor/verify-backup-code), with their lockout (FR-AUTH-001 AC3, NFR-SEC-05) and the
// same words as the web sign-in pages, kept in the LIFF frame instead of going to /login. Signed in, the page renders
// again with the web session and asks the person to confirm the link (./link-member.tsx). Loaded only when needed
// (React.lazy in ./link-flow.tsx) and kept small, as the sign-in screen's JavaScript counts in its 200 KB gzip with the
// LINE SDK (§9.4): it calls the endpoints with fetch rather than Better Auth's browser client (some 13 KB gzip), and its
// fields and the lockout words are the workspace's (src/ui/form/field.tsx, src/ui/auth/lock-message.ts) without the icon
// library and the date code those bring. Errors show in one message above the fields, as on the web sign-in. Nothing
// typed here is kept beyond the request. Nothing is sent but by the script, as on the web sign-in (src/ui/auth): both
// forms post and their buttons — the switch to a backup code too — wait for hydration (src/ui/form/hydrated.ts), so a
// password or a code never goes into the page's address (NFR-SEC-09). The screen is drawn after the LINE sign-in said
// "not linked", by the script, so it is never in the server's HTML; the guard holds wherever it is drawn.

const LOCKED_STATUS = 429
const UNAUTHORIZED_STATUS = 401

type AuthPath = '/sign-in/email' | '/two-factor/verify-totp' | '/two-factor/verify-backup-code'

interface AuthAnswer {
  readonly ok: boolean
  readonly status: number
  /** The JSON body: on success what Better Auth answers (twoFactorRedirect), on failure its code and our lockout's fields */
  readonly body: { readonly code?: string; readonly reason?: unknown; readonly retryAt?: unknown; readonly twoFactorRedirect?: unknown } | null
}

/** One step of Better Auth's sign-in, from this page (same origin, its cookies) */
async function postAuth(path: AuthPath, body: Readonly<Record<string, string>>): Promise<AuthAnswer> {
  try {
    const response = await fetch(`/api/auth${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      credentials: 'same-origin',
      cache: 'no-store',
    })
    const json: unknown = await response.json().catch(() => null)
    return { ok: response.ok, status: response.status, body: json !== null && typeof json === 'object' ? (json as AuthAnswer['body']) : null }
  } catch {
    return { ok: false, status: 0, body: null }
  }
}

/** The lockout's words (src/ui/auth/lock-message.ts): which lock applies and when it lifts, in the page's time zone */
function useLockText() {
  const t = useTranslations('auth.lock')
  const format = useFormatter()
  return (body: AuthAnswer['body']): string => {
    const retryAt = typeof body?.retryAt === 'string' ? new Date(body.retryAt) : null
    if (body?.code !== 'LOGIN_LOCKED' || !retryAt || Number.isNaN(retryAt.getTime())) return t('busy')
    const values = { limit: LOGIN_FAILURE_LIMIT, minutes: LOGIN_FAILURE_WINDOW_MS / MS_PER_MINUTE, time: format.dateTime(retryAt, { dateStyle: 'medium', timeStyle: 'short' }) }
    return body.reason === 'IP' ? t('address', values) : t('account', values)
  }
}

/** A labelled input with an optional hint (src/ui/form/field.tsx without its error line: errors show above the form) */
function LiffField({ id, label, hint, className, ...input }: InputHTMLAttributes<HTMLInputElement> & { readonly id: string; readonly label: string; readonly hint?: string }) {
  const hintId = hint ? `${id}-hint` : undefined
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="font-medium text-ink">
        {label}
      </label>
      <input
        id={id}
        aria-describedby={hintId}
        className={cn('h-11 w-full rounded-md border border-input bg-bg px-3 text-base text-ink placeholder:text-ink-muted', className)}
        {...input}
      />
      {hint ? (
        <p id={hintId} className="text-ink-muted">
          {hint}
        </p>
      ) : null}
    </div>
  )
}

export function LiffSignIn() {
  const t = useTranslations('liff.link.signIn')
  const tLogin = useTranslations('auth.login')
  const tTwo = useTranslations('auth.twoFactor')
  const router = useRouter()
  const lockText = useLockText()
  const id = useId()
  const hydrated = useHydrated()
  const [step, setStep] = useState<'password' | 'second'>('password')
  const [mode, setMode] = useState<'app' | 'backup'>('app')
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)

  async function onPassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    setPending(true)
    setError(null)
    const answer = await postAuth('/sign-in/email', { email: String(form.get('email') ?? ''), password: String(form.get('password') ?? '') })
    setPending(false)
    if (!answer.ok) {
      setError(answer.status === LOCKED_STATUS ? lockText(answer.body) : answer.status === UNAUTHORIZED_STATUS ? tLogin('invalid') : tLogin('failed'))
      return
    }
    if (answer.body?.twoFactorRedirect === true) {
      setStep('second')
      return
    }
    router.refresh()
  }

  async function onSecond(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const code = String(new FormData(event.currentTarget).get('code') ?? '').trim()
    setPending(true)
    setError(null)
    const answer = await postAuth(mode === 'app' ? '/two-factor/verify-totp' : '/two-factor/verify-backup-code', { code })
    if (!answer.ok) {
      setPending(false)
      // The second step waited too long: start again with the password
      if (answer.body?.code === 'INVALID_TWO_FACTOR_COOKIE') {
        setStep('password')
        setError(tTwo('expired'))
        return
      }
      setError(answer.status === LOCKED_STATUS ? lockText(answer.body) : mode === 'app' ? tTwo('invalid') : tTwo('invalidBackup'))
      return
    }
    router.refresh()
  }

  if (step === 'second') {
    return (
      <section aria-labelledby={`${id}-second`} className="flex flex-col gap-4">
        <h2 id={`${id}-second`} className="text-lg leading-snug font-semibold">
          {t('twoFactorHeading')}
        </h2>
        <form method="post" onSubmit={onSecond} className="flex flex-col gap-5" noValidate>
          <p className="text-ink-muted">{tTwo('intro')}</p>
          {error ? <LiffNotice tone="danger">{error}</LiffNotice> : null}
          {mode === 'app' ? (
            <LiffField key="app" id={`${id}-code`} name="code" label={tTwo('code')} inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} required className="tabular tracking-widest" />
          ) : (
            <LiffField key="backup" id={`${id}-code`} name="code" label={tTwo('backupCode')} hint={tTwo('backupHint')} autoComplete="off" required />
          )}
          <Button type="submit" disabled={pending || !hydrated} className="w-full">
            {pending ? tTwo('submitting') : tTwo('submit')}
          </Button>
          <Button
            variant="link"
            className="min-h-11 self-start"
            disabled={!hydrated}
            onClick={() => {
              setMode(mode === 'app' ? 'backup' : 'app')
              setError(null)
            }}
          >
            {mode === 'app' ? tTwo('useBackup') : tTwo('useApp')}
          </Button>
        </form>
      </section>
    )
  }

  return (
    <section aria-labelledby={`${id}-password`} className="flex flex-col gap-4">
      <h2 id={`${id}-password`} className="text-lg leading-snug font-semibold">
        {t('heading')}
      </h2>
      <p className="text-ink-muted">{t('intro')}</p>
      <form method="post" onSubmit={onPassword} className="flex flex-col gap-5" noValidate>
        {error ? <LiffNotice tone="danger">{error}</LiffNotice> : null}
        <LiffField id={`${id}-email`} name="email" type="email" autoComplete="username" inputMode="email" required label={tLogin('email')} />
        <LiffField id={`${id}-pw`} name="password" type="password" autoComplete="current-password" required label={tLogin('password')} />
        <Button type="submit" disabled={pending || !hydrated} className="w-full">
          {pending ? tLogin('submitting') : tLogin('submit')}
        </Button>
      </form>
      {/* Out of the LIFF app: the web page that resets a password */}
      <a href="/forgot-password" className={LIFF_LINK_CLASS}>
        {tLogin('forgot')}
      </a>
    </section>
  )
}
