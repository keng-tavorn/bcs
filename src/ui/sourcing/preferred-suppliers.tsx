'use client'

import { CircleAlert, Plus } from 'lucide-react'
import Link from 'next/link'
import { useLocale, useTranslations } from 'next-intl'
import { useId, useState, type FormEvent, type ReactNode } from 'react'
import { toast } from 'sonner'
import { formatEnglishBeDate, formatThaiDate } from '@/core/thai/date'
import { useAction } from '../admin-org/use-action'
import { lastDayOf, validDay } from '../catalog/model'
import { StatusBadge } from '../document/badges'
import { Notice } from '../form/notice'
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '../shadcn/alert-dialog'
import { Button } from '../shadcn/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../shadcn/dialog'
import { Input } from '../shadcn/input'
import { Label } from '../shadcn/label'
import { NativeSelect, NativeSelectOption } from '../shadcn/native-select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../shadcn/table'
import { Textarea } from '../shadcn/textarea'
import {
  AT_RISK_LOOK,
  atRiskCauses,
  endReasonReady,
  INACTIVE_SUPPLIER_LOOK,
  isOneOf,
  newPreferredErrors,
  PREFERRED_REASON_MAX,
  PREFERRED_REASON_MIN,
  PREFERRED_STATUS_LOOK,
  preferredErrorField,
  preferredErrorKey,
  RISK_STATUSES,
  RISK_TIER_LOOK,
  RISK_TIERS,
  type EndPreferredInput,
  type NewPreferredField,
  type NewPreferredInput,
  type PreferredFailure,
  type PreferredOutcome,
  type PreferredRowView,
  type PreferredSupplierChoice,
} from './preferred-model'

// /suppliers/preferred (S10-13 · BR-RFX-14 · ADR-207): the preferred suppliers per category — a table on wide screens and
// a list on phones, so nothing scrolls sideways (§9.9) — each with its source (the award AWD-… linked to its award page
// for whoever reads every RFx, or set by procurement with its reason), its first and last day, its standing as a badge
// with an icon and a word (ending soon within the warning days), and with RISK on its tier and the badge "แนะนำแต่ติด
// ความเสี่ยง" (BR-RFX-14). Procurement sets one in a Dialog and ends one after an Alert Dialog with its reason (it cannot
// be undone); both open only when their button is pressed (NG-13), and a refusal is said inside them, beside the field
// it is about when there is one (§9.9 rule 7). The commands of preferred.ts check everything again.

export interface PreferredActions {
  readonly create: (input: NewPreferredInput, idempotencyKey: string) => Promise<PreferredOutcome<{ preferredSupplierId: string }>>
  readonly end: (input: EndPreferredInput, idempotencyKey: string) => Promise<PreferredOutcome<{ preferredSupplierId: string }>>
}

type T = ReturnType<typeof useTranslations<'preferredSuppliers'>>

const dayIn = (locale: string, d: string) => (locale === 'en' ? formatEnglishBeDate(d) : formatThaiDate(d))
const nameIn = (locale: string, n: { readonly th: string; readonly en: string | null }) => (locale === 'en' && n.en ? n.en : n.th)
const CONTROL = 'w-full [&_select]:h-11 [&_select]:bg-bg [&_select]:text-base lg:[&_select]:h-10'

/** The words of a refusal: the day an overlapping row runs to (its last day, included), the reference support asks for */
function failureText(t: T, locale: string, f: PreferredFailure): string {
  const lastDay = f.validTo && validDay(f.validTo) ? dayIn(locale, lastDayOf(f.validTo)) : '-'
  return t(`errors.${preferredErrorKey(f)}`, { requestId: f.requestId ?? '-', lastDay })
}

/** A label, its control, a hint and an error said with an icon and words (never colour alone), tied to the control */
function FormRow({
  id,
  label,
  hint,
  error,
  children,
}: {
  id: string
  label: string
  hint?: string
  error?: string
  children: (a11y: { readonly id: string; readonly 'aria-describedby'?: string; readonly 'aria-invalid'?: true }) => ReactNode
}) {
  const hintId = hint ? `${id}-hint` : undefined
  const errorId = error ? `${id}-error` : undefined
  const describedBy = [hintId, errorId].filter(Boolean).join(' ') || undefined
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id} className="text-base font-medium text-ink">
        {label}
      </Label>
      {children({ id, ...(describedBy ? { 'aria-describedby': describedBy } : {}), ...(error ? { 'aria-invalid': true as const } : {}) })}
      {hint ? (
        <p id={hintId} className="text-base text-ink-muted md:text-sm">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={errorId} className="flex items-start gap-1.5 text-base text-danger md:text-sm">
          <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          <span>{error}</span>
        </p>
      ) : null}
    </div>
  )
}

// ---------- "ตั้งผู้ขายที่แนะนำ" ----------

export interface SetPreferredProps {
  readonly categories: readonly string[]
  readonly suppliers: readonly PreferredSupplierChoice[]
  /** YYYY-MM-DD: the Thai calendar day, the earliest first day */
  readonly today: string
  /** The period a blank last day gives (preferredSupplierDays) */
  readonly defaultDays: number
  /** The category the page is filtered by, chosen at the start */
  readonly initialCategory: string | null
  readonly create: PreferredActions['create']
}

/** The page's main action: the set form in a Dialog, drawn while open so each opening starts blank */
export function SetPreferredButton(props: SetPreferredProps) {
  const t = useTranslations('preferredSuppliers')
  const [open, setOpen] = useState(false)
  return (
    <>
      <Button className="min-h-11 px-4 lg:min-h-10" onClick={() => setOpen(true)}>
        <Plus aria-hidden="true" />
        {t('create.open')}
      </Button>
      {open ? <SetPreferredDialog {...props} onClose={() => setOpen(false)} /> : null}
    </>
  )
}

function SetPreferredDialog({ categories, suppliers, today, defaultDays, initialCategory, create, onClose }: SetPreferredProps & { readonly onClose: () => void }) {
  const t = useTranslations('preferredSuppliers')
  const locale = useLocale()
  const id = useId()
  const action = useAction()
  const [values, setValues] = useState<NewPreferredInput>(() => ({
    categoryCode: initialCategory && categories.includes(initialCategory) ? initialCategory : '',
    supplierId: '',
    validFrom: today,
    lastDay: '',
    note: '',
  }))
  const [checked, setChecked] = useState(false)
  const [failure, setFailure] = useState<PreferredFailure | null>(null)
  const errors = checked ? newPreferredErrors(values, today) : {}
  const serverField = failure ? preferredErrorField(failure) : null
  const set = (key: keyof NewPreferredInput, value: string) => {
    setValues((v) => ({ ...v, [key]: value }))
    setFailure(null)
  }
  const errorOf = (field: NewPreferredField): string | undefined => {
    const own = errors[field]
    if (own) return t(`errors.${own}`)
    return failure && serverField === field ? failureText(t, locale, failure) : undefined
  }
  const withDay = (hint: string, day: string) => (validDay(day) ? t('create.chosen', { hint, date: dayIn(locale, day) }) : hint)

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setChecked(true)
    setFailure(null)
    if (Object.keys(newPreferredErrors(values, today)).length > 0) return
    const outcome = await action.run((key) => create({ ...values, note: values.note.trim() }, key))
    if (outcome.ok) {
      onClose()
      toast.success(t('create.done'))
      action.done()
      return
    }
    setFailure(outcome)
  }

  const cannot = categories.length === 0 || suppliers.length === 0
  return (
    <Dialog open onOpenChange={(next) => (next || action.pending ? null : onClose())}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto p-6 sm:max-w-160">
        <DialogHeader>
          <DialogTitle className="text-xl font-semibold">{t('create.title')}</DialogTitle>
          <DialogDescription className="text-base text-ink-muted md:text-sm">{t('create.intro')}</DialogDescription>
        </DialogHeader>
        {cannot ? (
          <div className="flex flex-col gap-3">
            {categories.length === 0 ? <Notice tone="warning">{t('create.noCategories')}</Notice> : null}
            {suppliers.length === 0 ? <Notice tone="warning">{t('create.noSuppliers')}</Notice> : null}
            <Button variant="outline" className="min-h-11 self-end px-4 lg:min-h-10" onClick={onClose}>
              {t('create.cancel')}
            </Button>
          </div>
        ) : (
          <form noValidate className="flex flex-col gap-4" onSubmit={(e) => void onSubmit(e)}>
            {failure && !serverField ? <Notice tone="danger">{failureText(t, locale, failure)}</Notice> : null}
            <FormRow id={`${id}-category`} label={t('create.category')} hint={t('create.categoryHint')} error={errorOf('categoryCode')}>
              {(a11y) => (
                <NativeSelect {...a11y} className={CONTROL} value={values.categoryCode} required onChange={(e) => set('categoryCode', e.currentTarget.value)}>
                  <NativeSelectOption value="">{t('create.categoryChoose')}</NativeSelectOption>
                  {categories.map((c) => (
                    <NativeSelectOption key={c} value={c}>
                      {c}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
              )}
            </FormRow>
            <FormRow id={`${id}-supplier`} label={t('create.supplier')} error={errorOf('supplierId')}>
              {(a11y) => (
                <NativeSelect {...a11y} className={CONTROL} value={values.supplierId} required onChange={(e) => set('supplierId', e.currentTarget.value)}>
                  <NativeSelectOption value="">{t('create.supplierChoose')}</NativeSelectOption>
                  {suppliers.map((s) => (
                    <NativeSelectOption key={s.id} value={s.id}>
                      {t('create.supplierOption', { code: s.code, name: nameIn(locale, { th: s.nameTh, en: s.nameEn }) })}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
              )}
            </FormRow>
            <div className="grid gap-4 sm:grid-cols-2">
              <FormRow id={`${id}-from`} label={t('create.validFrom')} hint={withDay(t('create.validFromHint'), values.validFrom)} error={errorOf('validFrom')}>
                {(a11y) => <Input {...a11y} type="date" className="h-11 bg-bg text-base lg:h-10" value={values.validFrom} min={today} required onChange={(e) => set('validFrom', e.currentTarget.value)} />}
              </FormRow>
              <FormRow id={`${id}-last`} label={t('create.lastDay')} hint={withDay(t('create.lastDayHint', { days: defaultDays }), values.lastDay)} error={errorOf('lastDay')}>
                {(a11y) => <Input {...a11y} type="date" className="h-11 bg-bg text-base lg:h-10" value={values.lastDay} min={values.validFrom || today} onChange={(e) => set('lastDay', e.currentTarget.value)} />}
              </FormRow>
            </div>
            <FormRow id={`${id}-note`} label={t('create.note')} hint={t('create.noteHint', { min: PREFERRED_REASON_MIN })} error={errorOf('note')}>
              {(a11y) => <Textarea {...a11y} className="bg-bg text-base" value={values.note} maxLength={PREFERRED_REASON_MAX} required onChange={(e) => set('note', e.currentTarget.value)} />}
            </FormRow>
            <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
              <Button variant="outline" className="min-h-11 px-4 lg:min-h-10" onClick={onClose} disabled={action.pending}>
                {t('create.cancel')}
              </Button>
              <Button type="submit" className="min-h-11 px-4 lg:min-h-10" disabled={action.pending} aria-busy={action.pending || undefined}>
                {action.pending ? t('create.saving') : t('create.save')}
              </Button>
            </div>
          </form>
        )}
      </DialogContent>
    </Dialog>
  )
}

// ---------- "สิ้นสุด" ----------

/** Asks first, with the reason (it cannot be undone), then the row is no longer in effect from now on */
function EndPreferred({ row, end }: { readonly row: PreferredRowView; readonly end: PreferredActions['end'] }) {
  const t = useTranslations('preferredSuppliers')
  const locale = useLocale()
  const id = useId()
  const action = useAction()
  const [open, setOpen] = useState(false)
  const [reason, setReason] = useState('')
  const [checked, setChecked] = useState(false)
  const [failure, setFailure] = useState<PreferredFailure | null>(null)
  const missing = checked && !endReasonReady(reason)
  const names = { code: row.supplierCode, category: row.categoryCode }

  function onOpenChange(next: boolean) {
    if (action.pending) return
    setOpen(next)
    if (!next) {
      setFailure(null)
      setChecked(false)
    }
  }

  async function onConfirm(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setChecked(true)
    setFailure(null)
    if (!endReasonReady(reason)) return
    const outcome = await action.run((key) => end({ preferredSupplierId: row.id, reason: reason.trim() }, key))
    if (outcome.ok) {
      setOpen(false)
      setReason('')
      setChecked(false)
      toast.success(t('end.done'))
      action.done()
      return
    }
    setFailure(outcome)
  }

  const hintId = `${id}-hint`
  const errorId = `${id}-error`
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogTrigger asChild>
        <Button variant="outline" className="min-h-11 border-danger px-4 text-danger hover:text-danger lg:min-h-10" aria-label={t('end.openLabel', names)}>
          {t('end.open')}
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent className="max-h-[90dvh] overflow-y-auto">
        <form noValidate className="grid gap-4" onSubmit={(e) => void onConfirm(e)}>
          <AlertDialogHeader>
            <AlertDialogTitle className="text-lg font-semibold text-ink">{t('end.title', names)}</AlertDialogTitle>
            <AlertDialogDescription className="text-base text-ink-muted">{t('end.body', names)}</AlertDialogDescription>
          </AlertDialogHeader>
          {failure ? <Notice tone="danger">{failureText(t, locale, failure)}</Notice> : null}
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`${id}-reason`} className="text-base font-medium text-ink">
              {t('end.reason')}
            </Label>
            <Textarea
              id={`${id}-reason`}
              className="bg-bg text-base"
              value={reason}
              maxLength={PREFERRED_REASON_MAX}
              required
              aria-invalid={missing || undefined}
              aria-describedby={missing ? `${hintId} ${errorId}` : hintId}
              onChange={(e) => {
                setReason(e.currentTarget.value)
                setFailure(null)
              }}
            />
            <p id={hintId} className="text-base text-ink-muted md:text-sm">
              {t('end.reasonHint', { min: PREFERRED_REASON_MIN })}
            </p>
            {missing ? (
              <p id={errorId} className="flex items-start gap-1.5 text-base text-danger md:text-sm">
                <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
                <span>{t('errors.REASON')}</span>
              </p>
            ) : null}
          </div>
          <AlertDialogFooter className="gap-3">
            <AlertDialogCancel className="min-h-11 px-4 lg:min-h-10" disabled={action.pending}>
              {t('end.keep')}
            </AlertDialogCancel>
            <Button type="submit" variant="destructive" className="min-h-11 px-4 lg:min-h-10" disabled={action.pending} aria-busy={action.pending || undefined}>
              {action.pending ? t('end.saving') : t('end.confirm')}
            </Button>
          </AlertDialogFooter>
        </form>
      </AlertDialogContent>
    </AlertDialog>
  )
}

// ---------- the rows ----------

function SupplierCell({ row, riskOn }: { readonly row: PreferredRowView; readonly riskOn: boolean }) {
  const t = useTranslations('preferredSuppliers')
  const locale = useLocale()
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <Link href={`/suppliers/${row.supplierId}`} className="font-semibold break-words text-primary underline underline-offset-4 hover:no-underline">
        {t('row.supplier', { code: row.supplierCode, name: nameIn(locale, row.supplierName) })}
      </Link>
      {!row.supplierActive ? <StatusBadge look={INACTIVE_SUPPLIER_LOOK} label={t('row.inactive')} className="self-start" /> : null}
      {riskOn && row.risk ? <RiskBadges row={row} /> : null}
    </div>
  )
}

/** With RISK on: the tier and status of S11 as a fact, and BR-RFX-14's "recommended but at risk" with why */
function RiskBadges({ row }: { readonly row: PreferredRowView }) {
  const t = useTranslations('preferredSuppliers')
  const risk = row.risk
  if (!risk) return null
  const tier = isOneOf(RISK_TIERS, risk.tier) ? t(`risk.tierName.${risk.tier}`) : risk.tier
  const status = isOneOf(RISK_STATUSES, risk.status) ? t(`risk.status.${risk.status}`) : risk.status
  const tierLabel = tier ? (status ? t('risk.tierStatus', { tier, status }) : t('risk.tier', { tier })) : t('risk.notAssessed')
  const causes = atRiskCauses(row)
  const why = [causes.status ? t(`risk.status.${causes.status}`) : null, causes.flag ? t(`risk.flag.${causes.flag}`) : null].filter((w): w is string => Boolean(w)).join(' · ')
  return (
    <div className="flex flex-col items-start gap-1">
      <StatusBadge look={RISK_TIER_LOOK} label={tierLabel} />
      {row.riskExempt ? (
        <>
          <StatusBadge look={AT_RISK_LOOK} label={t('risk.atRisk', { why })} />
          <span className="text-base text-ink-muted md:text-sm">{t('risk.exempt')}</span>
        </>
      ) : null}
    </div>
  )
}

function SourceCell({ row, awardLinks }: { readonly row: PreferredRowView; readonly awardLinks: boolean }) {
  const t = useTranslations('preferredSuppliers')
  if (row.source === 'SOURCING' && row.award) {
    const text = row.award.number ? t('row.fromAward', { award: row.award.number }) : t('row.fromAwardPending')
    return awardLinks ? (
      <Link href={`/sourcing/${row.award.rfxEventId}/award`} className="break-words text-primary underline underline-offset-4 hover:no-underline">
        {text}
      </Link>
    ) : (
      <span className="break-words text-ink">{text}</span>
    )
  }
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <span className="text-ink">{t('row.manual')}</span>
      {row.note ? <span className="text-base break-words text-ink-muted md:text-sm">{t('row.note', { note: row.note })}</span> : null}
    </div>
  )
}

function StatusCell({ row }: { readonly row: PreferredRowView }) {
  const t = useTranslations('preferredSuppliers')
  const locale = useLocale()
  const label =
    row.status === 'ENDING_SOON'
      ? t('status.ENDING_SOON', { days: row.daysLeft ?? 0 })
      : row.status === 'UPCOMING'
        ? t('status.UPCOMING', { date: dayIn(locale, row.validFrom) })
        : t(`status.${row.status}`)
  return (
    <div className="flex min-w-0 flex-col items-start gap-1">
      <StatusBadge look={PREFERRED_STATUS_LOOK[row.status]} label={label} />
      {row.ended ? (
        <>
          <span className="text-base text-ink-muted md:text-sm">{t('row.endedAt', { at: dayIn(locale, row.ended.at) })}</span>
          {row.ended.reason ? <span className="text-base break-words text-ink-muted md:text-sm">{t('row.endReason', { reason: row.ended.reason })}</span> : null}
        </>
      ) : null}
    </div>
  )
}

export function PreferredList({
  rows,
  riskOn,
  awardLinks,
  end,
}: {
  readonly rows: readonly PreferredRowView[]
  readonly riskOn: boolean
  readonly awardLinks: boolean
  /** Only for a reader who may end one (sourcing.preferred.manage) */
  readonly end: PreferredActions['end'] | null
}) {
  const t = useTranslations('preferredSuppliers')
  const locale = useLocale()
  const withActions = end !== null && rows.some((r) => r.canEnd)
  const period = (row: PreferredRowView) => t('row.period', { from: dayIn(locale, row.validFrom), to: dayIn(locale, row.lastDay) })
  const rowLabel = (row: PreferredRowView) => t('row.label', { category: row.categoryCode, code: row.supplierCode, name: nameIn(locale, row.supplierName) })
  return (
    <>
      <div className="hidden lg:block">
        <Table aria-label={t('listLabel')} className="text-base md:text-sm">
          <TableHeader>
            <TableRow>
              <TableHead>{t('col.category')}</TableHead>
              <TableHead>{t('col.supplier')}</TableHead>
              <TableHead>{t('col.source')}</TableHead>
              <TableHead>{t('col.period')}</TableHead>
              <TableHead>{t('col.status')}</TableHead>
              {withActions ? (
                <TableHead>
                  <span className="sr-only">{t('col.actions')}</span>
                </TableHead>
              ) : null}
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={row.id}>
                <TableCell className="align-top font-medium">{row.categoryCode}</TableCell>
                <TableCell className="align-top whitespace-normal">
                  <SupplierCell row={row} riskOn={riskOn} />
                </TableCell>
                <TableCell className="align-top whitespace-normal">
                  <SourceCell row={row} awardLinks={awardLinks} />
                </TableCell>
                <TableCell className="tabular align-top whitespace-normal">{period(row)}</TableCell>
                <TableCell className="align-top whitespace-normal">
                  <StatusCell row={row} />
                </TableCell>
                {withActions ? <TableCell className="align-top text-right">{row.canEnd && end ? <EndPreferred row={row} end={end} /> : null}</TableCell> : null}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      <ul aria-label={t('listLabel')} className="flex flex-col divide-y divide-line lg:hidden">
        {rows.map((row) => (
          <li key={row.id} aria-label={rowLabel(row)} className="flex flex-col gap-2 py-3">
            <span className="text-base text-ink-muted">
              {t('col.category')} {row.categoryCode}
            </span>
            <SupplierCell row={row} riskOn={riskOn} />
            <SourceCell row={row} awardLinks={awardLinks} />
            <span className="tabular text-ink">{period(row)}</span>
            <StatusCell row={row} />
            {row.canEnd && end ? (
              <div>
                <EndPreferred row={row} end={end} />
              </div>
            ) : null}
          </li>
        ))}
      </ul>
    </>
  )
}
