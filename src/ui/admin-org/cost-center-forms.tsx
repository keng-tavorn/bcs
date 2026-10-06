'use client'

import { useLocale, useTranslations } from 'next-intl'
import { useId, useRef, useState, type FormEvent } from 'react'
import { Button } from '../form/button'
import { Field } from '../form/field'
import { Notice } from '../form/notice'
import { ORG_REASONS, type OrgActionResult, type ParentOption } from './department-forms'
import { departmentOption } from './names'
import { failureKey } from './outcome'
import { SelectField } from './select-field'
import { errorValues, useAction } from './use-action'

// Cost centers of /admin/org/cost-centers (FR-ADM-002 AC1, ADR-042 item 5): add one to a department, rename it, switch
// it off and on again. A cost center keeps its department: choosing the wrong one means switching it off and adding
// a new one. Switching off can be undone from the same list, so it needs no extra confirmation.

export type CreateCostCenterAction = (input: { code: string; nameTh: string; departmentId: string }, idempotencyKey: string) => Promise<OrgActionResult>
export type UpdateCostCenterAction = (input: { costCenterId: string; nameTh?: string; active?: boolean }, idempotencyKey: string) => Promise<OrgActionResult>

const CODE = /^[A-Z0-9][A-Z0-9_-]{0,39}$/

type Status = { tone: 'success' | 'danger'; text: string } | null

export function CreateCostCenterForm({ departments, create }: { departments: readonly ParentOption[]; create: CreateCostCenterAction }) {
  const t = useTranslations('adminOrg')
  const locale = useLocale()
  const formRef = useRef<HTMLFormElement>(null)
  const action = useAction()
  const [status, setStatus] = useState<Status>(null)
  const [errors, setErrors] = useState<{ code?: string; nameTh?: string; departmentId?: string }>({})

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    const input = {
      code: String(form.get('code') ?? '')
        .trim()
        .toUpperCase(),
      nameTh: String(form.get('nameTh') ?? '').trim(),
      departmentId: String(form.get('departmentId') ?? ''),
    }
    const next: typeof errors = {}
    if (!CODE.test(input.code)) next.code = t('errors.CODE')
    if (!input.nameTh) next.nameTh = t('errors.NAME')
    if (!input.departmentId) next.departmentId = t('errors.DEPARTMENT')
    setErrors(next)
    setStatus(null)
    if (next.code || next.nameTh || next.departmentId) return
    const outcome = await action.run((key) => create(input, key))
    if (outcome.ok) {
      setStatus({ tone: 'success', text: t('costCenters.created', { code: input.code }) })
      formRef.current?.reset()
      action.done()
      return
    }
    if (outcome.reason === 'CODE_EXISTS') return setErrors({ code: t('errors.CODE_EXISTS') })
    if (outcome.field === 'code') return setErrors({ code: t('errors.CODE') })
    if (outcome.field === 'nameTh') return setErrors({ nameTh: t('errors.NAME') })
    if (outcome.field === 'departmentId') return setErrors({ departmentId: t('errors.DEPARTMENT') })
    setStatus({ tone: 'danger', text: t(`errors.${failureKey(outcome, ORG_REASONS)}`, errorValues(outcome)) })
  }

  return (
    <form ref={formRef} onSubmit={onSubmit} className="flex flex-col gap-5" noValidate>
      {status ? <Notice tone={status.tone}>{status.text}</Notice> : null}
      <Field id="cost-center-code" name="code" required autoComplete="off" label={t('costCenters.codeLabel')} hint={t('costCenters.codeHint')} error={errors.code} />
      <Field id="cost-center-name" name="nameTh" required label={t('costCenters.nameTh')} error={errors.nameTh} />
      <SelectField
        id="cost-center-department"
        name="departmentId"
        required
        label={t('costCenters.departmentLabel')}
        placeholder={t('choose')}
        options={departments.map((d) => ({ value: d.id, label: departmentOption(locale, d) }))}
        error={errors.departmentId}
      />
      <Button type="submit" disabled={action.pending} className="self-start">
        {action.pending ? t('saving') : t('costCenters.createSubmit')}
      </Button>
    </form>
  )
}

export interface CostCenterRowProps {
  readonly costCenter: { readonly id: string; readonly code: string; readonly nameTh: string; readonly active: boolean }
  readonly update: UpdateCostCenterAction
}

/** Rename in place, or switch off / on again. */
export function CostCenterRowActions({ costCenter, update }: CostCenterRowProps) {
  const t = useTranslations('adminOrg')
  const id = useId()
  const action = useAction()
  const [open, setOpen] = useState(false)
  const [status, setStatus] = useState<Status>(null)
  const [nameError, setNameError] = useState<string | undefined>()

  async function send(input: { nameTh?: string; active?: boolean }, success: string) {
    setStatus(null)
    const outcome = await action.run((key) => update({ costCenterId: costCenter.id, ...input }, key))
    if (outcome.ok) {
      setOpen(false)
      setStatus({ tone: 'success', text: success })
      action.done()
      return
    }
    if (outcome.field === 'nameTh') return setNameError(t('errors.NAME'))
    setStatus({ tone: 'danger', text: t(`errors.${failureKey(outcome, ORG_REASONS)}`, errorValues(outcome)) })
  }

  async function onRename(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const nameTh = String(new FormData(event.currentTarget).get('nameTh') ?? '').trim()
    if (!nameTh) return setNameError(t('errors.NAME'))
    setNameError(undefined)
    await send({ nameTh }, t('costCenters.renamed', { code: costCenter.code }))
  }

  return (
    <div className="flex flex-col gap-3">
      {status ? <Notice tone={status.tone}>{status.text}</Notice> : null}
      {open ? (
        <form onSubmit={onRename} className="flex flex-col gap-4 border-l-4 border-line pl-3" noValidate>
          <Field id={`${id}-name`} name="nameTh" required defaultValue={costCenter.nameTh} label={t('costCenters.nameTh')} error={nameError} />
          <div className="flex flex-wrap gap-3">
            <Button type="submit" disabled={action.pending}>
              {action.pending ? t('saving') : t('saveName')}
            </Button>
            <Button type="button" variant="secondary" onClick={() => setOpen(false)}>
              {t('cancel')}
            </Button>
          </div>
        </form>
      ) : (
        <div className="flex flex-wrap items-center gap-x-6 gap-y-1">
          <Button
            variant="link"
            className="min-h-11"
            onClick={() => {
              setStatus(null)
              setOpen(true)
            }}
          >
            {t('rename')}
            <span className="sr-only"> {costCenter.code}</span>
          </Button>
          {costCenter.active ? (
            <Button variant="secondary" disabled={action.pending} onClick={() => send({ active: false }, t('costCenters.deactivated', { code: costCenter.code }))}>
              {t('costCenters.deactivate', { code: costCenter.code })}
            </Button>
          ) : (
            <Button variant="secondary" disabled={action.pending} onClick={() => send({ active: true }, t('costCenters.reactivated', { code: costCenter.code }))}>
              {t('costCenters.reactivate', { code: costCenter.code })}
            </Button>
          )}
        </div>
      )}
    </div>
  )
}
