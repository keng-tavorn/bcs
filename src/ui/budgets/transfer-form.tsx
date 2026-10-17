'use client'

import Link from 'next/link'
import { REASON_MAX_LENGTH } from '@/lib/constants'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { useId, useState, type FormEvent } from 'react'
import { Button } from '../form/button'
import { Notice } from '../form/notice'
import { useHydrated } from '../form/hydrated'
import { useSubmissionKey } from '../form/submission-key'
import { describedBy, FieldError, Hint } from '../request-form/controls'
import { Input } from '../shadcn/input'
import { NativeSelect, NativeSelectOption } from '../shadcn/native-select'
import { RadioGroup, RadioGroupItem } from '../shadcn/radio-group'
import { Textarea } from '../shadcn/textarea'
import { moneyText } from './format'
import {
  destinationLines,
  kindsOffered,
  needsDestination,
  needsSource,
  sameTransfer,
  sourceLines,
  transferFormErrors,
  transferInput,
  type TransferFormErrors,
  type TransferInput,
  type TransferKind,
  type TransferLineOption,
} from './transfer-model'
import { transferErrorField, transferErrorKey, type TransferFailure, type TransferOutcome } from './transfer-outcome'

export interface TransferFormActions {
  readonly create: (input: TransferInput, idempotencyKey: string) => Promise<TransferOutcome<{ transferId: string }>>
  readonly submit: (transferId: string, idempotencyKey: string) => Promise<TransferOutcome<{ transferId: string; number: string }>>
  readonly cancel: (transferId: string, idempotencyKey: string) => Promise<TransferOutcome<{ transferId: string }>>
}

const NO_ANSWER: TransferFailure = { ok: false, code: 'NO_ANSWER' }
const control = 'h-11 w-full bg-bg text-base md:text-base'

/** Runs one call; a thrown call (the network, a server that stopped) is an answer that never came */
async function settle<T>(call: Promise<T>): Promise<T | TransferFailure> {
  try {
    return await call
  } catch {
    return NO_ANSWER
  }
}

// The new transfer or adjustment (S6-15 · FR-BUD-103 AC1, §9.1 /budgets/transfers/new): the kind first, then only the
// lines the member may use for it — a source they may give from (TRANSFER, DECREASE), any other line of the year as
// the destination of a transfer, a line they may raise for an increase — the amount with what the source has left, and
// the reason. "ส่งขออนุมัติ" is two commands, each with its own idempotency key (spec §4.3): the draft, then the send.
// A refused send keeps the draft: pressed again with the same details it sends that draft; with other details the
// earlier draft is cancelled first, so one press never leaves two drafts behind. Every refusal is said in the form,
// beside the field it is about when there is one (§9.9 rule 7); the services check every rule again.
export function TransferForm({ lines, actions }: { lines: readonly TransferLineOption[]; actions: TransferFormActions }) {
  const t = useTranslations('budgetTransfer')
  const router = useRouter()
  const id = useId()
  const hydrated = useHydrated()
  const createKey = useSubmissionKey()
  const submitKey = useSubmissionKey()
  const cancelKey = useSubmissionKey()
  const offered = kindsOffered(lines)
  const [kind, setKind] = useState<TransferKind>(() => offered[0] ?? 'TRANSFER')
  const [fromId, setFromId] = useState('')
  const [toId, setToId] = useState('')
  const [amount, setAmount] = useState('')
  const [reason, setReason] = useState('')
  const [errors, setErrors] = useState<TransferFormErrors>({})
  /** The server's refusal: beside its field when it is about one, otherwise above the button */
  const [failure, setFailure] = useState<{ text: string; field: keyof TransferFormErrors | null } | null>(null)
  /** The send was refused after the draft was made: the draft is kept for the next press */
  const [draftKept, setDraftKept] = useState(false)
  const [draft, setDraft] = useState<{ id: string; input: TransferInput } | null>(null)
  const [pending, setPending] = useState(false)

  const sources = sourceLines(kind, lines)
  const destinations = destinationLines(kind, lines, fromId)
  const source = sources.find((l) => l.id === fromId)
  /** What is wrong with a field: the form's own check, or the server's refusal about it */
  const fieldError = (field: keyof TransferFormErrors): string | undefined => {
    const e = errors[field]
    if (e) return t(`errors.${e.key}`, { shortfall: e.shortfall ?? '' })
    return failure?.field === field ? failure.text : undefined
  }
  const lineLabel = (l: TransferLineOption) =>
    l.available ? t('form.lineOption', { code: l.code, name: l.nameTh, department: l.departmentCode, available: moneyText(l.available) }) : t('form.lineOptionNoAmount', { code: l.code, name: l.nameTh, department: l.departmentCode })
  const fromLabel = kind === 'DECREASE' ? t('form.lineDecrease') : t('form.from')
  const toLabel = kind === 'INCREASE' ? t('form.lineIncrease') : t('form.to')

  function chooseKind(next: TransferKind) {
    setKind(next)
    setErrors({})
    // A line the new kind does not offer is not kept
    if (!sourceLines(next, lines).some((l) => l.id === fromId)) setFromId('')
    if (!destinationLines(next, lines, fromId).some((l) => l.id === toId)) setToId('')
  }

  function chooseFrom(next: string) {
    setFromId(next)
    if (next && next === toId) setToId('')
  }

  /** A refusal of the server, beside its field when it has one, otherwise above the button */
  function refused(f: TransferFailure, kept: boolean) {
    const key = f.code === 'NO_ANSWER' ? 'FAILED' : transferErrorKey(f)
    const text = t(`errors.${key}`, { shortfall: f.shortfall ? moneyText({ amount: f.shortfall }) : '', requestId: f.requestId ?? '-' })
    setFailure({ text, field: transferErrorField(f) })
    setDraftKept(kept)
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (pending) return
    const values = { kind, fromBudgetLineId: fromId, toBudgetLineId: toId, amount, reason }
    const next = transferFormErrors(values, lines)
    setErrors(next)
    setFailure(null)
    setDraftKept(false)
    if (Object.keys(next).length) return
    const input = transferInput(values)
    setPending(true)
    try {
      let transferId = draft && sameTransfer(draft.input, input) ? draft.id : null
      if (!transferId) {
        // Other details than the draft kept from a refused send: that draft is cancelled, never left behind
        if (draft) {
          const cancelled = await settle(actions.cancel(draft.id, cancelKey.key))
          if (cancelled.ok || cancelled.code !== 'NO_ANSWER') cancelKey.next()
          setDraft(null)
        }
        const created = await settle(actions.create(input, createKey.key))
        // No answer: the same key goes with a retry, so the draft is made at most once
        if (!created.ok) {
          if (created.code !== 'NO_ANSWER') createKey.next()
          return refused(created, false)
        }
        createKey.next()
        transferId = created.transferId
        setDraft({ id: transferId, input })
      }
      const sent = await settle(actions.submit(transferId, submitKey.key))
      if (sent.ok || sent.code !== 'NO_ANSWER') submitKey.next()
      if (!sent.ok) return refused(sent, true)
      router.push(`/budgets/transfers/${sent.transferId}?sent=1`)
    } finally {
      setPending(false)
    }
  }

  return (
    <form method="post" noValidate onSubmit={onSubmit} className="flex max-w-2xl flex-col gap-5" aria-busy={pending || undefined}>
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 font-medium text-ink">{t('form.kind')}</legend>
        <RadioGroup value={kind} onValueChange={(v) => chooseKind(v as TransferKind)} className="gap-3">
          {(['TRANSFER', 'INCREASE', 'DECREASE'] as const).map((k) => {
            return (
              <label key={k} htmlFor={`${id}-kind-${k}`} className="flex cursor-pointer items-start gap-3 has-[button:disabled]:cursor-not-allowed">
                <RadioGroupItem id={`${id}-kind-${k}`} value={k} disabled={!offered.includes(k)} className="mt-1 size-5" />
                <span className="flex flex-col">
                  <span className="font-medium text-ink">{t(`kind.${k}`)}</span>
                  <span className="text-base text-ink-muted md:text-sm">{t(`kindHint.${k}`)}</span>
                </span>
              </label>
            )
          })}
        </RadioGroup>
      </fieldset>

      {needsSource(kind) ? (
        <div className="flex flex-col gap-1.5">
          <label htmlFor={`${id}-from`} className="font-medium text-ink">
            {fromLabel}
          </label>
          <NativeSelect
            id={`${id}-from`}
            value={fromId}
            onChange={(e) => chooseFrom(e.target.value)}
            aria-invalid={fieldError('from') ? true : undefined}
            aria-describedby={describedBy(`${id}-from`, Boolean(source), Boolean(fieldError('from')))}
            className="w-full [&_select]:h-11 [&_select]:bg-bg [&_select]:text-base"
          >
            <NativeSelectOption value="">{t('form.choose')}</NativeSelectOption>
            {sources.map((l) => (
              <NativeSelectOption key={l.id} value={l.id}>
                {lineLabel(l)}
              </NativeSelectOption>
            ))}
          </NativeSelect>
          {source?.available ? <Hint id={`${id}-from`}>{t('form.available', { amount: moneyText(source.available) })}</Hint> : null}
          {fieldError('from') ? <FieldError id={`${id}-from`}>{fieldError('from')}</FieldError> : null}
        </div>
      ) : null}

      {needsDestination(kind) ? (
        <div className="flex flex-col gap-1.5">
          <label htmlFor={`${id}-to`} className="font-medium text-ink">
            {toLabel}
          </label>
          <NativeSelect
            id={`${id}-to`}
            value={toId}
            onChange={(e) => setToId(e.target.value)}
            aria-invalid={fieldError('to') ? true : undefined}
            aria-describedby={describedBy(`${id}-to`, false, Boolean(fieldError('to')))}
            className="w-full [&_select]:h-11 [&_select]:bg-bg [&_select]:text-base"
          >
            <NativeSelectOption value="">{t('form.choose')}</NativeSelectOption>
            {destinations.map((l) => (
              <NativeSelectOption key={l.id} value={l.id}>
                {lineLabel(l)}
              </NativeSelectOption>
            ))}
          </NativeSelect>
          {fieldError('to') ? <FieldError id={`${id}-to`}>{fieldError('to')}</FieldError> : null}
        </div>
      ) : null}

      <div className="flex flex-col gap-1.5">
        <label htmlFor={`${id}-amount`} className="font-medium text-ink">
          {t('form.amount')}
        </label>
        <Input
          id={`${id}-amount`}
          inputMode="decimal"
          autoComplete="off"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          aria-invalid={fieldError('amount') ? true : undefined}
          aria-describedby={describedBy(`${id}-amount`, true, Boolean(fieldError('amount')))}
          className={`${control} tabular-nums sm:max-w-64`}
        />
        <Hint id={`${id}-amount`}>{t('form.amountHint')}</Hint>
        {fieldError('amount') ? <FieldError id={`${id}-amount`}>{fieldError('amount')}</FieldError> : null}
      </div>

      <div className="flex flex-col gap-1.5">
        <label htmlFor={`${id}-reason`} className="font-medium text-ink">
          {t('form.reason')}
        </label>
        <Textarea
          id={`${id}-reason`}
          value={reason}
          maxLength={REASON_MAX_LENGTH}
          onChange={(e) => setReason(e.target.value)}
          aria-invalid={fieldError('reason') ? true : undefined}
          aria-describedby={describedBy(`${id}-reason`, true, Boolean(fieldError('reason')))}
          className="min-h-28 bg-bg text-base md:text-base"
        />
        <Hint id={`${id}-reason`}>{t('form.reasonHint')}</Hint>
        {fieldError('reason') ? <FieldError id={`${id}-reason`}>{fieldError('reason')}</FieldError> : null}
      </div>

      {failure && !failure.field ? <Notice tone="danger">{failure.text}</Notice> : null}
      {draftKept && draft ? (
        <Notice tone="info">
          <p>
            {t('form.draftKept')}{' '}
            <Link href={`/budgets/transfers/${draft.id}`} className="font-medium text-primary underline underline-offset-4 hover:no-underline">
              {t('form.openDraft')}
            </Link>
          </p>
        </Notice>
      ) : null}

      <Button type="submit" className="self-start" disabled={!hydrated || pending} aria-busy={pending || undefined}>
        {pending ? t('form.sending') : t('form.submit')}
      </Button>
    </form>
  )
}
