'use client'

import { CircleAlert } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { useId, useState, type FormEvent } from 'react'
import { settle } from '../admin-settings/outcome'
import { Button } from '../form/button'
import { Notice } from '../form/notice'
import { useSubmissionKey } from '../form/submission-key'
import { GrantState, type GrantStateName } from './badges'
import { grantErrorKey, type GrantOutcome } from './outcome'

export type RevokeGrantAction = (grantId: string, idempotencyKey: string) => Promise<GrantOutcome>

export interface GrantRowView {
  readonly id: string
  readonly state: GrantStateName
  readonly stateLabel: string
  /** "IT-OPEX-2569 · ค่าใช้จ่ายดำเนินงาน ฝ่ายไอที" */
  readonly line: string
  /** "งบของฝ่ายไอที" */
  readonly owner: string
  /** "ทั้งฝ่ายจัดซื้อ" or "สมชาย ใจดี (req_con)" */
  readonly grantee: string
  readonly period: string
  readonly granted: string
  readonly revoked: string | null
  readonly revocable: boolean
}

function GrantRow({ row, revoke, onRevoked }: { row: GrantRowView; revoke?: RevokeGrantAction; onRevoked?: (text: string) => void }) {
  return (
    <li className="flex flex-col gap-3 py-4 sm:flex-row sm:items-start sm:justify-between sm:gap-6">
      <div className="flex min-w-0 flex-col gap-1">
        <p className="font-medium break-words">{row.grantee}</p>
        <p className="break-words">{row.line}</p>
        <p className="text-base text-ink-muted md:text-sm">{row.owner}</p>
        <p className="text-base md:text-sm">{row.period}</p>
        <p className="text-base text-ink-muted md:text-sm">{row.granted}</p>
        {row.revoked ? <p className="text-base text-ink-muted md:text-sm">{row.revoked}</p> : null}
      </div>
      <div className="flex shrink-0 flex-col gap-2 sm:max-w-xs sm:items-end">
        <GrantState state={row.state} label={row.stateLabel} className="text-base md:text-sm" />
        {row.revocable && revoke && onRevoked ? <RevokeGrant row={row} revoke={revoke} onRevoked={onRevoked} /> : null}
      </div>
    </li>
  )
}

// Take back a grant that is in force or coming (FR-BUD-004 AC1). New requests then cannot choose the line; requests
// already sent keep what they reserved. It cannot be undone (a new grant must be made), so the first button opens a
// tick box that says what happens; the second, outlined in danger and apart from "keep", takes it back.
function RevokeGrant({ row, revoke, onRevoked }: { row: GrantRowView; revoke: RevokeGrantAction; onRevoked: (text: string) => void }) {
  const t = useTranslations('budgets.grants')
  const id = useId()
  const submission = useSubmissionKey()
  const [open, setOpen] = useState(false)
  const [pending, setPending] = useState(false)
  const [confirmError, setConfirmError] = useState<string | null>(null)
  const [failure, setFailure] = useState<string | null>(null)

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (new FormData(event.currentTarget).get('confirm') !== 'yes') return setConfirmError(t('errors.CONFIRM'))
    setConfirmError(null)
    setFailure(null)
    setPending(true)
    const outcome = await settle(revoke(row.id, submission.key))
    setPending(false)
    // No answer: the same key goes with a retry, so the grant is taken back at most once
    if (!outcome) return setFailure(t('errors.FAILED'))
    submission.next()
    if (outcome.ok) return onRevoked(t('revoked', { line: row.line, grantee: row.grantee }))
    setFailure(t(`errors.${grantErrorKey(outcome)}`, { requestId: outcome.requestId ?? '-' }))
  }

  if (!open) {
    return (
      // Short on screen; screen readers hear whose grant it is (the words shown are part of that name)
      <Button variant="secondary" onClick={() => setOpen(true)} aria-label={t('revoke', { grantee: row.grantee })} className="self-start sm:self-end">
        {t('revokeShort')}
      </Button>
    )
  }
  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-3" noValidate>
      {failure ? <Notice tone="danger">{failure}</Notice> : null}
      <div className="flex flex-col gap-1.5">
        <label className="flex min-h-11 items-start gap-3">
          <input
            type="checkbox"
            name="confirm"
            value="yes"
            aria-invalid={confirmError ? true : undefined}
            aria-describedby={confirmError ? `${id}-error` : undefined}
            onChange={(event) => event.currentTarget.checked && setConfirmError(null)}
            className="mt-1 size-5 shrink-0"
          />
          <span>{t('revokeConfirm')}</span>
        </label>
        {confirmError ? (
          <p id={`${id}-error`} className="flex items-start gap-1.5 text-base text-danger md:text-sm">
            <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            <span>{confirmError}</span>
          </p>
        ) : null}
      </div>
      <div className="flex flex-wrap gap-x-6 gap-y-3">
        <Button type="submit" variant="danger" disabled={pending}>
          {t('revokeSubmit')}
        </Button>
        <Button type="button" variant="secondary" onClick={() => setOpen(false)}>
          {t('keep')}
        </Button>
      </div>
    </form>
  )
}

// The grants of the organization: in force and coming (each can be taken back), then those that ended or were taken
// back. The confirmation of a revoke stays at the top of the list, since the grant itself moves to the ended list.
export function GrantLists({ current, past, revoke }: { current: readonly GrantRowView[]; past: readonly GrantRowView[]; revoke: RevokeGrantAction }) {
  const t = useTranslations('budgets.grants')
  const [done, setDone] = useState<string | null>(null)
  return (
    <div className="flex flex-col gap-8">
      <section aria-labelledby="grants-current" className="flex flex-col gap-4">
        <h2 id="grants-current" className="text-xl font-semibold">
          {t('currentTitle')}
        </h2>
        {done ? <Notice tone="success">{done}</Notice> : null}
        {current.length === 0 ? (
          <p className="text-ink-muted">{t('currentEmpty')}</p>
        ) : (
          <ul aria-labelledby="grants-current" className="flex flex-col divide-y divide-line border-y border-line">
            {current.map((row) => (
              <GrantRow key={row.id} row={row} revoke={revoke} onRevoked={setDone} />
            ))}
          </ul>
        )}
      </section>
      <section aria-labelledby="grants-past" className="flex flex-col gap-4 border-t border-line pt-6">
        <h2 id="grants-past" className="text-xl font-semibold">
          {t('pastTitle')}
        </h2>
        {past.length === 0 ? (
          <p className="text-ink-muted">{t('pastEmpty')}</p>
        ) : (
          <ul aria-labelledby="grants-past" className="flex flex-col divide-y divide-line border-y border-line">
            {past.map((row) => (
              <GrantRow key={row.id} row={row} />
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}
