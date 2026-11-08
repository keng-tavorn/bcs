'use client'

import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { useState, type FormEvent } from 'react'
import { Button } from '../form/button'
import { Field } from '../form/field'
import { Notice } from '../form/notice'
import { useSubmissionKey } from '../form/submission-key'
import { Checkbox } from '../shadcn/checkbox'

// The form of /admin/supplier-document-types (S7-06 · BR-SDOC ข้อ 01): one type added or changed (an existing code
// changes that type), and the close button of a row. The server checks everything again; this keeps the form honest.

export const PAYEE_TYPES = ['JURISTIC', 'INDIVIDUAL', 'FOREIGN'] as const
export type PayeeTypeCode = (typeof PAYEE_TYPES)[number]

export interface DocumentTypeInput {
  readonly code: string
  readonly nameTh: string
  readonly nameEn: string
  readonly appliesTo: PayeeTypeCode[]
  readonly required: boolean
  readonly validityDays: number | null
  readonly reminderDaysBefore: number
  readonly sensitive: boolean
  readonly singleInstance: boolean
}

export type TypeActionResult = { readonly ok: true } | { readonly ok: false; readonly code: string }
const KNOWN = ['FORBIDDEN', 'VALIDATION_FAILED'] as const

export function DocumentTypeForm({ save }: { readonly save: (input: DocumentTypeInput, key: string) => Promise<TypeActionResult> }) {
  const t = useTranslations('supplierDocs')
  const router = useRouter()
  const { key, next } = useSubmissionKey()
  const [appliesTo, setAppliesTo] = useState<PayeeTypeCode[]>(['JURISTIC'])
  const [flags, setFlags] = useState({ required: false, sensitive: false, singleInstance: true })
  const [state, setState] = useState<{ kind: 'idle' | 'saved' } | { kind: 'error'; code: string }>({ kind: 'idle' })
  const [busy, setBusy] = useState(false)

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    const text = (name: string) => String(form.get(name) ?? '').trim()
    const validity = text('validityDays')
    setBusy(true)
    const r = await save(
      { code: text('code').toUpperCase(), nameTh: text('nameTh'), nameEn: text('nameEn'), appliesTo, required: flags.required, validityDays: validity ? Number(validity) : null, reminderDaysBefore: Number(text('reminderDaysBefore') || '30'), sensitive: flags.sensitive, singleInstance: flags.singleInstance },
      key,
    )
    setBusy(false)
    next()
    setState(r.ok ? { kind: 'saved' } : { kind: 'error', code: r.code })
    if (r.ok) router.refresh()
  }

  const toggle = (payee: PayeeTypeCode, on: boolean) => setAppliesTo((cur) => (on ? [...new Set([...cur, payee])] : cur.filter((p) => p !== payee)))
  const errorCode = state.kind === 'error' ? ((KNOWN as readonly string[]).includes(state.code) ? (state.code as (typeof KNOWN)[number]) : null) : null

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-4" noValidate>
      {state.kind === 'saved' ? <Notice tone="success">{t('types.saved')}</Notice> : null}
      {state.kind === 'error' ? <Notice tone="danger">{errorCode ? t(`errors.${errorCode}`) : t('errors.FAILED')}</Notice> : null}
      <Field id="code" name="code" label={t('types.code')} hint={t('types.codeHint')} required autoComplete="off" />
      <Field id="nameTh" name="nameTh" label={t('types.nameTh')} required />
      <Field id="nameEn" name="nameEn" label={t('types.nameEn')} required />
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 font-medium text-ink">{t('types.appliesTo')}</legend>
        {PAYEE_TYPES.map((p) => (
          <label key={p} className="flex min-h-11 items-center gap-3">
            <Checkbox checked={appliesTo.includes(p)} onCheckedChange={(v) => toggle(p, v === true)} aria-label={t(`types.payee.${p}`)} />
            <span>{t(`types.payee.${p}`)}</span>
          </label>
        ))}
      </fieldset>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field id="validityDays" name="validityDays" type="number" inputMode="numeric" min={1} label={t('types.validityDays')} hint={t('types.validityHint')} />
        <Field id="reminderDaysBefore" name="reminderDaysBefore" type="number" inputMode="numeric" min={0} defaultValue={30} label={t('types.reminderDaysBefore')} />
      </div>
      {(['required', 'sensitive', 'singleInstance'] as const).map((f) => (
        <label key={f} className="flex min-h-11 items-center gap-3">
          <Checkbox checked={flags[f]} onCheckedChange={(v) => setFlags((cur) => ({ ...cur, [f]: v === true }))} aria-label={t(`types.${f}`)} />
          <span>{t(`types.${f}`)}</span>
        </label>
      ))}
      <Button type="submit" disabled={busy || appliesTo.length === 0} className="self-start">
        {t('types.save')}
      </Button>
    </form>
  )
}

export function CloseTypeButton({ code, close }: { readonly code: string; readonly close: (code: string, key: string) => Promise<TypeActionResult> }) {
  const t = useTranslations('supplierDocs')
  const router = useRouter()
  const { key, next } = useSubmissionKey()
  const [busy, setBusy] = useState(false)
  return (
    <Button
      variant="secondary"
      disabled={busy}
      onClick={async () => {
        setBusy(true)
        const r = await close(code, key)
        setBusy(false)
        next()
        if (r.ok) router.refresh()
      }}
    >
      {t('types.close')}
    </Button>
  )
}
