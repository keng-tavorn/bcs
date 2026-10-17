'use client'

import { useTranslations } from 'next-intl'
import { useId, useState, type FormEvent } from 'react'
import { FileButton } from '../finance/file-button'
import { Notice } from '../form/notice'
import { useSubmissionKey } from '../form/submission-key'
import { Button } from '../shadcn/button'
import { Checkbox } from '../shadcn/checkbox'
import { Label } from '../shadcn/label'
import { NativeSelect, NativeSelectOption } from '../shadcn/native-select'
import { useTaxFailureText } from './failure-text'
import { NO_ANSWER, type ExportOutcome } from './outcome'

// The monthly summary of ภ.ง.ด.3 or ภ.ง.ด.53 (S8-13 /finance/wht, FR-AP-104 AC4): month paid and form in native selects
// (one control that works the same on a phone, §9.10), and — only for a member with wht.revealTaxId — "รวมเลขบัตรเต็ม",
// which makes a file with individuals' national ids whole (every certificate in it logged by the service). The answer
// stays under the form: rows, total tax, the file's sha256 and its download (§9.9 rule 7).

type Export = (input: { month: string; form: 'PND3' | 'PND53'; revealTaxId: boolean }, idempotencyKey: string) => Promise<ExportOutcome>

export function WhtExportForm({
  months,
  canReveal,
  exportReturn,
  open,
}: {
  /** value YYYY-MM with its label in the reader's language, newest first */
  months: ReadonlyArray<{ readonly value: string; readonly label: string }>
  canReveal: boolean
  exportReturn: Export
  open: (fileId: string) => Promise<string | null>
}) {
  const t = useTranslations('apTax.wht')
  const failureText = useTaxFailureText()
  const id = useId()
  const submission = useSubmissionKey()
  const [month, setMonth] = useState(months[0]?.value ?? '')
  const [form, setForm] = useState<'PND3' | 'PND53'>('PND53')
  const [whole, setWhole] = useState(false)
  const [pending, setPending] = useState(false)
  const [outcome, setOutcome] = useState<ExportOutcome | null>(null)

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setPending(true)
    setOutcome(null)
    let result: ExportOutcome
    try {
      result = await exportReturn({ month, form, revealTaxId: canReveal && whole }, submission.key)
      submission.next()
    } catch {
      result = NO_ANSWER
    }
    setPending(false)
    setOutcome(result)
  }

  return (
    <div className="flex flex-col gap-4">
      <p className="text-ink-muted">{t('export.hint')}</p>
      <form onSubmit={(e) => void onSubmit(e)} className="flex flex-col gap-3 md:flex-row md:flex-wrap md:items-end">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${id}-month`} className="text-base">
            {t('export.month')}
          </Label>
          <NativeSelect id={`${id}-month`} value={month} onChange={(e) => setMonth(e.target.value)} className="w-full md:w-56 [&_select]:h-11 [&_select]:text-base lg:[&_select]:h-10">
            {months.map((m) => (
              <NativeSelectOption key={m.value} value={m.value}>
                {m.label}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${id}-form`} className="text-base">
            {t('export.form')}
          </Label>
          <NativeSelect id={`${id}-form`} value={form} onChange={(e) => setForm(e.target.value === 'PND3' ? 'PND3' : 'PND53')} className="w-full md:w-40 [&_select]:h-11 [&_select]:text-base lg:[&_select]:h-10">
            <NativeSelectOption value="PND53">{t('forms.PND53')}</NativeSelectOption>
            <NativeSelectOption value="PND3">{t('forms.PND3')}</NativeSelectOption>
          </NativeSelect>
        </div>
        {canReveal ? (
          <div className="flex w-full items-start gap-2">
            <Checkbox id={`${id}-whole`} checked={whole} onCheckedChange={(v) => setWhole(v === true)} aria-describedby={`${id}-whole-hint`} className="mt-1" />
            <div className="flex flex-col gap-0.5">
              <Label htmlFor={`${id}-whole`} className="text-base">
                {t('export.includeIds')}
              </Label>
              <p id={`${id}-whole-hint`} className="text-ink-muted">
                {t('export.includeIdsHint')}
              </p>
            </div>
          </div>
        ) : null}
        <Button type="submit" className="h-11 self-start text-base lg:h-10" disabled={pending || !month} aria-busy={pending || undefined}>
          {pending ? t('export.working') : t('export.submit')}
        </Button>
      </form>
      {outcome && !outcome.ok ? <Notice tone="danger">{failureText(outcome)}</Notice> : null}
      {outcome?.ok ? (
        <Notice tone="success">
          <div className="flex flex-col gap-1">
            <span className="font-medium">{t('export.done')}</span>
            <span>{`${t('export.rows', { count: outcome.rowCount })} · ${t('export.total', { amount: outcome.total })}`}</span>
            <span>
              {t('export.checksum')}: <span className="tabular break-all">{outcome.checksum}</span>
            </span>
            <FileButton fileId={outcome.fileId} label={t('export.download')} busyLabel={t('downloading')} failedText={t('downloadFailed')} open={open} />
          </div>
        </Notice>
      ) : null}
    </div>
  )
}
