'use client'

import { FileText, Paperclip } from 'lucide-react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { useEffect, useId, useRef, useState, type ChangeEvent, type FormEvent, type ReactNode } from 'react'
import { Button } from '../form/button'
import { Field } from '../form/field'
import { Notice } from '../form/notice'
import { useSubmissionKey } from '../form/submission-key'
import { StateLine } from '../request-view/status'
import { ETAX_MAX_BYTES } from './limits'
import { addAmounts, cleanAmount, isIsoDay, sameAmount, showAmount } from './money'
import { etaxOutcomeOf, financeErrorKey, financeErrorValues, NO_ANSWER, type EtaxOutcome, type FinanceFailure, type PreviewOutcome, type RecordOutcome } from './outcome'
import type { BudgetMoveView, EtaxPrefillView, EtaxProblemKey, GiveBackView, InvoiceDoneView, InvoiceFormInput, InvoicePartView, InvoicePreviewView } from './types'

// Recording a supplier's invoice against a PO (FR-P2P-008, BR-IVC-01 to BR-IVC-05, demo scene 13). Two real steps,
// because recording moves budget and FINANCE cannot undo it: (1) the invoice — an e-Tax file (a PDF/A-3 with its XML,
// or the XML) is read by the server and fills number, date, amount before VAT and VAT for FINANCE to check (AC4); a file
// that cannot be read, or whose seller is not the PO's supplier, is explained in plain words and the form is typed by
// hand; (2) what will happen, calculated by the server before anything is written (§9.9 principle 3): the VAT against
// the PO's rate (a warning beyond 1.00 baht, BR-IVC-01), how the amount is shared over the PO lines (BR-IVC-04), the
// budget that moves from committed to actual on each budget line (AC2), what a last invoice gives back (AC3), and
// whether the invoice counts as read from its e-Tax file — the server decides that from the stored file, the page only
// sends which file goes with the invoice. Confirming records it; the server checks every rule again.

export interface InvoiceFormActions {
  readonly preview: (input: InvoiceFormInput) => Promise<PreviewOutcome>
  readonly record: (input: InvoiceFormInput, idempotencyKey: string) => Promise<RecordOutcome>
}

export interface InvoiceFormProps {
  readonly poId: string
  /** An invoice may be recorded on the PO now */
  readonly open: boolean
  /** The PO's supplier, as the e-Tax reader compares the file's seller with it (branch: the register's 5 digits) */
  readonly supplier: { readonly name: string; readonly taxId: string | null; readonly branch: string }
  /** The PO's VAT rate in percent ("7"), or null */
  readonly vatRate: string | null
  /** Where the e-Tax file is posted */
  readonly etaxUrl: string
  readonly listHref: string
  readonly actions: InvoiceFormActions
}

interface Values {
  readonly invoiceNo: string
  readonly invoiceDate: string
  readonly net: string
  readonly vat: string
  readonly isFinal: boolean
}

type FieldKey = 'invoiceNo' | 'invoiceDate' | 'net' | 'vat'
type FieldErrors = Partial<Record<FieldKey, string>>

interface FileState {
  readonly fileId: string
  readonly fileName: string
  readonly prefill: EtaxPrefillView | null
  readonly problems: readonly EtaxProblemKey[]
  /** The file goes with the invoice (not when its seller is another supplier) */
  readonly kept: boolean
}

type Reading = { readonly kind: 'idle' } | { readonly kind: 'busy'; readonly name: string } | { readonly kind: 'failed'; readonly name: string; readonly failure: FinanceFailure }

const EMPTY: Values = { invoiceNo: '', invoiceDate: '', net: '', vat: '', isFinal: false }
const ETAX_ACCEPT = '.pdf,.xml,application/pdf,application/xml,text/xml'
const linkClass = 'inline-flex min-h-11 items-center font-medium text-primary underline underline-offset-4 hover:no-underline'
/** The check and the answer, with their facts, shares, budget moves and notices, end at one right edge (money lines up, §9.9) */
const listWidth = 'w-full max-w-2xl'
// The main action stays at the bottom of a phone screen while the form scrolls; on wide screens it follows the form
const barClass = 'sticky bottom-0 z-10 -mx-4 flex flex-col gap-3 border-t border-line bg-bg px-4 py-3 sm:flex-row sm:items-center lg:static lg:mx-0 lg:border-0 lg:px-0 lg:py-0'

/** Where a server failure belongs on step 1: under a field, or in the form's notice */
function fieldOfFailure(failure: FinanceFailure): FieldKey | null {
  if (failure.code === 'DUPLICATE_INVOICE') return 'invoiceNo'
  if (failure.code === 'INVOICE_EXCEEDS_COMMITTED') return 'net'
  if (failure.code !== 'VALIDATION_FAILED') return null
  if (failure.reason === 'AMOUNT_NOT_POSITIVE') return 'net'
  return failure.field === 'invoiceNo' || failure.field === 'invoiceDate' || failure.field === 'net' || failure.field === 'vat' ? failure.field : null
}

export function InvoiceForm({ poId, open, supplier, vatRate, etaxUrl, listHref, actions }: InvoiceFormProps) {
  const t = useTranslations('finance.form')
  const tErrors = useTranslations('finance.errors')
  const router = useRouter()
  const id = useId()
  const submission = useSubmissionKey()

  const [values, setValues] = useState<Values>(EMPTY)
  const [file, setFile] = useState<FileState | null>(null)
  const [reading, setReading] = useState<Reading>({ kind: 'idle' })
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({})
  const [failure, setFailure] = useState<FinanceFailure | null>(null)
  const [step, setStep] = useState<'enter' | 'review' | 'done'>('enter')
  const [preview, setPreview] = useState<InvoicePreviewView | null>(null)
  const [done, setDone] = useState<InvoiceDoneView | null>(null)
  const [pending, setPending] = useState(false)
  const headingRef = useRef<HTMLHeadingElement>(null)
  const doneRef = useRef<HTMLElement>(null)

  // A new step takes focus at its top, so a phone user sees it from its start and a screen reader reads it first —
  // above all the answer once the invoice is recorded (as the request form does)
  const firstRender = useRef(true)
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false
      return
    }
    const target = step === 'done' ? doneRef.current : headingRef.current
    target?.focus({ preventScroll: true })
    // From the step's first line ("ขั้น 2 จาก 2"), not from its heading
    const top = target?.closest('form') ?? target
    top?.scrollIntoView({ block: 'start' })
  }, [step])

  const errorText = (f: FinanceFailure) => tErrors(financeErrorKey(f), financeErrorValues(f))

  function update(patch: Partial<Values>) {
    setValues((v) => ({ ...v, ...patch }))
    // An error goes as soon as its field is being fixed
    setFieldErrors((e) => {
      const next = { ...e }
      for (const key of Object.keys(patch)) delete next[key as FieldKey]
      return next
    })
    setFailure(null)
  }

  async function onFile(event: ChangeEvent<HTMLInputElement>) {
    const chosen = event.currentTarget.files?.[0]
    event.currentTarget.value = ''
    if (!chosen) return
    setFailure(null)
    if (chosen.size === 0) return setReading({ kind: 'failed', name: chosen.name, failure: { ok: false, code: 'VALIDATION_FAILED', reason: 'EMPTY' } })
    if (chosen.size > ETAX_MAX_BYTES) return setReading({ kind: 'failed', name: chosen.name, failure: { ok: false, code: 'VALIDATION_FAILED', reason: 'TOO_LARGE' } })
    setReading({ kind: 'busy', name: chosen.name })
    let outcome: EtaxOutcome
    try {
      const response = await fetch(etaxUrl, { method: 'POST', body: chosen, headers: { 'content-type': 'application/octet-stream', 'x-file-name': encodeURIComponent(chosen.name) } })
      // Not always the route's JSON: the host may refuse the body itself (413) or a proxy may answer with a page
      outcome = etaxOutcomeOf(response.status, await response.json().catch(() => undefined))
    } catch {
      outcome = { ok: false, code: NO_ANSWER }
    }
    // The file kept so far (if any) stays kept; only this one is refused
    if (!outcome.ok) return setReading({ kind: 'failed', name: chosen.name, failure: outcome })
    setReading({ kind: 'idle' })
    const kept = !outcome.problems.includes('TAX_ID_MISMATCH')
    setFile({ fileId: outcome.fileId, fileName: outcome.fileName, prefill: outcome.prefill, problems: outcome.problems, kept })
    if (outcome.prefill) {
      const p = outcome.prefill
      update({ invoiceNo: p.invoiceNo, invoiceDate: p.invoiceDate, net: showAmount(p.net), vat: showAmount(p.vat) })
    }
  }

  /** The form's values as the server takes them, or the errors to show */
  function collect(): InvoiceFormInput | null {
    const errors: FieldErrors = {}
    if (!values.invoiceNo.trim()) errors.invoiceNo = t('fieldErrors.invoiceNo')
    if (!isIsoDay(values.invoiceDate)) errors.invoiceDate = t('fieldErrors.invoiceDate')
    const net = cleanAmount(values.net)
    if (net === null) errors.net = t('fieldErrors.net')
    else if (/^0+(\.0+)?$/.test(net)) errors.net = t('fieldErrors.netZero')
    if (cleanAmount(values.vat) === null) errors.vat = t('fieldErrors.vat')
    setFieldErrors(errors)
    if (Object.keys(errors).length) return null
    return { poId, invoiceNo: values.invoiceNo.trim(), invoiceDate: values.invoiceDate, net: values.net, vat: values.vat, isFinal: values.isFinal, sourceFileId: file?.kept ? file.fileId : null }
  }

  function showFailure(f: FinanceFailure) {
    const field = fieldOfFailure(f)
    if (field) {
      setFieldErrors((e) => ({ ...e, [field]: errorText(f) }))
      setFailure(null)
    } else setFailure(f)
  }

  async function onReview(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setFailure(null)
    const input = collect()
    if (!input) return
    setPending(true)
    const outcome = await actions.preview(input).catch((): PreviewOutcome => ({ ok: false, code: NO_ANSWER }))
    setPending(false)
    if (!outcome.ok) return showFailure(outcome)
    setPreview(outcome.preview)
    setStep('review')
  }

  async function onConfirm(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const input = collect()
    if (!input) return setStep('enter')
    setPending(true)
    setFailure(null)
    let outcome: RecordOutcome
    try {
      outcome = await actions.record(input, submission.key)
      submission.next()
    } catch {
      // No answer: the key stays, so trying again is the same submission (spec §4.3)
      outcome = { ok: false, code: NO_ANSWER }
    }
    setPending(false)
    if (!outcome.ok) {
      // What the server found wrong is fixed on step 1 (the PO may have changed since the check)
      if (fieldOfFailure(outcome) || outcome.code === 'VALIDATION_FAILED') setStep('enter')
      return showFailure(outcome)
    }
    setDone(outcome.done)
    setStep('done')
    router.refresh()
  }

  function startAgain() {
    setValues(EMPTY)
    setFile(null)
    setReading({ kind: 'idle' })
    setFieldErrors({})
    setFailure(null)
    setPreview(null)
    setDone(null)
    setStep('enter')
  }

  /** Where the values came from, as the server decided it from the file (BR-IVC-05), named with the file */
  const sourceText = (parsedFrom: 'ETAX_XML' | 'MANUAL', withFile: boolean): string => {
    const name = file?.fileName ?? ''
    if (parsedFrom === 'ETAX_XML') return t('sourceEtax', { name })
    return withFile && name ? t('sourceTypedWithFile', { name }) : t('sourceTyped')
  }

  if (step === 'done' && done) {
    return (
      <section ref={doneRef} tabIndex={-1} aria-labelledby={`${id}-done`} className={`flex ${listWidth} flex-col gap-4 outline-none`}>
        <Notice tone="success">
          <p id={`${id}-done`} className="font-semibold">
            {t('doneTitle', { number: done.invoiceNo })}
          </p>
          <p>{t('doneSource', { source: sourceText(done.parsedFrom, Boolean(file?.kept)) })}</p>
          {done.vatWarning ? <p>{t('doneVatWarning', { given: done.vatWarning.given, expected: done.vatWarning.expected })}</p> : null}
        </Notice>
        <Parts title={t('partsDoneTitle')} parts={done.parts} label={t('partsDoneTitle')} />
        <Moves title={t('movesDoneTitle')} hint={t('movesDoneHint')} moves={done.moves} />
        {done.giveBack ? <GiveBack giveBack={done.giveBack} done /> : <p className="text-ink">{t('heldAfterDone', { amount: done.heldAfter })}</p>}
        <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center sm:gap-x-6">
          {done.more ? (
            <Button variant="secondary" onClick={startAgain} className="self-start">
              {t('another')}
            </Button>
          ) : null}
          <Link href={listHref} className={linkClass}>
            {t('toList')}
          </Link>
        </div>
      </section>
    )
  }
  if (!open) return null

  if (step === 'review' && preview) {
    return (
      <form onSubmit={onConfirm} noValidate aria-labelledby={`${id}-review`} className={`flex ${listWidth} flex-col gap-5`}>
        <div className="flex flex-col gap-1">
          <p className="text-ink-muted">{t('step', { step: 2 })}</p>
          <h2 id={`${id}-review`} ref={headingRef} tabIndex={-1} className="text-xl font-semibold text-ink outline-none">
            {t('reviewTitle')}
          </h2>
          <p className="text-ink-muted">{t('reviewHint')}</p>
        </div>

        <dl className={`flex ${listWidth} flex-col divide-y divide-line border-y border-line`}>
          <Fact label={t('invoiceNoLabel')} value={preview.invoiceNo} />
          <Fact label={t('invoiceDateLabel')} value={preview.invoiceDate} />
          <Fact label={t('netLabel')} value={preview.net} money />
          <Fact label={t('vatLabel')} value={preview.vat} money />
          <Fact label={t('grossLabel')} value={preview.gross} money strong />
          <Fact label={t('finalFact')} value={preview.isFinal ? t('finalYes') : t('finalNo')} />
          <Fact label={t('sourceFact')} value={sourceText(preview.source, preview.withFile)} />
        </dl>

        {preview.vatWarning ? (
          <Notice tone="warning">{t('vatWarning', { given: preview.vat, expected: preview.expectedVat, rate: preview.vatRate ?? '0' })}</Notice>
        ) : (
          <StateLine kind="done">{preview.vatRate ? t('vatMatches', { rate: preview.vatRate, expected: preview.expectedVat }) : t('vatMatchesNoRate', { expected: preview.expectedVat })}</StateLine>
        )}

        <Parts title={t('partsTitle')} hint={t('partsHint')} parts={preview.parts} label={t('partsTitle')} />
        <Moves title={t('movesTitle')} hint={t('movesHint')} moves={preview.moves} />
        <p className="text-ink">{t('heldChange', { before: preview.heldBefore, after: preview.heldAfter })}</p>
        {preview.giveBack ? <GiveBack giveBack={preview.giveBack} done={false} /> : null}

        {failure ? <Notice tone="danger">{errorText(failure)}</Notice> : null}
        <div className={barClass}>
          <Button type="submit" disabled={pending}>
            {pending ? t('recording') : t('confirm')}
          </Button>
          <Button
            variant="secondary"
            onClick={() => {
              setFailure(null)
              setStep('enter')
            }}
            disabled={pending}
          >
            {t('backToEnter')}
          </Button>
        </div>
      </form>
    )
  }

  const gross = addAmounts(values.net, values.vat)
  const prefill = file?.prefill ?? null
  const grossDiffers = prefill !== null && cleanAmount(values.net) !== null && cleanAmount(values.vat) !== null && !sameAmount(gross ?? '', prefill.gross)
  return (
    <form onSubmit={onReview} noValidate aria-labelledby={`${id}-enter`} className="flex flex-col gap-5">
      <div className="flex flex-col gap-1">
        <p className="text-ink-muted">{t('step', { step: 1 })}</p>
        <h2 id={`${id}-enter`} ref={headingRef} tabIndex={-1} className="text-xl font-semibold text-ink outline-none">
          {t('enterTitle')}
        </h2>
        <p className="text-ink-muted">{t('enterHint')}</p>
      </div>

      <section aria-labelledby={`${id}-etax`} className="flex flex-col gap-3 border-y border-line py-4">
        <h3 id={`${id}-etax`} className="font-semibold text-ink">
          {t('etaxTitle')}
        </h3>
        <p className="text-base text-ink-muted md:text-sm">{t('etaxHint')}</p>
        <label
          htmlFor={`${id}-etax-file`}
          className="inline-flex min-h-11 w-fit cursor-pointer items-center gap-2 rounded-md border border-input bg-bg px-4 font-medium text-ink hover:bg-surface focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-[var(--ring)]"
        >
          <Paperclip className="size-4" aria-hidden="true" />
          {file ? t('etaxChooseAgain') : t('etaxChoose')}
          <input id={`${id}-etax-file`} type="file" className="sr-only" accept={ETAX_ACCEPT} onChange={(event) => void onFile(event)} disabled={reading.kind === 'busy' || pending} />
        </label>
        {reading.kind === 'busy' ? <p role="status">{t('etaxReading', { name: reading.name })}</p> : null}
        {reading.kind === 'failed' ? (
          <Notice tone="danger">
            <p className="font-semibold">{t('etaxRefused', { name: reading.name })}</p>
            <p>{errorText(reading.failure)}</p>
          </Notice>
        ) : null}
        {file && reading.kind === 'idle' ? <FileReading file={file} supplier={supplier} /> : null}
        {file?.kept ? (
          <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
            <span className="inline-flex min-w-0 items-start gap-2 text-ink">
              <FileText className="mt-1 size-4 shrink-0 text-ink-muted" aria-hidden="true" />
              <span className="break-all">{t('fileKept', { name: file.fileName })}</span>
            </span>
            <Button variant="link" className="min-h-11 self-start sm:self-center" onClick={() => setFile(null)}>
              {t('fileRemove', { name: file.fileName })}
            </Button>
          </div>
        ) : null}
      </section>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          id={`${id}-no`}
          label={t('invoiceNoLabel')}
          autoComplete="off"
          maxLength={60}
          value={values.invoiceNo}
          onChange={(event) => update({ invoiceNo: event.currentTarget.value })}
          error={fieldErrors.invoiceNo}
        />
        <Field id={`${id}-date`} type="date" label={t('invoiceDateLabel')} value={values.invoiceDate} onChange={(event) => update({ invoiceDate: event.currentTarget.value })} error={fieldErrors.invoiceDate} />
        <Field
          id={`${id}-net`}
          label={t('netLabel')}
          inputMode="decimal"
          autoComplete="off"
          value={values.net}
          onChange={(event) => update({ net: event.currentTarget.value })}
          error={fieldErrors.net}
          className="tabular text-right"
        />
        <Field
          id={`${id}-vat`}
          label={t('vatLabel')}
          hint={vatRate ? t('vatHint', { rate: vatRate }) : t('vatHintNoRate')}
          inputMode="decimal"
          autoComplete="off"
          value={values.vat}
          onChange={(event) => update({ vat: event.currentTarget.value })}
          error={fieldErrors.vat}
          className="tabular text-right"
        />
      </div>
      <p className="flex flex-wrap items-baseline justify-between gap-x-4 border-y border-line py-2 text-ink sm:max-w-md" aria-live="polite">
        <span>{t('grossComputed')}</span>
        {gross ? <span className="money font-semibold">{gross}</span> : <span className="text-base text-ink-muted md:text-sm">{t('grossPending')}</span>}
      </p>
      {grossDiffers ? <Notice tone="warning">{t('grossDiffers', { file: showAmount(prefill.gross), computed: gross ?? '-' })}</Notice> : null}

      <div className="flex flex-col gap-1">
        <label htmlFor={`${id}-final`} className="flex min-h-11 items-center gap-3">
          <input
            id={`${id}-final`}
            type="checkbox"
            checked={values.isFinal}
            onChange={(event) => update({ isFinal: event.currentTarget.checked })}
            aria-describedby={`${id}-final-hint`}
            className="size-5 shrink-0 accent-[var(--primary)]"
          />
          <span className="text-ink">{t('finalLabel')}</span>
        </label>
        <p id={`${id}-final-hint`} className="text-base text-ink-muted md:text-sm">
          {t('finalHint')}
        </p>
      </div>

      {failure ? <Notice tone="danger">{errorText(failure)}</Notice> : null}
      <div className={barClass}>
        <Button type="submit" disabled={pending || reading.kind === 'busy'}>
          {pending ? t('checking') : t('toReview')}
        </Button>
      </div>
    </form>
  )
}

/** What the e-Tax reader found in the file: the values it filled, or why it could not, in plain words */
function FileReading({ file, supplier }: { file: FileState; supplier: { name: string; taxId: string | null; branch: string } }) {
  const t = useTranslations('finance.form')
  const tProblems = useTranslations('finance.etaxProblems')
  if (file.prefill) {
    const p = file.prefill
    // The tax id is checked by the server (BR-IVC-05); a branch other than the register's is only pointed out
    const otherBranch = p.sellerBranch !== null && p.sellerBranch !== supplier.branch
    return (
      <Notice tone={otherBranch ? 'warning' : 'success'}>
        <p className="font-semibold">{t('etaxRead', { name: file.fileName })}</p>
        <p>
          {otherBranch
            ? t('etaxSellerOtherBranch', { taxId: p.sellerTaxId, branch: p.sellerBranch ?? '-', registered: supplier.branch })
            : p.sellerBranch
              ? t('etaxSeller', { taxId: p.sellerTaxId, branch: p.sellerBranch })
              : t('etaxSellerNoBranch', { taxId: p.sellerTaxId })}
        </p>
        <p>{t('etaxGross', { gross: showAmount(p.gross) })}</p>
      </Notice>
    )
  }
  return (
    <Notice tone="warning">
      <p className="font-semibold">{t('etaxNotRead', { name: file.fileName })}</p>
      {file.problems.map((problem) => (
        <p key={problem}>{tProblems(problem, { supplier: supplier.name, taxId: supplier.taxId ?? '-' })}</p>
      ))}
      <p>{file.kept ? t('etaxTypeKept') : t('etaxTypeNotKept')}</p>
    </Notice>
  )
}

/** One fact of the invoice: label left, value right (money right-aligned in tabular digits, §9.9 principle 6) */
function Fact({ label, value, money, strong }: { label: string; value: string; money?: boolean; strong?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-1.5">
      <dt className="shrink-0 text-ink-muted">{label}</dt>
      <dd className={`${money ? 'money' : 'min-w-0 text-right break-words'} ${strong ? 'font-semibold' : ''} text-ink`}>{value}</dd>
    </div>
  )
}

function Parts({ title, hint, parts, label }: { title: string; hint?: string; parts: readonly InvoicePartView[]; label: string }) {
  return (
    <div className="flex flex-col gap-2">
      <h3 className="font-semibold text-ink">{title}</h3>
      {hint ? <p className="text-base text-ink-muted md:text-sm">{hint}</p> : null}
      <ul aria-label={label} className={`flex ${listWidth} flex-col divide-y divide-line border-y border-line`}>
        {parts.map((p) => (
          <li key={p.poLineId} className="flex items-baseline justify-between gap-4 py-2">
            <span className="flex min-w-0 flex-col">
              <span className="break-words text-ink">{p.description}</span>
              <span className="text-base break-words text-ink-muted md:text-sm">{p.budgetLine}</span>
            </span>
            <span className="money shrink-0 text-ink">{p.amount}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

function Moves({ title, hint, moves }: { title: string; hint: string; moves: readonly BudgetMoveView[] }) {
  return (
    <div className="flex flex-col gap-2">
      <h3 className="font-semibold text-ink">{title}</h3>
      <p className="text-base text-ink-muted md:text-sm">{hint}</p>
      <ul aria-label={title} className={`flex ${listWidth} flex-col divide-y divide-line border-y border-line`}>
        {moves.map((m) => (
          <li key={m.budgetLineId} className="flex items-baseline justify-between gap-4 py-2">
            <span className="min-w-0 break-words text-ink">{m.budgetLine}</span>
            <span className="money shrink-0 font-semibold text-ink">{m.amount}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

/** AC3: what a last invoice gives back — now, or when procurement closes the PO */
function GiveBack({ giveBack, done }: { giveBack: GiveBackView; done: boolean }): ReactNode {
  const t = useTranslations('finance.form')
  const zero = /^0(\.00)?$/.test(giveBack.amount)
  if (giveBack.when === 'NOW') {
    return <Notice tone="info">{zero ? t('giveBackNothing') : done ? t('giveBackNowDone', { amount: giveBack.amount }) : t('giveBackNow', { amount: giveBack.amount })}</Notice>
  }
  return (
    <Notice tone="info">
      <p>{zero ? t('giveBackOnCloseNothing') : t('giveBackOnClose', { amount: giveBack.amount })}</p>
      {giveBack.unsettledLines > 0 ? <p>{t('giveBackWaits', { count: giveBack.unsettledLines })}</p> : null}
    </Notice>
  )
}
