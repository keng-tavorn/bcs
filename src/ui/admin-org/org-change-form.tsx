'use client'

import Link from 'next/link'
import { useLocale, useTranslations } from 'next-intl'
import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { REASON_MAX_LENGTH } from '@/lib/constants'
import { Button } from '../form/button'
import { Field } from '../form/field'
import { Notice } from '../form/notice'
import { formatDateTime } from '../format'
import { ChangeSummary, type ChangeSummaryInput } from './change-summary'
import { departmentOption, memberLabel, nameIn, type Named } from './names'
import type { ChangeKind } from './kinds'
import { failureKey, type ActionFailure } from './outcome'
import { SelectField } from './select-field'
import { thaiLocalToIso } from './thai-time'
import { errorValues, useAction } from './use-action'
import { WarningText } from './warning-text'

// Proposing an authority change (FR-DOA-010 AC1, BR-DOA-17, BR-SOD-08): step 2 fills in the details of the chosen
// kind, step 3 shows what the change would do — who gains or loses authority, the pending tasks that move to the new
// holder or stay where they are when the slot becomes vacant, who will approve — and asks for each vacancy warning to
// be ticked on its own before "ส่งขออนุมัติ". The service checks every rule again when it is sent; a warning it still
// asks for (WARNINGS_NOT_ACKNOWLEDGED) is shown here to tick. Times are typed as Thai time and echoed in Thai dates.

const DOCUMENT_TYPES = ['PURCHASE_REQUEST', 'PURCHASE_ORDER', 'GR_VARIANCE', 'DOA_CHANGE', 'ORG_AUTHORITY_CHANGE'] as const

/** What the form sends; times are local "YYYY-MM-DDTHH:mm" in Thai time and the server turns them into instants */
export interface OrgChangeDraft {
  readonly kind: ChangeKind
  readonly positionCode: string
  readonly departmentId: string
  readonly memberId: string
  readonly replacementMemberId: string
  readonly newParentId: string
  readonly delegatorMemberId: string
  readonly delegateMemberId: string
  readonly startsAt: string
  readonly endsAt: string
  readonly documentTypes: readonly string[]
  readonly maxAmount: string
  readonly effectiveMode: 'ON_APPROVAL' | 'AT'
  readonly effectiveAt: string
  readonly reason: string
}

export interface PreviewPerson extends Named {
  readonly id: string
}

export interface PreviewView {
  readonly effectiveFrom: string
  /** The delegation period as instants (DELEGATION_ON_BEHALF), as the server read the form's local times */
  readonly period: { readonly startsAt: string; readonly endsAt: string } | null
  readonly warnings: readonly string[]
  readonly gains: readonly PreviewPerson[]
  readonly loses: readonly PreviewPerson[]
  /** Pending tasks that move to the new holder */
  readonly openTasks: number
  /** Pending tasks that stay where they are because the slot becomes vacant */
  readonly openTasksStay: number
  readonly route: {
    readonly doaCode: string
    readonly versionNo: number
    readonly ruleCode: string
    readonly approvers: ReadonlyArray<PreviewPerson & { readonly onBehalfOf: PreviewPerson | null }>
  }
}

export type PreviewResult = { readonly ok: true; readonly preview: PreviewView } | ActionFailure
export type ProposeResult = { readonly ok: true; readonly changeId: string; readonly assigneeMemberId: string } | ActionFailure

export interface OrgChangeFormData {
  readonly departments: ReadonlyArray<Named & { readonly id: string; readonly code: string; readonly depth: number; readonly parentId: string | null }>
  readonly positions: ReadonlyArray<Named & { readonly code: string; readonly scope: 'DEPARTMENT' | 'ORG'; readonly authority: boolean }>
  readonly members: ReadonlyArray<Named & { readonly id: string; readonly employeeCode: string | null }>
  readonly holders: ReadonlyArray<{ readonly positionCode: string; readonly departmentId: string; readonly member: PreviewPerson }>
}

export interface OrgChangeFormProps {
  readonly kind: ChangeKind
  readonly data: OrgChangeFormData
  readonly initial: Partial<Pick<OrgChangeDraft, 'positionCode' | 'departmentId' | 'memberId' | 'newParentId' | 'delegatorMemberId'>>
  readonly preview: (draft: OrgChangeDraft, idempotencyKey: string) => Promise<PreviewResult>
  readonly propose: (draft: OrgChangeDraft, acknowledged: readonly string[], idempotencyKey: string) => Promise<ProposeResult>
}

export const AUTHORITY_REASONS = [
  'EFFECTIVE_IN_PAST',
  'SOD_VIOLATION',
  'MEMBER',
  'DEPARTMENT',
  'POSITION',
  'NO_CHANGE',
  'CYCLE',
  'REPARENT_WAITING',
  'GOVERNANCE_UNRESOLVABLE',
  'INVALID_PERIOD',
  'INVALID_AMOUNT',
  'SELF_DELEGATION',
  'NOTHING_TO_DELEGATE',
  'DELEGATE_NOT_ACTIVE',
  'OVERLAPPING_DELEGATION',
  'WARNINGS_NOT_ACKNOWLEDGED',
] as const

const AMOUNT = /^\d{1,13}(\.\d{1,2})?$/
type FieldName = 'positionCode' | 'departmentId' | 'memberId' | 'newParentId' | 'delegatorMemberId' | 'delegateMemberId' | 'startsAt' | 'endsAt' | 'maxAmount' | 'effectiveAt' | 'reason'
type Errors = Partial<Record<FieldName, string>>

function Steps({ current }: { current: 2 | 3 }) {
  const t = useTranslations('adminOrg.authority.new')
  const steps = [t('steps.kind'), t('steps.details'), t('steps.review')]
  return (
    <ol aria-label={t('steps.label')} className="flex flex-wrap gap-x-6 gap-y-1 border-b border-line">
      {steps.map((label, i) => {
        const n = i + 1
        const active = n === current
        return (
          <li key={label} aria-current={active ? 'step' : undefined} className={active ? '-mb-px border-b-2 border-primary py-2 font-semibold text-ink' : 'py-2 text-ink-muted'}>
            {n === 1 ? (
              <Link href="/admin/org-authority/new" className="underline underline-offset-4 hover:no-underline">
                {t('stepLabel', { n, name: label })}
              </Link>
            ) : (
              t('stepLabel', { n, name: label })
            )}
          </li>
        )
      })}
    </ol>
  )
}

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section aria-labelledby={id} className="flex flex-col gap-2 border-t border-line pt-4">
      <h3 id={id} className="text-lg font-semibold">
        {title}
      </h3>
      {children}
    </section>
  )
}

export function OrgChangeForm({ kind, data, initial, preview, propose }: OrgChangeFormProps) {
  const t = useTranslations('adminOrg')
  const tn = useTranslations('adminOrg.authority.new')
  const locale = useLocale()
  const id = useId()
  const action = useAction()
  const reviewRef = useRef<HTMLHeadingElement>(null)
  const sentRef = useRef<HTMLDivElement>(null)
  const root = data.departments.find((d) => d.parentId === null)
  const [draft, setDraft] = useState<OrgChangeDraft>(() => {
    const position = data.positions.find((p) => p.code === initial.positionCode)
    return {
      kind,
      positionCode: initial.positionCode ?? '',
      departmentId: position?.scope === 'ORG' ? (root?.id ?? '') : (initial.departmentId ?? ''),
      memberId: initial.memberId ?? '',
      replacementMemberId: '',
      newParentId: initial.newParentId ?? '',
      delegatorMemberId: initial.delegatorMemberId ?? '',
      delegateMemberId: '',
      startsAt: '',
      endsAt: '',
      documentTypes: [],
      maxAmount: '',
      effectiveMode: 'ON_APPROVAL',
      effectiveAt: '',
      reason: '',
    }
  })
  const [errors, setErrors] = useState<Errors>({})
  const [failure, setFailure] = useState<string | null>(null)
  const [phase, setPhase] = useState<'edit' | 'review' | 'sent'>('edit')
  const [view, setView] = useState<PreviewView | null>(null)
  const [warnings, setWarnings] = useState<readonly string[]>([])
  const [ticked, setTicked] = useState<ReadonlySet<string>>(new Set())
  const [sentTo, setSentTo] = useState<string | null>(null)

  useEffect(() => {
    if (phase === 'review') reviewRef.current?.focus()
    if (phase === 'sent') sentRef.current?.focus()
  }, [phase])

  /** A field the admin changes loses its old error at once, so what is shown is about what is there now */
  const clearErrors = (...fields: FieldName[]) =>
    setErrors((e) => (fields.some((f) => e[f]) ? Object.fromEntries(Object.entries(e).filter(([k]) => !fields.includes(k as FieldName))) : e))
  const set = <K extends keyof OrgChangeDraft>(field: K, value: OrgChangeDraft[K]) => {
    setDraft((d) => ({ ...d, [field]: value }))
    clearErrors(field as FieldName)
  }
  const name = (n: Named) => nameIn(locale, n)
  const member = (memberId: string) => data.members.find((m) => m.id === memberId)
  const department = (departmentId: string) => data.departments.find((d) => d.id === departmentId)
  const position = data.positions.find((p) => p.code === draft.positionCode)
  const holder = data.holders.find((h) => h.positionCode === draft.positionCode && h.departmentId === draft.departmentId)
  const memberOptions = data.members.map((m) => ({ value: m.id, label: memberLabel(locale, m) }))
  const departmentOptions = (filter: (d: OrgChangeFormData['departments'][number]) => boolean = () => true) =>
    data.departments.filter(filter).map((d) => ({ value: d.id, label: departmentOption(locale, d) }))
  /** Whether `departmentId` is `ancestorId` or one of the departments under it (a move there would make a cycle) */
  const under = (departmentId: string, ancestorId: string) => {
    for (let at: string | null | undefined = departmentId, steps = 0; at && steps <= data.departments.length; at = department(at)?.parentId, steps++) {
      if (at === ancestorId) return true
    }
    return false
  }

  function validate(): Errors {
    const e: Errors = {}
    const need = (field: FieldName, message: string) => {
      if (!String(draft[field as keyof OrgChangeDraft] ?? '').trim()) e[field] = message
    }
    switch (kind) {
      case 'POSITION_ASSIGN':
        need('positionCode', t('errors.POSITION'))
        need('departmentId', t('errors.DEPARTMENT'))
        need('memberId', t('errors.MEMBER'))
        break
      case 'POSITION_END':
        need('positionCode', t('errors.POSITION'))
        need('departmentId', t('errors.DEPARTMENT'))
        break
      case 'DEPARTMENT_REPARENT':
        need('departmentId', t('errors.DEPARTMENT'))
        need('newParentId', t('errors.PARENT'))
        break
      case 'DELEGATION_ON_BEHALF':
        need('delegatorMemberId', t('errors.MEMBER'))
        need('delegateMemberId', t('errors.MEMBER'))
        need('startsAt', t('errors.PERIOD'))
        need('endsAt', t('errors.PERIOD'))
        if (draft.startsAt && draft.endsAt && draft.endsAt <= draft.startsAt) e.endsAt = t('errors.INVALID_PERIOD')
        if (draft.maxAmount.trim() && !AMOUNT.test(draft.maxAmount.replaceAll(',', '').trim())) e.maxAmount = t('errors.AMOUNT')
        break
      case 'IDENTITY_RESET':
        need('memberId', t('errors.MEMBER'))
        break
    }
    if (kind !== 'IDENTITY_RESET' && kind !== 'DELEGATION_ON_BEHALF' && draft.effectiveMode === 'AT') need('effectiveAt', t('errors.EFFECTIVE'))
    if (draft.reason.trim().length < 3) e.reason = t('errors.REASON')
    else if (draft.reason.trim().length > REASON_MAX_LENGTH) e.reason = t('errors.REASON_TOO_LONG', { max: REASON_MAX_LENGTH })
    return e
  }

  /** A refusal of the service, at the field it is about when there is one */
  function showFailure(outcome: ActionFailure) {
    const key = failureKey(outcome, AUTHORITY_REASONS)
    const message = t(`errors.${key}`, errorValues(outcome))
    if (outcome.reason === 'EFFECTIVE_IN_PAST') {
      setPhase('edit')
      return setErrors({ effectiveAt: message })
    }
    if (outcome.reason === 'INVALID_PERIOD') {
      setPhase('edit')
      return setErrors({ endsAt: message })
    }
    if (outcome.reason === 'CYCLE' || outcome.reason === 'NO_CHANGE') {
      setPhase('edit')
      return setErrors({ newParentId: message })
    }
    if (outcome.field === 'reason') {
      setPhase('edit')
      return setErrors({ reason: draft.reason.trim().length > REASON_MAX_LENGTH ? t('errors.REASON_TOO_LONG', { max: REASON_MAX_LENGTH }) : t('errors.REASON') })
    }
    setFailure(message)
  }

  async function onPreview(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const next = validate()
    setErrors(next)
    setFailure(null)
    if (Object.keys(next).length) return
    const outcome = await action.run((key) => preview(draft, key))
    if (!outcome.ok) return showFailure(outcome)
    setView(outcome.preview)
    setWarnings(outcome.preview.warnings)
    setTicked(new Set())
    setPhase('review')
  }

  async function onSend(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setFailure(null)
    if (warnings.some((w) => !ticked.has(w))) return setFailure(t('errors.WARNINGS_NOT_ACKNOWLEDGED'))
    const outcome = await action.run((key) => propose(draft, [...ticked], key))
    if (outcome.ok) {
      const approver = view?.route.approvers.find((a) => a.id === outcome.assigneeMemberId)
      setSentTo(approver ? name(approver) : null)
      setPhase('sent')
      return
    }
    if (outcome.reason === 'WARNINGS_NOT_ACKNOWLEDGED' && outcome.warnings?.length) {
      // The organization changed since the preview: these are the warnings the service asks for now
      setWarnings(outcome.warnings)
      setTicked(new Set([...ticked].filter((w) => outcome.warnings!.includes(w))))
    }
    showFailure(outcome)
  }

  const summary: ChangeSummaryInput | null = (() => {
    const pos = position ? `${name(position)} (${position.code})` : draft.positionCode
    const dept = (departmentId: string) => {
      const d = department(departmentId)
      return d ? name(d) : departmentId
    }
    const who = (memberId: string) => {
      const m = member(memberId)
      return m ? name(m) : memberId
    }
    switch (kind) {
      case 'POSITION_ASSIGN':
        return { kind, position: pos, department: dept(draft.departmentId), member: who(draft.memberId) }
      case 'POSITION_END':
        return { kind, position: pos, department: dept(draft.departmentId), replacement: draft.replacementMemberId ? who(draft.replacementMemberId) : null }
      case 'DEPARTMENT_REPARENT':
        return { kind, department: dept(draft.departmentId), parent: dept(draft.newParentId) }
      case 'DELEGATION_ON_BEHALF':
        return view?.period
          ? {
              kind,
              delegator: who(draft.delegatorMemberId),
              delegate: who(draft.delegateMemberId),
              startsAt: view.period.startsAt,
              endsAt: view.period.endsAt,
              documentTypes: draft.documentTypes,
              maxAmount: draft.maxAmount.trim() ? satangText(draft.maxAmount) : null,
            }
          : null
      case 'IDENTITY_RESET':
        return { kind, member: who(draft.memberId) }
    }
  })()

  if (phase === 'sent') {
    return (
      <div ref={sentRef} tabIndex={-1} className="flex flex-col gap-4 outline-none">
        <Notice tone="success">{sentTo ? tn('sent', { name: sentTo }) : tn('sentNoName')}</Notice>
        <div className="flex flex-wrap gap-x-6 gap-y-2">
          <Link href="/admin/org-authority" className="inline-flex min-h-11 items-center font-medium text-primary underline underline-offset-4 hover:no-underline">
            {tn('viewList')}
          </Link>
          <Link href="/admin/org-authority/new" className="inline-flex min-h-11 items-center font-medium text-primary underline underline-offset-4 hover:no-underline">
            {tn('proposeAnother')}
          </Link>
        </div>
      </div>
    )
  }

  if (phase === 'review' && view) {
    const effective =
      kind === 'DELEGATION_ON_BEHALF'
        ? tn('fields.delegationEffective')
        : kind === 'IDENTITY_RESET' || draft.effectiveMode === 'ON_APPROVAL'
          ? tn('effectiveOnApproval')
          : tn('effectiveAtTime', { time: formatDateTime(locale, view.effectiveFrom) })
    const people = (list: readonly PreviewPerson[]) => (list.length ? list.map(name).join(', ') : tn('nobody'))
    // Pending tasks follow the new holder; with nobody new they stay with whoever holds them (the admins are told)
    const tasks =
      view.openTasks > 0
        ? tn('tasksMove', { count: view.openTasks })
        : view.openTasksStay > 0
          ? view.loses.length
            ? tn('tasksStay', { count: view.openTasksStay, names: people(view.loses) })
            : tn('tasksStayHeld', { count: view.openTasksStay })
          : tn('tasksNone')
    const ref = t('authority.doaRef', { code: view.route.doaCode, version: view.route.versionNo, rule: view.route.ruleCode })
    const approvers = view.route.approvers.map((a) => (a.onBehalfOf ? tn('onBehalf', { name: name(a), principal: name(a.onBehalfOf) }) : name(a))).join(', ')
    return (
      <div className="flex flex-col gap-6">
        <Steps current={3} />
        <form onSubmit={onSend} className="flex flex-col gap-5" noValidate>
          <h2 ref={reviewRef} tabIndex={-1} className="text-xl font-semibold outline-none">
            {tn('reviewTitle')}
          </h2>
          {failure ? <Notice tone="danger">{failure}</Notice> : null}
          <Section id={`${id}-what`} title={tn('reviewWhat')}>
            {summary ? <ChangeSummary input={summary} className="font-medium" /> : null}
            <p className="text-ink-muted">{effective}</p>
            <p className="text-ink-muted">{t('authority.reasonLine', { reason: draft.reason.trim() })}</p>
          </Section>
          <Section id={`${id}-impact`} title={tn('impactTitle')}>
            <dl className="grid gap-x-6 gap-y-1 sm:grid-cols-[12rem_1fr]">
              <dt className="font-medium">{tn('gainsTitle')}</dt>
              <dd>{people(view.gains)}</dd>
              <dt className="font-medium">{tn('losesTitle')}</dt>
              <dd>{people(view.loses)}</dd>
              <dt className="font-medium">{tn('tasksTitle')}</dt>
              <dd>{tasks}</dd>
            </dl>
          </Section>
          <Section id={`${id}-approver`} title={tn('approverTitle')}>
            <p>{tn('approverLine', { names: approvers, ref })}</p>
          </Section>
          {warnings.length ? (
            <fieldset className="flex flex-col gap-2 border-t border-line pt-4">
              <legend className="float-left mb-1 w-full text-lg font-semibold">{tn('warningsTitle')}</legend>
              <p className="text-ink-muted">{tn('warningsHint')}</p>
              {warnings.map((w) => (
                <label key={w} className="flex min-h-11 items-start gap-3 py-1">
                  <input
                    type="checkbox"
                    checked={ticked.has(w)}
                    onChange={(event) => {
                      const checked = event.currentTarget.checked
                      setTicked((s) => {
                        const next = new Set(s)
                        if (checked) next.add(w)
                        else next.delete(w)
                        return next
                      })
                    }}
                    className="mt-1 size-5 shrink-0 accent-[var(--warn)]"
                  />
                  <WarningText warningKey={w} positions={data.positions} departments={data.departments} />
                </label>
              ))}
            </fieldset>
          ) : null}
          <div className="flex flex-wrap gap-3 border-t border-line pt-4">
            <Button type="submit" disabled={action.pending}>
              {action.pending ? tn('sending') : tn('send')}
            </Button>
            <Button
              type="button"
              variant="secondary"
              onClick={() => {
                setFailure(null)
                setPhase('edit')
              }}
            >
              {tn('edit')}
            </Button>
          </div>
        </form>
      </div>
    )
  }

  // Step 2: the details of the chosen kind
  const field = (f: FieldName) => `${id}-${f}`
  /** The chosen time in Thai, Buddhist-era dates; the browser's own picker shows its own calendar */
  const echo = (local: string) => {
    const at = thaiLocalToIso(local)
    return at ? tn('fields.timeEcho', { time: formatDateTime(locale, at) }) : tn('fields.timeHint')
  }
  return (
    <div className="flex flex-col gap-6">
      <Steps current={2} />
      <form onSubmit={onPreview} className="flex max-w-2xl flex-col gap-5" noValidate>
        {failure ? <Notice tone="danger">{failure}</Notice> : null}
        {kind === 'POSITION_ASSIGN' || kind === 'POSITION_END' ? (
          <>
            <SelectField
              id={field('positionCode')}
              label={tn('fields.position')}
              placeholder={t('choose')}
              value={draft.positionCode}
              onChange={(event) => {
                const code = event.currentTarget.value
                const p = data.positions.find((x) => x.code === code)
                setDraft((d) => ({ ...d, positionCode: code, departmentId: p?.scope === 'ORG' ? (root?.id ?? '') : d.departmentId }))
                clearErrors('positionCode', 'departmentId')
              }}
              options={data.positions.map((p) => ({ value: p.code, label: `${name(p)} (${p.code})` }))}
              error={errors.positionCode}
            />
            {position?.scope === 'ORG' ? (
              <p className="text-ink-muted">{t('positions.rootOnly', { name: root ? name(root) : '' })}</p>
            ) : (
              <SelectField
                id={field('departmentId')}
                label={tn('fields.department')}
                placeholder={t('choose')}
                value={draft.departmentId}
                onChange={(event) => set('departmentId', event.currentTarget.value)}
                options={departmentOptions()}
                error={errors.departmentId}
              />
            )}
            {draft.positionCode && draft.departmentId ? (
              <p className="text-ink-muted">{holder ? tn('fields.currentHolder', { name: name(holder.member) }) : tn('fields.currentVacant')}</p>
            ) : null}
            {kind === 'POSITION_ASSIGN' ? (
              <SelectField
                id={field('memberId')}
                label={tn('fields.member')}
                placeholder={t('choose')}
                value={draft.memberId}
                onChange={(event) => set('memberId', event.currentTarget.value)}
                options={memberOptions}
                error={errors.memberId}
              />
            ) : (
              <SelectField
                id={field('memberId')}
                label={tn('fields.replacement')}
                placeholder={tn('fields.noReplacement')}
                hint={tn('fields.replacementHint')}
                value={draft.replacementMemberId}
                onChange={(event) => set('replacementMemberId', event.currentTarget.value)}
                options={memberOptions}
              />
            )}
          </>
        ) : null}

        {kind === 'DEPARTMENT_REPARENT' ? (
          <>
            <SelectField
              id={field('departmentId')}
              label={tn('fields.moveDepartment')}
              placeholder={t('choose')}
              value={draft.departmentId}
              onChange={(event) => set('departmentId', event.currentTarget.value)}
              options={departmentOptions((d) => d.parentId !== null)}
              error={errors.departmentId}
            />
            <SelectField
              id={field('newParentId')}
              label={tn('fields.newParent')}
              placeholder={t('choose')}
              value={draft.newParentId}
              onChange={(event) => set('newParentId', event.currentTarget.value)}
              options={departmentOptions((d) => !under(d.id, draft.departmentId))}
              error={errors.newParentId}
            />
          </>
        ) : null}

        {kind === 'DELEGATION_ON_BEHALF' ? (
          <>
            <SelectField
              id={field('delegatorMemberId')}
              label={tn('fields.delegator')}
              placeholder={t('choose')}
              value={draft.delegatorMemberId}
              onChange={(event) => set('delegatorMemberId', event.currentTarget.value)}
              options={memberOptions}
              error={errors.delegatorMemberId}
            />
            <SelectField
              id={field('delegateMemberId')}
              label={tn('fields.delegate')}
              placeholder={t('choose')}
              value={draft.delegateMemberId}
              onChange={(event) => set('delegateMemberId', event.currentTarget.value)}
              options={memberOptions}
              error={errors.delegateMemberId}
            />
            <div className="grid gap-5 sm:grid-cols-2">
              <Field
                id={field('startsAt')}
                type="datetime-local"
                label={tn('fields.startsAt')}
                hint={echo(draft.startsAt)}
                value={draft.startsAt}
                onChange={(event) => set('startsAt', event.currentTarget.value)}
                error={errors.startsAt}
              />
              <Field
                id={field('endsAt')}
                type="datetime-local"
                label={tn('fields.endsAt')}
                hint={echo(draft.endsAt)}
                value={draft.endsAt}
                onChange={(event) => set('endsAt', event.currentTarget.value)}
                error={errors.endsAt}
              />
            </div>
            <fieldset className="flex flex-col gap-1">
              <legend className="mb-1.5 font-medium text-ink">{tn('fields.documentTypes')}</legend>
              <div className="grid grid-cols-1 gap-x-4 sm:grid-cols-2">
                {DOCUMENT_TYPES.map((d) => (
                  <label key={d} className="flex min-h-11 items-center gap-3">
                    <input
                      type="checkbox"
                      checked={draft.documentTypes.includes(d)}
                      onChange={(event) => {
                        const checked = event.currentTarget.checked
                        setDraft((x) => ({ ...x, documentTypes: checked ? [...x.documentTypes, d] : x.documentTypes.filter((v) => v !== d) }))
                      }}
                      className="size-5 accent-[var(--primary)]"
                    />
                    <span>{t(`authority.documentTypes.${d}`)}</span>
                  </label>
                ))}
              </div>
            </fieldset>
            <Field
              id={field('maxAmount')}
              inputMode="decimal"
              label={tn('fields.maxAmount')}
              hint={tn('fields.maxAmountHint')}
              value={draft.maxAmount}
              onChange={(event) => set('maxAmount', event.currentTarget.value)}
              error={errors.maxAmount}
              className="money max-w-xs"
            />
          </>
        ) : null}

        {kind === 'IDENTITY_RESET' ? (
          <SelectField
            id={field('memberId')}
            label={tn('fields.identityMember')}
            placeholder={t('choose')}
            hint={tn('fields.identityHint')}
            value={draft.memberId}
            onChange={(event) => set('memberId', event.currentTarget.value)}
            options={memberOptions}
            error={errors.memberId}
          />
        ) : null}

        {kind === 'IDENTITY_RESET' || kind === 'DELEGATION_ON_BEHALF' ? (
          <p className="text-ink-muted">{kind === 'IDENTITY_RESET' ? tn('fields.identityEffective') : tn('fields.delegationEffective')}</p>
        ) : (
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-1.5 font-medium text-ink">{tn('fields.effective')}</legend>
            <label className="flex min-h-11 items-center gap-3">
              <input type="radio" name={field('effectiveAt')} checked={draft.effectiveMode === 'ON_APPROVAL'} onChange={() => set('effectiveMode', 'ON_APPROVAL')} className="size-5 accent-[var(--primary)]" />
              <span>{tn('fields.effectiveOnApproval')}</span>
            </label>
            <label className="flex min-h-11 items-center gap-3">
              <input type="radio" name={field('effectiveAt')} checked={draft.effectiveMode === 'AT'} onChange={() => set('effectiveMode', 'AT')} className="size-5 accent-[var(--primary)]" />
              <span>{tn('fields.effectiveAt')}</span>
            </label>
            {draft.effectiveMode === 'AT' ? (
              <Field
                id={field('effectiveAt')}
                type="datetime-local"
                label={tn('fields.effectiveAtLabel')}
                hint={echo(draft.effectiveAt)}
                value={draft.effectiveAt}
                onChange={(event) => set('effectiveAt', event.currentTarget.value)}
                error={errors.effectiveAt}
                className="max-w-xs"
              />
            ) : errors.effectiveAt ? (
              <Notice tone="danger">{errors.effectiveAt}</Notice>
            ) : null}
          </fieldset>
        )}

        <div className="flex flex-col gap-1.5">
          <label htmlFor={field('reason')} className="font-medium text-ink">
            {tn('fields.reason')}
          </label>
          <textarea
            id={field('reason')}
            rows={3}
            maxLength={REASON_MAX_LENGTH}
            value={draft.reason}
            onChange={(event) => set('reason', event.currentTarget.value)}
            aria-invalid={errors.reason ? true : undefined}
            aria-describedby={errors.reason ? `${field('reason')}-error` : undefined}
            className="w-full rounded-md border border-input bg-bg px-3 py-2 text-base text-ink aria-[invalid=true]:border-danger"
          />
          {errors.reason ? (
            <p id={`${field('reason')}-error`} className="text-base text-danger md:text-sm">
              {errors.reason}
            </p>
          ) : null}
        </div>

        <Button type="submit" disabled={action.pending} className="self-start">
          {action.pending ? tn('previewing') : tn('previewSubmit')}
        </Button>
      </form>
    </div>
  )
}

/** "50,000.5" → "5000050" (satang text) for the summary; the server parses the amount again with its own rules */
function satangText(amount: string): string | null {
  const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(amount.replaceAll(',', '').trim())
  return m ? (BigInt(m[1]!) * 100n + BigInt((m[2] ?? '').padEnd(2, '0'))).toString() : null
}
