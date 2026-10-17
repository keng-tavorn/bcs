'use client'

import { Plus } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { useId, useState, type FormEvent } from 'react'
import { StatusBadge } from '../document/badges'
import type { BadgeLook } from '../document/badge-looks'
import { Notice } from '../form/notice'
import { useSubmissionKey } from '../form/submission-key'
import { ListEmpty } from '../page/page'
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
import { Checkbox } from '../shadcn/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../shadcn/dialog'
import { Input } from '../shadcn/input'
import { Label } from '../shadcn/label'
import { NativeSelect, NativeSelectOption } from '../shadcn/native-select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../shadcn/table'
import { useTaxFailureText } from './failure-text'
import { NO_ANSWER, type TaxFailure, type TaxOutcome } from './outcome'

// The organization's income types (S8-13 /finance/wht/types, FR-AP-104 AC2, BR-WHT-03): code, name, rate, return form,
// in use or not, and the confirmation — "รอยืนยัน" until another FINANCE member confirms the rate after its last change
// (who changed it and who confirmed it, when). A member with wht.configure adds or changes a type in a Dialog they open
// (7 fields; the rate is typed as a percentage and the server turns the text into basis points) and confirms a rate in
// an AlertDialog; the member who changed it last sees why they cannot (the service refuses SOD_VIOLATION anyway).
// Phones get a list instead of the table (§9.9).

export const INCOME_TYPE_FORMS = ['PND3_53', 'PND53', 'PND3'] as const
export type IncomeTypeForm = (typeof INCOME_TYPE_FORMS)[number]

export interface IncomeTypeFormInput {
  readonly code: string
  readonly nameTh: string
  readonly nameEn: string
  /** A percentage as typed: "3", "1.5" */
  readonly rate: string
  readonly form: IncomeTypeForm
  readonly legalRefTh: string
  readonly active: boolean
}

export interface IncomeTypeRowView {
  readonly code: string
  /** In the reader's language */
  readonly name: string
  readonly nameTh: string
  readonly nameEn: string
  /** "3", "1.5" */
  readonly rate: string
  readonly form: IncomeTypeForm
  readonly legalRefTh: string
  readonly active: boolean
  readonly confirmed: boolean
  /** "ยืนยันโดย … · …" */
  readonly confirmedText: string | null
  /** "แก้ล่าสุดโดย …" */
  readonly changedText: string | null
  readonly changedByMe: boolean
}

type Save = (input: IncomeTypeFormInput, idempotencyKey: string) => Promise<TaxOutcome>
type Confirm = (input: { code: string }, idempotencyKey: string) => Promise<TaxOutcome>

const CONFIRMED: BadgeLook = { tone: 'ok', icon: 'CircleCheck' }
const WAITING: BadgeLook = { tone: 'warn', icon: 'Hourglass' }
const ACTIVE: BadgeLook = { tone: 'ok', icon: 'CircleCheck' }
const INACTIVE: BadgeLook = { tone: 'neutral', icon: 'Ban' }
const BLANK: IncomeTypeFormInput = { code: '', nameTh: '', nameEn: '', rate: '', form: 'PND3_53', legalRefTh: '', active: true }
const CONTROL = 'h-11 bg-bg text-base lg:h-10 md:text-base'

/** Runs one command with this form's submission key; a new key after each answer (spec §4.3) */
function useRun() {
  const router = useRouter()
  const submission = useSubmissionKey()
  const [pending, setPending] = useState(false)
  async function run(call: (key: string) => Promise<TaxOutcome>): Promise<TaxOutcome> {
    setPending(true)
    let outcome: TaxOutcome
    try {
      outcome = await call(submission.key)
      submission.next()
    } catch {
      outcome = NO_ANSWER
    }
    setPending(false)
    if (outcome.ok) router.refresh()
    return outcome
  }
  return { pending, run }
}

export function IncomeTypes({ rows, canConfigure, save, confirm }: { rows: readonly IncomeTypeRowView[]; canConfigure: boolean; save: Save; confirm: Confirm }) {
  const t = useTranslations('apTax.types')
  const failureText = useTaxFailureText()
  const confirming = useRun()
  const [editing, setEditing] = useState<{ readonly value: IncomeTypeFormInput; readonly isNew: boolean } | null>(null)
  const [done, setDone] = useState<string | null>(null)
  const [failure, setFailure] = useState<{ readonly code: string; readonly failure: TaxFailure } | null>(null)

  async function onConfirm(code: string) {
    setDone(null)
    setFailure(null)
    const outcome = await confirming.run((key) => confirm({ code }, key))
    if (outcome.ok) setDone(t('confirmed', { code }))
    else setFailure({ code, failure: outcome })
  }

  const open = (row: IncomeTypeRowView | null) => {
    setDone(null)
    setFailure(null)
    setEditing(row ? { isNew: false, value: { code: row.code, nameTh: row.nameTh, nameEn: row.nameEn, rate: row.rate, form: row.form, legalRefTh: row.legalRefTh, active: row.active } } : { isNew: true, value: BLANK })
  }

  const confirmation = (row: IncomeTypeRowView) => (
    <div className="flex flex-col items-start gap-1">
      <StatusBadge look={row.confirmed ? CONFIRMED : WAITING} label={row.confirmed ? t('confirmedBadge') : t('waiting')} />
      {row.confirmedText ? <span className="text-ink-muted">{row.confirmedText}</span> : null}
      {row.changedText ? <span className="text-ink-muted">{row.changedText}</span> : null}
    </div>
  )

  const actions = (row: IncomeTypeRowView) =>
    canConfigure ? (
      <div className="flex flex-wrap items-start gap-2">
        <Button variant="outline" className="min-h-11 lg:min-h-10" aria-label={t('editOf', { code: row.code })} onClick={() => open(row)}>
          {t('edit')}
        </Button>
        {!row.confirmed && row.changedByMe ? <span className="text-ink-muted">{t('changedByYou')}</span> : null}
        {!row.confirmed && !row.changedByMe ? (
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button className="min-h-11 lg:min-h-10" disabled={confirming.pending} aria-label={t('confirmOf', { code: row.code })}>
                {confirming.pending ? t('confirming') : t('confirm')}
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>{t('confirmTitle', { rate: row.rate, name: row.name })}</AlertDialogTitle>
                <AlertDialogDescription>{t('confirmBody')}</AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel className="min-h-11 text-base">{t('confirmKeep')}</AlertDialogCancel>
                <AlertDialogAction className="min-h-11 text-base" onClick={() => void onConfirm(row.code)}>
                  {t('confirm')}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        ) : null}
      </div>
    ) : null

  return (
    <div className="flex flex-col gap-3">
      {canConfigure ? (
        <Button className="min-h-11 self-start lg:min-h-10" onClick={() => open(null)}>
          <Plus aria-hidden="true" />
          {t('add')}
        </Button>
      ) : null}
      {done ? <Notice tone="success">{done}</Notice> : null}
      {failure ? <Notice tone="danger">{`${failure.code} · ${failureText(failure.failure)}`}</Notice> : null}
      {rows.length === 0 ? (
        <ListEmpty title={t('empty')} hint={t('emptyHint')} />
      ) : (
        <>
          <Table aria-label={t('list')} className="hidden text-base md:table md:text-sm">
            <TableHeader>
              <TableRow>
                <TableHead>{t('columns.code')}</TableHead>
                <TableHead>{t('columns.name')}</TableHead>
                <TableHead className="text-right">{t('columns.rate')}</TableHead>
                <TableHead>{t('columns.form')}</TableHead>
                <TableHead>{t('columns.active')}</TableHead>
                <TableHead>{t('columns.confirmation')}</TableHead>
                {canConfigure ? <TableHead>{t('columns.actions')}</TableHead> : null}
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={row.code}>
                  <TableCell className="align-top">{row.code}</TableCell>
                  <TableCell className="align-top whitespace-normal">
                    {row.name}
                    {row.legalRefTh ? <span className="block text-ink-muted">{row.legalRefTh}</span> : null}
                  </TableCell>
                  <TableCell className="tabular text-right align-top">{t('rate', { rate: row.rate })}</TableCell>
                  <TableCell className="align-top whitespace-normal">{t(`forms.${row.form}`)}</TableCell>
                  <TableCell className="align-top">
                    <StatusBadge look={row.active ? ACTIVE : INACTIVE} label={row.active ? t('active') : t('inactive')} />
                  </TableCell>
                  <TableCell className="align-top whitespace-normal">{confirmation(row)}</TableCell>
                  {canConfigure ? <TableCell className="align-top whitespace-normal">{actions(row)}</TableCell> : null}
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <ul aria-label={t('list')} className="flex flex-col divide-y divide-line border-y border-line md:hidden">
            {rows.map((row) => (
              <li key={row.code} className="flex flex-col gap-1.5 py-3">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="font-medium">{`${row.code} · ${row.name}`}</span>
                  <span className="tabular font-medium">{t('rate', { rate: row.rate })}</span>
                </div>
                <span className="text-ink-muted">{t(`forms.${row.form}`)}</span>
                <StatusBadge look={row.active ? ACTIVE : INACTIVE} label={row.active ? t('active') : t('inactive')} />
                {confirmation(row)}
                {actions(row)}
              </li>
            ))}
          </ul>
        </>
      )}
      {editing ? (
        <IncomeTypeDialog
          key={`${editing.value.code}-${editing.isNew}`}
          initial={editing.value}
          isNew={editing.isNew}
          save={save}
          onClose={() => setEditing(null)}
          onSaved={(code) => {
            setEditing(null)
            setDone(t('form.saved', { code }))
          }}
        />
      ) : null}
    </div>
  )
}

function IncomeTypeDialog({ initial, isNew, save, onClose, onSaved }: { initial: IncomeTypeFormInput; isNew: boolean; save: Save; onClose: () => void; onSaved: (code: string) => void }) {
  const t = useTranslations('apTax.types.form')
  const tt = useTranslations('apTax.types')
  const failureText = useTaxFailureText()
  const id = useId()
  const saving = useRun()
  const [value, setValue] = useState<IncomeTypeFormInput>(initial)
  const [failure, setFailure] = useState<TaxFailure | null>(null)
  const set = <K extends keyof IncomeTypeFormInput>(key: K, v: IncomeTypeFormInput[K]) => setValue((old) => ({ ...old, [key]: v }))

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setFailure(null)
    const outcome = await saving.run((key) => save(value, key))
    if (outcome.ok) onSaved(value.code.trim().toUpperCase())
    else setFailure(outcome)
  }

  const field = (name: 'code' | 'nameTh' | 'nameEn' | 'rate' | 'legalRefTh', label: string, options: { hint?: string; required?: boolean; disabled?: boolean; inputMode?: 'decimal' } = {}) => (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={`${id}-${name}`} className="text-base">
        {label}
      </Label>
      <Input
        id={`${id}-${name}`}
        value={value[name]}
        onChange={(e) => set(name, e.target.value)}
        required={options.required}
        disabled={options.disabled}
        inputMode={options.inputMode}
        aria-describedby={options.hint ? `${id}-${name}-hint` : undefined}
        aria-invalid={failure?.field === name.toUpperCase() || (name === 'nameTh' && failure?.field === 'NAME') || undefined}
        className={CONTROL}
      />
      {options.hint ? (
        <p id={`${id}-${name}-hint`} className="text-ink-muted">
          {options.hint}
        </p>
      ) : null}
    </div>
  )

  return (
    <Dialog open onOpenChange={(next) => (next ? null : onClose())}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{isNew ? t('titleNew') : t('titleEdit', { code: initial.code })}</DialogTitle>
          <DialogDescription>{t('description')}</DialogDescription>
        </DialogHeader>
        <form id={`${id}-form`} onSubmit={(e) => void onSubmit(e)} className="flex flex-col gap-3">
          {field('code', t('code'), { hint: t('codeHint'), required: true, disabled: !isNew })}
          {field('nameTh', t('nameTh'), { required: true })}
          {field('nameEn', t('nameEn'))}
          {field('rate', t('rate'), { hint: t('rateHint'), required: true, inputMode: 'decimal' })}
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`${id}-form-select`} className="text-base">
              {t('formLabel')}
            </Label>
            <NativeSelect id={`${id}-form-select`} value={value.form} onChange={(e) => set('form', (INCOME_TYPE_FORMS as readonly string[]).includes(e.target.value) ? (e.target.value as IncomeTypeForm) : 'PND3_53')} className="w-full [&_select]:h-11 [&_select]:text-base lg:[&_select]:h-10">
              {INCOME_TYPE_FORMS.map((f) => (
                <NativeSelectOption key={f} value={f}>
                  {tt(`forms.${f}`)}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </div>
          {field('legalRefTh', t('legalRef'))}
          <div className="flex items-center gap-2">
            <Checkbox id={`${id}-active`} checked={value.active} onCheckedChange={(v) => set('active', v === true)} />
            <Label htmlFor={`${id}-active`} className="text-base">
              {t('active')}
            </Label>
          </div>
          {failure ? <Notice tone="danger">{failureText(failure)}</Notice> : null}
        </form>
        <DialogFooter>
          <Button type="button" variant="outline" className="min-h-11 lg:min-h-10" onClick={onClose}>
            {t('cancel')}
          </Button>
          <Button type="submit" form={`${id}-form`} className="min-h-11 lg:min-h-10" disabled={saving.pending} aria-busy={saving.pending || undefined}>
            {saving.pending ? t('saving') : t('save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
