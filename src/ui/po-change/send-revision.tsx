'use client'

import { useTranslations } from 'next-intl'
import { useId, useState } from 'react'
import { Button } from '../form/button'
import { Notice } from '../form/notice'
import { useOutcomeAction } from '../procurement/use-outcome-action'
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '../shadcn/alert-dialog'
import { Refusal } from './failure'
import { PO_S8_NO_ANSWER, type PoS8Outcome } from './outcome'

// "ส่งฉบับแก้ไขให้ผู้ขาย" (FR-AP-107 AC3, po.sendRevision): the latest approved revision of the PO is e-mailed to the
// supplier with its PDF. An e-mail cannot be called back, so the button asks first (§9.9: nothing irreversible without
// a confirmation) in the same words; the result is said where the button was.

export function SendRevision({ poId, revisionNo, send }: { poId: string; revisionNo: number; send: (poId: string, idempotencyKey: string) => Promise<PoS8Outcome> }) {
  const t = useTranslations('poChange.sendRevision')
  const id = useId()
  const [asking, setAsking] = useState(false)
  const action = useOutcomeAction<PoS8Outcome>(PO_S8_NO_ANSWER)
  const outcome = action.outcome
  return (
    <section aria-labelledby={`${id}-title`} className="flex flex-col gap-3">
      <h3 id={`${id}-title`} className="font-semibold text-ink">
        {t('title')}
      </h3>
      <p className="text-ink">{t('body', { no: revisionNo })}</p>
      {outcome && !outcome.ok ? <Refusal failure={outcome} /> : null}
      {outcome?.ok ? <Notice tone="success">{t('done')}</Notice> : null}
      <Button className="self-start" disabled={action.pending} onClick={() => setAsking(true)}>
        {action.pending ? t('working') : t('button')}
      </Button>
      <AlertDialog open={asking} onOpenChange={setAsking}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('confirmTitle', { no: revisionNo })}</AlertDialogTitle>
            <AlertDialogDescription>{t('confirmBody')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="min-h-11 text-base">{t('keep')}</AlertDialogCancel>
            <AlertDialogAction className="min-h-11 text-base" onClick={() => void action.run((key) => send(poId, key))}>
              {t('confirm')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  )
}
