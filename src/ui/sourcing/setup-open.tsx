'use client'

import { CircleAlert, CircleCheck } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { useId, useState } from 'react'
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
import { Textarea } from '../shadcn/textarea'
import type { RfxOutcome } from './setup-model'
import { useRfxAct } from './use-rfx-act'

// Step "ตรวจและเปิด" of /sourcing/[id]/edit (S10-12 · BR-RFX-01 02 09 · BR-SOD-14): what the opening checks, each item
// with an icon and its words (never colour alone) — lines, invites against the minimum, the scorecard and its
// evaluators, the close at or after the earliest — and a reason when fewer suppliers are invited than the minimum
// (the approver of the award sees it). "เปิด RFx" is asked first: it numbers the RFx, locks the scorecard and e-mails
// every invite their link; it cannot be undone. rfx.open checks everything again.

export interface OpenCheck {
  readonly ok: boolean
  readonly text: string
}

export function SetupOpen({
  checks,
  needsReason,
  ready,
  closesText,
  open,
  detailHref,
}: {
  readonly checks: readonly OpenCheck[]
  /** Fewer invites than the minimum: a reason is asked (FEWER_INVITES_REASON) */
  readonly needsReason: boolean
  /** Every check passes but the reason */
  readonly ready: boolean
  readonly closesText: string | null
  readonly open: (fewerInvitesReason: string, key: string) => Promise<RfxOutcome>
  readonly detailHref: string
}) {
  const t = useTranslations('sourcing.setup')
  const id = useId()
  const { act, pending, message, router } = useRfxAct()
  const [reason, setReason] = useState('')
  const blocked = !ready || (needsReason && reason.trim().length < 3)

  return (
    <div className="flex flex-col gap-4">
      {message ? <Notice tone={message.tone}>{message.text}</Notice> : null}
      <ul aria-label={t('review.checks')} className="flex flex-col gap-2">
        {checks.map((c) => (
          <li key={c.text} className={`inline-flex items-start gap-2 ${c.ok ? 'text-ink' : 'font-medium text-warn'}`}>
            {c.ok ? <CircleCheck className="mt-[0.3em] size-4 shrink-0 text-primary" aria-hidden="true" /> : <CircleAlert className="mt-[0.3em] size-4 shrink-0" aria-hidden="true" />}
            <span>
              <span className="sr-only">{c.ok ? t('review.ok') : t('review.missing')}: </span>
              {c.text}
            </span>
          </li>
        ))}
      </ul>
      {needsReason ? (
        <div className="flex flex-col gap-2">
          <Label htmlFor={`${id}-reason`}>{t('review.fewerReason')}</Label>
          <Textarea id={`${id}-reason`} value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} aria-describedby={`${id}-reason-hint`} />
          <p id={`${id}-reason-hint`} className="text-base text-ink-muted md:text-sm">
            {t('review.fewerReasonHint')}
          </p>
        </div>
      ) : null}
      <AlertDialog>
        <AlertDialogTrigger asChild>
          <Button className="min-h-11 self-start lg:min-h-10" disabled={pending || blocked}>
            {pending ? t('review.opening') : t('review.open')}
          </Button>
        </AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('review.openTitle')}</AlertDialogTitle>
            <AlertDialogDescription>{t('review.openBody', { closes: closesText ?? '-' })}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('back')}</AlertDialogCancel>
            <AlertDialogAction onClick={() => void act((key) => open(reason, key), null, () => router.push(detailHref))}>{t('review.openConfirm')}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
