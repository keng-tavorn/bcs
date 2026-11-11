'use client'

import { useRouter } from 'next/navigation'
import { useLocale, useTranslations } from 'next-intl'
import { useId, useState, type FormEvent, type ReactNode } from 'react'
import { RadioChoices, TextField } from '../bank-accounts/fields'
import { StatusBadge } from '../document/badges'
import { Button } from '../form/button'
import { Notice } from '../form/notice'
import { useSubmissionKey } from '../form/submission-key'
import { formatDateTime } from '../format'
import { ListEmpty } from '../page/page'
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '../shadcn/alert-dialog'
import { Checkbox } from '../shadcn/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../shadcn/dialog'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../shadcn/table'

// The "ผู้ติดต่อ" tab of /suppliers/[id] (S7-09 · S7-04 · BR-SUP ข้อ 17 · BR-PORTAL ข้อ 03): who of the supplier may act
// on the portal — name, role, primary, portal access, the last sign-in, status. PROCUREMENT (supplier.contact.manage)
// adds a contact in a dialog it opens itself (NG-13), makes another one primary, signs one out of every device, and
// closes one — which cannot be undone, so it asks first (§9.9). A table from 768 px; under it the same as a list, so the
// page never scrolls sideways on a phone. The server checks every right again and sends e-mails only to this reader.

export interface ContactRowView {
  readonly id: string
  readonly version: number
  readonly nameTh: string
  readonly nameEn: string | null
  readonly roleLabel: string | null
  /** Shown to supplier.contact.manage only (null for the others) */
  readonly email: string | null
  readonly phone: string | null
  readonly isPrimary: boolean
  readonly portalEnabled: boolean
  readonly status: 'ACTIVE' | 'DEACTIVATED'
  readonly firstSignedInAt: string | null
  readonly lastSeenAt: string | null
  readonly liveSessions: number
  readonly deactivatedAt: string | null
}

export interface NewContactInput {
  readonly nameTh: string
  readonly nameEn: string
  readonly email: string
  readonly phone: string
  readonly roleLabel: string
  readonly isPrimary: boolean
  readonly locale: 'th' | 'en'
}

export type ContactActionResult = { readonly ok: true } | { readonly ok: false; readonly code: string; readonly reason?: string }

export interface ContactActions {
  add(supplierId: string, input: NewContactInput, key: string): Promise<ContactActionResult>
  deactivate(contactId: string, version: number, key: string): Promise<ContactActionResult>
  revoke(contactId: string, key: string): Promise<ContactActionResult>
  makePrimary(contactId: string, version: number, key: string): Promise<ContactActionResult>
}

const KNOWN = ['FORBIDDEN', 'MODULE_DISABLED', 'NOT_FOUND', 'CONFLICT_VERSION', 'INVALID_STATE_TRANSITION', 'EMAIL_TAKEN', 'NO_SESSION', 'VALIDATION_FAILED'] as const
type Known = (typeof KNOWN)[number]

/** The words of a refusal: the reason first (EMAIL_TAKEN, NO_SESSION), then the code */
export function refusalKey(r: { code: string; reason?: string }): Known | 'FAILED' {
  const pick = (v: string | undefined) => (v && (KNOWN as readonly string[]).includes(v) ? (v as Known) : null)
  return pick(r.reason) ?? pick(r.code) ?? 'FAILED'
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
type Done = 'added' | 'deactivated' | 'revoked' | 'primary'
type Asking = { readonly kind: 'deactivate' | 'revoke'; readonly row: ContactRowView } | null

export function ContactsPanel({ supplierId, rows, canManage, seesAddresses, actions }: { supplierId: string; rows: readonly ContactRowView[]; canManage: boolean; seesAddresses: boolean; actions: ContactActions }) {
  const t = useTranslations('supplierContacts.contacts')
  const locale = useLocale()
  const router = useRouter()
  const { key, next } = useSubmissionKey()
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState<Done | null>(null)
  const [failure, setFailure] = useState<ReturnType<typeof refusalKey> | null>(null)
  const [asking, setAsking] = useState<Asking>(null)

  const nameOf = (c: ContactRowView) => (locale === 'en' && c.nameEn ? c.nameEn : c.nameTh)
  const when = (iso: string) => formatDateTime(locale, iso)

  async function run(fn: () => Promise<ContactActionResult>, success: Done): Promise<boolean> {
    setBusy(true)
    setFailure(null)
    setDone(null)
    const r = await fn()
    setBusy(false)
    next()
    if (!r.ok) {
      setFailure(refusalKey(r))
      return false
    }
    setDone(success)
    router.refresh()
    return true
  }

  const who = (c: ContactRowView): ReactNode => (
    <div className="flex flex-col gap-1">
      <span className="font-medium text-ink">{nameOf(c)}</span>
      {c.roleLabel ? <span className="text-base text-ink-muted md:text-sm">{c.roleLabel}</span> : null}
      {c.isPrimary ? <StatusBadge look={{ tone: 'info', icon: 'CircleDot' }} label={t('primary')} className="self-start" /> : null}
    </div>
  )
  const reach = (c: ContactRowView): ReactNode => (
    <div className="flex min-w-0 flex-col gap-1">
      <span className="break-all text-ink">{c.email}</span>
      <span className="text-base text-ink-muted md:text-sm">{c.phone ?? t('noPhone')}</span>
    </div>
  )
  const access = (c: ContactRowView): ReactNode => (
    <div className="flex flex-col gap-1">
      <StatusBadge look={c.portalEnabled && c.status === 'ACTIVE' ? { tone: 'ok', icon: 'CircleCheck' } : { tone: 'neutral', icon: 'Ban' }} label={c.portalEnabled ? t('portalOn') : t('portalOff')} className="self-start" />
      <span className="text-base text-ink-muted md:text-sm">{c.lastSeenAt ? t('lastSeen', { when: when(c.lastSeenAt) }) : c.firstSignedInAt ? t('firstSignedIn', { when: when(c.firstSignedInAt) }) : t('neverSignedIn')}</span>
      {c.liveSessions > 0 && c.status === 'ACTIVE' ? <span className="text-base text-ink-muted md:text-sm">{t('liveSessions', { count: c.liveSessions })}</span> : null}
    </div>
  )
  const state = (c: ContactRowView): ReactNode => (
    <div className="flex flex-col gap-1">
      <StatusBadge look={c.status === 'ACTIVE' ? { tone: 'ok', icon: 'CircleCheck' } : { tone: 'neutral', icon: 'Lock' }} label={t(`status.${c.status}`)} className="self-start" />
      {c.status === 'DEACTIVATED' && c.deactivatedAt ? <span className="text-base text-ink-muted md:text-sm">{t('closedOn', { when: when(c.deactivatedAt) })}</span> : null}
    </div>
  )
  const manage = (c: ContactRowView): ReactNode =>
    canManage && c.status === 'ACTIVE' ? (
      <div className="flex flex-wrap gap-2">
        {!c.isPrimary ? (
          <Button variant="secondary" disabled={busy} onClick={() => void run(() => actions.makePrimary(c.id, c.version, key), 'primary')}>
            {t('makePrimary')}
          </Button>
        ) : null}
        {c.liveSessions > 0 ? (
          <Button variant="secondary" disabled={busy} onClick={() => setAsking({ kind: 'revoke', row: c })}>
            {t('revoke')}
          </Button>
        ) : null}
        <Button variant="danger" disabled={busy} onClick={() => setAsking({ kind: 'deactivate', row: c })}>
          {t('deactivate')}
        </Button>
      </div>
    ) : null

  const actionsShown = canManage && rows.some((r) => r.status === 'ACTIVE')
  return (
    <div className="flex flex-col gap-3">
      <p className="text-ink-muted">{t('intro')}</p>
      {!seesAddresses && rows.length ? <p className="text-base text-ink-muted md:text-sm">{t('addressHidden')}</p> : null}
      {canManage ? <AddContact supplierId={supplierId} add={actions.add} onAdded={() => { setFailure(null); setDone('added'); router.refresh() }} /> : null}
      {done ? <Notice tone="success">{t(`done.${done}`)}</Notice> : null}
      {failure ? <Notice tone="danger">{t(`errors.${failure}`)}</Notice> : null}

      {rows.length === 0 ? (
        <ListEmpty title={t('emptyTitle')} hint={canManage ? t('emptyHintManage') : t('emptyHint')} />
      ) : (
        <>
          <div className="hidden md:block">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('columns.name')}</TableHead>
                  {seesAddresses ? <TableHead>{t('columns.reach')}</TableHead> : null}
                  <TableHead>{t('columns.portal')}</TableHead>
                  <TableHead>{t('columns.status')}</TableHead>
                  {actionsShown ? <TableHead>{t('columns.action')}</TableHead> : null}
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((c) => (
                  <TableRow key={c.id}>
                    <TableCell className="align-top whitespace-normal">{who(c)}</TableCell>
                    {seesAddresses ? <TableCell className="max-w-64 align-top whitespace-normal">{reach(c)}</TableCell> : null}
                    <TableCell className="align-top whitespace-normal">{access(c)}</TableCell>
                    <TableCell className="align-top whitespace-normal">{state(c)}</TableCell>
                    {actionsShown ? <TableCell className="align-top whitespace-normal">{manage(c)}</TableCell> : null}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          <ul className="flex flex-col divide-y divide-line md:hidden">
            {rows.map((c) => (
              <li key={c.id} className="flex flex-col gap-3 py-3 first:pt-0 last:pb-0">
                {who(c)}
                {seesAddresses ? reach(c) : null}
                {access(c)}
                {state(c)}
                {manage(c)}
              </li>
            ))}
          </ul>
        </>
      )}

      <AlertDialog open={asking !== null} onOpenChange={(open) => (open ? null : setAsking(null))}>
        <AlertDialogContent>
          {asking ? (
            <>
              <AlertDialogHeader>
                <AlertDialogTitle>{asking.kind === 'deactivate' ? t('deactivateTitle', { name: nameOf(asking.row) }) : t('revokeTitle', { name: nameOf(asking.row) })}</AlertDialogTitle>
                <AlertDialogDescription className="text-base md:text-sm">{asking.kind === 'deactivate' ? t('deactivateBody') : t('revokeBody')}</AlertDialogDescription>
              </AlertDialogHeader>
              {asking.kind === 'deactivate' && asking.row.isPrimary && rows.filter((r) => r.status === 'ACTIVE').length > 1 ? <Notice tone="warning">{t('deactivatePrimary')}</Notice> : null}
              <AlertDialogFooter>
                <AlertDialogCancel className="min-h-11 text-base">{t('keep')}</AlertDialogCancel>
                <AlertDialogAction
                  className="min-h-11 text-base"
                  disabled={busy}
                  onClick={() => {
                    const row = asking.row
                    void (asking.kind === 'deactivate' ? run(() => actions.deactivate(row.id, row.version, key), 'deactivated') : run(() => actions.revoke(row.id, key), 'revoked'))
                  }}
                >
                  {asking.kind === 'deactivate' ? t('deactivateConfirm') : t('revokeConfirm')}
                </AlertDialogAction>
              </AlertDialogFooter>
            </>
          ) : null}
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

const EMPTY: NewContactInput = { nameTh: '', nameEn: '', email: '', phone: '', roleLabel: '', isPrimary: false, locale: 'th' }

function AddContact({ supplierId, add, onAdded }: { supplierId: string; add: ContactActions['add']; onAdded: () => void }) {
  const t = useTranslations('supplierContacts.contacts')
  const id = useId()
  const { key, next } = useSubmissionKey()
  const [open, setOpen] = useState(false)
  const [form, setForm] = useState<NewContactInput>(EMPTY)
  const [checked, setChecked] = useState(false)
  const [pending, setPending] = useState(false)
  const [failure, setFailure] = useState<ReturnType<typeof refusalKey> | null>(null)
  const set = <K extends keyof NewContactInput>(k: K, v: NewContactInput[K]) => setForm((f) => ({ ...f, [k]: v }))

  const nameError = checked && form.nameTh.trim() === '' ? t('nameMissing') : null
  const emailError = checked && !EMAIL.test(form.email.trim()) ? t('emailInvalid') : null

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setChecked(true)
    if (form.nameTh.trim() === '' || !EMAIL.test(form.email.trim())) return
    setPending(true)
    setFailure(null)
    const r = await add(supplierId, { ...form, email: form.email.trim() }, key)
    setPending(false)
    next()
    if (!r.ok) return setFailure(refusalKey(r))
    setOpen(false)
    setForm(EMPTY)
    setChecked(false)
    onAdded()
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Button className="self-start" onClick={() => setOpen(true)}>
        {t('add')}
      </Button>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-lg">
        <form onSubmit={onSubmit} className="flex flex-col gap-4" noValidate>
          <DialogHeader>
            <DialogTitle className="text-lg font-semibold">{t('addTitle')}</DialogTitle>
            <DialogDescription className="text-base text-ink-muted md:text-sm">{t('addDescription')}</DialogDescription>
          </DialogHeader>
          <TextField id={`${id}-nameTh`} label={t('fields.nameTh')} value={form.nameTh} onChange={(e) => set('nameTh', e.target.value)} error={nameError} maxLength={200} autoComplete="off" />
          <TextField id={`${id}-nameEn`} label={t('fields.nameEn')} value={form.nameEn} onChange={(e) => set('nameEn', e.target.value)} maxLength={200} autoComplete="off" />
          <TextField id={`${id}-email`} type="email" inputMode="email" label={t('fields.email')} hint={t('fields.emailHint')} value={form.email} onChange={(e) => set('email', e.target.value)} error={emailError} maxLength={254} autoComplete="off" />
          <TextField id={`${id}-phone`} type="tel" inputMode="tel" label={t('fields.phone')} value={form.phone} onChange={(e) => set('phone', e.target.value)} maxLength={40} autoComplete="off" />
          <TextField id={`${id}-role`} label={t('fields.roleLabel')} hint={t('fields.roleHint')} value={form.roleLabel} onChange={(e) => set('roleLabel', e.target.value)} maxLength={200} autoComplete="off" />
          <div className="flex items-start gap-3">
            <Checkbox id={`${id}-primary`} checked={form.isPrimary} onCheckedChange={(v) => set('isPrimary', v === true)} className="mt-1" aria-describedby={`${id}-primary-hint`} />
            <div className="flex flex-col gap-0.5">
              <label htmlFor={`${id}-primary`} className="font-medium text-ink">
                {t('fields.isPrimary')}
              </label>
              <p id={`${id}-primary-hint`} className="text-base text-ink-muted md:text-sm">
                {t('fields.isPrimaryHint')}
              </p>
            </div>
          </div>
          <RadioChoices
            id={`${id}-locale`}
            legend={t('fields.locale')}
            choices={[
              { value: 'th', label: t('fields.localeTh') },
              { value: 'en', label: t('fields.localeEn') },
            ]}
            value={form.locale}
            onChange={(v) => set('locale', v)}
          />
          {failure ? <Notice tone="danger">{t(`errors.${failure}`)}</Notice> : null}
          <DialogFooter className="flex-row flex-wrap gap-x-6 gap-y-2 sm:justify-start">
            <Button type="submit" disabled={pending}>
              {pending ? t('saving') : t('save')}
            </Button>
            <Button variant="link" className="min-h-11" disabled={pending} onClick={() => setOpen(false)}>
              {t('cancel')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
