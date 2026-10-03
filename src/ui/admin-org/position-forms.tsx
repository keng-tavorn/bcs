'use client'

import { useLocale, useTranslations } from 'next-intl'
import { useId, useState, type FormEvent } from 'react'
import { Button } from '../form/button'
import { Notice } from '../form/notice'
import { ORG_REASONS, type OrgActionResult, type ParentOption } from './department-forms'
import { departmentOption, memberLabel, nameIn, type Named } from './names'
import { failureKey } from './outcome'
import { SelectField } from './select-field'
import { errorValues, useAction } from './use-action'

// Holders of a position that carries no authority (FR-ADM-002 AC2): assigned or ended at once. A position a DOA names,
// or that open approval tasks came from, is refused by the service (USE_ORG_AUTHORITY_CHANGE) and the page offers a
// proposal instead. Ending a term takes effect for a real person at once, so it asks for a second click that says so
// (§9.9). One result line for the whole position, so it stays when the holder it is about leaves the list.

export type AssignHolderAction = (input: { positionCode: string; departmentId: string; memberId: string }, idempotencyKey: string) => Promise<OrgActionResult>
export type EndHolderAction = (input: { positionCode: string; departmentId: string }, idempotencyKey: string) => Promise<OrgActionResult>

type Status = { tone: 'success' | 'danger'; text: string } | null

export interface MemberOption extends Named {
  readonly id: string
  readonly employeeCode: string | null
}

export interface HolderRow {
  readonly departmentId: string
  /** The department's name and the holder's name in the reader's language */
  readonly department: string
  readonly name: string
  /** "ดำรงตำแหน่งตั้งแต่ …" already formatted */
  readonly since: string
}

export interface PositionHoldersProps {
  readonly position: { readonly code: string; readonly name: string; readonly scope: 'DEPARTMENT' | 'ORG' }
  readonly holders: readonly HolderRow[]
  readonly departments: ReadonlyArray<ParentOption & { readonly root: boolean }>
  readonly members: readonly MemberOption[]
  readonly assign: AssignHolderAction
  readonly end: EndHolderAction
}

export function PositionHolders({ position, holders, departments, members, assign, end }: PositionHoldersProps) {
  const t = useTranslations('adminOrg')
  const locale = useLocale()
  const id = useId()
  const action = useAction()
  const [status, setStatus] = useState<Status>(null)
  const [confirming, setConfirming] = useState<string | null>(null)
  const [errors, setErrors] = useState<{ departmentId?: string; memberId?: string }>({})
  const root = departments.find((d) => d.root)

  async function onAssign(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    const input = {
      positionCode: position.code,
      departmentId: position.scope === 'ORG' ? (root?.id ?? '') : String(form.get('departmentId') ?? ''),
      memberId: String(form.get('memberId') ?? ''),
    }
    const next: typeof errors = {}
    if (!input.departmentId) next.departmentId = t('errors.DEPARTMENT')
    if (!input.memberId) next.memberId = t('errors.MEMBER')
    setErrors(next)
    setStatus(null)
    setConfirming(null)
    if (next.departmentId || next.memberId) return
    const outcome = await action.run((key) => assign(input, key))
    const member = members.find((m) => m.id === input.memberId)
    if (outcome.ok) {
      setStatus({ tone: 'success', text: t('positions.assigned', { name: member ? nameIn(locale, member) : '', position: position.name }) })
      action.done()
      return
    }
    if (outcome.reason === 'MEMBER') return setErrors({ memberId: t('errors.MEMBER') })
    setStatus({ tone: 'danger', text: t(`errors.${failureKey(outcome, ORG_REASONS)}`, errorValues(outcome)) })
  }

  async function onEnd(holder: HolderRow) {
    setStatus(null)
    const outcome = await action.run((key) => end({ positionCode: position.code, departmentId: holder.departmentId }, key))
    setConfirming(null)
    if (outcome.ok) {
      setStatus({ tone: 'success', text: t('positions.ended', { name: holder.name }) })
      action.done()
      return
    }
    setStatus({ tone: 'danger', text: t(`errors.${failureKey(outcome, ORG_REASONS)}`, errorValues(outcome)) })
  }

  return (
    <div className="flex flex-col gap-4">
      {status ? <Notice tone={status.tone}>{status.text}</Notice> : null}
      {holders.length === 0 ? (
        <p className="border-y border-line py-3 text-ink-muted">{t('positions.vacant')}</p>
      ) : (
        <ul className="flex flex-col divide-y divide-line border-y border-line">
          {holders.map((h) => (
            <li key={h.departmentId} className="flex flex-col gap-2 py-3">
              <div className="flex flex-col gap-0.5">
                <p className="font-medium">{t('positions.holderLine', { name: h.name, department: h.department })}</p>
                <p className="text-base text-ink-muted md:text-sm">{h.since}</p>
              </div>
              {confirming === h.departmentId ? (
                <div className="flex flex-col gap-3 border-l-4 border-danger pl-3">
                  <p>{t('positions.endConfirmText', { name: h.name })}</p>
                  <div className="flex flex-wrap gap-3">
                    <Button variant="danger" disabled={action.pending} onClick={() => onEnd(h)}>
                      {action.pending ? t('saving') : t('positions.endConfirm', { name: h.name })}
                    </Button>
                    <Button variant="secondary" onClick={() => setConfirming(null)}>
                      {t('cancel')}
                    </Button>
                  </div>
                </div>
              ) : (
                <Button
                  variant="secondary"
                  className="self-start"
                  onClick={() => {
                    setStatus(null)
                    setConfirming(h.departmentId)
                  }}
                >
                  {t('positions.end', { name: h.name })}
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}

      <form onSubmit={onAssign} className="flex flex-col gap-4" noValidate aria-labelledby={`${id}-title`}>
        <h3 id={`${id}-title`} className="text-lg font-semibold">
          {t('positions.assignTitle', { position: position.name })}
        </h3>
        {position.scope === 'ORG' ? (
          <p className="text-ink-muted">{t('positions.rootOnly', { name: root ? nameIn(locale, root) : '' })}</p>
        ) : (
          <SelectField
            id={`${id}-department`}
            name="departmentId"
            required
            label={t('positions.department')}
            placeholder={t('choose')}
            options={departments.map((d) => ({ value: d.id, label: departmentOption(locale, d) }))}
            error={errors.departmentId}
          />
        )}
        <SelectField
          id={`${id}-member`}
          name="memberId"
          required
          label={t('positions.member')}
          placeholder={t('choose')}
          hint={t('positions.replaceHint')}
          options={members.map((m) => ({ value: m.id, label: memberLabel(locale, m) }))}
          error={errors.memberId}
        />
        <Button type="submit" disabled={action.pending} className="self-start">
          {action.pending ? t('saving') : t('positions.assignSubmit')}
        </Button>
      </form>
    </div>
  )
}
