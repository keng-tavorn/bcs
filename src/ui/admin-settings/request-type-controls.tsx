'use client'

import { useTranslations } from 'next-intl'
import { useState } from 'react'
import { Button } from '../form/button'
import { Notice } from '../form/notice'
import { useSubmissionKey } from '../form/submission-key'
import { commonErrorKey, settle, type SettingsOutcome } from './outcome'

export type MoveRequestTypeAction = (code: string, direction: 'UP' | 'DOWN', idempotencyKey: string) => Promise<SettingsOutcome>
export type SetRequestTypeActiveAction = (code: string, active: boolean, idempotencyKey: string) => Promise<SettingsOutcome>

const OWN_ERRORS = ['AT_EDGE', 'NO_PUBLISHED_FORM', 'NO_CHANGE'] as const

// The catalog place and on/off switch of one request type (FR-ADM-005 AC2). Moving and switching are undone from this
// same row, so they need no confirmation; the result line says what requesters will see. The button text names the
// action and, for screen readers, the type.
export function RequestTypeControls({
  code,
  name,
  active,
  first,
  last,
  move,
  setActive,
}: {
  code: string
  name: string
  active: boolean
  first: boolean
  last: boolean
  move: MoveRequestTypeAction
  setActive: SetRequestTypeActiveAction
}) {
  const t = useTranslations('adminSettings.requestTypes')
  const tCommon = useTranslations('adminSettings')
  const submission = useSubmissionKey()
  const [pending, setPending] = useState(false)
  const [status, setStatus] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null)

  async function run(call: (idempotencyKey: string) => Promise<SettingsOutcome>, success: string) {
    setPending(true)
    setStatus(null)
    const outcome = await settle(call(submission.key))
    setPending(false)
    // No answer: the same key goes with a retry, so the change runs at most once
    if (!outcome) return setStatus({ tone: 'danger', text: tCommon('errors.FAILED') })
    submission.next()
    if (outcome.ok) return setStatus({ tone: 'success', text: success })
    const own = OWN_ERRORS.find((r) => r === outcome.reason)
    setStatus({ tone: 'danger', text: own ? t(`errors.${own}`) : tCommon(`errors.${commonErrorKey(outcome)}`, { requestId: outcome.requestId ?? '-' }) })
  }

  return (
    <div className="flex flex-col gap-2 md:max-w-sm md:items-end">
      {status ? <Notice tone={status.tone}>{status.text}</Notice> : null}
      <div className="flex flex-wrap gap-2 md:justify-end">
        <Button variant="secondary" disabled={pending || first} onClick={() => run((key) => move(code, 'UP', key), t('moved', { name }))}>
          {t('moveUp')}
          <span className="sr-only"> {name}</span>
        </Button>
        <Button variant="secondary" disabled={pending || last} onClick={() => run((key) => move(code, 'DOWN', key), t('moved', { name }))}>
          {t('moveDown')}
          <span className="sr-only"> {name}</span>
        </Button>
        {/* Switching off is undone from this row, so it is not styled as something lost; switching on is the call to act.
            Each has its own key: a new button, not one that fades from one look to the other */}
        {active ? (
          <Button key="off" variant="secondary" disabled={pending} onClick={() => run((key) => setActive(code, false, key), t('switchedOff', { name }))}>
            {t('switchOff')}
            <span className="sr-only"> {name}</span>
          </Button>
        ) : (
          <Button key="on" disabled={pending} onClick={() => run((key) => setActive(code, true, key), t('switchedOn', { name }))}>
            {t('switchOn')}
            <span className="sr-only"> {name}</span>
          </Button>
        )}
      </div>
    </div>
  )
}
