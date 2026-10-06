'use client'

import { useTranslations } from 'next-intl'
import { useState, type FormEvent } from 'react'
import { settle } from '../admin-settings/outcome'
import { Button } from '../form/button'
import { Field } from '../form/field'
import { useHydrated } from '../form/hydrated'
import { Notice } from '../form/notice'
import { useSubmissionKey } from '../form/submission-key'
import { NewPinField } from './new-pin-field'
import { proveError, setPinError, type IdentityMethodView, type ProveIdentityAction, type SetPinAction } from './types'

// Setting or changing the member's own transaction PIN (FR-AUTH-005 AC1, /settings/pin). Two real steps:
//  1. prove who you are again — the password, or the code of the authenticator app — which gives a short-lived proof.
//     Only the ways that work for this member are offered (proofMethods, from getOwnPinStatus): the choice shows when
//     both do, one field alone when only one does, and a member who has neither is told so instead of being offered a
//     way the server refuses;
//  2. the new PIN twice; the server checks the PIN rules and stores only its hash.
// The proof lives in this component's memory only and is dropped on cancel or once used. The password is read from the
// form when it is sent and never kept; the two PINs are held while typed (digits only, NewPinField: never offered to the
// browser's password manager) and cleared after every answer. Every PIN submission has its own idempotency key; the
// button is disabled while one is on its way. Nothing is sent before the page's script runs: step 1 shows in the server's
// HTML for a member without a PIN, so both submit buttons wait for hydration and both forms post (src/ui/form/hydrated.ts)
// — the password never reaches the page's address. The other controls that need the script (the button that opens step
// 1, the choice of method) wait for it too, so a click before it is never lost.

type Step = { readonly kind: 'idle' } | { readonly kind: 'prove' } | { readonly kind: 'set'; readonly proofToken: string; readonly expiresAtText: string }

/** A message about the whole form: a refusal, or an answer that never came (it may or may not have been done) */
type FormMessage = { readonly tone: 'danger' | 'warning'; readonly text: string }

const PIN_PATTERN = /^[0-9]{6}$/
const CODE_PATTERN = /^[0-9]{6}$/
/** The order the ways of proving who you are are offered in */
const METHOD_ORDER: readonly IdentityMethodView[] = ['PASSWORD', 'TOTP']

export interface PinSetupProps {
  readonly hasPin: boolean
  /** The ways this member can prove who they are (PinStatusDto.proofMethods): only these are offered */
  readonly proofMethods: readonly IdentityMethodView[]
  readonly prove: ProveIdentityAction
  readonly setPin: SetPinAction
}

export function PinSetup({ hasPin, proofMethods, prove, setPin }: PinSetupProps) {
  const t = useTranslations('pinSettings')
  const hydrated = useHydrated()
  const submission = useSubmissionKey()
  const methods = METHOD_ORDER.filter((m) => proofMethods.includes(m))
  // A member without a PIN came to set one: the first step shows at once
  const [step, setStep] = useState<Step>(hasPin ? { kind: 'idle' } : { kind: 'prove' })
  const [chosen, setChosen] = useState<IdentityMethodView>(methods[0] ?? 'PASSWORD')
  // The page's status is read again after every answer: a way that stopped working meanwhile is never kept chosen
  const method = methods.includes(chosen) ? chosen : (methods[0] ?? chosen)
  const [pending, setPending] = useState(false)
  const [fieldError, setFieldError] = useState<{ field: 'password' | 'code' | 'pin' | 'repeat'; text: string } | null>(null)
  const [formMessage, setFormMessage] = useState<FormMessage | null>(null)
  const [done, setDone] = useState<string | null>(null)
  const [newPin, setNewPin] = useState('')
  const [repeatPin, setRepeatPin] = useState('')

  const errorOf = (field: 'password' | 'code' | 'pin' | 'repeat') => (fieldError?.field === field ? fieldError.text : undefined)
  const formError = (text: string) => setFormMessage({ tone: 'danger', text })
  const clearErrors = () => {
    setFieldError(null)
    setFormMessage(null)
  }
  const clearPins = () => {
    setNewPin('')
    setRepeatPin('')
  }

  async function onProve(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    clearErrors()
    const form = new FormData(event.currentTarget)
    let input: Parameters<ProveIdentityAction>[0]
    if (method === 'PASSWORD') {
      const password = String(form.get('password') ?? '')
      if (!password) return setFieldError({ field: 'password', text: t('errors.PASSWORD_REQUIRED') })
      input = { method: 'PASSWORD', password }
    } else {
      // A code copied from the app may carry a space or a dash in the middle ("123 456"): only the digits are sent
      const code = String(form.get('code') ?? '').replace(/[\s-]/g, '')
      if (!CODE_PATTERN.test(code)) return setFieldError({ field: 'code', text: t('errors.CODE_FORMAT') })
      input = { method: 'TOTP', code }
    }
    setPending(true)
    const answer = await settle(prove(input))
    setPending(false)
    if (!answer) return formError(t('errors.FAILED'))
    if (answer.ok) {
      setDone(null)
      clearPins()
      setStep({ kind: 'set', proofToken: answer.proofToken, expiresAtText: answer.expiresAtText })
      return
    }
    const { key, field } = proveError(answer, method)
    const text = t(`errors.${key}`, { time: answer.timeText ?? '-', requestId: answer.requestId ?? '-' })
    if (field) setFieldError({ field, text })
    else formError(text)
  }

  async function onSetPin(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (step.kind !== 'set') return
    clearErrors()
    const pin = newPin
    if (!PIN_PATTERN.test(pin)) return setFieldError({ field: 'pin', text: t('errors.PIN_FORMAT') })
    if (pin !== repeatPin) return setFieldError({ field: 'repeat', text: t('errors.MISMATCH') })
    setPending(true)
    const answer = await settle(setPin({ pin, proofToken: step.proofToken }, submission.key))
    setPending(false)
    // No answer: the PIN may or may not be set. The PINs stay in the fields and the same key goes with the next press, so
    // the PIN is set at most once
    if (!answer) return setFormMessage({ tone: 'warning', text: t('errors.NO_ANSWER') })
    submission.next()
    // The PINs are not kept after an answer: a refused one is typed again from the start
    clearPins()
    if (answer.ok) {
      // The action revalidated the page: its status (set, tries left) arrives with the answer
      setDone(answer.replaced ? t('done.changed') : t('done.set'))
      setStep({ kind: 'idle' })
      return
    }
    const refusal = setPinError(answer)
    const text = t(`errors.${refusal.key}`, { requestId: answer.requestId ?? '-' })
    if (refusal.proof) {
      // The proof ran out or was used: back to step 1, with the reason
      setStep({ kind: 'prove' })
      formError(text)
      return
    }
    if (refusal.field) setFieldError({ field: 'pin', text })
    else formError(text)
  }

  const submitLabel = hasPin ? t('set.submitChange') : t('set.submitNew')
  const formNotice = formMessage ? <Notice tone={formMessage.tone}>{formMessage.text}</Notice> : null

  // Neither a password nor an authenticator app: no proof can be made, so no step is offered that would be refused
  if (methods.length === 0) return <Notice tone="warning">{t('prove.noMethod')}</Notice>

  if (step.kind === 'idle') {
    return (
      <div className="flex flex-col gap-4">
        {done ? <Notice tone="success">{done}</Notice> : null}
        <Button
          onClick={() => {
            setDone(null)
            clearErrors()
            setStep({ kind: 'prove' })
          }}
          disabled={!hydrated}
          className="self-start"
        >
          {submitLabel}
        </Button>
      </div>
    )
  }

  if (step.kind === 'prove') {
    return (
      // method="post": a submission before hydration never puts the password in the address (see the top)
      <form method="post" onSubmit={onProve} className="flex flex-col gap-5" noValidate aria-labelledby="pin-prove">
        <div className="flex flex-col gap-1">
          <h2 id="pin-prove" className="text-xl font-semibold">
            {t('prove.title')}
          </h2>
          <p className="text-ink-muted">{methods.length > 1 ? t('prove.intro') : t(`prove.introOnly.${method}`)}</p>
        </div>
        {formNotice}
        {/* A choice only between ways that work for this member; with one way, its field alone. The choice is the
            component's state: before the script runs, a click on it would show the wrong field after */}
        {methods.length > 1 ? (
          <fieldset disabled={!hydrated} className="flex min-w-0 flex-col gap-1">
            <legend className="mb-1 font-medium">{t('prove.method')}</legend>
            {methods.map((m) => (
              <label key={m} className="flex min-h-11 cursor-pointer items-center gap-3">
                <input
                  type="radio"
                  name="method"
                  value={m}
                  checked={method === m}
                  onChange={() => {
                    setChosen(m)
                    clearErrors()
                  }}
                  className="size-5 shrink-0"
                />
                <span>{t(`prove.${m}`)}</span>
              </label>
            ))}
          </fieldset>
        ) : null}
        {method === 'PASSWORD' ? (
          <Field id="pin-password" name="password" type="password" autoComplete="current-password" maxLength={256} label={t('prove.password')} error={errorOf('password')} />
        ) : (
          // No maxLength: a pasted "123 456" is not cut short; the six digits are checked when it is sent
          <Field id="pin-code" name="code" inputMode="numeric" autoComplete="one-time-code" label={t('prove.code')} error={errorOf('code')} className="tabular tracking-widest sm:max-w-48" />
        )}
        <div className="flex flex-wrap gap-3">
          <Button type="submit" disabled={pending || !hydrated}>
            {pending ? t('prove.submitting') : t('prove.submit')}
          </Button>
          {hasPin ? (
            <Button
              variant="secondary"
              onClick={() => {
                clearErrors()
                setStep({ kind: 'idle' })
              }}
            >
              {t('set.cancel')}
            </Button>
          ) : null}
        </div>
      </form>
    )
  }

  return (
    <form method="post" onSubmit={onSetPin} className="flex flex-col gap-5" noValidate aria-labelledby="pin-set">
      <div className="flex flex-col gap-1">
        <h2 id="pin-set" className="text-xl font-semibold">
          {t('set.title')}
        </h2>
      </div>
      <Notice tone="success">{t('set.proved', { time: step.expiresAtText })}</Notice>
      {formNotice}
      <div className="flex flex-col gap-4 sm:max-w-xs">
        <NewPinField id="pin-new" name="pin" label={t('set.pin')} value={newPin} onChange={setNewPin} error={errorOf('pin')} />
        <NewPinField id="pin-repeat" name="repeat" label={t('set.repeat')} value={repeatPin} onChange={setRepeatPin} error={errorOf('repeat')} />
      </div>
      <div className="flex flex-wrap gap-3">
        <Button type="submit" disabled={pending || !hydrated}>
          {pending ? t('set.submitting') : submitLabel}
        </Button>
        <Button
          variant="secondary"
          onClick={() => {
            // The proof and the PINs typed are dropped: setting a PIN later proves who you are again
            clearErrors()
            clearPins()
            setStep(hasPin ? { kind: 'idle' } : { kind: 'prove' })
          }}
        >
          {t('set.cancel')}
        </Button>
      </div>
    </form>
  )
}
