'use client'

import { useState } from 'react'
import { Notice } from '../form/notice'
import type { RiskAdminOutcome } from '../risk-admin/model'
import { useFailureText, useRun } from '../risk-admin/run'
import { useSay } from '../risk-admin/say'
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

// The requester's buttons on /risk/overrides/[id] (S11-08 · BR-RSK-10): send it to its approvers under DOA RISK_OVERRIDE
// (a draft, or after a return), and cancel it with a confirmation (AlertDialog). The commands check that the reader asked
// for it, its state and its terms again; a refusal is said in words next to the buttons.

export interface OverrideActions {
  readonly submit: (expectedVersion: number, key: string) => Promise<RiskAdminOutcome>
  readonly cancel: (expectedVersion: number, key: string) => Promise<RiskAdminOutcome>
}

export function OverrideButtons({ version, actions }: { version: number; actions: OverrideActions }) {
  const t = useSay('risk.override.detail')
  const failureText = useFailureText()
  const working = useRun()
  const [message, setMessage] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null)

  async function act(call: (key: string) => Promise<RiskAdminOutcome>, done: string) {
    setMessage(null)
    const outcome = await working.run(call)
    setMessage(outcome.ok ? { tone: 'success', text: done } : { tone: 'danger', text: failureText(outcome) })
  }

  return (
    <div className="flex flex-col gap-3">
      {message ? <Notice tone={message.tone}>{message.text}</Notice> : null}
      <div className="flex flex-wrap gap-2">
        <Button className="min-h-11 lg:min-h-10" disabled={working.pending} onClick={() => void act((key) => actions.submit(version, key), t('sent'))}>
          {working.pending ? t('working') : t('submit')}
        </Button>
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button variant="outline" className="min-h-11 lg:min-h-10" disabled={working.pending}>
              {t('cancel')}
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{t('cancelTitle')}</AlertDialogTitle>
              <AlertDialogDescription>{t('cancelBody')}</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel className="min-h-11 lg:min-h-10">{t('keep')}</AlertDialogCancel>
              <AlertDialogAction className="min-h-11 lg:min-h-10" onClick={() => void act((key) => actions.cancel(version, key), t('cancelled'))}>
                {t('cancelConfirm')}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    </div>
  )
}
