'use client'

import Link from 'next/link'
import { useLocale, useTranslations } from 'next-intl'
import { useId, useRef, useState, type FormEvent } from 'react'
import { Button } from '../form/button'
import { Field } from '../form/field'
import { Notice } from '../form/notice'
import { departmentOption } from './names'
import { failureKey, type ActionFailure } from './outcome'
import { SelectField } from './select-field'
import { errorValues, useAction } from './use-action'

// Departments of /admin/org (FR-ADM-002 AC1): add a department under another, rename one. Both change at once with
// admin.orgStructure.editBasic; moving a department goes through an authority change (link), never from here.

export type OrgActionResult = { readonly ok: true } | ActionFailure
export type CreateDepartmentAction = (input: { code: string; nameTh: string; nameEn: string; parentId: string; kind: string }, idempotencyKey: string) => Promise<OrgActionResult>
export type RenameDepartmentAction = (input: { departmentId: string; nameTh: string; nameEn: string }, idempotencyKey: string) => Promise<OrgActionResult>

export const ORG_REASONS = ['CODE_EXISTS', 'NO_CHANGE', 'VACANT', 'ORG_POSITION', 'DEPARTMENT', 'MEMBER', 'POSITION', 'USE_ORG_AUTHORITY_CHANGE'] as const

const CODE = /^[A-Z0-9][A-Z0-9_-]{0,39}$/
const KINDS = ['DIVISION', 'DEPARTMENT', 'SECTION'] as const

type Status = { tone: 'success' | 'danger'; text: string } | null

export interface ParentOption {
  readonly id: string
  readonly code: string
  readonly nameTh: string
  readonly nameEn: string | null
  readonly depth: number
}

export function CreateDepartmentForm({ parents, create }: { parents: readonly ParentOption[]; create: CreateDepartmentAction }) {
  const t = useTranslations('adminOrg')
  const locale = useLocale()
  const formRef = useRef<HTMLFormElement>(null)
  const action = useAction()
  const [status, setStatus] = useState<Status>(null)
  const [errors, setErrors] = useState<{ code?: string; nameTh?: string; parentId?: string }>({})

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    const input = {
      code: String(form.get('code') ?? '')
        .trim()
        .toUpperCase(),
      nameTh: String(form.get('nameTh') ?? '').trim(),
      nameEn: String(form.get('nameEn') ?? '').trim(),
      parentId: String(form.get('parentId') ?? ''),
      kind: String(form.get('kind') ?? 'DEPARTMENT'),
    }
    const next: typeof errors = {}
    if (!CODE.test(input.code)) next.code = t('errors.CODE')
    if (!input.nameTh) next.nameTh = t('errors.NAME')
    if (!input.parentId) next.parentId = t('errors.PARENT')
    setErrors(next)
    setStatus(null)
    if (next.code || next.nameTh || next.parentId) return
    const outcome = await action.run((key) => create(input, key))
    if (outcome.ok) {
      setStatus({ tone: 'success', text: t('departments.created', { code: input.code }) })
      formRef.current?.reset()
      action.done()
      return
    }
    if (outcome.reason === 'CODE_EXISTS') return setErrors({ code: t('errors.CODE_EXISTS') })
    if (outcome.field === 'code') return setErrors({ code: t('errors.CODE') })
    if (outcome.field === 'nameTh') return setErrors({ nameTh: t('errors.NAME') })
    if (outcome.field === 'parentId') return setErrors({ parentId: t('errors.PARENT') })
    setStatus({ tone: 'danger', text: t(`errors.${failureKey(outcome, ORG_REASONS)}`, errorValues(outcome)) })
  }

  return (
    <form ref={formRef} onSubmit={onSubmit} className="flex flex-col gap-5" noValidate>
      {status ? <Notice tone={status.tone}>{status.text}</Notice> : null}
      <Field id="department-code" name="code" required autoComplete="off" label={t('departments.codeLabel')} hint={t('departments.codeHint')} error={errors.code} />
      <Field id="department-name-th" name="nameTh" required label={t('departments.nameTh')} error={errors.nameTh} />
      <Field id="department-name-en" name="nameEn" label={t('departments.nameEn')} />
      <SelectField
        id="department-parent"
        name="parentId"
        required
        label={t('departments.parent')}
        placeholder={t('choose')}
        options={parents.map((p) => ({ value: p.id, label: departmentOption(locale, p) }))}
        error={errors.parentId}
      />
      <SelectField id="department-kind" name="kind" label={t('departments.kind')} defaultValue="DEPARTMENT" options={KINDS.map((k) => ({ value: k, label: t(`kinds.${k}`) }))} />
      <Button type="submit" disabled={action.pending} className="self-start">
        {action.pending ? t('saving') : t('departments.createSubmit')}
      </Button>
    </form>
  )
}

export interface DepartmentRowProps {
  readonly department: { readonly id: string; readonly code: string; readonly nameTh: string; readonly nameEn: string | null; readonly root: boolean }
  /** Shown name in the reader's language */
  readonly name: string
  readonly rename: RenameDepartmentAction
}

/** The actions of one department in the tree: rename in place, or propose a move. */
export function DepartmentRowActions({ department, name, rename }: DepartmentRowProps) {
  const t = useTranslations('adminOrg')
  const id = useId()
  const action = useAction()
  const [open, setOpen] = useState(false)
  const [status, setStatus] = useState<Status>(null)
  const [nameError, setNameError] = useState<string | undefined>()

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    const input = { departmentId: department.id, nameTh: String(form.get('nameTh') ?? '').trim(), nameEn: String(form.get('nameEn') ?? '').trim() }
    if (!input.nameTh) return setNameError(t('errors.NAME'))
    setNameError(undefined)
    const outcome = await action.run((key) => rename(input, key))
    if (outcome.ok) {
      setOpen(false)
      setStatus({ tone: 'success', text: t('departments.renamed', { code: department.code }) })
      action.done()
      return
    }
    if (outcome.field === 'nameTh') return setNameError(t('errors.NAME'))
    setStatus({ tone: 'danger', text: t(`errors.${failureKey(outcome, ORG_REASONS)}`, errorValues(outcome)) })
  }

  return (
    <div className="flex flex-col gap-3">
      {status ? <Notice tone={status.tone}>{status.text}</Notice> : null}
      {open ? (
        <form onSubmit={onSubmit} className="flex flex-col gap-4 border-l-4 border-line pl-3" noValidate>
          <Field id={`${id}-th`} name="nameTh" required defaultValue={department.nameTh} label={t('departments.nameTh')} error={nameError} />
          <Field id={`${id}-en`} name="nameEn" defaultValue={department.nameEn ?? ''} label={t('departments.nameEn')} />
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
            onClick={() => {
              setStatus(null)
              setOpen(true)
            }}
            className="min-h-11"
          >
            {t('rename')}
            <span className="sr-only"> {name}</span>
          </Button>
          {department.root ? null : (
            <Link
              href={`/admin/org-authority/new?kind=DEPARTMENT_REPARENT&department=${department.id}`}
              className="inline-flex min-h-11 items-center font-medium text-primary underline underline-offset-4 hover:no-underline"
            >
              {t('departments.move')}
              <span className="sr-only"> {name}</span>
            </Link>
          )}
        </div>
      )}
    </div>
  )
}
