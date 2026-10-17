'use client'

import { Fingerprint } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { useState, type FormEvent } from 'react'
import { settle } from '../admin-settings/outcome'
import { Button } from '../form/button'
import { Field } from '../form/field'
import { useHydrated } from '../form/hydrated'
import { Notice } from '../form/notice'
import { useSubmissionKey } from '../form/submission-key'
import { makePasskey, passkeySupported } from '../passkey/webauthn'
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '../shadcn/alert-dialog'
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemTitle } from '../shadcn/item'
import { proveError, type IdentityMethodView, type PinFailure, type ProveIdentityAction } from './types'

// The member's own passkeys on /settings/pin (S17-15, FR-PLT-301 AC4, BR-AUTH-10, OQ-168, ADR-166): a passkey confirms
// an approval instead of the PIN with the device's fingerprint, face or screen lock, and is never a way to sign in.
// Adding one takes what setting the PIN takes — the password or the authenticator code again (the PIN's own step 1,
// prove) — then the device makes the passkey, user verification required, and the server checks it against a
// challenge it issued once. Removing one asks first. The list names each passkey by the name its owner gave it and when
// it was added and last used; nothing of the credential itself. A browser without WebAuthn is told so, and the PIN works.

export interface PasskeyView {
  readonly id: string
  readonly deviceLabel: string | null
  readonly addedAtText: string
  readonly lastUsedAtText: string | null
}

export type PasskeyOutcome = { readonly ok: true } | PinFailure
export type PasskeyOptionsAction = (input: { readonly proofToken: string }) => Promise<({ readonly ok: true; readonly options: Record<string, unknown> }) | PinFailure>
export type AddPasskeyAction = (input: { readonly proofToken: string; readonly response: Record<string, unknown>; readonly deviceLabel?: string }, idempotencyKey: string) => Promise<PasskeyOutcome>
export type RemovePasskeyAction = (input: { readonly passkeyId: string }, idempotencyKey: string) => Promise<PasskeyOutcome>

export interface PasskeySetupProps {
  readonly passkeys: readonly PasskeyView[]
  readonly proofMethods: readonly IdentityMethodView[]
  readonly prove: ProveIdentityAction
  readonly options: PasskeyOptionsAction
  readonly add: AddPasskeyAction
  readonly remove: RemovePasskeyAction
}

const METHOD_ORDER: readonly IdentityMethodView[] = ['PASSWORD', 'TOTP']
const CODE_PATTERN = /^[0-9]{6}$/
const LABEL_MAX = 60

type Message = { readonly tone: 'success' | 'danger' | 'warning'; readonly text: string }

type AddErrorKey = 'PROOF_EXPIRED' | 'RATE_LIMITED' | 'LIMIT' | 'DUPLICATE' | 'UV_REQUIRED' | 'NOT_ADDED' | 'FAILED'
const SAID_AS_IS: readonly string[] = ['LIMIT', 'DUPLICATE', 'UV_REQUIRED']

/** Why adding was refused, as pinSettings.passkey.errors says it */
function addErrorKey(failure: PinFailure): AddErrorKey {
  if (failure.code === 'STEP_UP_REQUIRED') return 'PROOF_EXPIRED'
  if (failure.code === 'RATE_LIMITED') return 'RATE_LIMITED'
  if (failure.code === 'VALIDATION_FAILED' && failure.field === 'passkey' && failure.reason) return SAID_AS_IS.includes(failure.reason) ? (failure.reason as AddErrorKey) : 'NOT_ADDED'
  return 'FAILED'
}

export function PasskeySetup({ passkeys, proofMethods, prove, options, add, remove }: PasskeySetupProps) {
  const t = useTranslations('pinSettings')
  const tp = useTranslations('pinSettings.passkey')
  const hydrated = useHydrated()
  const submission = useSubmissionKey()
  const methods = METHOD_ORDER.filter((m) => proofMethods.includes(m))
  const [proving, setProving] = useState(false)
  const [chosen, setChosen] = useState<IdentityMethodView>(methods[0] ?? 'PASSWORD')
  const method = methods.includes(chosen) ? chosen : (methods[0] ?? chosen)
  const [label, setLabel] = useState('')
  const [pending, setPending] = useState(false)
  const [fieldError, setFieldError] = useState<{ field: 'password' | 'code'; text: string } | null>(null)
  const [message, setMessage] = useState<Message | null>(null)
  const [removing, setRemoving] = useState<PasskeyView | null>(null)
  const supported = hydrated && passkeySupported()

  async function onAdd(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setFieldError(null)
    setMessage(null)
    const form = new FormData(event.currentTarget)
    let input: Parameters<ProveIdentityAction>[0]
    if (method === 'PASSWORD') {
      const password = String(form.get('password') ?? '')
      if (!password) return setFieldError({ field: 'password', text: t('errors.PASSWORD_REQUIRED') })
      input = { method: 'PASSWORD', password }
    } else {
      const code = String(form.get('code') ?? '').replace(/[\s-]/g, '')
      if (!CODE_PATTERN.test(code)) return setFieldError({ field: 'code', text: t('errors.CODE_FORMAT') })
      input = { method: 'TOTP', code }
    }
    setPending(true)
    try {
      // 1. who you are, again — as for the PIN
      const proved = await settle(prove(input))
      if (!proved) return setMessage({ tone: 'danger', text: t('errors.FAILED') })
      if (!proved.ok) {
        const { key, field } = proveError(proved, method)
        const text = t(`errors.${key}`, { time: proved.timeText ?? '-', requestId: proved.requestId ?? '-' })
        return field ? setFieldError({ field, text }) : setMessage({ tone: 'danger', text })
      }
      // 2. a challenge for a new passkey, 3. the device makes it, 4. the server checks and keeps it
      const asked = await settle(options({ proofToken: proved.proofToken }))
      if (!asked || !asked.ok) return setMessage({ tone: 'danger', text: tp(`errors.${asked ? addErrorKey(asked) : 'FAILED'}`) })
      const made = await makePasskey(asked.options)
      if (!made.ok) return made.reason === 'CANCELLED' ? undefined : setMessage({ tone: 'danger', text: tp('errors.DEVICE') })
      const added = await settle(add({ proofToken: proved.proofToken, response: made.response, ...(label.trim() ? { deviceLabel: label.trim() } : {}) }, submission.key))
      if (!added) return setMessage({ tone: 'warning', text: tp('errors.NO_ANSWER') })
      submission.next()
      if (!added.ok) return setMessage({ tone: 'danger', text: tp(`errors.${addErrorKey(added)}`) })
      setProving(false)
      setLabel('')
      setMessage({ tone: 'success', text: tp('added') })
    } finally {
      setPending(false)
    }
  }

  async function onRemove(passkey: PasskeyView) {
    setRemoving(null)
    setMessage(null)
    const removed = await settle(remove({ passkeyId: passkey.id }, submission.key))
    submission.next()
    setMessage(removed?.ok ? { tone: 'success', text: tp('removed') } : { tone: 'danger', text: tp('errors.FAILED') })
  }

  return (
    <section aria-labelledby="passkey-title" className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h2 id="passkey-title" className="text-base font-semibold">
          {tp('title')}
        </h2>
        <p className="text-ink-muted">{tp('intro')}</p>
      </div>
      {message ? <Notice tone={message.tone}>{message.text}</Notice> : null}
      {passkeys.length ? (
        <ItemGroup className="gap-2">
          {passkeys.map((p) => (
            <Item key={p.id} role="listitem" variant="outline" className="flex-wrap">
              <ItemContent className="min-w-48">
                <ItemTitle className="text-base">{p.deviceLabel ?? tp('unnamed')}</ItemTitle>
                <ItemDescription className="line-clamp-none text-base text-ink-muted md:text-sm">
                  {tp('addedAt', { time: p.addedAtText })}
                  {p.lastUsedAtText ? ` · ${tp('lastUsedAt', { time: p.lastUsedAtText })}` : ''}
                </ItemDescription>
              </ItemContent>
              <ItemActions>
                <Button variant="danger" onClick={() => setRemoving(p)} disabled={!hydrated}>
                  {tp('remove', { name: p.deviceLabel ?? tp('unnamed') })}
                </Button>
              </ItemActions>
            </Item>
          ))}
        </ItemGroup>
      ) : (
        <p className="text-ink-muted">{tp('none')}</p>
      )}

      {!supported && hydrated ? <Notice tone="info">{tp('unsupported')}</Notice> : null}
      {methods.length === 0 ? <Notice tone="warning">{t('prove.noMethod')}</Notice> : null}
      {supported && methods.length > 0 && !proving ? (
        <Button className="self-start" onClick={() => setProving(true)}>
          <Fingerprint className="size-5" aria-hidden="true" />
          {tp('add')}
        </Button>
      ) : null}
      {supported && methods.length > 0 && proving ? (
        <form method="post" onSubmit={(event) => void onAdd(event)} className="flex flex-col gap-4" noValidate aria-labelledby="passkey-add">
          <h3 id="passkey-add" className="font-semibold">
            {tp('addTitle')}
          </h3>
          <p className="text-ink-muted">{tp('addIntro')}</p>
          {methods.length > 1 ? (
            <fieldset className="flex min-w-0 flex-col gap-1">
              <legend className="mb-1 font-medium">{t('prove.method')}</legend>
              {methods.map((m) => (
                <label key={m} className="flex min-h-11 cursor-pointer items-center gap-3">
                  <input type="radio" name="method" value={m} checked={method === m} onChange={() => setChosen(m)} className="size-5 shrink-0" />
                  <span>{t(`prove.${m}`)}</span>
                </label>
              ))}
            </fieldset>
          ) : null}
          {method === 'PASSWORD' ? (
            <Field id="passkey-password" name="password" type="password" autoComplete="current-password" maxLength={256} label={t('prove.password')} error={fieldError?.field === 'password' ? fieldError.text : undefined} />
          ) : (
            <Field id="passkey-code" name="code" inputMode="numeric" autoComplete="one-time-code" label={t('prove.code')} error={fieldError?.field === 'code' ? fieldError.text : undefined} className="tabular tracking-widest sm:max-w-48" />
          )}
          <Field id="passkey-label" name="label" label={tp('label')} hint={tp('labelHint')} maxLength={LABEL_MAX} value={label} onChange={(event) => setLabel(event.currentTarget.value)} />
          <div className="flex flex-wrap gap-3">
            <Button type="submit" disabled={pending || !hydrated}>
              {pending ? tp('adding') : tp('addSubmit')}
            </Button>
            <Button variant="secondary" onClick={() => setProving(false)} disabled={pending}>
              {t('set.cancel')}
            </Button>
          </div>
        </form>
      ) : null}

      <AlertDialog open={removing !== null} onOpenChange={(open) => !open && setRemoving(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{tp('removeTitle', { name: removing?.deviceLabel ?? tp('unnamed') })}</AlertDialogTitle>
            <AlertDialogDescription>{tp('removeBody')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="gap-3">
            <AlertDialogCancel className="h-11 px-4 text-base">{tp('keep')}</AlertDialogCancel>
            <Button variant="danger" onClick={() => removing && void onRemove(removing)}>
              {tp('removeConfirm')}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  )
}
