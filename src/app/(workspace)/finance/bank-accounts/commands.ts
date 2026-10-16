import { z } from 'zod'
import { REASON_MAX_LENGTH } from '@/lib/constants'
import type { Ctx } from '@/server/context'
import {
  attachBankProof,
  cancelBankAccountChange,
  createBankAccountChange,
  detachBankProof,
  submitBankAccountChange,
  updateBankAccountChange,
} from '@/server/services/bank-accounts'
import { revealBankAccount, revealBankAccountChange } from '@/server/services/bank-accounts/view'
import { toBankFailure, type BankFailure, type BankOutcome, type RevealOutcome } from '@/ui/bank-accounts/outcome'

// The commands behind the bank-account screens (S9-09, docs/sub-specs/S9.md "หน้าจอ", FR-PAY-102 AC7 AC8), apart from
// the session and the page cache so tests run them with a context. Every input is parsed first, so a malformed call
// gets VALIDATION_FAILED and never a crash; blank text is taken as not given. Then the S9-04 service decides and checks
// bankAccountChange.propose, the proposer, the state, the version and module PAY again (BR-AUTH-05): a hidden button is
// never the guard. Each command that changes something runs with the idempotencyKey of its form (spec §4.3). Opening a
// number whole is a POST of its own (never a GET), and the service logs every opening (NFR-PRIV-03).

const Key = z.uuid()
const MIN_TEXT = 3
/** What a field may carry here: the service holds each to its own length */
const TEXT_MAX = REASON_MAX_LENGTH * 2
const NOTE_MAX = 500

const invalid = (field: string, reason?: string): BankFailure => ({ ok: false, code: 'VALIDATION_FAILED', field, ...(reason ? { reason } : {}) })

/** Parses the key and the input, or says which is wrong */
function parsed<S extends z.ZodType>(schema: S, input: unknown, idempotencyKey: unknown): { ok: true; value: z.infer<S>; key: string } | BankFailure {
  if (!Key.safeParse(idempotencyKey).success) return invalid('idempotencyKey')
  const r = schema.safeParse(input)
  if (!r.success) return invalid(String(r.error.issues[0]?.path[0] ?? 'input'))
  return { ok: true, value: r.data, key: idempotencyKey as string }
}

/** Typed text: trimmed, and undefined when blank */
const given = (value: string | undefined): string | undefined => {
  const v = value?.trim()
  return v ? v : undefined
}

type ServiceResult<T> = { ok: true; data: T } | { ok: false; error: { code: string; details?: Readonly<Record<string, unknown>> } }

const Text = z.string().max(TEXT_MAX)
const AccountType = z.enum(['CURRENT', 'SAVINGS'])

// ---------- a new request (bankAccountChange.create) ----------

const CreateInput = z.strictObject({
  kind: z.enum(['ADD', 'REPLACE', 'CLOSE']),
  ownerKind: z.enum(['SUPPLIER', 'ORGANIZATION']),
  supplierId: z.uuid().nullable().optional(),
  targetBankAccountId: z.uuid().nullable().optional(),
  bankCode: Text.optional(),
  accountNo: Text.optional(),
  accountName: Text.optional(),
  branchName: Text.optional(),
  accountType: AccountType.nullable().optional(),
  reason: Text,
})

/** /finance/bank-accounts/changes/new: the draft of a request; a closure proposes no account */
export async function createChangeFor(ctx: Ctx, input: unknown, idempotencyKey: unknown): Promise<BankOutcome> {
  const p = parsed(CreateInput, input, idempotencyKey)
  if (!p.ok) return p
  const v = p.value
  const reason = given(v.reason)
  if (!reason || reason.length < MIN_TEXT) return invalid('reason', 'REASON_SHORT')
  if (v.ownerKind === 'SUPPLIER' && !v.supplierId) return invalid('supplierId', 'REQUIRED')
  if (v.kind !== 'ADD' && !v.targetBankAccountId) return invalid('targetBankAccountId', 'REQUIRED')
  const account =
    v.kind === 'CLOSE'
      ? {}
      : {
          ...(given(v.bankCode) ? { bankCode: given(v.bankCode) } : {}),
          ...(given(v.accountNo) ? { accountNo: given(v.accountNo) } : {}),
          ...(given(v.accountName) ? { accountName: given(v.accountName) } : {}),
          ...(given(v.branchName) ? { branchName: given(v.branchName) } : {}),
          ...(v.ownerKind === 'ORGANIZATION' && v.accountType ? { accountType: v.accountType } : {}),
        }
  const result = await createBankAccountChange(
    ctx,
    {
      kind: v.kind,
      ownerKind: v.ownerKind,
      ...(v.ownerKind === 'SUPPLIER' && v.supplierId ? { supplierId: v.supplierId } : {}),
      ...(v.kind !== 'ADD' && v.targetBankAccountId ? { targetBankAccountId: v.targetBankAccountId } : {}),
      ...account,
      reason,
    },
    { idempotencyKey: p.key },
  )
  return result.ok ? { ok: true, changeId: result.data.changeId, version: 0, warnings: result.data.warnings } : toBankFailure(result.error)
}

// ---------- the proposer's draft (bankAccountChange.update and the proofs) ----------

const Version = { changeId: z.uuid(), version: z.number().int().min(0) }

const UpdateInput = z.strictObject({
  ...Version,
  bankCode: Text.optional(),
  /** Blank keeps the number proposed: the page never holds it whole */
  accountNo: Text.optional(),
  accountName: Text.optional(),
  /** Blank takes the branch out */
  branchName: Text.optional(),
  accountType: AccountType.optional(),
  reason: Text.optional(),
})

/** Saves what the proposer changed in the draft: only the fields sent, and the number only when typed again */
export async function updateChangeFor(ctx: Ctx, input: unknown, idempotencyKey: unknown): Promise<BankOutcome> {
  const p = parsed(UpdateInput, input, idempotencyKey)
  if (!p.ok) return p
  const v = p.value
  if (v.reason !== undefined && (given(v.reason)?.length ?? 0) < MIN_TEXT) return invalid('reason', 'REASON_SHORT')
  if (v.accountName !== undefined && !given(v.accountName)) return invalid('accountName', 'REQUIRED')
  if (v.bankCode !== undefined && !given(v.bankCode)) return invalid('bankCode', 'REQUIRED')
  const result = await updateBankAccountChange(
    ctx,
    {
      changeId: v.changeId,
      version: v.version,
      ...(given(v.bankCode) ? { bankCode: given(v.bankCode) } : {}),
      ...(given(v.accountNo) ? { accountNo: given(v.accountNo) } : {}),
      ...(given(v.accountName) ? { accountName: given(v.accountName) } : {}),
      ...(v.branchName !== undefined ? { branchName: given(v.branchName) ?? null } : {}),
      ...(v.accountType ? { accountType: v.accountType } : {}),
      ...(v.reason !== undefined ? { reason: given(v.reason) } : {}),
    },
    { idempotencyKey: p.key },
  )
  return outcomeOf(result)
}

const CallInput = z.strictObject({ ...Version, note: z.string().max(NOTE_MAX * 2) })

/** Records the call made to the number in the register (OQ-133): its time is now; the note names no account */
export async function recordCallFor(ctx: Ctx, input: unknown, idempotencyKey: unknown): Promise<BankOutcome> {
  const p = parsed(CallInput, input, idempotencyKey)
  if (!p.ok) return p
  const note = given(p.value.note)
  if (!note || note.length < MIN_TEXT) return invalid('callVerificationNote', 'NOTE_SHORT')
  if (note.length > NOTE_MAX) return invalid('callVerificationNote', 'NOTE_LONG')
  const result = await updateBankAccountChange(ctx, { changeId: p.value.changeId, version: p.value.version, callVerificationNote: note }, { idempotencyKey: p.key })
  return outcomeOf(result)
}

const ProofInput = z.strictObject({ ...Version, fileId: z.uuid() })

/** Attaches a paper the proposer uploaded (a PDF or a picture) as the request's proof */
export async function attachProofFor(ctx: Ctx, input: unknown, idempotencyKey: unknown): Promise<BankOutcome> {
  const p = parsed(ProofInput, input, idempotencyKey)
  if (!p.ok) return p
  return outcomeOf(await attachBankProof(ctx, p.value, { idempotencyKey: p.key }))
}

/** Takes a proof off the draft */
export async function detachProofFor(ctx: Ctx, input: unknown, idempotencyKey: unknown): Promise<BankOutcome> {
  const p = parsed(ProofInput, input, idempotencyKey)
  if (!p.ok) return p
  return outcomeOf(await detachBankProof(ctx, p.value, { idempotencyKey: p.key }))
}

// ---------- sending and cancelling ----------

const SubmitInput = z.strictObject(Version)

/** Sends the request for approval (DOA BANK_ACCOUNT_CHANGE): the number BAC-… on the first send */
export async function submitChangeFor(ctx: Ctx, input: unknown, idempotencyKey: unknown): Promise<BankOutcome> {
  const p = parsed(SubmitInput, input, idempotencyKey)
  if (!p.ok) return p
  const result = await submitBankAccountChange(ctx, p.value, { idempotencyKey: p.key })
  return result.ok ? { ok: true, changeId: result.data.changeId, number: result.data.number } : toBankFailure(result.error)
}

const CancelInput = z.strictObject({ ...Version, reason: Text })

/** Cancels the request with the reason its readers will see (a draft, or one waiting for approval) */
export async function cancelChangeFor(ctx: Ctx, input: unknown, idempotencyKey: unknown): Promise<BankOutcome> {
  const p = parsed(CancelInput, input, idempotencyKey)
  if (!p.ok) return p
  const reason = given(p.value.reason)
  if (!reason || reason.length < MIN_TEXT) return invalid('reason', 'REASON_SHORT')
  const result = await cancelBankAccountChange(ctx, { changeId: p.value.changeId, version: p.value.version, reason }, { idempotencyKey: p.key })
  return result.ok ? { ok: true, changeId: result.data.changeId } : toBankFailure(result.error)
}

function outcomeOf(result: ServiceResult<{ changeId: string; version: number; warnings?: string[] }>): BankOutcome {
  if (!result.ok) return toBankFailure(result.error)
  return { ok: true, changeId: result.data.changeId, version: result.data.version, ...(result.data.warnings ? { warnings: result.data.warnings } : {}) }
}

// ---------- opening a number whole (bankAccount.reveal, logged) ----------

const RevealChangeInput = z.strictObject({ changeId: z.uuid() })

/** The numbers of a request whole — the one proposed and the one it replaces or closes: FINANCE and its approvers */
export async function revealChangeFor(ctx: Ctx, input: unknown): Promise<RevealOutcome> {
  const p = RevealChangeInput.safeParse(input)
  if (!p.success) return invalid('changeId')
  const result = await revealBankAccountChange(ctx, p.data)
  return result.ok ? { ok: true, accountNo: result.data.accountNo, targetAccountNo: result.data.targetAccountNo } : toBankFailure(result.error)
}

const RevealAccountInput = z.strictObject({ bankAccountId: z.uuid() })

/** An account's number whole: FINANCE, or the approver of a request waiting to replace or close it */
export async function revealAccountFor(ctx: Ctx, input: unknown): Promise<RevealOutcome> {
  const p = RevealAccountInput.safeParse(input)
  if (!p.success) return invalid('bankAccountId')
  const result = await revealBankAccount(ctx, p.data)
  return result.ok ? { ok: true, accountNo: result.data.accountNo, targetAccountNo: null } : toBankFailure(result.error)
}
