'use client'

import { Trash2, Undo2 } from 'lucide-react'
import { useLocale, useTranslations } from 'next-intl'
import { useEffect, useId, useRef, useState, type FormEvent } from 'react'
import { REASON_MAX_LENGTH } from '@/lib/constants'
import { departmentOption, memberLabel, nameIn, type Named } from '../admin-org/names'
import { failureKey, type IssueView } from '../admin-org/outcome'
import { SelectField } from '../admin-org/select-field'
import { errorValues, useAction } from '../admin-org/use-action'
import { WarningText } from '../admin-org/warning-text'
import { Button } from '../form/button'
import { Field } from '../form/field'
import { Notice } from '../form/notice'
import { BoundaryConfirm } from './boundary-confirm'
import { boundaryRefusalAt, boundaryTickMissing, boundaryTickValue } from './boundary-tick'
import { DOA_REASONS } from './import-form'
import { LintIssueText } from './lint-issue'
import type { SubmitDoaResult } from './submit-panel'

// The organization's initial package (BR-DOA-19, FR-DOA-002 AC3, ADR-042 item 1): the first DOA version and who holds
// each position it names go together to the contract signatory, who approves with a step-up. Only positions the
// version names may be listed, every current holder of such a position must be listed, one holder per position and
// department, and never the submitter. The service checks all of this again and answers with what to fix.
// Two real steps (§9.9: no single page of more than 8 fields): (1) the holders as a short list, prefilled with the
// current holders, where one row at a time is edited, added or removed (3 fields); (2) the reason, any warning to tick
// on its own, the tick that the boundary table was checked when the page shows one (FR-DOA-009 AC3), and the send. A
// refusal goes back to the step and the row it is about.

export interface PackageHolder {
  readonly positionCode: string
  readonly departmentId: string
  readonly memberId: string
}

/** boundaryTableConfirmed: the drafter's tick, or null when the page showed no boundary table */
export type SubmitInitialPackageAction = (
  versionId: string,
  holders: readonly PackageHolder[],
  reason: string,
  acknowledged: readonly string[],
  boundaryTableConfirmed: boolean | null,
  idempotencyKey: string,
) => Promise<SubmitDoaResult>

export interface InitialPackageFormProps {
  readonly versionId: string
  readonly positions: ReadonlyArray<Named & { readonly code: string; readonly scope: 'DEPARTMENT' | 'ORG' }>
  readonly departments: ReadonlyArray<Named & { readonly id: string; readonly code: string; readonly depth: number; readonly root: boolean }>
  readonly members: ReadonlyArray<Named & { readonly id: string; readonly employeeCode: string | null }>
  readonly holders: readonly PackageHolder[]
  readonly signatory: (Named & { readonly id: string }) | null
  /** The page shows a boundary table the drafter must tick as checked before sending (FR-DOA-009 AC3); its section id */
  readonly boundaryTableId: string | null
  readonly submit: SubmitInitialPackageAction
}

type Row = PackageHolder & { readonly key: number }
/** The one row being edited: an existing row by its key, or a new one */
type Editing = { readonly key: number | 'new'; readonly draft: PackageHolder; readonly error: string | null }

const slotOf = (h: Pick<PackageHolder, 'positionCode' | 'departmentId'>) => `${h.positionCode}@${h.departmentId}`
const without = (errors: Readonly<Record<number, string>>, key: number) => Object.fromEntries(Object.entries(errors).filter(([k]) => Number(k) !== key))

export function InitialPackageForm({ versionId, positions, departments, members, holders, signatory, boundaryTableId, submit }: InitialPackageFormProps) {
  const t = useTranslations('adminDoa.detail.initial')
  const tDoa = useTranslations('adminDoa')
  const locale = useLocale()
  const id = useId()
  const action = useAction()
  const root = departments.find((d) => d.root)
  const stepRef = useRef<HTMLHeadingElement>(null)
  const [step, setStep] = useState<1 | 2>(1)
  const [rows, setRows] = useState<readonly Row[]>(() => holders.map((h, i) => ({ ...h, key: i })))
  const [nextKey, setNextKey] = useState(holders.length)
  const [editing, setEditing] = useState<Editing | null>(null)
  const [rowErrors, setRowErrors] = useState<Readonly<Record<number, string>>>({})
  const [listFailure, setListFailure] = useState<string | null>(null)
  /** The row taken out last, where it stood, so one press brings it back (taking a row out is undone, not confirmed) */
  const [removed, setRemoved] = useState<{ readonly kind: 'removed'; readonly row: Row; readonly index: number } | { readonly kind: 'restored'; readonly row: Row } | null>(null)
  const [reason, setReason] = useState('')
  const [reasonError, setReasonError] = useState<string | undefined>()
  const [warnings, setWarnings] = useState<readonly string[]>([])
  const [ticked, setTicked] = useState<ReadonlySet<string>>(new Set())
  const [boundaryTicked, setBoundaryTicked] = useState(false)
  const [boundaryError, setBoundaryError] = useState<string | undefined>()
  const [errors, setErrors] = useState<readonly IssueView[]>([])
  const [failure, setFailure] = useState<string | null>(null)
  const [sent, setSent] = useState(false)
  const moved = useRef(false)

  // Each step starts at its heading, so a screen reader and the keyboard follow the change of step
  useEffect(() => {
    if (moved.current) stepRef.current?.focus()
  }, [step])
  const goTo = (next: 1 | 2) => {
    moved.current = true
    setStep(next)
  }

  const scopeOf = (code: string) => positions.find((p) => p.code === code)?.scope
  const positionName = (code: string) => {
    const p = positions.find((x) => x.code === code)
    return p ? `${nameIn(locale, p)} (${p.code})` : code
  }
  const departmentName = (departmentId: string) => {
    const d = departments.find((x) => x.id === departmentId)
    return d ? nameIn(locale, d) : departmentId
  }
  const memberName = (memberId: string) => {
    const m = members.find((x) => x.id === memberId)
    return m ? nameIn(locale, m) : memberId
  }
  const what = (h: Pick<PackageHolder, 'positionCode' | 'departmentId'>) => t('rowWhat', { position: positionName(h.positionCode), department: departmentName(h.departmentId) })
  const missing = positions.filter((p) => !rows.some((r) => r.positionCode === p.code)).map((p) => positionName(p.code))

  function startEdit(row: Row | null) {
    setListFailure(null)
    setRemoved(null)
    setEditing(row ? { key: row.key, draft: { positionCode: row.positionCode, departmentId: row.departmentId, memberId: row.memberId }, error: null } : { key: 'new', draft: { positionCode: '', departmentId: '', memberId: '' }, error: null })
  }

  function changeDraft(change: Partial<PackageHolder>) {
    setEditing((e) => {
      if (!e) return e
      const draft = { ...e.draft, ...change }
      // An organization-wide position belongs to the root department
      const placed = change.positionCode !== undefined && scopeOf(change.positionCode) === 'ORG' ? { ...draft, departmentId: root?.id ?? '' } : draft
      return { ...e, draft: placed, error: null }
    })
  }

  function saveRow() {
    if (!editing) return
    const d = editing.draft
    if (!d.positionCode || !d.departmentId || !d.memberId) return setEditing({ ...editing, error: t('rowIncomplete') })
    if (rows.some((r) => r.key !== editing.key && slotOf(r) === slotOf(d))) return setEditing({ ...editing, error: tDoa('errors.DUPLICATE_SLOT') })
    if (editing.key === 'new') {
      setRows((list) => [...list, { ...d, key: nextKey }])
      setNextKey((k) => k + 1)
    } else {
      const key = editing.key
      setRows((list) => list.map((r) => (r.key === key ? { ...d, key } : r)))
      setRowErrors((e) => without(e, key))
    }
    setEditing(null)
  }

  function removeRow(key: number) {
    const index = rows.findIndex((r) => r.key === key)
    if (index >= 0) setRemoved({ kind: 'removed', row: rows[index]!, index })
    setRows((list) => list.filter((r) => r.key !== key))
    setRowErrors((e) => without(e, key))
    setEditing(null)
  }

  /** Puts the row taken out last back where it stood, unless its slot is in the list again */
  function restoreRow() {
    if (removed?.kind !== 'removed') return
    const { row, index } = removed
    setRows((list) => (list.some((r) => r.key === row.key || slotOf(r) === slotOf(row)) ? list : [...list.slice(0, index), row, ...list.slice(index)]))
    setRemoved({ kind: 'restored', row })
  }

  function toSend() {
    if (editing) return setListFailure(t('finishEditing'))
    if (rows.length === 0) return setListFailure(t('noRows'))
    setListFailure(null)
    goTo(2)
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setFailure(null)
    setErrors([])
    const trimmed = reason.trim()
    const reasonProblem = trimmed.length < 3 ? tDoa('errors.REASON') : trimmed.length > REASON_MAX_LENGTH ? tDoa('errors.REASON_TOO_LONG', { max: REASON_MAX_LENGTH }) : undefined
    setReasonError(reasonProblem)
    const missingBoundary = boundaryTickMissing(boundaryTableId, boundaryTicked)
    setBoundaryError(missingBoundary ? tDoa('errors.BOUNDARY_NOT_CONFIRMED') : undefined)
    if (reasonProblem) return
    if (warnings.some((w) => !ticked.has(w))) return setFailure(tDoa('errors.WARNINGS_NOT_ACKNOWLEDGED'))
    if (missingBoundary) return
    const list = rows.map(({ positionCode, departmentId, memberId }) => ({ positionCode, departmentId, memberId }))
    const outcome = await action.run((key) => submit(versionId, list, trimmed, [...ticked], boundaryTickValue(boundaryTableId, boundaryTicked), key))
    if (outcome.ok) {
      setSent(true)
      action.done()
      return
    }
    if (outcome.code === 'DOA_LINT_FAILED' && outcome.errors?.length) {
      setErrors(outcome.errors)
      return setFailure(tDoa('detail.errorsTitle'))
    }
    if (outcome.reason === 'WARNINGS_NOT_ACKNOWLEDGED' && outcome.warnings?.length) {
      setWarnings(outcome.warnings)
      setTicked(new Set([...ticked].filter((w) => outcome.warnings!.includes(w))))
      return setFailure(tDoa('errors.WARNINGS_NOT_ACKNOWLEDGED'))
    }
    if (outcome.reason === 'BOUNDARY_NOT_CONFIRMED') {
      if (boundaryRefusalAt(boundaryTableId) === 'FORM') return setFailure(tDoa('errors.BOUNDARY_TABLE_CHANGED'))
      return setBoundaryError(tDoa('errors.BOUNDARY_NOT_CONFIRMED'))
    }
    if (outcome.field === 'reason') return setReasonError(trimmed.length > REASON_MAX_LENGTH ? tDoa('errors.REASON_TOO_LONG', { max: REASON_MAX_LENGTH }) : tDoa('errors.REASON'))
    const message = tDoa(`errors.${failureKey(outcome, DOA_REASONS)}`, errorValues(outcome))
    // A refusal about one row (holders.<i>) or the list (UNLISTED_HOLDER) goes back to the list, at what it is about
    const row = /^holders\.(\d+)$/.exec(outcome.field ?? '')
    const target = row ? rows[Number(row[1])] : undefined
    if (target) {
      setRowErrors({ [target.key]: message })
      return goTo(1)
    }
    if (outcome.reason === 'UNLISTED_HOLDER' && outcome.slots?.length) {
      setListFailure(`${message} ${outcome.slots.map(what).join(', ')}`)
      return goTo(1)
    }
    setFailure(message)
  }

  if (sent) return <Notice tone="success">{signatory ? t('sent', { name: nameIn(locale, signatory) }) : t('sentNoName')}</Notice>

  const steps = (
    <ol aria-label={t('steps.label')} className="flex flex-wrap gap-x-6 gap-y-1 border-b border-line">
      {[t('steps.holders'), t('steps.send')].map((label, i) => (
        <li key={label} aria-current={step === i + 1 ? 'step' : undefined} className={step === i + 1 ? '-mb-px border-b-2 border-primary py-2 font-semibold text-ink' : 'py-2 text-ink-muted'}>
          {t('stepLabel', { n: i + 1, name: label })}
        </li>
      ))}
    </ol>
  )

  const editor = (e: Editing) => {
    const scope = scopeOf(e.draft.positionCode)
    return (
      <fieldset className="flex flex-col gap-4 border-l-4 border-primary py-1 pl-3">
        <legend className="float-left mb-1 w-full font-semibold">{e.key === 'new' ? t('addTitle') : t('editTitle', { what: what(e.draft) })}</legend>
        {e.error ? <Notice tone="danger">{e.error}</Notice> : null}
        <div className="grid gap-4 md:grid-cols-3">
          <SelectField
            id={`${id}-edit-position`}
            label={t('position')}
            placeholder={tDoa('choose')}
            value={e.draft.positionCode}
            onChange={(event) => changeDraft({ positionCode: event.currentTarget.value })}
            options={positions.map((p) => ({ value: p.code, label: positionName(p.code) }))}
          />
          {scope === 'ORG' ? (
            <div className="flex flex-col gap-1.5">
              <span className="font-medium text-ink">{t('department')}</span>
              <p className="flex min-h-11 items-center text-ink-muted">{root ? nameIn(locale, root) : ''}</p>
            </div>
          ) : (
            <SelectField
              id={`${id}-edit-department`}
              label={t('department')}
              placeholder={tDoa('choose')}
              value={e.draft.departmentId}
              onChange={(event) => changeDraft({ departmentId: event.currentTarget.value })}
              options={departments.map((d) => ({ value: d.id, label: departmentOption(locale, d) }))}
            />
          )}
          <SelectField
            id={`${id}-edit-member`}
            label={t('member')}
            placeholder={tDoa('choose')}
            value={e.draft.memberId}
            onChange={(event) => changeDraft({ memberId: event.currentTarget.value })}
            options={members.map((m) => ({ value: m.id, label: memberLabel(locale, m) }))}
          />
        </div>
        {/* Save and cancel together; taking the row out is outlined in danger at the far end, away from save, and undone with one press */}
        <div className="flex flex-wrap items-center gap-3">
          <Button onClick={saveRow}>{e.key === 'new' ? t('addSave') : t('editSave')}</Button>
          <Button variant="secondary" onClick={() => setEditing(null)}>
            {t('cancelEdit')}
          </Button>
          {e.key !== 'new' ? (
            // A short word on the button; its accessible name starts with it and says which row (WCAG 2.5.3)
            <Button variant="danger" className="ml-auto" aria-label={t('removeThis', { what: what(e.draft) })} onClick={() => removeRow(e.key as number)}>
              <Trash2 className="size-4 shrink-0" aria-hidden="true" />
              {t('removeRow')}
            </Button>
          ) : null}
        </div>
      </fieldset>
    )
  }

  if (step === 1) {
    return (
      <div className="flex flex-col gap-5">
        {signatory ? <p>{t('signatory', { name: nameIn(locale, signatory) })}</p> : null}
        {steps}
        <h3 ref={stepRef} tabIndex={-1} className="text-lg font-semibold outline-none">
          {t('holdersTitle')}
        </h3>
        <p className="text-base text-ink-muted md:text-sm">{t('holdersHint')}</p>
        {listFailure ? <Notice tone="danger">{listFailure}</Notice> : null}
        {rows.length === 0 ? (
          <p className="border-y border-line py-3 text-ink-muted">{t('emptyRows')}</p>
        ) : (
          <ol className="flex flex-col divide-y divide-line border-y border-line">
            {rows.map((r) => (
              <li key={r.key} className="flex flex-col gap-2 py-3">
                {editing?.key === r.key ? (
                  editor(editing)
                ) : (
                  <>
                    <div className="flex items-start justify-between gap-4">
                      <p className="min-w-0 flex-1 break-words">
                        <span className="font-medium">{memberName(r.memberId)}</span>
                        <span className="text-ink-muted"> · {what(r)}</span>
                      </p>
                      {/* "แก้" on the button; the accessible name says which row (it starts with the visible word) */}
                      <Button variant="secondary" className="shrink-0" aria-label={t('editRow', { what: what(r) })} onClick={() => startEdit(r)}>
                        {t('edit')}
                      </Button>
                    </div>
                    {rowErrors[r.key] ? <Notice tone="danger">{rowErrors[r.key]}</Notice> : null}
                  </>
                )}
              </li>
            ))}
          </ol>
        )}
        {/* Always there, so what is said in it is announced */}
        <div aria-live="polite">
          {removed?.kind === 'removed' ? (
            <Notice tone="info">
              <p>{t('removedRow', { what: what(removed.row) })}</p>
              <Button variant="secondary" className="mt-2" onClick={restoreRow}>
                <Undo2 className="size-4 shrink-0" aria-hidden="true" />
                {t('restoreRow', { what: what(removed.row) })}
              </Button>
            </Notice>
          ) : removed?.kind === 'restored' ? (
            <Notice tone="info">{t('restoredRow', { what: what(removed.row) })}</Notice>
          ) : null}
        </div>
        {missing.length ? <p className="text-base text-ink-muted md:text-sm">{t('missing', { positions: missing.join(', ') })}</p> : null}
        {editing?.key === 'new' ? (
          editor(editing)
        ) : (
          <Button variant="secondary" className="self-start" onClick={() => startEdit(null)}>
            {t('addRow')}
          </Button>
        )}
        <Button className="self-start" onClick={toSend}>
          {t('next')}
        </Button>
      </div>
    )
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-5" noValidate>
      {signatory ? <p>{t('signatory', { name: nameIn(locale, signatory) })}</p> : null}
      {steps}
      <h3 ref={stepRef} tabIndex={-1} className="text-lg font-semibold outline-none">
        {t('sendTitle')}
      </h3>
      <p>{t('countLine', { count: rows.length })}</p>
      <Button variant="secondary" className="self-start" onClick={() => goTo(1)}>
        {t('backToList')}
      </Button>
      {failure ? (
        <Notice tone="danger">
          <p>{failure}</p>
          {errors.length ? (
            <ul className="mt-2 flex list-disc flex-col gap-1 pl-5">
              {errors.map((e, i) => (
                <li key={`${e.code}-${i}`}>
                  <LintIssueText issue={e} />
                </li>
              ))}
            </ul>
          ) : null}
        </Notice>
      ) : null}
      <Field
        id={`${id}-reason`}
        label={t('reason')}
        maxLength={REASON_MAX_LENGTH}
        value={reason}
        onChange={(event) => {
          setReason(event.currentTarget.value)
          // What is shown is about what is there now: a fixed reason loses its old error at once
          setReasonError(undefined)
        }}
        error={reasonError}
      />
      {warnings.length ? (
        <fieldset className="flex flex-col gap-2">
          <legend className="float-left mb-1 w-full font-semibold">{tDoa('detail.warningsTitle')}</legend>
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
              <WarningText warningKey={w} />
            </label>
          ))}
        </fieldset>
      ) : null}
      {boundaryTableId !== null ? (
        <BoundaryConfirm
          tableId={boundaryTableId}
          checked={boundaryTicked}
          onChange={(checked) => {
            setBoundaryTicked(checked)
            if (checked) setBoundaryError(undefined)
          }}
          error={boundaryError}
        />
      ) : null}
      <Button type="submit" disabled={action.pending || !signatory} className="self-start">
        {action.pending ? tDoa('detail.submitting') : t('submit')}
      </Button>
    </form>
  )
}
