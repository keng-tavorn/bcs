'use client'

import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { useState, type FormEvent, type ReactNode } from 'react'
import { Button } from '../form/button'
import { Notice } from '../form/notice'
import { useSubmissionKey } from '../form/submission-key'
import { Panel } from '../page/page'
import { checkboxClass, Choices, describedBy, inputClass, Labelled, textareaClass } from '../request-form/controls'
import { ConfirmRemove } from '../request-form/confirm-remove'
import { looksLikeEmail, optionalText, SUPPLIER_LIMITS } from './model'
import { supplierErrorKey, type SupplierFailure, type SupplierOutcome } from './outcome'
import type { SupplierEditInput, SupplierStatus } from './types'

// PROCUREMENT's changes on /suppliers/[id] (S4-02, §2.4 supplier.manage): two small forms — the supplier's details, and
// its Express vendor code (BR-EXP-04) and contacts — each with a button that says what it saves, and the supplier's
// status. Every save names the version it was based on (§6.1): a save after someone else's is refused with a way to
// load the latest. Deactivating asks first and says what follows; activating again needs no question. The tax id,
// branch and registry check are not edited here: they were checked against the registries (BR-SUP-01). Each part is a
// white card of the page's frame (S16-10), named by its title.

export interface SupplierManageActions {
  readonly update: (input: SupplierEditInput, idempotencyKey: string) => Promise<SupplierOutcome<{ version: number }>>
}

export interface SupplierManageProps {
  readonly supplier: {
    readonly id: string
    readonly nameTh: string
    readonly nameEn: string | null
    readonly address: string | null
    readonly isVatRegistered: boolean
    readonly category: string | null
    readonly expressVendorCode: string | null
    readonly email: string | null
    readonly phone: string | null
    readonly status: SupplierStatus
    readonly version: number
  }
  readonly actions: SupplierManageActions
}

type Result = { tone: 'success' | 'danger'; text: string; conflict: boolean } | null

const NO_ANSWER: SupplierFailure = { ok: false, code: 'FAILED' }

/** Runs one save against the version the page holds; a new submission key once the answer is in */
function useSave(version: number, onSaved: (version: number) => void) {
  const te = useTranslations('suppliers.errors')
  const router = useRouter()
  const submission = useSubmissionKey()
  const [pending, setPending] = useState(false)
  const [result, setResult] = useState<Result>(null)
  async function run(call: (expectedVersion: number, idempotencyKey: string) => Promise<SupplierOutcome<{ version: number }>>, success: string): Promise<boolean> {
    setPending(true)
    setResult(null)
    let outcome: SupplierOutcome<{ version: number }>
    try {
      outcome = await call(version, submission.key)
      // An answer came: the next save is a new command. Without one the key stays, so trying again saves once
      submission.next()
    } catch {
      // A dropped connection or a server fault: the button comes back and says so (§9.9 rule 7)
      outcome = NO_ANSWER
    } finally {
      setPending(false)
    }
    if (outcome.ok) {
      onSaved(outcome.version)
      setResult({ tone: 'success', text: success, conflict: false })
      router.refresh()
      return true
    }
    const failure: SupplierFailure = outcome
    setResult({ tone: 'danger', text: te(supplierErrorKey(failure), { code: failure.existingCode ?? '-', requestId: failure.requestId ?? '-' }), conflict: failure.code === 'CONFLICT_VERSION' })
    return false
  }
  return { pending, result, run }
}

function ResultNotice({ result }: { result: Result }) {
  const t = useTranslations('suppliers.edit')
  if (!result) return null
  return (
    <Notice tone={result.tone}>
      <p>{result.text}</p>
      {result.conflict ? (
        <Button variant="secondary" className="mt-2" onClick={() => window.location.reload()}>
          {t('reload')}
        </Button>
      ) : null}
    </Notice>
  )
}

function Part({ id, title, hint, children }: { id: string; title: string; hint?: string; children: ReactNode }) {
  return (
    <Panel id={id} title={title}>
      {hint ? <p className="text-ink-muted">{hint}</p> : null}
      {children}
    </Panel>
  )
}

export function SupplierManage({ supplier, actions }: SupplierManageProps) {
  // The version of the last save: the forms of this page save one after another without reloading
  const [version, setVersion] = useState(supplier.version)
  // The container the question of "ปิดใช้งานผู้ขาย" splits by (src/ui/request-form/confirm-remove.tsx)
  return (
    <div className="@container flex flex-col gap-4 lg:gap-6">
      <DetailsForm supplier={supplier} version={version} onSaved={setVersion} actions={actions} />
      <CodesForm supplier={supplier} version={version} onSaved={setVersion} actions={actions} />
      <StatusPart supplier={supplier} version={version} onSaved={setVersion} actions={actions} />
    </div>
  )
}

interface PartProps extends SupplierManageProps {
  readonly version: number
  readonly onSaved: (version: number) => void
}

function DetailsForm({ supplier, version, onSaved, actions }: PartProps) {
  const t = useTranslations('suppliers.edit')
  const tf = useTranslations('suppliers.fields')
  const { pending, result, run } = useSave(version, onSaved)
  const [nameError, setNameError] = useState<string | undefined>()

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    const nameTh = String(form.get('nameTh') ?? '').trim()
    if (!nameTh) return setNameError(tf('missingName'))
    setNameError(undefined)
    const input = {
      nameTh,
      nameEn: optionalText(String(form.get('nameEn') ?? '')),
      address: optionalText(String(form.get('address') ?? '')),
      isVatRegistered: form.get('vat') === 'Y',
      category: optionalText(String(form.get('category') ?? '')),
    }
    await run((expectedVersion, key) => actions.update({ supplierId: supplier.id, expectedVersion, ...input }, key), t('detailsSaved'))
  }

  return (
    <Part id="edit-details" title={t('detailsTitle')} hint={t('detailsHint')}>
      <form onSubmit={onSubmit} className="flex flex-col gap-5" noValidate>
        <ResultNotice result={result} />
        <Labelled id="edit-name" label={tf('nameTh')} requiredText={tf('required')} error={nameError}>
          <input
            id="edit-name"
            name="nameTh"
            className={inputClass}
            defaultValue={supplier.nameTh}
            maxLength={SUPPLIER_LIMITS.name}
            required
            aria-required
            aria-invalid={nameError ? true : undefined}
            aria-describedby={describedBy('edit-name', false, Boolean(nameError))}
          />
        </Labelled>
        <Labelled id="edit-name-en" label={tf('nameEn')}>
          <input id="edit-name-en" name="nameEn" className={inputClass} defaultValue={supplier.nameEn ?? ''} maxLength={SUPPLIER_LIMITS.name} />
        </Labelled>
        <Labelled id="edit-address" label={tf('address')}>
          <textarea id="edit-address" name="address" className={textareaClass} defaultValue={supplier.address ?? ''} maxLength={SUPPLIER_LIMITS.address} />
        </Labelled>
        <Choices id="edit-vat" legend={tf('vat')}>
          <label className="flex min-h-11 items-center gap-3">
            <input type="radio" name="vat" value="Y" className={checkboxClass} defaultChecked={supplier.isVatRegistered} />
            <span>{tf('vatYes')}</span>
          </label>
          <label className="flex min-h-11 items-center gap-3">
            <input type="radio" name="vat" value="N" className={checkboxClass} defaultChecked={!supplier.isVatRegistered} />
            <span>{tf('vatNo')}</span>
          </label>
        </Choices>
        <Labelled id="edit-category" label={tf('category')} hint={tf('categoryHint')}>
          <input id="edit-category" name="category" className={inputClass} defaultValue={supplier.category ?? ''} maxLength={SUPPLIER_LIMITS.category} aria-describedby={describedBy('edit-category', true, false)} />
        </Labelled>
        <Button type="submit" className="self-start" disabled={pending}>
          {pending ? t('saving') : t('detailsSubmit')}
        </Button>
      </form>
    </Part>
  )
}

function CodesForm({ supplier, version, onSaved, actions }: PartProps) {
  const t = useTranslations('suppliers.edit')
  const tf = useTranslations('suppliers.fields')
  const { pending, result, run } = useSave(version, onSaved)
  const [emailError, setEmailError] = useState<string | undefined>()

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    const email = String(form.get('email') ?? '')
    if (email.trim() && !looksLikeEmail(email)) return setEmailError(tf('badEmail'))
    setEmailError(undefined)
    const input = { expressVendorCode: optionalText(String(form.get('expressVendorCode') ?? '')), email: optionalText(email), phone: optionalText(String(form.get('phone') ?? '')) }
    await run((expectedVersion, key) => actions.update({ supplierId: supplier.id, expectedVersion, ...input }, key), t('codesSaved'))
  }

  return (
    <Part id="edit-codes" title={t('codesTitle')} hint={t('codesHint')}>
      <form onSubmit={onSubmit} className="flex flex-col gap-5" noValidate>
        <ResultNotice result={result} />
        <Labelled id="edit-express" label={tf('express')} hint={tf('expressHint')}>
          <input
            id="edit-express"
            name="expressVendorCode"
            className={`${inputClass} max-w-xs`}
            defaultValue={supplier.expressVendorCode ?? ''}
            maxLength={SUPPLIER_LIMITS.expressVendorCode}
            aria-describedby={describedBy('edit-express', true, false)}
          />
        </Labelled>
        <Labelled id="edit-email" label={tf('email')} hint={tf('emailHint')} error={emailError}>
          <input
            id="edit-email"
            name="email"
            type="email"
            inputMode="email"
            autoComplete="off"
            className={inputClass}
            defaultValue={supplier.email ?? ''}
            maxLength={SUPPLIER_LIMITS.email}
            aria-invalid={emailError ? true : undefined}
            aria-describedby={describedBy('edit-email', true, Boolean(emailError))}
          />
        </Labelled>
        <Labelled id="edit-phone" label={tf('phone')}>
          <input id="edit-phone" name="phone" type="tel" inputMode="tel" className={`${inputClass} max-w-xs`} defaultValue={supplier.phone ?? ''} maxLength={SUPPLIER_LIMITS.phone} />
        </Labelled>
        <Button type="submit" className="self-start" disabled={pending}>
          {pending ? t('saving') : t('codesSubmit')}
        </Button>
      </form>
    </Part>
  )
}

function StatusPart({ supplier, version, onSaved, actions }: PartProps) {
  const t = useTranslations('suppliers.edit')
  const { pending, result, run } = useSave(version, onSaved)
  const [status, setStatus] = useState<SupplierStatus>(supplier.status)
  const change = async (next: SupplierStatus) => {
    const done = await run((expectedVersion, key) => actions.update({ supplierId: supplier.id, expectedVersion, status: next }, key), next === 'INACTIVE' ? t('deactivated') : t('activated'))
    if (done) setStatus(next)
  }
  return (
    <Part id="edit-status" title={t('statusTitle')} hint={status === 'ACTIVE' ? t('activeHint') : t('inactiveHint')}>
      <ResultNotice result={result} />
      {status === 'ACTIVE' ? (
        <ConfirmRemove
          label={t('deactivate')}
          question={t('deactivateQuestion', { name: supplier.nameTh })}
          detail={t('deactivateDetail')}
          confirmLabel={t('deactivateConfirm')}
          keepLabel={t('deactivateKeep')}
          disabled={pending}
          onConfirm={() => void change('INACTIVE')}
        />
      ) : (
        <Button variant="secondary" className="self-start" disabled={pending} onClick={() => void change('ACTIVE')}>
          {t('activate')}
        </Button>
      )}
    </Part>
  )
}
