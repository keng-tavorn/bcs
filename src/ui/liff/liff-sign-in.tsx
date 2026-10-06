'use client'

import { useRouter } from 'next/navigation'
import { useFormatter, useTranslations } from 'next-intl'
import { useEffect, useId, useRef, useState, type FormEvent, type InputHTMLAttributes } from 'react'
import { LOGIN_FAILURE_LIMIT, LOGIN_FAILURE_WINDOW_MS, MS_PER_MINUTE, TWO_FACTOR_LOCK_LIMIT, TWO_FACTOR_LOCK_MS } from '@/lib/constants'
import { lockWords, secondStepRefusal, serverFailed, signInRefusal } from '../auth/answers'
import { useHydrated } from '../form/hydrated'
import { Button } from './button'
import { cn } from './cn'
import { LIFF_LINK_CLASS } from './liff-link'
import { LiffNotice, NoticeIcon } from './notice'

// FR-LINE-001 AC2, the LIFF half: a LINE account that is not linked yet signs in to BCS inside LIFF with the work e-mail
// and password and then the authenticator code — Better Auth's own web sign-in endpoints (POST /api/auth/sign-in/email,
// /two-factor/verify-totp and /two-factor/verify-backup-code), with their lockout (FR-AUTH-001 AC3, NFR-SEC-05) and the
// same words as the web sign-in pages, kept in the LIFF frame instead of going to /login. Signed in, the page renders
// again with the web session and asks the person to confirm the link (./link-member.tsx). Loaded only when needed
// (React.lazy in ./link-flow.tsx) and kept small, as the sign-in screen's JavaScript counts in its 200 KB gzip with the
// LINE SDK (§9.4): it calls the endpoints with fetch rather than Better Auth's browser client (some 13 KB gzip), and its
// fields and the lockout words are the workspace's (src/ui/form/field.tsx, src/ui/auth/lock-message.ts) without the icon
// library and the date code those bring. What went wrong is said where it is, as on the web sign-in (§9.9 rule 7; what
// each answer means is src/ui/auth/answers.ts, which has no client): an empty field, an e-mail the server cannot read as
// one, or a code that cannot be one (none, or an app code that is not six digits — never sent), on that field, which
// takes the focus; a refusal, a lock or a request that got no answer in one message above
// the fields. Nothing typed here is kept beyond the request. Nothing is sent but by the script, as on the web sign-in
// (src/ui/auth): both forms post and their buttons — the switch to a backup code too — wait for hydration
// (src/ui/form/hydrated.ts), so a password or a code never goes into the page's address (NFR-SEC-09). The screen is drawn
// after the LINE sign-in said "not linked", by the script, so it is never in the server's HTML; the guard holds wherever
// it is drawn.

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

/** A refused answer as src/ui/auth/answers.ts reads it: its status and Better Auth's code, when the code is words */
const failureOf = (answer: AuthAnswer) => ({ status: answer.status, code: typeof answer.body?.code === 'string' ? answer.body.code : undefined })

/**
 * The lockout's words (src/ui/auth/lock-message.ts): which lock applies and when it lifts, in the page's time zone — ours
 * of this account or network, or Better Auth's of the second step with how long it lasts (src/ui/auth/answers.ts lockWords)
 */
function useLockText() {
  const t = useTranslations('auth.lock')
  const format = useFormatter()
  return (body: AuthAnswer['body']): string => {
    const words = lockWords(body ?? {})
    if (words === 'secondStep') return t('secondStep', { limit: TWO_FACTOR_LOCK_LIMIT, minutes: TWO_FACTOR_LOCK_MS / MS_PER_MINUTE })
    if (words === 'busy') return t('busy')
    const retryAt = new Date(String(body?.retryAt))
    const values = { limit: LOGIN_FAILURE_LIMIT, minutes: LOGIN_FAILURE_WINDOW_MS / MS_PER_MINUTE, time: format.dateTime(retryAt, { dateStyle: 'medium', timeStyle: 'short' }) }
    return t(words, values)
  }
}

export type SignInFieldProps = InputHTMLAttributes<HTMLInputElement> & { readonly id: string; readonly label: string; readonly hint?: string; readonly error?: string }

/**
 * A labelled input with an optional hint and error: src/ui/form/field.tsx's look and rules — the error announced with
 * the input (aria-describedby, aria-invalid), an icon and words, never colour alone (NFR-A11Y-03) — without its icon library
 */
export function SignInField({ id, label, hint, error, className, ...input }: SignInFieldProps) {
  const hintId = hint ? `${id}-hint` : undefined
  const errorId = error ? `${id}-error` : undefined
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="font-medium text-ink">
        {label}
      </label>
      <input
        id={id}
        aria-invalid={error ? true : undefined}
        aria-describedby={[hintId, errorId].filter(Boolean).join(' ') || undefined}
        className={cn('h-11 w-full rounded-md border border-input bg-bg px-3 text-base text-ink placeholder:text-ink-muted aria-[invalid=true]:border-danger', className)}
        {...input}
      />
      {hint ? (
        <p id={hintId} className="text-ink-muted">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={errorId} className="flex items-start gap-1.5 text-danger">
          <NoticeIcon tone="danger" />
          <span>{error}</span>
        </p>
      ) : null}
    </div>
  )
}

type FieldErrors = { readonly email?: string; readonly password?: string }

/** A code from the authenticator app: six digits (TOTP, RFC 6238) */
const APP_CODE = /^\d{6}$/

export function LiffSignIn() {
  const t = useTranslations('liff.link.signIn')
  const tLogin = useTranslations('auth.login')
  const tTwo = useTranslations('auth.twoFactor')
  const router = useRouter()
  const lockText = useLockText()
  const id = useId()
  const hydrated = useHydrated()
  const passwordForm = useRef<HTMLFormElement>(null)
  const secondForm = useRef<HTMLFormElement>(null)
  const [step, setStep] = useState<'password' | 'second'>('password')
  const [mode, setMode] = useState<'app' | 'backup'>('app')
  const [error, setError] = useState<string | null>(null)
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({})
  /** What is wrong with the code field, said on it; a new object at every press, so the field takes the focus every time */
  const [codeError, setCodeError] = useState<{ readonly text: string } | null>(null)
  const [pending, setPending] = useState(false)

  // The first field that says what is wrong with it takes the focus, so a screen reader reads its words with it
  useEffect(() => {
    const first = fieldErrors.email ? 'email' : fieldErrors.password ? 'password' : null
    const field = first ? passwordForm.current?.elements.namedItem(first) : null
    if (field instanceof HTMLInputElement) field.focus()
  }, [fieldErrors])
  useEffect(() => {
    const field = codeError ? secondForm.current?.elements.namedItem('code') : null
    if (field instanceof HTMLInputElement) field.focus()
  }, [codeError])

  async function onPassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    const email = String(form.get('email') ?? '').trim()
    const password = String(form.get('password') ?? '')
    setError(null)
    // Nothing is sent without both: the empty field says what to fill in (Better Auth would refuse an empty e-mail)
    const missing: FieldErrors = { ...(email ? {} : { email: tLogin('emailRequired') }), ...(password ? {} : { password: tLogin('passwordRequired') }) }
    setFieldErrors(missing)
    if (missing.email || missing.password) return
    setPending(true)
    const answer = await postAuth('/sign-in/email', { email, password })
    setPending(false)
    if (!answer.ok) {
      const refusal = signInRefusal(failureOf(answer))
      if (refusal === 'emailInvalid') setFieldErrors({ email: tLogin('emailInvalid') })
      else setError(refusal === 'locked' ? lockText(answer.body) : refusal === 'invalid' ? tLogin('invalid') : refusal === 'serverFailed' ? tLogin('serverFailed') : tLogin('failed'))
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
    setError(null)
    // Nothing is sent that cannot be a code, as on the web (src/ui/auth/two-factor-form.tsx): said on the field, never
    // "the code is wrong", and never a failed sign-in counted against the account
    const problem = !code ? (mode === 'app' ? tTwo('codeRequired') : tTwo('backupRequired')) : mode === 'app' && !APP_CODE.test(code) ? tTwo('codeFormat') : null
    setCodeError(problem ? { text: problem } : null)
    if (problem) return
    setPending(true)
    const answer = await postAuth(mode === 'app' ? '/two-factor/verify-totp' : '/two-factor/verify-backup-code', { code })
    if (!answer.ok) {
      setPending(false)
      const refusal = secondStepRefusal(failureOf(answer))
      // The second step waited too long: start again with the password
      if (refusal === 'expired') {
        setStep('password')
        setError(tTwo('expired'))
        return
      }
      // No answer, or the server failed: the code was not checked, so it is not called wrong. No answer speaks of the
      // connection (the sign-in's words); a server failure says the code was not checked, and to send it again shortly
      if (refusal === 'failed') setError(serverFailed(failureOf(answer)) ? tTwo('serverFailed') : tLogin('failed'))
      else setError(refusal === 'locked' ? lockText(answer.body) : mode === 'app' ? tTwo('invalid') : tTwo('invalidBackup'))
      return
    }
    router.refresh()
  }

  if (step === 'second') {
    return (
      <section aria-labelledby={`${id}-second`} className="flex flex-col gap-4">
        <h2 id={`${id}-second`} className="text-lg font-semibold">
          {t('twoFactorHeading')}
        </h2>
        <form ref={secondForm} method="post" onSubmit={onSecond} className="flex flex-col gap-5" noValidate>
          {/* The words above the field ask for what the field takes: a code from the app, or a backup code */}
          <p className="text-ink-muted">{mode === 'app' ? tTwo('intro') : tTwo('backupIntro')}</p>
          {error ? <LiffNotice tone="danger">{error}</LiffNotice> : null}
          {mode === 'app' ? (
            <SignInField
              key="app"
              id={`${id}-code`}
              name="code"
              label={tTwo('code')}
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="[0-9]{6}"
              maxLength={6}
              required
              className="tabular tracking-widest"
              error={codeError?.text}
            />
          ) : (
            <SignInField key="backup" id={`${id}-code`} name="code" label={tTwo('backupCode')} hint={tTwo('backupHint')} autoComplete="off" required error={codeError?.text} />
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
              setCodeError(null)
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
      <h2 id={`${id}-password`} className="text-lg font-semibold">
        {t('heading')}
      </h2>
      <p className="text-ink-muted">{t('intro')}</p>
      <form ref={passwordForm} method="post" onSubmit={onPassword} className="flex flex-col gap-5" noValidate>
        {error ? <LiffNotice tone="danger">{error}</LiffNotice> : null}
        <SignInField id={`${id}-email`} name="email" type="email" autoComplete="username" inputMode="email" required label={tLogin('email')} error={fieldErrors.email} />
        <SignInField id={`${id}-pw`} name="password" type="password" autoComplete="current-password" required label={tLogin('password')} error={fieldErrors.password} />
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
