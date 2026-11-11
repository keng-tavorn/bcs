'use client'

import { CircleAlert, CircleCheck } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { useId, useState } from 'react'
import { StatusBadge } from '../document/badges'
import { Notice } from '../form/notice'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '../shadcn/alert-dialog'
import { Button } from '../shadcn/button'
import { Label } from '../shadcn/label'
import { NativeSelect, NativeSelectOption } from '../shadcn/native-select'
import { Textarea } from '../shadcn/textarea'
import { INVITE_STATUS_LOOK, isInviteStatus } from './rfx-looks'
import type { RfxOutcome } from './setup-model'
import { useRfxAct } from './use-rfx-act'

// Step "ผู้ขาย" of /sourcing/[id]/edit (S10-12 · BR-RFX-01 BR-RFX-03): the suppliers invited with what was true of each
// when invited (VAT registration, abroad, the registry's flag, S7's documents, S11's risk tier while RISK is on — a tag,
// never a bar to inviting), the count against the RFx's minimum (BR-RFX-01: below it the opening asks a reason), and
// inviting another active supplier of the portal or an open application of a new supplier (ADR-203). While the RFx is
// open and before its close an invite still goes (its e-mail and link at once · BR-RFX-03) and one may be withdrawn
// with a reason, asked first. rfx.invite and rfx.uninvite check everything again.

export interface SupplierInviteView {
  readonly id: string
  readonly name: string
  readonly status: string
  readonly tags: readonly string[]
  /** A tag that calls for care: flagged by the registry, documents not complete, risk not cleared */
  readonly warnings: readonly string[]
}

export interface SupplierChoiceView {
  readonly id: string
  readonly label: string
  readonly sameCategory: boolean
  /** Why it cannot be invited, worded, or null */
  readonly refusal: string | null
}

export function SetupSuppliers({
  invites,
  minInvites,
  suppliers,
  applications,
  invite,
  uninvite,
}: {
  readonly invites: readonly SupplierInviteView[]
  readonly minInvites: number
  readonly suppliers: readonly SupplierChoiceView[]
  readonly applications: ReadonlyArray<{ readonly id: string; readonly label: string }>
  readonly invite: (owner: { supplierId?: string; applicationId?: string }, key: string) => Promise<RfxOutcome>
  readonly uninvite: (inviteId: string, reason: string, key: string) => Promise<RfxOutcome>
}) {
  const t = useTranslations('sourcing.setup')
  const id = useId()
  const { act, pending, message, setMessage } = useRfxAct()
  const [supplierId, setSupplierId] = useState('')
  const [applicationId, setApplicationId] = useState('')
  const [reason, setReason] = useState('')
  const live = invites.filter((i) => i.status !== 'REMOVED' && i.status !== 'DECLINED' && i.status !== 'EXPIRED').length
  const enough = live >= minInvites
  const same = suppliers.filter((s) => s.sameCategory)
  const others = suppliers.filter((s) => !s.sameCategory)

  const option = (s: SupplierChoiceView) => (
    <NativeSelectOption key={s.id} value={s.id} disabled={s.refusal !== null}>
      {s.refusal ? `${s.label} (${s.refusal})` : s.label}
    </NativeSelectOption>
  )

  return (
    <div className="flex flex-col gap-4">
      {message ? <Notice tone={message.tone}>{message.text}</Notice> : null}
      <p className={`inline-flex items-start gap-2 font-medium ${enough ? 'text-ink' : 'text-warn'}`} aria-live="polite">
        {enough ? <CircleCheck className="mt-[0.3em] size-4 shrink-0 text-primary" aria-hidden="true" /> : <CircleAlert className="mt-[0.3em] size-4 shrink-0" aria-hidden="true" />}
        <span>{enough ? t('suppliers.counterOk', { count: live, min: minInvites }) : t('suppliers.counterShort', { count: live, min: minInvites })}</span>
      </p>
      {invites.length ? (
        <ul aria-label={t('suppliers.label')} className="flex flex-col divide-y divide-line">
          {invites.map((i) => (
            <li key={i.id} className="flex flex-col gap-1.5 py-3 md:flex-row md:items-start md:justify-between md:gap-4">
              <div className="flex min-w-0 flex-col gap-1">
                <span className="font-medium break-words text-ink">{i.name}</span>
                <span className="flex flex-wrap gap-2">
                  {isInviteStatus(i.status) ? <StatusBadge look={INVITE_STATUS_LOOK[i.status]} label={t(`inviteStatus.${i.status}`)} className="text-base md:text-sm" /> : null}
                  {i.tags.map((tag) => (
                    <span key={tag} className="text-base text-ink-muted md:text-sm">
                      {tag}
                    </span>
                  ))}
                </span>
                {i.warnings.map((w) => (
                  <span key={w} className="inline-flex items-start gap-1.5 text-base font-medium text-warn md:text-sm">
                    <CircleAlert className="mt-[0.3em] size-4 shrink-0" aria-hidden="true" />
                    <span>{w}</span>
                  </span>
                ))}
              </div>
              {i.status !== 'REMOVED' ? (
                <AlertDialog onOpenChange={() => setReason('')}>
                  <AlertDialogTrigger asChild>
                    <Button variant="outline" className="min-h-11 shrink-0 self-start lg:min-h-10" disabled={pending}>
                      {t('suppliers.uninvite')}
                    </Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>{t('suppliers.uninviteTitle', { name: i.name })}</AlertDialogTitle>
                      <AlertDialogDescription>{t('suppliers.uninviteBody')}</AlertDialogDescription>
                    </AlertDialogHeader>
                    <Label htmlFor={`${id}-reason-${i.id}`}>{t('suppliers.uninviteReason')}</Label>
                    <Textarea id={`${id}-reason-${i.id}`} value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} />
                    <AlertDialogFooter>
                      <AlertDialogCancel>{t('back')}</AlertDialogCancel>
                      <AlertDialogAction disabled={reason.trim().length < 3} onClick={() => void act((key) => uninvite(i.id, reason, key), t('suppliers.uninvited', { name: i.name }))}>
                        {t('suppliers.uninviteConfirm')}
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              ) : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-ink-muted">{t('suppliers.none')}</p>
      )}
      <form
        className="flex flex-col gap-3 border-t border-line pt-4 md:flex-row md:items-end"
        onSubmit={(e) => {
          e.preventDefault()
          if (!supplierId) return setMessage({ tone: 'danger', text: t('suppliers.pickFirst') })
          const name = suppliers.find((s) => s.id === supplierId)?.label ?? ''
          void act((key) => invite({ supplierId }, key), t('suppliers.invited', { name })).then((done) => done && setSupplierId(''))
        }}
      >
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <Label htmlFor={`${id}-supplier`}>{t('suppliers.pick')}</Label>
          <NativeSelect id={`${id}-supplier`} className="min-h-11 w-full lg:min-h-10" value={supplierId} onChange={(e) => setSupplierId(e.target.value)}>
            <NativeSelectOption value="">{t('suppliers.choose')}</NativeSelectOption>
            {same.length ? <optgroup label={t('suppliers.sameCategory')}>{same.map(option)}</optgroup> : null}
            {others.length ? <optgroup label={t('suppliers.otherCategory')}>{others.map(option)}</optgroup> : null}
          </NativeSelect>
        </div>
        <Button type="submit" className="min-h-11 self-start lg:min-h-10 md:self-auto" disabled={pending}>
          {pending ? t('suppliers.inviting') : t('suppliers.invite')}
        </Button>
      </form>
      {applications.length ? (
        <form
          className="flex flex-col gap-3 md:flex-row md:items-end"
          onSubmit={(e) => {
            e.preventDefault()
            if (!applicationId) return setMessage({ tone: 'danger', text: t('suppliers.pickFirst') })
            const name = applications.find((a) => a.id === applicationId)?.label ?? ''
            void act((key) => invite({ applicationId }, key), t('suppliers.invited', { name })).then((done) => done && setApplicationId(''))
          }}
        >
          <div className="flex min-w-0 flex-1 flex-col gap-2">
            <Label htmlFor={`${id}-application`}>{t('suppliers.pickApplication')}</Label>
            <NativeSelect id={`${id}-application`} className="min-h-11 w-full lg:min-h-10" value={applicationId} onChange={(e) => setApplicationId(e.target.value)}>
              <NativeSelectOption value="">{t('suppliers.choose')}</NativeSelectOption>
              {applications.map((a) => (
                <NativeSelectOption key={a.id} value={a.id}>
                  {a.label}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </div>
          <Button type="submit" variant="outline" className="min-h-11 self-start lg:min-h-10 md:self-auto" disabled={pending}>
            {t('suppliers.inviteApplication')}
          </Button>
        </form>
      ) : null}
    </div>
  )
}
