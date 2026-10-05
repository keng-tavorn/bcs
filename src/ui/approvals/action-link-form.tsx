'use client'

import Link from 'next/link'
import { useLocale, useTranslations } from 'next-intl'
import { useState, type FormEvent } from 'react'
import { Button } from '../form/button'
import { Notice } from '../form/notice'
import { useSubmissionKey } from '../form/submission-key'
import { formatDateTime } from '../format'
import type { ActionLinkFailure, ActionLinkOutcome } from './action-link-outcome'

// Deciding from an e-mail link (BR-TOK-03, FR-NOTI-002 AC2): the page is the confirmation — nothing is decided until
// one of these buttons is pressed. Not approving asks for a reason first. The outcome replaces the form; a task decided
// already — with this link or anywhere else, by this member or by the other approver of its step — says when and, to
// the member signed in as the link's, by whom (§9.3 "ดำเนินการแล้วโดย … เมื่อ …", FR-DOA-004 AC2), and offers the
// task in BCS instead of buttons that would only be refused again. What the server action answers, and what it tells
// whom, is src/ui/approvals/action-link-outcome.ts.

/** What went wrong, in words that say what to do next (§9.9 rule 7) */
export function LinkRefusal({ failure }: { failure: ActionLinkFailure }) {
  const t = useTranslations('actionLink')
  const locale = useLocale()
  function text(): string {
    switch (failure.code) {
      case 'TOKEN_USED':
        if (!failure.time) return t('usedBody')
        return failure.name ? t('usedBy', { name: failure.name, time: formatDateTime(locale, failure.time) }) : t('usedAt', { time: formatDateTime(locale, failure.time) })
      case 'TOKEN_EXPIRED':
        return t('expiredBody')
      case 'TOKEN_INVALID':
        return t('invalidBody')
      case 'STEP_UP_REQUIRED':
        return t('workspaceOnly')
      case 'INVALID_STATE_TRANSITION':
        return t('closedBody')
      case 'UNAUTHENTICATED':
        return t('signIn')
      case 'SOD_VIOLATION':
        return t('sod')
      default:
        return t('failed')
    }
  }
  return <Notice tone="danger">{text()}</Notice>
}

export interface ActionLinkFormProps {
  readonly link: string
  readonly csrf: string
  readonly actions: readonly string[]
  readonly workspaceHref: string
  readonly decide: (input: { link: string; csrf: string; decision: 'APPROVE' | 'REJECT'; reason: string; idempotencyKey: string }) => Promise<ActionLinkOutcome>
}

const MIN_REASON = 3

export function ActionLinkForm({ link, csrf, actions, workspaceHref, decide }: ActionLinkFormProps) {
  const t = useTranslations('actionLink')
  const submission = useSubmissionKey()
  const [rejecting, setRejecting] = useState(false)
  const [reason, setReason] = useState('')
  const [reasonError, setReasonError] = useState(false)
  const [pending, setPending] = useState(false)
  const [outcome, setOutcome] = useState<ActionLinkOutcome | null>(null)

  async function submit(decision: 'APPROVE' | 'REJECT') {
    setPending(true)
    const result = await decide({ link, csrf, decision, reason: decision === 'REJECT' ? reason.trim() : '', idempotencyKey: submission.key })
    submission.next()
    setPending(false)
    setOutcome(result)
  }

  function onReject(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (reason.trim().length < MIN_REASON) return setReasonError(true)
    setReasonError(false)
    void submit('REJECT')
  }

  const workspace = (
    <Link href={workspaceHref} className="self-start font-medium text-primary underline underline-offset-4 hover:no-underline">
      {t('openWorkspace')}
    </Link>
  )

  if (outcome?.ok) {
    return (
      <div className="flex flex-col gap-4">
        <Notice tone="success">
          <p className="font-medium">{outcome.decision === 'APPROVE' ? t('approvedTitle') : t('rejectedTitle')}</p>
          <p>{t('doneBody')}</p>
        </Notice>
        {workspace}
      </div>
    )
  }

  const failure = outcome && !outcome.ok ? outcome : null

  // Decided already: who and when, and the task in BCS — pressing again would only be refused again
  if (failure?.code === 'TOKEN_USED') {
    return (
      <div className="flex flex-col gap-4">
        <LinkRefusal failure={failure} />
        {workspace}
      </div>
    )
  }

  if (rejecting) {
    return (
      <form onSubmit={onReject} className="flex flex-col gap-4" noValidate>
        {failure ? <LinkRefusal failure={failure} /> : null}
        <div className="flex flex-col gap-1.5">
          <label htmlFor="reason" className="font-medium text-ink">
            {t('reason')}
          </label>
          <textarea
            id="reason"
            name="reason"
            rows={3}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            aria-invalid={reasonError ? true : undefined}
            aria-describedby={reasonError ? 'reason-hint reason-error' : 'reason-hint'}
            className="w-full rounded-md border border-input bg-bg px-3 py-2 text-base text-ink aria-[invalid=true]:border-danger"
          />
          <p id="reason-hint" className="text-base text-ink-muted md:text-sm">
            {t('reasonHint')}
          </p>
          {reasonError ? (
            <p id="reason-error" className="text-base text-danger md:text-sm">
              {t('reasonTooShort')}
            </p>
          ) : null}
        </div>
        <div className="flex flex-col gap-3 sm:flex-row">
          <Button type="submit" variant="danger" disabled={pending}>
            {pending ? t('submitting') : t('confirmReject')}
          </Button>
          <Button variant="secondary" disabled={pending} onClick={() => setRejecting(false)}>
            {t('back')}
          </Button>
        </div>
      </form>
    )
  }

  return (
    <div className="flex flex-col gap-4">
      {failure ? <LinkRefusal failure={failure} /> : null}
      <div className="flex flex-col gap-3 sm:flex-row">
        {actions.includes('APPROVE') ? (
          <Button disabled={pending} onClick={() => void submit('APPROVE')}>
            {pending ? t('submitting') : t('approve')}
          </Button>
        ) : null}
        {actions.includes('REJECT') ? (
          <Button variant="secondary" disabled={pending} onClick={() => setRejecting(true)}>
            {t('reject')}
          </Button>
        ) : null}
      </div>
      {workspace}
    </div>
  )
}
