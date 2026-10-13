'use client'

import { CalendarIcon } from 'lucide-react'
import { useLocale, useTranslations } from 'next-intl'
import { useId, useState, type ReactNode } from 'react'
import { enUS, th } from 'react-day-picker/locale'
import { BE_OFFSET, formatEnglishBeDay, formatThaiDay, isoDay, monthNamesShort, partsOf } from '@/core/thai/day'
import { Button } from '../../form/button'
import { Notice } from '../../form/notice'
import { Calendar } from '../../shadcn/calendar'
import { Input } from '../../shadcn/input'
import { Label } from '../../shadcn/label'
import { Popover, PopoverContent, PopoverTrigger } from '../../shadcn/popover'
import { Switch } from '../../shadcn/switch'
import type { ApOutcome } from './outcome'
import { SourceLabel } from './source-label'
import type { InvoiceFieldSource } from './types'
import { useApAction, useApErrorText } from './use-ap-action'

export interface HeaderValues {
  readonly supplierInvoiceNo: string
  /** yyyy-mm-dd, or '' while not given */
  readonly invoiceDate: string
  readonly priceIncludesVat: boolean
  /** Baht with 2 decimals */
  readonly discount: string
  readonly statedVat: string
  readonly isFinal: boolean
}

/**
 * The header of a draft invoice (FR-AP-101, BR-AP-03): the supplier's invoice number, its date (a calendar in a
 * popover, the year in the Buddhist era), whether its prices include VAT, the discount on the total, the VAT it states,
 * and whether it is the PO's last invoice. Only what the member changed is sent, so a value still as the file or the AI
 * gave it keeps its label ("เติมโดย AI โปรดตรวจ", "จาก e-Tax") until a person types over it; the version the page read
 * goes with it (CONFLICT_VERSION when someone else saved first). FINANCE's draft only; the service checks again.
 */
export function HeaderForm({
  invoiceId,
  version,
  values,
  sources,
  update,
}: {
  invoiceId: string
  version: number
  values: HeaderValues
  sources: Readonly<Record<string, InvoiceFieldSource>>
  update: (input: unknown, idempotencyKey: string) => Promise<ApOutcome>
}) {
  const t = useTranslations('apInvoice')
  const locale = useLocale() === 'en' ? 'en' : 'th'
  const errorText = useApErrorText()
  const action = useApAction()
  const id = useId()
  const [form, setForm] = useState<HeaderValues>(values)
  const [dateOpen, setDateOpen] = useState(false)
  const [saved, setSaved] = useState(false)
  const [nothing, setNothing] = useState(false)
  const labels = { AI_READING: t('source.AI_READING'), ETAX_XML: t('source.ETAX_XML') }
  const set = <K extends keyof HeaderValues>(key: K, value: HeaderValues[K]) => {
    setForm((f) => ({ ...f, [key]: value }))
    setSaved(false)
    setNothing(false)
  }

  const months = monthNamesShort(locale)
  const parts = form.invoiceDate ? partsOf(form.invoiceDate) : null
  const selected = parts ? new Date(parts.year, parts.month - 1, parts.date) : undefined
  const dayText = form.invoiceDate ? ((locale === 'en' ? formatEnglishBeDay(form.invoiceDate) : formatThaiDay(form.invoiceDate)) ?? form.invoiceDate) : t('header.pickDate')

  async function onSave() {
    const changed: Record<string, unknown> = {}
    if (form.supplierInvoiceNo.trim() !== values.supplierInvoiceNo) changed.supplierInvoiceNo = form.supplierInvoiceNo
    if (form.invoiceDate && form.invoiceDate !== values.invoiceDate) changed.invoiceDate = form.invoiceDate
    if (form.priceIncludesVat !== values.priceIncludesVat) changed.priceIncludesVat = form.priceIncludesVat
    if (form.discount.trim() !== values.discount) changed.discount = form.discount
    if (form.statedVat.trim() !== values.statedVat) changed.statedVat = form.statedVat
    if (form.isFinal !== values.isFinal) changed.isFinal = form.isFinal
    if (Object.keys(changed).length === 0) return setNothing(true)
    const outcome = await action.run((key) => update({ invoiceId, version, ...changed }, key))
    setSaved(outcome.ok)
  }

  const label = (field: string, text: string, htmlFor?: string): ReactNode => (
    <div className="flex flex-wrap items-center gap-2">
      {htmlFor ? (
        <Label htmlFor={htmlFor} className="text-base text-ink">
          {text}
        </Label>
      ) : (
        <span className="font-medium text-ink">{text}</span>
      )}
      <SourceLabel source={sources[field]} labels={labels} />
    </div>
  )

  return (
    <form
      className="flex flex-col gap-4"
      aria-label={t('header.title')}
      onSubmit={(e) => {
        e.preventDefault()
        void onSave()
      }}
    >
      <p className="text-ink-muted">{t('header.editHint')}</p>
      <div className="grid gap-4 md:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          {label('supplierInvoiceNo', t('header.supplierInvoiceNo'), `${id}-no`)}
          <Input id={`${id}-no`} value={form.supplierInvoiceNo} maxLength={60} onChange={(e) => set('supplierInvoiceNo', e.target.value)} className="h-11 text-base" />
        </div>
        <div className="flex flex-col gap-1.5">
          {label('invoiceDate', t('header.invoiceDate'), `${id}-date`)}
          <Popover open={dateOpen} onOpenChange={setDateOpen}>
            <PopoverTrigger asChild>
              <Button id={`${id}-date`} variant="secondary" className="justify-start font-normal">
                <CalendarIcon aria-hidden="true" className="size-4" />
                {dayText}
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-auto p-0">
              <Calendar
                mode="single"
                locale={locale === 'en' ? enUS : th}
                selected={selected}
                defaultMonth={selected}
                onSelect={(date) => {
                  if (!date) return
                  set('invoiceDate', isoDay(date.getFullYear(), date.getMonth() + 1, date.getDate()))
                  setDateOpen(false)
                }}
                formatters={{ formatCaption: (month) => `${months[month.getMonth()]} ${month.getFullYear() + BE_OFFSET}` }}
              />
            </PopoverContent>
          </Popover>
        </div>
        <div className="flex flex-col gap-1.5">
          {label('discount', t('header.discount'), `${id}-discount`)}
          <Input id={`${id}-discount`} inputMode="decimal" value={form.discount} maxLength={20} onChange={(e) => set('discount', e.target.value)} className="money h-11 text-base" />
        </div>
        <div className="flex flex-col gap-1.5">
          {label('statedVat', t('header.statedVat'), `${id}-vat`)}
          <Input id={`${id}-vat`} inputMode="decimal" value={form.statedVat} maxLength={20} onChange={(e) => set('statedVat', e.target.value)} className="money h-11 text-base" />
        </div>
        <div className="flex items-center gap-3">
          <Switch id={`${id}-incl`} checked={form.priceIncludesVat} onCheckedChange={(v) => set('priceIncludesVat', v)} />
          {label('priceIncludesVat', t('header.priceIncludesVat'), `${id}-incl`)}
        </div>
        <div className="flex items-center gap-3">
          <Switch id={`${id}-final`} checked={form.isFinal} onCheckedChange={(v) => set('isFinal', v)} />
          {label('isFinal', t('header.isFinal'), `${id}-final`)}
        </div>
      </div>
      <Button type="submit" className="self-start" disabled={action.pending} aria-busy={action.pending || undefined}>
        {action.pending ? t('header.saving') : t('header.save')}
      </Button>
      {nothing ? <Notice tone="info">{t('errors.NO_CHANGE')}</Notice> : null}
      {action.outcome && !action.outcome.ok ? <Notice tone="danger">{errorText(action.outcome)}</Notice> : null}
      {saved ? <Notice tone="success">{t('header.saved')}</Notice> : null}
    </form>
  )
}
