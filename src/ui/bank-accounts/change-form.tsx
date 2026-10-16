'use client'

import { FileText, X } from 'lucide-react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { useId, useState, type FormEvent } from 'react'
import { v4 as uuidv4 } from 'uuid'
import { REASON_MAX_LENGTH } from '@/lib/constants'
import { Button } from '../form/button'
import { useHydrated } from '../form/hydrated'
import { Notice } from '../form/notice'
import { useSubmissionKey } from '../form/submission-key'
import { DropUploadButton } from '../request-form/drop-upload'
import type { UploadActions } from '../request-form/upload-button'
import { Card, CardContent, CardHeader, CardTitle } from '../shadcn/card'
import { Checkbox } from '../shadcn/checkbox'
import { Combobox } from '../shadcn/combobox'
import { Label } from '../shadcn/label'
import { ChoiceSelect, FieldProblem, NoteField, RadioChoices, TextField, type SelectChoice } from './fields'
import { BANK_NO_ANSWER, bankErrorKey, type BankFailure, type BankOutcome } from './outcome'

// /finance/bank-accounts/changes/new (S9-09, FR-PAY-102 AC7, BR-SUP-06, BR-SUP-07, OQ-133): FINANCE proposes adding,
// replacing or closing a supplier's account or one of the organization's, in two steps so no step asks more than a few
// things (§9.9): first which account — the kind, whose, and the account in force it replaces or closes; then the new
// account (bank from the phone's own picker, number, name, branch, and its type for the organization's), the papers
// (react-dropzone, uploaded straight to private storage), the call to the number in the register, and the reason.
// Saving makes the draft (bankAccountChange.create with this form's idempotencyKey: a double press makes one), then
// attaches each paper, records the call and, when asked, sends it — each a command of its own — and opens the request's
// page, which says what is still missing if a later step was refused. A refusal of the draft itself stays here, next to
// its field. The service checks every rule again: one open request per supplier and per account, the paper and the call
// before sending, no account number in the reason or the note, the proposer never approving.

export interface BankTargetView {
  readonly id: string
  /** "ธนาคารกสิกรไทย ••••••0016 · ชื่อบัญชี" */
  readonly label: string
  /** The request already open on it */
  readonly openChangeHref: string | null
}

export interface BankSupplierView {
  readonly id: string
  /** "SP0056 · ชื่อ" */
  readonly label: string
  readonly phone: string | null
  readonly account: BankTargetView | null
  readonly openChangeHref: string | null
}

type Kind = 'ADD' | 'REPLACE' | 'CLOSE'
type Owner = 'SUPPLIER' | 'ORGANIZATION'
type FieldKey = 'kind' | 'supplierId' | 'targetBankAccountId' | 'bankCode' | 'accountNo' | 'accountName' | 'branchName' | 'accountType' | 'reason' | 'proof' | 'callVerificationNote' | 'callTick'

export interface ChangeFormActions extends UploadActions {
  readonly create: (input: unknown, idempotencyKey: string) => Promise<BankOutcome>
  readonly attach: (input: unknown, idempotencyKey: string) => Promise<BankOutcome>
  readonly recordCall: (input: unknown, idempotencyKey: string) => Promise<BankOutcome>
  readonly submit: (input: unknown, idempotencyKey: string) => Promise<BankOutcome>
}

const SERVER_FIELDS: Readonly<Record<string, FieldKey>> = {
  kind: 'kind',
  supplierId: 'supplierId',
  targetBankAccountId: 'targetBankAccountId',
  bankCode: 'bankCode',
  accountNo: 'accountNo',
  accountName: 'accountName',
  branchName: 'branchName',
  accountType: 'accountType',
  reason: 'reason',
  callVerificationNote: 'callVerificationNote',
  fileId: 'proof',
  proof: 'proof',
}
const STEP_ONE: readonly FieldKey[] = ['kind', 'supplierId', 'targetBankAccountId']
const MIN_TEXT = 3

const call = async (run: () => Promise<BankOutcome>): Promise<BankOutcome> => {
  try {
    return await run()
  } catch {
    return BANK_NO_ANSWER
  }
}

export function ChangeForm({
  banks,
  suppliers,
  companyAccounts,
  initial,
  actions,
}: {
  banks: readonly SelectChoice[]
  suppliers: readonly BankSupplierView[]
  companyAccounts: readonly BankTargetView[]
  initial: { readonly ownerKind: Owner; readonly supplierId: string | null; readonly kind: Kind }
  actions: ChangeFormActions
}) {
  const t = useTranslations('bankAccount.form')
  const tk = useTranslations('bankAccount.kind')
  const te = useTranslations('bankAccount.errors')
  const router = useRouter()
  const hydrated = useHydrated()
  const submission = useSubmissionKey()
  const id = useId()
  const [step, setStep] = useState<1 | 2>(1)
  const [kind, setKind] = useState<Kind>(initial.kind)
  const [owner, setOwner] = useState<Owner>(initial.ownerKind)
  const [supplierId, setSupplierId] = useState<string | null>(initial.supplierId)
  const [companyTarget, setCompanyTarget] = useState('')
  const [bankCode, setBankCode] = useState('')
  const [accountNo, setAccountNo] = useState('')
  const [accountName, setAccountName] = useState('')
  const [branchName, setBranchName] = useState('')
  const [accountType, setAccountType] = useState<'CURRENT' | 'SAVINGS'>('CURRENT')
  const [reason, setReason] = useState('')
  const [proofs, setProofs] = useState<Array<{ fileId: string; fileName: string }>>([])
  const [callNote, setCallNote] = useState('')
  const [callTicked, setCallTicked] = useState(false)
  const [errors, setErrors] = useState<Partial<Record<FieldKey, string>>>({})
  const [problem, setProblem] = useState<string | null>(null)
  const [stage, setStage] = useState<'saving' | 'sending' | null>(null)

  const supplier = owner === 'SUPPLIER' ? (suppliers.find((s) => s.id === supplierId) ?? null) : null
  const target = kind === 'ADD' ? null : owner === 'SUPPLIER' ? (supplier?.account ?? null) : (companyAccounts.find((a) => a.id === companyTarget) ?? null)
  const openHref = supplier?.openChangeHref ?? target?.openChangeHref ?? null
  const proposes = kind !== 'CLOSE'
  const callNeeded = kind === 'REPLACE' && owner === 'SUPPLIER'
  const callShown = owner === 'SUPPLIER' && proposes
  const busy = stage !== null

  const clear = (...keys: FieldKey[]) => {
    setErrors((e) => {
      const next = { ...e }
      for (const k of keys) delete next[k]
      return next
    })
    setProblem(null)
  }

  /** Step one: whose account and which; blocks what the service would refuse at once */
  function checkStepOne(): Partial<Record<FieldKey, string>> {
    const found: Partial<Record<FieldKey, string>> = {}
    if (owner === 'SUPPLIER' && !supplier) found.supplierId = t('errors.pickSupplier')
    if (owner === 'SUPPLIER' && supplier && kind === 'ADD' && supplier.account) found.kind = t('errors.supplierHasAccount')
    if (owner === 'SUPPLIER' && supplier && kind !== 'ADD' && !supplier.account) found.kind = t('errors.supplierHasNoAccount')
    if (owner === 'ORGANIZATION' && kind !== 'ADD' && !target) found.targetBankAccountId = t('errors.pickTarget')
    if (openHref) found[owner === 'SUPPLIER' && supplier?.openChangeHref ? 'supplierId' : 'targetBankAccountId'] = t('errors.changeOpen')
    return found
  }

  function checkStepTwo(): Partial<Record<FieldKey, string>> {
    const found: Partial<Record<FieldKey, string>> = {}
    if (proposes) {
      if (!bankCode) found.bankCode = t('errors.pickBank')
      if (!accountNo.trim()) found.accountNo = t('errors.accountNo')
      if (!accountName.trim()) found.accountName = t('errors.accountName')
    }
    if (reason.trim().length < MIN_TEXT) found.reason = te('reason.REASON_SHORT')
    if (callNote.trim() && callNote.trim().length < MIN_TEXT) found.callVerificationNote = te('reason.NOTE_SHORT')
    if (callNote.trim() && !callTicked) found.callTick = t('callTickError')
    return found
  }

  function show(found: Partial<Record<FieldKey, string>>): boolean {
    setErrors(found)
    const first = Object.keys(found)[0]
    if (!first) return true
    document.getElementById(`${id}-${first}`)?.focus()
    return false
  }

  function next(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!show(checkStepOne())) return
    setStep(2)
    window.scrollTo({ top: 0 })
  }

  /** Where a refusal of the service belongs: next to its field, on the step that has it */
  function refused(failure: BankFailure) {
    const words = te(bankErrorKey(failure))
    const field = failure.field ? SERVER_FIELDS[failure.field] : undefined
    if (field) {
      if (STEP_ONE.includes(field)) setStep(1)
      show({ [field]: words })
    } else setProblem(words)
  }

  async function save(send: boolean) {
    setProblem(null)
    if (!show(checkStepTwo())) return
    setStage(send ? 'sending' : 'saving')
    const created = await call(() =>
      actions.create(
        {
          kind,
          ownerKind: owner,
          supplierId: owner === 'SUPPLIER' ? supplierId : null,
          targetBankAccountId: kind === 'ADD' ? null : (target?.id ?? null),
          ...(proposes ? { bankCode, accountNo, accountName, branchName, ...(owner === 'ORGANIZATION' ? { accountType } : {}) } : {}),
          reason,
        },
        submission.key,
      ),
    )
    // No answer keeps the key: pressing again is the same submission and makes one draft
    if (!(!created.ok && created.code === 'NO_ANSWER')) submission.next()
    if (!created.ok || !created.changeId) {
      setStage(null)
      return refused(created.ok ? BANK_NO_ANSWER : created)
    }
    const changeId = created.changeId
    let version = created.version ?? 0
    let left: BankFailure | null = null
    for (const proof of proofs) {
      const attached = await call(() => actions.attach({ changeId, version, fileId: proof.fileId }, uuidv4()))
      if (!attached.ok) {
        left = attached
        break
      }
      version = attached.version ?? version
    }
    if (!left && callNote.trim()) {
      const recorded = await call(() => actions.recordCall({ changeId, version, note: callNote }, uuidv4()))
      if (recorded.ok) version = recorded.version ?? version
      else left = recorded
    }
    if (!left && send) {
      const sent = await call(() => actions.submit({ changeId, version }, uuidv4()))
      if (!sent.ok) left = sent
    }
    const query = left ? `notice=incomplete&problem=${encodeURIComponent(bankErrorKey(left))}` : send ? 'notice=sent' : 'notice=saved'
    router.push(`/finance/bank-accounts/changes/${changeId}?${query}`)
  }

  const steps = [t('stepOne'), t('stepTwo')]
  const stepper = (
    <ol aria-label={t('steps')} className="flex flex-col gap-1 sm:flex-row sm:gap-6">
      {steps.map((label, i) => {
        const current = step === i + 1
        return (
          <li key={label} aria-current={current ? 'step' : undefined} className={current ? 'font-semibold text-ink' : 'text-ink-muted'}>
            {t('stepOf', { step: i + 1, total: steps.length, label })}
          </li>
        )
      })}
    </ol>
  )

  if (step === 1) {
    const supplierChoices = suppliers.map((s) => ({ value: s.id, label: s.label }))
    return (
      <form method="post" noValidate onSubmit={next} className="flex max-w-3xl flex-col gap-4">
        {stepper}
        <Card className="gap-3 bg-bg text-base">
          <CardHeader>
            <CardTitle>
              <h2 className="text-base font-semibold">{t('whatTitle')}</h2>
            </CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-5">
            <RadioChoices<Kind>
              id={`${id}-kind`}
              legend={t('kind')}
              value={kind}
              onChange={(v) => {
                setKind(v)
                clear('kind', 'targetBankAccountId', 'supplierId')
              }}
              choices={(['ADD', 'REPLACE', 'CLOSE'] as const).map((k) => ({ value: k, label: tk(k), hint: t(`kindHint.${k}`) }))}
              error={errors.kind}
            />
            <RadioChoices<Owner>
              id={`${id}-owner`}
              legend={t('owner')}
              value={owner}
              onChange={(v) => {
                setOwner(v)
                clear('supplierId', 'targetBankAccountId', 'kind')
              }}
              choices={[
                { value: 'SUPPLIER', label: t('ownerSupplier'), hint: t('ownerSupplierHint') },
                { value: 'ORGANIZATION', label: t('ownerCompany'), hint: t('ownerCompanyHint') },
              ]}
            />
            {owner === 'SUPPLIER' ? (
              <div className="flex flex-col gap-2">
                <Label htmlFor={`${id}-supplierId`} className="text-base font-medium text-ink">
                  {t('supplier')}
                </Label>
                <p id={`${id}-supplierId-hint`} className="text-base text-ink-muted md:text-sm">
                  {t('supplierHint')}
                </p>
                <Combobox
                  id={`${id}-supplierId`}
                  options={supplierChoices}
                  value={supplierId}
                  onValueChange={(v) => {
                    setSupplierId(v)
                    clear('supplierId', 'kind')
                  }}
                  placeholder={t('supplierPick')}
                  searchPlaceholder={t('supplierSearch')}
                  emptyText={t('supplierNone')}
                  aria-invalid={errors.supplierId ? true : undefined}
                  className="min-h-11 text-base"
                />
                {errors.supplierId ? <FieldProblem id={`${id}-supplierId-error`}>{errors.supplierId}</FieldProblem> : null}
                {supplier ? (
                  <p className="text-ink">{supplier.account ? t('currentAccount', { account: supplier.account.label }) : t('noCurrentAccount')}</p>
                ) : null}
              </div>
            ) : kind !== 'ADD' ? (
              <ChoiceSelect
                id={`${id}-targetBankAccountId`}
                label={t('target')}
                choices={companyAccounts.map((a) => ({ value: a.id, label: a.label }))}
                value={companyTarget}
                onChange={(v) => {
                  setCompanyTarget(v)
                  clear('targetBankAccountId')
                }}
                placeholder={companyAccounts.length ? t('targetPick') : t('noTargets')}
                disabled={companyAccounts.length === 0}
                error={errors.targetBankAccountId}
              />
            ) : null}
            {openHref ? (
              <Notice tone="warning">
                <p>{t('openChange')}</p>
                <Link href={openHref} className="inline-flex min-h-11 items-center font-medium text-primary underline underline-offset-4 hover:no-underline">
                  {t('openChangeLink')}
                </Link>
              </Notice>
            ) : null}
          </CardContent>
        </Card>
        <Button type="submit" className="self-start" disabled={!hydrated}>
          {t('next')}
        </Button>
      </form>
    )
  }

  const errorOf = (key: FieldKey) => errors[key]
  return (
    <form
      method="post"
      noValidate
      onSubmit={(event) => {
        event.preventDefault()
        void save(true)
      }}
      className="flex max-w-3xl flex-col gap-4"
    >
      {stepper}
      <p className="text-ink">
        {tk(kind)} · {owner === 'SUPPLIER' ? (supplier?.label ?? '-') : t('ownerCompany')}
        {target ? ` · ${t('currentAccount', { account: target.label })}` : ''}
      </p>

      {proposes ? (
        <Card className="gap-3 bg-bg text-base">
          <CardHeader>
            <CardTitle>
              <h2 className="text-base font-semibold">{t('accountTitle')}</h2>
            </CardTitle>
          </CardHeader>
          <CardContent className="grid gap-4 md:grid-cols-2">
            <ChoiceSelect
              id={`${id}-bankCode`}
              label={t('bank')}
              choices={banks}
              value={bankCode}
              onChange={(v) => {
                setBankCode(v)
                clear('bankCode')
              }}
              placeholder={t('bankPick')}
              error={errorOf('bankCode')}
            />
            <TextField
              id={`${id}-accountNo`}
              label={t('accountNo')}
              hint={t('accountNoHint')}
              inputMode="numeric"
              autoComplete="off"
              maxLength={40}
              value={accountNo}
              onChange={(e) => {
                setAccountNo(e.currentTarget.value)
                clear('accountNo')
              }}
              error={errorOf('accountNo')}
              className="tabular"
            />
            <TextField
              id={`${id}-accountName`}
              label={t('accountName')}
              hint={t('accountNameHint')}
              maxLength={200}
              autoComplete="off"
              value={accountName}
              onChange={(e) => {
                setAccountName(e.currentTarget.value)
                clear('accountName')
              }}
              error={errorOf('accountName')}
            />
            <TextField
              id={`${id}-branchName`}
              label={t('branch')}
              maxLength={200}
              autoComplete="off"
              value={branchName}
              onChange={(e) => {
                setBranchName(e.currentTarget.value)
                clear('branchName')
              }}
              error={errorOf('branchName')}
            />
            {owner === 'ORGANIZATION' ? (
              <RadioChoices<'CURRENT' | 'SAVINGS'>
                id={`${id}-accountType`}
                legend={t('accountType')}
                value={accountType}
                onChange={(v) => {
                  setAccountType(v)
                  clear('accountType')
                }}
                choices={[
                  { value: 'CURRENT', label: t('accountTypes.CURRENT') },
                  { value: 'SAVINGS', label: t('accountTypes.SAVINGS') },
                ]}
                error={errorOf('accountType')}
              />
            ) : null}
          </CardContent>
        </Card>
      ) : null}

      <Card className="gap-3 bg-bg text-base">
        <CardHeader>
          <CardTitle>
            <h2 className="text-base font-semibold">{t('proofTitle')}</h2>
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <p id={`${id}-proof-hint`} className="text-ink-muted">
            {proposes ? t('proofHint') : t('proofHintClose')}
          </p>
          {proofs.length ? (
            <ul aria-label={t('proofTitle')} className="flex flex-col divide-y divide-line border-y border-line">
              {proofs.map((p) => (
                <li key={p.fileId} className="flex flex-wrap items-center justify-between gap-2 py-2">
                  <span className="inline-flex min-w-0 items-start gap-2">
                    <FileText className="mt-1 size-4 shrink-0 text-ink-muted" aria-hidden="true" />
                    <span className="break-all text-ink">{p.fileName}</span>
                  </span>
                  <Button variant="link" disabled={busy} onClick={() => setProofs((list) => list.filter((x) => x.fileId !== p.fileId))}>
                    <X className="size-4" aria-hidden="true" />
                    {t('proofRemove', { name: p.fileName })}
                  </Button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-ink-muted">{t('proofNone')}</p>
          )}
          <DropUploadButton
            label={t('proofUpload')}
            actions={actions}
            disabled={busy}
            onUploaded={(file) => {
              setProofs((list) => (list.some((x) => x.fileId === file.fileId) ? list : [...list, file]))
              clear('proof')
            }}
          />
          {errorOf('proof') ? <FieldProblem id={`${id}-proof-error`}>{errorOf('proof')}</FieldProblem> : null}
        </CardContent>
      </Card>

      {callShown ? (
        <Card className="gap-3 bg-bg text-base">
          <CardHeader>
            <CardTitle>
              <h2 className="text-base font-semibold">{callNeeded ? t('callTitleRequired') : t('callTitle')}</h2>
            </CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <p className="text-ink-muted">{t('callHint')}</p>
            <p className="font-medium text-ink">{supplier?.phone ? t('registerPhone', { phone: supplier.phone }) : t('noRegisterPhone')}</p>
            <NoteField
              id={`${id}-callVerificationNote`}
              label={t('callNote')}
              hint={t('callNoteHint')}
              maxLength={500}
              value={callNote}
              onChange={(e) => {
                setCallNote(e.currentTarget.value)
                clear('callVerificationNote')
              }}
              error={errorOf('callVerificationNote')}
            />
            <div className="flex flex-col gap-1.5">
              <label htmlFor={`${id}-callTick`} className="flex min-h-11 cursor-pointer items-start gap-3 py-1">
                <Checkbox
                  id={`${id}-callTick`}
                  checked={callTicked}
                  onCheckedChange={(v) => {
                    setCallTicked(v === true)
                    clear('callTick')
                  }}
                  aria-invalid={errorOf('callTick') ? true : undefined}
                  aria-describedby={errorOf('callTick') ? `${id}-callTick-error` : undefined}
                  className="mt-1 size-5"
                />
                <span className="text-ink">{t('callTick')}</span>
              </label>
              {errorOf('callTick') ? <FieldProblem id={`${id}-callTick-error`}>{errorOf('callTick')}</FieldProblem> : null}
            </div>
          </CardContent>
        </Card>
      ) : null}

      <Card className="gap-3 bg-bg text-base">
        <CardHeader>
          <CardTitle>
            <h2 className="text-base font-semibold">{t('reasonTitle')}</h2>
          </CardTitle>
        </CardHeader>
        <CardContent>
          <NoteField
            id={`${id}-reason`}
            label={t('reason')}
            hint={t('reasonHint')}
            maxLength={REASON_MAX_LENGTH}
            value={reason}
            onChange={(e) => {
              setReason(e.currentTarget.value)
              clear('reason')
            }}
            error={errorOf('reason')}
          />
        </CardContent>
      </Card>

      {problem ? <Notice tone="danger">{problem}</Notice> : null}
      <p className="text-ink-muted">{t('sendHint')}</p>
      <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
        <Button type="submit" disabled={busy || !hydrated} aria-busy={stage === 'sending' || undefined}>
          {stage === 'sending' ? t('sending') : t('send')}
        </Button>
        <Button variant="secondary" disabled={busy || !hydrated} aria-busy={stage === 'saving' || undefined} onClick={() => void save(false)}>
          {stage === 'saving' ? t('saving') : t('saveDraft')}
        </Button>
        <Button
          variant="link"
          disabled={busy}
          onClick={() => {
            setStep(1)
            setErrors({})
            setProblem(null)
          }}
        >
          {t('back')}
        </Button>
      </div>
    </form>
  )
}
