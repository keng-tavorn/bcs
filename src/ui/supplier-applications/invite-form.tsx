'use client'

import Link from 'next/link'
import { useTranslations } from 'next-intl'
import { useState, type FormEvent } from 'react'
import { Button } from '../form/button'
import { Notice } from '../form/notice'
import { useSubmissionKey } from '../form/submission-key'
import { Input } from '../shadcn/input'
import { NativeSelect, NativeSelectOption } from '../shadcn/native-select'
import { Textarea } from '../shadcn/textarea'
import type { ActionResult } from './application-actions'

// /suppliers/invite (S7-09 · BR-SUP ข้อ 08 ข้อ 09 · BR-SUP ข้อ 11): PROCUREMENT invites a new supplier — name, tax id,
// branch, payee type, the phone procurement knows it by, and its contact (8 fields) — or a registered supplier to the
// portal. The duplicate check runs on the server: a registered tax id and branch is refused with what it matches; a
// warning shows inline with a reason to give for each, and the same invitation is sent again with them.

const WARNINGS = ['SAME_TAXID_OTHER_BRANCH', 'DUPLICATE_NAME', 'DUPLICATE_EMAIL'] as const
type Warning = (typeof WARNINGS)[number]

export function InviteForm({ kind, suppliers, invite }: { readonly kind: 'NEW' | 'EXISTING'; readonly suppliers: readonly { readonly id: string; readonly code: string; readonly nameTh: string }[]; readonly invite: (input: unknown, key: string) => Promise<ActionResult> }) {
  const t = useTranslations('supplierApplications')
  const { key, next } = useSubmissionKey()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [warnings, setWarnings] = useState<{ code: Warning; matches: string[] }[]>([])
  const [reasons, setReasons] = useState<Partial<Record<Warning, string>>>({})
  const [sent, setSent] = useState<string | null>(null)

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const form = new FormData(e.currentTarget)
    const text = (name: string) => String(form.get(name) ?? '').trim()
    const contact = { nameTh: text('contactName'), email: text('contactEmail'), locale: text('contactLocale') || 'th' }
    const input =
      kind === 'NEW'
        ? {
            kind,
            nameTh: text('nameTh'),
            taxId: text('taxId') || null,
            branchCode: text('branchCode') || '00000',
            payeeType: text('payeeType') || 'JURISTIC',
            inviterPhone: text('inviterPhone') || null,
            contact,
            ...(Object.keys(reasons).length ? { duplicateReasons: Object.fromEntries(Object.entries(reasons).filter(([, v]) => v && v.trim())) } : {}),
          }
        : { kind, supplierId: text('supplierId'), contact }
    setBusy(true)
    setError(null)
    const r = await invite(input, key)
    setBusy(false)
    next()
    if (r.ok) {
      setSent(r.applicationId)
      return
    }
    if (r.reason === 'DUPLICATE_REASON_REQUIRED' && Array.isArray(r.details.warnings)) {
      setWarnings((r.details.warnings as { code: string; matches: string[] }[]).filter((w): w is { code: Warning; matches: string[] } => (WARNINGS as readonly string[]).includes(w.code)))
      return
    }
    if (r.code === 'DUPLICATE_SUPPLIER') return setError(t('invite.blocked', { refs: Array.isArray(r.details.matches) ? (r.details.matches as string[]).join(', ') : '-' }))
    if (r.reason === 'EMAIL_TAKEN') return setError(t('invite.emailTaken'))
    if (r.details.field === 'taxId') return setError(r.reason === 'REQUIRED' ? t('invite.taxIdRequired') : t('invite.taxIdInvalid'))
    setError(r.code === 'FORBIDDEN' ? t('actions.errors.FORBIDDEN') : r.code === 'VALIDATION_FAILED' ? t('actions.errors.VALIDATION_FAILED') : t('actions.errors.FAILED'))
  }

  if (sent) {
    return (
      <div className="flex flex-col gap-3">
        <Notice tone="success">{t('invite.sent')}</Notice>
        <Link href={`/suppliers/applications/${sent}`} className="inline-flex min-h-11 items-center self-start font-medium text-primary underline underline-offset-4 hover:no-underline">
          {t('invite.open')}
        </Link>
      </div>
    )
  }

  const field = (id: string, label: string, control: React.ReactNode, hint?: string) => (
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

  return (
    <form onSubmit={submit} className="flex max-w-xl flex-col gap-4">
      {error ? <Notice tone="danger">{error}</Notice> : null}
      {kind === 'NEW' ? (
        <>
          {field('nameTh', t('invite.nameTh'), <Input id="nameTh" name="nameTh" required maxLength={200} />)}
          {field('taxId', t('invite.taxId'), <Input id="taxId" name="taxId" inputMode="numeric" maxLength={20} aria-describedby="taxId-hint" />, t('invite.taxIdHint'))}
          {field('branchCode', t('invite.branchCode'), <Input id="branchCode" name="branchCode" inputMode="numeric" pattern="[0-9]{5}" maxLength={5} defaultValue="00000" />)}
          {field(
            'payeeType',
            t('invite.payeeType'),
            <NativeSelect id="payeeType" name="payeeType" defaultValue="JURISTIC">
              {(['JURISTIC', 'INDIVIDUAL', 'FOREIGN'] as const).map((p) => (
                <NativeSelectOption key={p} value={p}>
                  {t(`detail.payee.${p}`)}
                </NativeSelectOption>
              ))}
            </NativeSelect>,
          )}
          {field('inviterPhone', t('invite.inviterPhone'), <Input id="inviterPhone" name="inviterPhone" type="tel" maxLength={40} aria-describedby="inviterPhone-hint" />, t('invite.inviterPhoneHint'))}
        </>
      ) : (
        field(
          'supplierId',
          t('invite.supplier'),
          <NativeSelect id="supplierId" name="supplierId" required defaultValue="">
            <NativeSelectOption value="" disabled>
              {t('invite.supplierChoose')}
            </NativeSelectOption>
            {suppliers.map((s) => (
              <NativeSelectOption key={s.id} value={s.id}>
                {s.code} · {s.nameTh}
              </NativeSelectOption>
            ))}
          </NativeSelect>,
        )
      )}
      {field('contactName', t('invite.contactName'), <Input id="contactName" name="contactName" required maxLength={200} />)}
      {field('contactEmail', t('invite.contactEmail'), <Input id="contactEmail" name="contactEmail" type="email" required maxLength={254} />)}
      {field(
        'contactLocale',
        t('invite.contactLocale'),
        <NativeSelect id="contactLocale" name="contactLocale" defaultValue="th">
          <NativeSelectOption value="th">{t('invite.th')}</NativeSelectOption>
          <NativeSelectOption value="en">{t('invite.en')}</NativeSelectOption>
        </NativeSelect>,
      )}
      {warnings.length ? (
        <section aria-labelledby="invite-warnings" className="flex flex-col gap-3 rounded-md border border-warn p-3">
          <h2 id="invite-warnings" className="font-semibold">
            {t('invite.warningsTitle')}
          </h2>
          {warnings.map((w) => (
            <div key={w.code} className="flex flex-col gap-1.5">
              <label htmlFor={`reason-${w.code}`} className="font-medium">
                {t(`detail.warning.${w.code}`)} · {t('detail.matches', { refs: w.matches.join(', ') })}
              </label>
              <Textarea id={`reason-${w.code}`} required maxLength={500} value={reasons[w.code] ?? ''} onChange={(e) => setReasons({ ...reasons, [w.code]: e.target.value })} />
            </div>
          ))}
        </section>
      ) : null}
      <Button type="submit" variant="primary" disabled={busy} className="self-start">
        {t('invite.submit')}
      </Button>
    </form>
  )
}
