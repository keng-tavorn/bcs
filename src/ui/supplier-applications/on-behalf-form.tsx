'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { useState, type FormEvent, type ReactNode } from 'react'
import { Button } from '../form/button'
import { Notice } from '../form/notice'
import { useSubmissionKey } from '../form/submission-key'
import { Input } from '../shadcn/input'
import { NativeSelect, NativeSelectOption } from '../shadcn/native-select'
import { Textarea } from '../shadcn/textarea'
import type { ActionResult } from './application-actions'
import { ON_BEHALF_STEPS, type OnBehalfStep } from './on-behalf-steps'

// PROCUREMENT fills in an application for the supplier (S7-09 · BR-SUP ข้อ 10 · /suppliers/applications/[id]/edit): the
// same fields as the portal's form, a step at a time (company, tax, bank account, send — at most 8 fields each), only
// what changed is sent; every field filled in is marked ON_BEHALF and the supplier gets a copy when it is sent. The
// account number is never shown back, its last four only.


export interface OnBehalfFields {
  readonly nameTh: string
  readonly nameEn: string | null
  readonly payeeType: 'JURISTIC' | 'INDIVIDUAL' | 'FOREIGN'
  readonly address: string | null
  readonly phone: string | null
  readonly email: string | null
  readonly category: string | null
  readonly taxId: string | null
  readonly branchCode: string
  readonly isVatRegistered: boolean
  readonly bankCode: string | null
  readonly accountNoLast4: string | null
  readonly accountName: string | null
  readonly bankBranch: string | null
}

const WARNINGS = ['SAME_TAXID_OTHER_BRANCH', 'DUPLICATE_NAME', 'DUPLICATE_EMAIL'] as const
const KNOWN = ['FORBIDDEN', 'CONFLICT_VERSION', 'INVALID_STATE_TRANSITION', 'VALIDATION_FAILED'] as const

export function OnBehalfForm({
  applicationId,
  version,
  step,
  fields,
  banks,
  missing,
  warnings,
  typeNames,
  update,
  submit,
}: {
  readonly applicationId: string
  readonly version: number
  readonly step: OnBehalfStep
  readonly fields: OnBehalfFields
  readonly banks: readonly { readonly code: string; readonly nameTh: string }[]
  readonly missing: readonly string[]
  readonly warnings: readonly { readonly code: string; readonly reason: string | null }[]
  /** The names of the document types `missing` names, in the reader's language */
  readonly typeNames: Readonly<Record<string, string>>
  readonly update: (id: string, version: number, fields: unknown, key: string) => Promise<ActionResult>
  readonly submit: (id: string, version: number, reasons: Record<string, string>, key: string) => Promise<ActionResult>
}) {
  const t = useTranslations('supplierApplications')
  const router = useRouter()
  const { key, next } = useSubmissionKey()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const at = ON_BEHALF_STEPS.indexOf(step)
  const nextStep = ON_BEHALF_STEPS[at + 1] ?? 'send'
  const base = `/suppliers/applications/${applicationId}`

  const failed = (r: Extract<ActionResult, { ok: false }>) =>
    setError(r.code === 'APPLICATION_INCOMPLETE' ? t('detail.missing') : (KNOWN as readonly string[]).includes(r.code) ? t(`actions.errors.${r.code as (typeof KNOWN)[number]}`) : t('actions.errors.FAILED'))

  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const form = new FormData(e.currentTarget)
    const text = (n: string) => String(form.get(n) ?? '').trim()
    const orNull = (n: string) => text(n) || null
    const sent: Record<string, unknown> =
      step === 'company'
        ? { nameTh: text('nameTh'), nameEn: orNull('nameEn'), payeeType: text('payeeType'), address: orNull('address'), phone: orNull('phone'), email: orNull('email'), category: orNull('category') }
        : step === 'tax'
          ? { ...(fields.payeeType === 'FOREIGN' ? {} : { taxId: orNull('taxId') }), branchCode: text('branchCode'), isVatRegistered: form.get('isVatRegistered') === '1' }
          : { bankCode: orNull('bankCode'), ...(text('accountNo') ? { accountNo: text('accountNo') } : {}), accountName: orNull('accountName'), bankBranch: orNull('bankBranch') }
    const stored = fields as unknown as Record<string, unknown>
    const changed = Object.fromEntries(Object.entries(sent).filter(([k, v]) => k === 'accountNo' || (stored[k] ?? null) !== (v ?? null)))
    if (Object.keys(changed).length === 0) return router.push(`${base}/edit?step=${nextStep}`)
    setBusy(true)
    setError(null)
    const r = await update(applicationId, version, changed, key)
    setBusy(false)
    next()
    if (!r.ok) return failed(r)
    router.push(`${base}/edit?step=${nextStep}`)
  }

  async function send(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const form = new FormData(e.currentTarget)
    const reasons = Object.fromEntries(WARNINGS.map((c) => [c, String(form.get(`reason.${c}`) ?? '').trim()]).filter(([, v]) => v !== ''))
    setBusy(true)
    setError(null)
    const r = await submit(applicationId, version, reasons, key)
    setBusy(false)
    next()
    if (!r.ok) return failed(r)
    router.push(base)
  }

  const field = (id: string, label: string, control: ReactNode, hint?: string) => (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="font-medium">
        {label}
      </label>
      {control}
      {hint ? (
        <p id={`${id}-hint`} className="text-base text-ink-muted md:text-sm">
          {hint}
        </p>
      ) : null}
    </div>
  )
  const f = fields
  const typeName = (m: string) => (m.startsWith('document:') ? t('detail.document', { type: typeNames[m.slice('document:'.length)] ?? m.slice('document:'.length) }) : (['nameTh', 'taxId', 'branchCode', 'address'] as const).includes(m as 'nameTh') ? t(`detail.field.${m as 'nameTh'}`) : m)

  return (
    <div className="flex max-w-xl flex-col gap-4">
      <nav aria-label={t('edit.title')} className="flex flex-col gap-2">
        <p className="font-medium">{t('edit.stepOf', { n: at + 1, total: ON_BEHALF_STEPS.length })}</p>
        <ol className="flex flex-wrap gap-x-4">
          {ON_BEHALF_STEPS.map((s) => (
            <li key={s}>
              {s === step ? (
                <span aria-current="step" className="inline-flex min-h-11 items-center font-semibold underline underline-offset-4">
                  {t(`edit.steps.${s}`)}
                </span>
              ) : (
                <Link href={`${base}/edit?step=${s}`} className="inline-flex min-h-11 items-center text-primary underline-offset-4 hover:underline">
                  {t(`edit.steps.${s}`)}
                </Link>
              )}
            </li>
          ))}
        </ol>
      </nav>
      {error ? <Notice tone="danger">{error}</Notice> : null}
      {step === 'send' ? (
        <form onSubmit={send} className="flex flex-col gap-4">
          <p className="text-ink-muted">{t('edit.sendIntro')}</p>
          {missing.length ? (
            <div className="flex flex-col gap-1">
              <p className="font-medium">{t('detail.missing')}</p>
              <ul className="list-disc pl-5">
                {missing.map((m) => (
                  <li key={m}>{typeName(m)}</li>
                ))}
              </ul>
            </div>
          ) : null}
          {warnings
            .filter((w) => (WARNINGS as readonly string[]).includes(w.code))
            .map((w) =>
              field(`reason-${w.code}`, t('edit.reasonFor', { warning: t(`detail.warning.${w.code as (typeof WARNINGS)[number]}`) }), <Textarea id={`reason-${w.code}`} name={`reason.${w.code}`} maxLength={500} defaultValue={w.reason ?? ''} />),
            )}
          <Button type="submit" variant="primary" disabled={busy} className="self-start">
            {t('edit.submit')}
          </Button>
        </form>
      ) : (
        <form onSubmit={save} className="flex flex-col gap-4" autoComplete="off">
          {step === 'company' ? (
            <>
              {field('nameTh', t('detail.field.nameTh'), <Input id="nameTh" name="nameTh" required maxLength={200} defaultValue={f.nameTh} />)}
              {field('nameEn', t('detail.field.nameEn'), <Input id="nameEn" name="nameEn" maxLength={200} defaultValue={f.nameEn ?? ''} />)}
              {field(
                'payeeType',
                t('detail.field.payeeType'),
                <NativeSelect id="payeeType" name="payeeType" defaultValue={f.payeeType}>
                  {(['JURISTIC', 'INDIVIDUAL', 'FOREIGN'] as const).map((p) => (
                    <NativeSelectOption key={p} value={p}>
                      {t(`detail.payee.${p}`)}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>,
              )}
              {field('address', t('detail.field.address'), <Textarea id="address" name="address" maxLength={500} defaultValue={f.address ?? ''} />)}
              {field('phone', t('detail.field.phone'), <Input id="phone" name="phone" type="tel" maxLength={40} defaultValue={f.phone ?? ''} />)}
              {field('email', t('detail.field.email'), <Input id="email" name="email" type="email" maxLength={254} defaultValue={f.email ?? ''} />)}
              {field('category', t('detail.field.category'), <Input id="category" name="category" maxLength={100} defaultValue={f.category ?? ''} />)}
            </>
          ) : step === 'tax' ? (
            <>
              {f.payeeType === 'FOREIGN' ? null : field('taxId', t('detail.field.taxId'), <Input id="taxId" name="taxId" inputMode="numeric" maxLength={20} defaultValue={f.taxId ?? ''} />)}
              {field('branchCode', t('detail.field.branchCode'), <Input id="branchCode" name="branchCode" inputMode="numeric" pattern="[0-9]{5}" maxLength={5} required defaultValue={f.branchCode} />)}
              <label className="flex min-h-11 items-center gap-3">
                <input type="checkbox" name="isVatRegistered" value="1" defaultChecked={f.isVatRegistered} className="size-5 shrink-0 accent-primary" />
                {t('detail.field.vat')}
              </label>
            </>
          ) : (
            <>
              {field(
                'bankCode',
                t('edit.bankCode'),
                <NativeSelect id="bankCode" name="bankCode" defaultValue={f.bankCode ?? ''}>
                  <NativeSelectOption value="">{t('edit.bankChoose')}</NativeSelectOption>
                  {banks.map((b) => (
                    <NativeSelectOption key={b.code} value={b.code}>
                      {b.nameTh}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>,
              )}
              {field('accountNo', t('edit.accountNo'), <Input id="accountNo" name="accountNo" inputMode="numeric" maxLength={40} />, f.accountNoLast4 ? t('edit.accountKept', { last4: f.accountNoLast4 }) : undefined)}
              {field('accountName', t('edit.accountName'), <Input id="accountName" name="accountName" maxLength={200} defaultValue={f.accountName ?? ''} />)}
              {field('bankBranch', t('edit.bankBranch'), <Input id="bankBranch" name="bankBranch" maxLength={100} defaultValue={f.bankBranch ?? ''} />)}
            </>
          )}
          <Button type="submit" variant="primary" disabled={busy} className="self-start">
            {t('edit.save')}
          </Button>
        </form>
      )}
      <Link href={base} className="inline-flex min-h-11 items-center self-start font-medium text-primary underline underline-offset-4 hover:no-underline">
        {t('edit.back')}
      </Link>
    </div>
  )
}
