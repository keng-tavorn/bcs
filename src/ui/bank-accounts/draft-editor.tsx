'use client'

import { CircleCheck, CircleDashed, FileText, X } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { useId, useState, type FormEvent } from 'react'
import { toast } from 'sonner'
import { REASON_MAX_LENGTH } from '@/lib/constants'
import { Button } from '../form/button'
import { useHydrated } from '../form/hydrated'
import { Notice } from '../form/notice'
import { DropUploadButton } from '../request-form/drop-upload'
import type { UploadActions } from '../request-form/upload-button'
import { Checkbox } from '../shadcn/checkbox'
import { ChoiceSelect, FieldProblem, NoteField, RadioChoices, TextField, type SelectChoice } from './fields'
import type { BankOutcome } from './outcome'
import { useBankAction, useBankErrorText } from './use-bank-action'

// The proposer's draft on a request's page (S9-09, FR-PAY-102 AC7, BR-SUP-06, OQ-133): the account proposed (the number
// stays masked: typing it again replaces it, blank keeps it), the reason, the papers (attached and taken off one at a
// time), the call to the number in the register, and "ส่งขออนุมัติ" with what is still missing said before it. Each part
// is its own command with its own submission key and the version the page last read (CONFLICT_VERSION when the request
// changed meanwhile); after each the page refreshes. Changing the account asks for the call again (the service clears
// it). The service checks every rule again: only the proposer, only a draft, no account number in the free text.

export interface DraftProposedView {
  readonly bankCode: string
  readonly accountNoMasked: string
  readonly accountName: string
  readonly branchName: string | null
  readonly accountType: 'CURRENT' | 'SAVINGS' | null
}

export interface DraftActions extends UploadActions {
  readonly update: (input: unknown, idempotencyKey: string) => Promise<BankOutcome>
  readonly attach: (input: unknown, idempotencyKey: string) => Promise<BankOutcome>
  readonly detach: (input: unknown, idempotencyKey: string) => Promise<BankOutcome>
  readonly recordCall: (input: unknown, idempotencyKey: string) => Promise<BankOutcome>
  readonly submit: (input: unknown, idempotencyKey: string) => Promise<BankOutcome>
  readonly openFile: (fileId: string) => Promise<string | null>
}

/** The version the page read, or a newer one an action of this page returned since */
function useVersion(read: number) {
  const [seen, setSeen] = useState(read)
  return { current: Math.max(seen, read), saw: (outcome: BankOutcome) => (outcome.ok && outcome.version !== undefined ? setSeen((s) => Math.max(s, outcome.version!)) : undefined) }
}

export function DraftEditor({
  changeId,
  version,
  kind,
  ownerKind,
  proposed,
  reason,
  banks,
  proofs,
  call,
  supplierPhone,
  actions,
}: {
  changeId: string
  version: number
  kind: 'ADD' | 'REPLACE' | 'CLOSE'
  ownerKind: 'SUPPLIER' | 'ORGANIZATION'
  proposed: DraftProposedView | null
  reason: string
  banks: readonly SelectChoice[]
  proofs: ReadonlyArray<{ readonly fileId: string; readonly fileName: string }>
  /** The call recorded, in words ("โทรเมื่อ …: note"), or null */
  call: { readonly when: string; readonly note: string } | null
  supplierPhone: string | null
  actions: DraftActions
}) {
  const t = useTranslations('bankAccount.draft')
  const tf = useTranslations('bankAccount.form')
  const errorText = useBankErrorText()
  const hydrated = useHydrated()
  const id = useId()
  const v = useVersion(version)
  const proposes = kind !== 'CLOSE'
  const callNeeded = kind === 'REPLACE' && ownerKind === 'SUPPLIER'
  const callShown = ownerKind === 'SUPPLIER' && proposes

  // ---------- the account and the reason ----------
  const editing = useBankAction()
  const [bankCode, setBankCode] = useState(proposed?.bankCode ?? '')
  const [accountNo, setAccountNo] = useState('')
  const [accountName, setAccountName] = useState(proposed?.accountName ?? '')
  const [branchName, setBranchName] = useState(proposed?.branchName ?? '')
  const [accountType, setAccountType] = useState<'CURRENT' | 'SAVINGS'>(proposed?.accountType ?? 'CURRENT')
  const [why, setWhy] = useState(reason)
  const [nothing, setNothing] = useState(false)
  const [saved, setSaved] = useState(false)

  async function onSave(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setSaved(false)
    const changed: Record<string, unknown> = {}
    if (proposes && proposed) {
      if (bankCode !== proposed.bankCode) changed.bankCode = bankCode
      if (accountNo.trim()) changed.accountNo = accountNo
      if (accountName.trim() !== proposed.accountName) changed.accountName = accountName
      if (branchName.trim() !== (proposed.branchName ?? '')) changed.branchName = branchName
      if (ownerKind === 'ORGANIZATION' && accountType !== proposed.accountType) changed.accountType = accountType
    }
    if (why.trim() !== reason) changed.reason = why
    setNothing(Object.keys(changed).length === 0)
    if (Object.keys(changed).length === 0) return
    const outcome = await editing.run((key) => actions.update({ changeId, version: v.current, ...changed }, key))
    v.saw(outcome)
    if (outcome.ok) {
      setAccountNo('')
      setSaved(true)
    }
  }
  const editFailure = editing.outcome && !editing.outcome.ok ? editing.outcome : null
  const at = (field: string) => (editFailure?.field === field ? errorText(editFailure) : undefined)

  // ---------- the papers ----------
  const filing = useBankAction()
  const [fileProblem, setFileProblem] = useState<string | null>(null)
  async function attach(file: { fileId: string; fileName: string }) {
    setFileProblem(null)
    const outcome = await filing.run((key) => actions.attach({ changeId, version: v.current, fileId: file.fileId }, key))
    v.saw(outcome)
    if (outcome.ok) toast.success(t('attached', { name: file.fileName }))
    else setFileProblem(errorText(outcome))
  }
  async function detach(file: { fileId: string; fileName: string }) {
    setFileProblem(null)
    const outcome = await filing.run((key) => actions.detach({ changeId, version: v.current, fileId: file.fileId }, key))
    v.saw(outcome)
    if (outcome.ok) toast.success(t('detached', { name: file.fileName }))
    else setFileProblem(errorText(outcome))
  }
  const [opening, setOpening] = useState<string | null>(null)
  async function open(fileId: string, name: string) {
    setOpening(fileId)
    setFileProblem(null)
    const url = await actions.openFile(fileId).catch(() => null)
    setOpening(null)
    if (url) window.location.assign(url)
    else setFileProblem(t('openFailed', { name }))
  }

  // ---------- the call ----------
  const calling = useBankAction()
  const [note, setNote] = useState('')
  const [ticked, setTicked] = useState(false)
  const [callErrors, setCallErrors] = useState<{ note?: string; tick?: string }>({})
  async function onCall(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const found: typeof callErrors = {}
    if (note.trim().length < 3) found.note = tf('callNoteShort')
    if (!ticked) found.tick = tf('callTickError')
    setCallErrors(found)
    if (found.note || found.tick) return
    const outcome = await calling.run((key) => actions.recordCall({ changeId, version: v.current, note }, key))
    v.saw(outcome)
    if (outcome.ok) {
      setNote('')
      setTicked(false)
      toast.success(t('callSaved'))
    }
  }
  const callFailure = calling.outcome && !calling.outcome.ok ? errorText(calling.outcome) : null

  // ---------- sending ----------
  const sending = useBankAction()
  const proofDone = !proposes || proofs.length > 0
  const callDone = !callNeeded || call !== null
  async function onSubmit() {
    const outcome = await sending.run((key) => actions.submit({ changeId, version: v.current }, key))
    if (outcome.ok) toast.success(t('sent', { number: outcome.number ?? '' }))
  }
  const sendFailure = sending.outcome && !sending.outcome.ok ? errorText(sending.outcome) : null

  const checks = [
    ...(proposes ? [{ key: 'proof', text: t('checkProof'), done: proofDone }] : []),
    ...(callNeeded ? [{ key: 'call', text: t('checkCall'), done: callDone }] : []),
  ]

  return (
    <div className="flex flex-col gap-6">
      <form method="post" noValidate onSubmit={(e) => void onSave(e)} aria-labelledby={`${id}-edit`} className="flex flex-col gap-4">
        <h3 id={`${id}-edit`} className="font-semibold text-ink">
          {proposes ? t('editTitle') : t('editReasonTitle')}
        </h3>
        {proposes ? (
          <div className="grid gap-4 md:grid-cols-2">
            <ChoiceSelect id={`${id}-bank`} label={tf('bank')} choices={banks} value={bankCode} onChange={setBankCode} placeholder={tf('bankPick')} error={at('bankCode')} />
            <TextField
              id={`${id}-no`}
              label={tf('accountNo')}
              hint={t('accountNoKeep', { masked: proposed?.accountNoMasked ?? '-' })}
              inputMode="numeric"
              autoComplete="off"
              maxLength={40}
              value={accountNo}
              onChange={(e) => setAccountNo(e.currentTarget.value)}
              error={at('accountNo')}
              className="tabular"
            />
            <TextField id={`${id}-name`} label={tf('accountName')} maxLength={200} autoComplete="off" value={accountName} onChange={(e) => setAccountName(e.currentTarget.value)} error={at('accountName')} />
            <TextField id={`${id}-branch`} label={tf('branch')} maxLength={200} autoComplete="off" value={branchName} onChange={(e) => setBranchName(e.currentTarget.value)} error={at('branchName')} />
            {ownerKind === 'ORGANIZATION' ? (
              <RadioChoices<'CURRENT' | 'SAVINGS'>
                id={`${id}-type`}
                legend={tf('accountType')}
                value={accountType}
                onChange={setAccountType}
                choices={[
                  { value: 'CURRENT', label: tf('accountTypes.CURRENT') },
                  { value: 'SAVINGS', label: tf('accountTypes.SAVINGS') },
                ]}
                error={at('accountType')}
              />
            ) : null}
          </div>
        ) : null}
        <NoteField id={`${id}-reason`} label={tf('reason')} hint={tf('reasonHint')} maxLength={REASON_MAX_LENGTH} value={why} onChange={(e) => setWhy(e.currentTarget.value)} error={at('reason')} />
        {proposes && callShown ? <p className="text-ink-muted">{t('callAgainHint')}</p> : null}
        <Button type="submit" className="self-start" disabled={editing.pending || !hydrated} aria-busy={editing.pending || undefined}>
          {editing.pending ? tf('saving') : t('save')}
        </Button>
        {nothing ? <Notice tone="info">{t('nothing')}</Notice> : null}
        {editFailure && !editFailure.field ? <Notice tone="danger">{errorText(editFailure)}</Notice> : null}
        {editFailure?.field && !['bankCode', 'accountNo', 'accountName', 'branchName', 'accountType', 'reason'].includes(editFailure.field) ? <Notice tone="danger">{errorText(editFailure)}</Notice> : null}
        {saved ? <Notice tone="success">{t('saved')}</Notice> : null}
      </form>

      <section aria-labelledby={`${id}-proofs`} className="flex flex-col gap-3 border-t border-line pt-4">
        <h3 id={`${id}-proofs`} className="font-semibold text-ink">
          {tf('proofTitle')}
        </h3>
        <p className="text-ink-muted">{proposes ? tf('proofHint') : tf('proofHintClose')}</p>
        {proofs.length ? (
          <ul aria-label={tf('proofTitle')} className="flex flex-col divide-y divide-line border-y border-line">
            {proofs.map((p) => (
              <li key={p.fileId} className="flex flex-col gap-1 py-2 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
                <span className="inline-flex min-w-0 items-start gap-2">
                  <FileText className="mt-1 size-4 shrink-0 text-ink-muted" aria-hidden="true" />
                  <span className="break-all text-ink">{p.fileName}</span>
                </span>
                <span className="flex flex-wrap gap-x-4">
                  <Button variant="link" disabled={opening === p.fileId} aria-busy={opening === p.fileId || undefined} onClick={() => void open(p.fileId, p.fileName)}>
                    {opening === p.fileId ? t('opening', { name: p.fileName }) : t('open', { name: p.fileName })}
                  </Button>
                  <Button variant="link" disabled={filing.pending || !hydrated} onClick={() => void detach(p)}>
                    <X className="size-4" aria-hidden="true" />
                    {tf('proofRemove', { name: p.fileName })}
                  </Button>
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-ink-muted">{tf('proofNone')}</p>
        )}
        <DropUploadButton label={tf('proofUpload')} actions={actions} disabled={filing.pending || !hydrated} onUploaded={attach} />
        {fileProblem ? <Notice tone="danger">{fileProblem}</Notice> : null}
      </section>

      {callShown ? (
        <section aria-labelledby={`${id}-call`} className="flex flex-col gap-3 border-t border-line pt-4">
          <h3 id={`${id}-call`} className="font-semibold text-ink">
            {callNeeded ? tf('callTitleRequired') : tf('callTitle')}
          </h3>
          {call ? (
            <Notice tone="success">
              <p>{call.when}</p>
              <p className="break-words whitespace-pre-line">{call.note}</p>
            </Notice>
          ) : (
            <p className="text-ink-muted">{t('noCall')}</p>
          )}
          <p className="text-ink-muted">{tf('callHint')}</p>
          <p className="font-medium text-ink">{supplierPhone ? tf('registerPhone', { phone: supplierPhone }) : tf('noRegisterPhone')}</p>
          <form method="post" noValidate onSubmit={(e) => void onCall(e)} className="flex flex-col gap-3">
            <NoteField
              id={`${id}-note`}
              label={call ? t('callAgain') : tf('callNote')}
              hint={tf('callNoteHint')}
              maxLength={500}
              value={note}
              onChange={(e) => {
                setNote(e.currentTarget.value)
                setCallErrors((c) => ({ ...c, note: undefined }))
              }}
              error={callErrors.note ?? (calling.outcome && !calling.outcome.ok && calling.outcome.field === 'callVerificationNote' ? callFailure : undefined)}
            />
            <div className="flex flex-col gap-1.5">
              <label htmlFor={`${id}-tick`} className="flex min-h-11 cursor-pointer items-start gap-3 py-1">
                <Checkbox
                  id={`${id}-tick`}
                  checked={ticked}
                  onCheckedChange={(next) => {
                    setTicked(next === true)
                    setCallErrors((c) => ({ ...c, tick: undefined }))
                  }}
                  aria-invalid={callErrors.tick ? true : undefined}
                  aria-describedby={callErrors.tick ? `${id}-tick-error` : undefined}
                  className="mt-1 size-5"
                />
                <span className="text-ink">{tf('callTick')}</span>
              </label>
              {callErrors.tick ? <FieldProblem id={`${id}-tick-error`}>{callErrors.tick}</FieldProblem> : null}
            </div>
            <Button type="submit" variant="secondary" className="self-start" disabled={calling.pending || !hydrated} aria-busy={calling.pending || undefined}>
              {calling.pending ? tf('saving') : t('callSave')}
            </Button>
            {callFailure && !(calling.outcome && !calling.outcome.ok && calling.outcome.field === 'callVerificationNote') ? <Notice tone="danger">{callFailure}</Notice> : null}
          </form>
        </section>
      ) : null}

      <section aria-labelledby={`${id}-send`} className="flex flex-col gap-3 border-t border-line pt-4">
        <h3 id={`${id}-send`} className="font-semibold text-ink">
          {t('sendTitle')}
        </h3>
        {checks.length ? (
          <ul className="flex flex-col gap-1">
            {checks.map((c) => (
              <li key={c.key} className="flex items-start gap-2">
                {c.done ? <CircleCheck className="mt-1 size-4 shrink-0 text-primary" aria-hidden="true" /> : <CircleDashed className="mt-1 size-4 shrink-0 text-warn" aria-hidden="true" />}
                <span className="text-ink">
                  {c.text} · {c.done ? t('checkDone') : t('checkMissing')}
                </span>
              </li>
            ))}
          </ul>
        ) : null}
        <p className="text-ink-muted">{tf('sendHint')}</p>
        <Button className="self-start" disabled={sending.pending || !hydrated} aria-busy={sending.pending || undefined} onClick={() => void onSubmit()}>
          {sending.pending ? tf('sending') : t('send')}
        </Button>
        {sendFailure ? <Notice tone="danger">{sendFailure}</Notice> : null}
      </section>
    </div>
  )
}
