'use client'

import { useTranslations } from 'next-intl'
import { lazy, Suspense, useState } from 'react'
import type { ActionOutcome } from '../../tasks/outcome'
import { LiffNotice } from '../notice'

// Cancelling a request from LINE (FR-INT-009 AC1: on every channel; the budget it reserved goes back at once): behind a
// disclosure at the end of the request's LIFF page, as on the web, with a reason and a tick first because it cannot be
// undone (§9.9). The form loads only when the requester opens the disclosure, so the page carries none of it
// otherwise (§9.4: the first JavaScript of a LIFF page); once the request is cancelled the confirmation stays after the
// page refreshes to the new state. The service checks the requester and the state again.

const CancelForm = lazy(() => import('./cancel-form').then((m) => ({ default: m.LiffCancelForm })))

export interface LiffCancelProps {
  readonly requestId: string
  /** The request can be cancelled now (the page's read model; the service decides) */
  readonly canCancel: boolean
  readonly cancel: (input: { requestId: string; reason: string }, idempotencyKey: string) => Promise<ActionOutcome>
}

export function LiffCancelRequest({ requestId, canCancel, cancel }: LiffCancelProps) {
  const t = useTranslations('requestView.actions')
  const [open, setOpen] = useState(false)
  const [done, setDone] = useState(false)
  if (done) return <LiffNotice tone="success">{t('cancelled')}</LiffNotice>
  if (!canCancel) return null
  return (
    <details className="border-t border-line pt-5" onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary className="inline-flex min-h-11 cursor-pointer items-center font-medium text-danger underline underline-offset-4 hover:no-underline">{t('cancelTitle')}</summary>
      {open ? (
        <Suspense fallback={null}>
          <CancelForm requestId={requestId} cancel={cancel} onDone={() => setDone(true)} />
        </Suspense>
      ) : null}
    </details>
  )
}
