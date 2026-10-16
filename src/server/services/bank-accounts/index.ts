import { z } from 'zod'
import { NEUTRAL_TEMPLATE_CODE, normalizeAccount } from '@/core/bankfile'
import { BANK_ACCOUNT_CHANGE_MACHINE, transition, type BankAccountChangeCommand, type BankAccountChangeState } from '@/core/state-machines'
import { REASON_MAX_LENGTH } from '@/lib/constants'
import { authorize } from '@/server/authz'
import type { Ctx } from '@/server/context'
import { lockRowsForUpdate } from '@/server/db/sql/locks'
import type { TenantTx } from '@/server/db/tenant'
import type { EventDraft } from '@/server/events/append'
import type { NotificationDraft } from '@/server/notifications/create'
import { enqueueSupplierNotice } from '@/server/notifications/supplier-notices'
import { PAY_SUPPLIER_TEMPLATES } from '@/server/notifications/supplier-templates-pay'
import { defineCommand, runCommand, type CommandOutcome, type RunOptions } from '../_pipeline'
import { fail, type Fail } from '../ap/common'
import { closeRoute, startRoute } from '../approvals/route'
import type { SubjectDecided, SubjectDecision } from '../approvals/subjects'
import { requireModule } from '../modules'
import { issueDocumentNumber } from '../numbering'

// Bank accounts of suppliers and of the organization (S9-04, docs/sub-specs/S9.md, BR-SUP-06, BR-SUP-07, BR-SOD-05,
// §4.11, OQ-133, OQ-137, ADR-128). Phase 1 runs PAY without the supplier portal, so FINANCE proposes every account: a
// BankAccountChange that adds, replaces or closes one, with the bank's or the supplier's paper as BANK_PROOF and, to
// replace a supplier's account, the call made to the number in the register. Sent, it goes to DOA BANK_ACCOUNT_CHANGE
// (no amount, the root department, the proposer never approves — BR-SOD-05). Its approval takes a step-up every time,
// on the web or in LIFF only (BR-DOA-25: ALWAYS_STEP_UP_SUBJECTS, the adapter's channels closed). Only the last
// approval puts the account in force — an account proposed is never paid into before — and, for a supplier's, writes
// the supplier's e-mail (SupplierNotice bank_account.notice) in the same transaction. A supplier has one ACTIVE account
// (INV-PAY-04). Numbers are kept as digits and leave this module masked or as their last four digits only: never in an
// event, a log, a notification or a LINE card (NFR-SEC-09, BR-BANK-08). Every command needs module PAY (BR-PAY-01).

const MIN_REASON_LENGTH = 3
const NOTE_MAX_LENGTH = 500
const NAME_MAX_LENGTH = 200
/** The papers a proof may be: a letter or a passbook page, scanned or photographed */
const PROOF_TYPES = ['application/pdf', 'image/jpeg', 'image/png', 'image/heic'] as const
const MAX_PROOFS = 10

type ChangeRow = NonNullable<Awaited<ReturnType<typeof readChange>>>

const last4 = (accountNo: string | null) => (accountNo ? accountNo.slice(-4) : null)

/** FINANCE of an organization with PAY switched on (BR-PAY-01, OQ-133) */
async function proposer(tx: TenantTx, ctx: Ctx): Promise<{ ok: true; memberId: string } | Fail> {
  const allowed = await authorize(tx, ctx, 'bankAccountChange.propose')
  if (!allowed.ok) return { ok: false, error: allowed.error }
  if (allowed.data.kind !== 'member') return fail('FORBIDDEN', 'only a member proposes a bank account')
  const pay = await requireModule(ctx, 'PAY', tx)
  if (!pay.ok) return { ok: false, error: pay.error }
  return { ok: true, memberId: allowed.data.memberId }
}

function readChange(tx: TenantTx, id: string) {
  return tx.bankAccountChange.findFirst({ where: { id }, include: { supplier: { select: { id: true, code: true, taxId: true } } } })
}

/** The change locked (INV-PLT-03), its command checked against the state machine and, for an edit, the version read */
async function lockedChange(tx: TenantTx, ctx: Ctx, id: string, command: BankAccountChangeCommand, version?: number): Promise<{ ok: true; change: ChangeRow; to: BankAccountChangeState } | Fail> {
  const [locked] = await lockRowsForUpdate(tx, 'BankAccountChange', ctx.organizationId, [id])
  const change = locked ? await readChange(tx, id) : null
  if (!change) return fail('NOT_FOUND', 'bank account change not found')
  const moved = transition(BANK_ACCOUNT_CHANGE_MACHINE, change.status as BankAccountChangeState, command)
  if (!moved.ok) return fail('INVALID_STATE_TRANSITION', `${command} is not allowed from ${change.status}`, { from: change.status, command })
  if (version !== undefined && change.version !== version) return fail('CONFLICT_VERSION', 'the request changed since it was read', { version: change.version })
  return { ok: true, change, to: moved.to }
}

/** Only the proposer edits, sends or cancels their request (sub-spec: ผู้เสนอ · OWN) */
const ownedBy = (change: ChangeRow, memberId: string): Fail | null =>
  change.submittedById === memberId ? null : fail('FORBIDDEN', 'only the proposer changes this request', { capability: 'bankAccountChange.propose' })

// ---------- what a request proposes ----------

const AccountFields = {
  bankCode: z.string().trim().min(1).max(10),
  /** As the passbook writes it: dashes and spaces allowed, kept as digits (BR-SUP-07) */
  accountNo: z.string().trim().min(1).max(40),
  /** 1 to 200 characters as the database keeps it; a control character is ACCOUNT_NAME_FORMAT */
  accountName: z.string().trim().min(1).max(NAME_MAX_LENGTH),
  branchName: z.string().trim().max(NAME_MAX_LENGTH).nullable(),
  /** An organization's account needs it */
  accountType: z.enum(['CURRENT', 'SAVINGS']),
}

interface Proposed {
  readonly bankCode: string
  readonly accountNo: string
  readonly accountName: string
  readonly branchName: string | null
  readonly accountType: 'CURRENT' | 'SAVINGS' | null
}

/** BR-SUP-07: the proposed account as it is kept, or why not */
function checkProposed(input: { bankCode?: string | undefined; accountNo?: string | undefined; accountName?: string | undefined; branchName?: string | null | undefined; accountType?: 'CURRENT' | 'SAVINGS' | undefined }, ownerKind: 'SUPPLIER' | 'ORGANIZATION'): { ok: true; proposed: Proposed } | Fail {
  if (input.bankCode === undefined || input.accountNo === undefined || input.accountName === undefined) {
    const field = input.bankCode === undefined ? 'bankCode' : input.accountNo === undefined ? 'accountNo' : 'accountName'
    return fail('VALIDATION_FAILED', 'a new account needs its bank, number and name', { field, reason: 'REQUIRED' })
  }
  if (ownerKind === 'ORGANIZATION' && !input.accountType) return fail('VALIDATION_FAILED', 'an account of the organization needs its type', { field: 'accountType', reason: 'REQUIRED' })
  const checked = normalizeAccount({ bankCode: input.bankCode, accountNo: input.accountNo, accountName: input.accountName })
  if (!checked.ok) return fail(checked.code, 'the account is not valid', { field: checked.reason === 'BANK_CODE_UNKNOWN' ? 'bankCode' : checked.reason === 'ACCOUNT_NAME_FORMAT' ? 'accountName' : 'accountNo', reason: checked.reason })
  return { ok: true, proposed: { bankCode: input.bankCode, accountNo: checked.accountNo, accountName: input.accountName, branchName: input.branchName ?? null, accountType: input.accountType ?? null } }
}

/** Thai numerals read as the digits they are (๐ U+0E50 … ๙ U+0E59) */
const THAI_DIGITS = /[\u0E50-\u0E59]/g
const THAI_NUMERALS = '\u0E50\u0E51\u0E52\u0E53\u0E54\u0E55\u0E56\u0E57\u0E58\u0E59'
/** What may stand between the digits of a number written by hand: spaces, dashes, dots, slashes, commas, underscores */
const NUMBER_RUN = /\d(?:[\s.,_/\u2010-\u2015-]*\d)*/g

/**
 * Free text of a request — its reason, the call note (OQ-133), a cancellation's reason — names no account it is about:
 * any number in it, read with Thai numerals as digits and its separators taken out, that holds the proposed number or
 * the number replaced is refused, so the number whole never sits in a field every viewer reads (BR-SUP-07,
 * BR-AUTH-04). A phone number is fine.
 */
export function namesAccount(text: string, numbers: ReadonlyArray<string | null>): boolean {
  const plain = text.replace(THAI_DIGITS, (d) => String(THAI_NUMERALS.indexOf(d)))
  const runs = (plain.match(NUMBER_RUN) ?? []).map((r) => r.replace(/\D/g, ''))
  return numbers.some((n) => n !== null && runs.some((r) => r.includes(n)))
}

const namesAccountFail = (field: string): Fail => fail('VALIDATION_FAILED', 'the text must not carry an account number', { field, reason: 'NOTE_HAS_ACCOUNT_NO' })

/**
 * Whether the same account is the ACTIVE account of a supplier with another tax id — or where either side has none, as
 * SHARED_BANK_ACCOUNT counts it (BR-PAY-06): a warning when the request is drafted, never a refusal
 */
export async function sharedAccount(tx: TenantTx, supplier: { id: string; taxId: string | null } | null, bankCode: string, accountNo: string): Promise<boolean> {
  if (!supplier) return false
  const others = await tx.bankAccount.findMany({ where: { ownerKind: 'SUPPLIER', status: 'ACTIVE', bankCode, accountNo, supplierId: { not: supplier.id } }, select: { supplier: { select: { taxId: true } } } })
  return others.some((o) => !o.supplier?.taxId || !supplier.taxId || o.supplier.taxId !== supplier.taxId)
}

/** The account a REPLACE or CLOSE is about: ACTIVE, of the same owner (TARGET_NOT_ACTIVE otherwise) */
async function checkTarget(tx: TenantTx, ctx: Ctx, targetId: string, owner: { ownerKind: 'SUPPLIER' | 'ORGANIZATION'; supplierId: string | null }) {
  await lockRowsForUpdate(tx, 'BankAccount', ctx.organizationId, [targetId])
  const target = await tx.bankAccount.findFirst({ where: { id: targetId } })
  if (!target || target.ownerKind !== owner.ownerKind || target.supplierId !== owner.supplierId) return { ok: false as const, error: fail('VALIDATION_FAILED', 'the account is not one of this owner', { field: 'targetBankAccountId', reason: 'TARGET_NOT_FOUND' }).error }
  if (target.status !== 'ACTIVE') return { ok: false as const, error: fail('VALIDATION_FAILED', 'the account is no longer in force', { field: 'targetBankAccountId', reason: 'TARGET_NOT_ACTIVE' }).error }
  return { ok: true as const, target }
}

// ---------- bankAccountChange.create ----------

const CreateInput = z.strictObject({
  kind: z.enum(['ADD', 'REPLACE', 'CLOSE']),
  ownerKind: z.enum(['SUPPLIER', 'ORGANIZATION']),
  supplierId: z.uuid().optional(),
  targetBankAccountId: z.uuid().optional(),
  bankCode: AccountFields.bankCode.optional(),
  accountNo: AccountFields.accountNo.optional(),
  accountName: AccountFields.accountName.optional(),
  branchName: AccountFields.branchName.optional(),
  accountType: AccountFields.accountType.optional(),
  reason: z.string().trim().min(MIN_REASON_LENGTH).max(REASON_MAX_LENGTH),
})

export const createBankAccountChangeCommand = defineCommand({
  name: 'bankAccountChange.create',
  capability: 'bankAccountChange.propose',
  input: CreateInput,
  async execute(tx, input, ctx): Promise<CommandOutcome<{ changeId: string; warnings: string[] }>> {
    const who = await proposer(tx, ctx)
    if (!who.ok) return who
    if ((input.ownerKind === 'SUPPLIER') !== (input.supplierId !== undefined)) return fail('VALIDATION_FAILED', 'a supplier’s account names its supplier, the organization’s none', { field: 'supplierId', reason: 'OWNER' })
    if ((input.kind === 'ADD') !== (input.targetBankAccountId === undefined)) return fail('VALIDATION_FAILED', 'a replacement or a closure names the account, an addition none', { field: 'targetBankAccountId', reason: 'TARGET' })
    if (input.kind === 'CLOSE' && (input.bankCode ?? input.accountNo ?? input.accountName ?? input.accountType ?? input.branchName) !== undefined) return fail('VALIDATION_FAILED', 'a closure proposes no new account', { field: 'accountNo', reason: 'CLOSE_HAS_ACCOUNT' })
    if (input.ownerKind === 'SUPPLIER' && input.accountType !== undefined) return fail('VALIDATION_FAILED', 'only an account of the organization has a type', { field: 'accountType', reason: 'OWNER' })

    // One open request per supplier and per account (the partial unique indexes): the supplier's row, then the account's
    const supplierId = input.supplierId ?? null
    let supplier: { id: string; taxId: string | null } | null = null
    if (supplierId) {
      const [locked] = await lockRowsForUpdate(tx, 'Supplier', ctx.organizationId, [supplierId])
      supplier = locked ? await tx.supplier.findFirst({ where: { id: supplierId }, select: { id: true, taxId: true } }) : null
      if (!supplier) return fail('NOT_FOUND', 'supplier not found')
      const open = await tx.bankAccountChange.findFirst({ where: { supplierId, status: { in: ['DRAFT', 'PENDING_APPROVAL'] } }, select: { id: true } })
      if (open) return fail('VALIDATION_FAILED', 'the supplier has a bank account request open already', { field: 'supplierId', reason: 'CHANGE_OPEN', changeId: open.id })
      if (input.kind === 'ADD' && (await tx.bankAccount.count({ where: { supplierId, status: 'ACTIVE' } })) > 0) return fail('VALIDATION_FAILED', 'the supplier has an account in force: replace it', { field: 'kind', reason: 'ACCOUNT_EXISTS' })
    }
    let targetNo: string | null = null
    if (input.targetBankAccountId) {
      const target = await checkTarget(tx, ctx, input.targetBankAccountId, { ownerKind: input.ownerKind, supplierId })
      if (!target.ok) return { ok: false, error: target.error }
      targetNo = target.target.accountNo
      const open = await tx.bankAccountChange.findFirst({ where: { targetBankAccountId: input.targetBankAccountId, status: { in: ['DRAFT', 'PENDING_APPROVAL'] } }, select: { id: true } })
      if (open) return fail('VALIDATION_FAILED', 'the account has a request open already', { field: 'targetBankAccountId', reason: 'CHANGE_OPEN', changeId: open.id })
    }
    let proposed: Proposed | null = null
    if (input.kind !== 'CLOSE') {
      const checked = checkProposed(input, input.ownerKind)
      if (!checked.ok) return checked
      proposed = checked.proposed
    }
    if (namesAccount(input.reason, [proposed?.accountNo ?? null, targetNo])) return namesAccountFail('reason')
    const shared = proposed ? await sharedAccount(tx, supplier, proposed.bankCode, proposed.accountNo) : false
    const change = await tx.bankAccountChange.create({
      data: {
        organizationId: ctx.organizationId,
        kind: input.kind,
        ownerKind: input.ownerKind,
        supplierId,
        targetBankAccountId: input.targetBankAccountId ?? null,
        bankCode: proposed?.bankCode ?? null,
        accountNo: proposed?.accountNo ?? null,
        accountName: proposed?.accountName ?? null,
        branchName: proposed?.branchName ?? null,
        accountType: input.ownerKind === 'ORGANIZATION' ? (proposed?.accountType ?? null) : null,
        // ADR-129: an account of the organization pays with the neutral template until a bank's own arrives (P0-03)
        fileTemplateCode: input.ownerKind === 'ORGANIZATION' && proposed ? NEUTRAL_TEMPLATE_CODE : null,
        reason: input.reason,
        submittedById: who.memberId,
      },
      select: { id: true },
    })
    return {
      ok: true,
      result: { changeId: change.id, warnings: shared ? ['SHARED_BANK_ACCOUNT'] : [] },
      events: [
        {
          type: 'bank_account_change.drafted',
          aggregateType: 'BankAccountChange',
          aggregateId: change.id,
          data: { kind: input.kind, ownerKind: input.ownerKind, supplierId, targetBankAccountId: input.targetBankAccountId ?? null, bankCode: proposed?.bankCode ?? null, last4: last4(proposed?.accountNo ?? null), sharedAccount: shared },
        },
      ],
    }
  },
})

export function createBankAccountChange(ctx: Ctx, input: z.input<typeof CreateInput>, options: RunOptions) {
  return runCommand(ctx, createBankAccountChangeCommand, input, options)
}

// ---------- bankAccountChange.update ----------

const UpdateInput = z.strictObject({
  changeId: z.uuid(),
  version: z.number().int().min(0),
  bankCode: AccountFields.bankCode.optional(),
  accountNo: AccountFields.accountNo.optional(),
  accountName: AccountFields.accountName.optional(),
  branchName: AccountFields.branchName.optional(),
  accountType: AccountFields.accountType.optional(),
  reason: z.string().trim().min(MIN_REASON_LENGTH).max(REASON_MAX_LENGTH).optional(),
  /** The call to the number in the register (OQ-133), recorded now; the note names no account */
  callVerificationNote: z.string().trim().min(MIN_REASON_LENGTH).max(NOTE_MAX_LENGTH).optional(),
})

export const updateBankAccountChangeCommand = defineCommand({
  name: 'bankAccountChange.update',
  capability: 'bankAccountChange.propose',
  input: UpdateInput,
  async execute(tx, input, ctx): Promise<CommandOutcome<{ changeId: string; version: number; warnings: string[] }>> {
    const who = await proposer(tx, ctx)
    if (!who.ok) return who
    const found = await lockedChange(tx, ctx, input.changeId, 'bankAccountChange.update', input.version)
    if (!found.ok) return found
    const { change } = found
    const notOwner = ownedBy(change, who.memberId)
    if (notOwner) return notOwner
    const accountTouched = (['bankCode', 'accountNo', 'accountName', 'branchName', 'accountType'] as const).filter((f) => input[f] !== undefined)
    if (change.kind === 'CLOSE' && accountTouched.length > 0) return fail('VALIDATION_FAILED', 'a closure proposes no new account', { field: accountTouched[0], reason: 'CLOSE_HAS_ACCOUNT' })
    if (change.ownerKind === 'SUPPLIER' && input.accountType !== undefined) return fail('VALIDATION_FAILED', 'only an account of the organization has a type', { field: 'accountType', reason: 'OWNER' })
    let proposed: Proposed | null = null
    if (change.kind !== 'CLOSE') {
      const checked = checkProposed(
        {
          bankCode: input.bankCode ?? change.bankCode ?? undefined,
          accountNo: input.accountNo ?? change.accountNo ?? undefined,
          accountName: input.accountName ?? change.accountName ?? undefined,
          branchName: input.branchName !== undefined ? input.branchName : change.branchName,
          accountType: input.accountType ?? change.accountType ?? undefined,
        },
        change.ownerKind,
      )
      if (!checked.ok) return checked
      proposed = checked.proposed
    }
    const target = change.targetBankAccountId ? await tx.bankAccount.findFirst({ where: { id: change.targetBankAccountId }, select: { accountNo: true } }) : null
    const numbers = [proposed?.accountNo ?? null, target?.accountNo ?? null]
    if (input.callVerificationNote !== undefined && namesAccount(input.callVerificationNote, numbers)) return namesAccountFail('callVerificationNote')
    if (namesAccount(input.reason ?? change.reason, numbers)) return namesAccountFail('reason')
    // A call confirms the account as it was when the call was made: changing the account asks for the call again
    const accountChanged = proposed !== null && (proposed.bankCode !== change.bankCode || proposed.accountNo !== change.accountNo || proposed.accountName !== change.accountName)
    const fields = [...accountTouched, ...(input.reason !== undefined ? ['reason'] : []), ...(input.callVerificationNote !== undefined ? ['callVerification'] : [])]
    if (fields.length === 0) return fail('VALIDATION_FAILED', 'nothing to change', { reason: 'NOTHING' })
    const call =
      input.callVerificationNote !== undefined
        ? { callVerifiedAt: ctx.now, callVerificationNote: input.callVerificationNote }
        : accountChanged
          ? { callVerifiedAt: null, callVerificationNote: null }
          : {}
    const updated = await tx.bankAccountChange.update({
      where: { id: change.id },
      data: {
        ...(proposed ? { bankCode: proposed.bankCode, accountNo: proposed.accountNo, accountName: proposed.accountName, branchName: proposed.branchName, accountType: change.ownerKind === 'ORGANIZATION' ? proposed.accountType : null } : {}),
        ...(input.reason !== undefined ? { reason: input.reason } : {}),
        ...call,
        version: { increment: 1 },
      },
      select: { version: true },
    })
    const shared = proposed ? await sharedAccount(tx, change.supplier, proposed.bankCode, proposed.accountNo) : false
    return {
      ok: true,
      result: { changeId: change.id, version: updated.version, warnings: shared ? ['SHARED_BANK_ACCOUNT'] : [] },
      events: [{ type: 'bank_account_change.updated', aggregateType: 'BankAccountChange', aggregateId: change.id, data: { fields, last4: last4(proposed?.accountNo ?? null) } }],
    }
  },
})

export function updateBankAccountChange(ctx: Ctx, input: z.input<typeof UpdateInput>, options: RunOptions) {
  return runCommand(ctx, updateBankAccountChangeCommand, input, options)
}

// ---------- proofs (FileLink BANK_PROOF) ----------

const ProofInput = z.strictObject({ changeId: z.uuid(), version: z.number().int().min(0), fileId: z.uuid() })

export const attachBankProofCommand = defineCommand({
  name: 'bankAccountChange.attachProof',
  capability: 'bankAccountChange.propose',
  input: ProofInput,
  async execute(tx, input, ctx): Promise<CommandOutcome<{ changeId: string; version: number }>> {
    const who = await proposer(tx, ctx)
    if (!who.ok) return who
    const found = await lockedChange(tx, ctx, input.changeId, 'bankAccountChange.update', input.version)
    if (!found.ok) return found
    const notOwner = ownedBy(found.change, who.memberId)
    if (notOwner) return notOwner
    // A paper the proposer uploaded and the files service checked (type by its bytes, sha256), attached nowhere else
    const file = await tx.fileObject.findFirst({ where: { id: input.fileId, uploadedById: who.memberId, status: 'AVAILABLE' }, select: { id: true, mimeType: true } })
    if (!file) return fail('VALIDATION_FAILED', 'the file must be one you uploaded', { field: 'fileId', reason: 'FILE' })
    if (!(PROOF_TYPES as readonly string[]).includes(file.mimeType)) return fail('VALIDATION_FAILED', 'a proof is a PDF or a picture', { field: 'fileId', reason: 'TYPE_NOT_ALLOWED' })
    if ((await tx.fileLink.count({ where: { fileId: file.id } })) > 0) return fail('VALIDATION_FAILED', 'the file is attached already', { field: 'fileId', reason: 'ALREADY_ATTACHED' })
    if ((await tx.fileLink.count({ where: { subjectType: 'BankAccountChange', subjectId: found.change.id, kind: 'BANK_PROOF' } })) >= MAX_PROOFS) return fail('VALIDATION_FAILED', 'the request has the most files it can carry', { field: 'fileId', reason: 'TOO_MANY', max: MAX_PROOFS })
    await tx.fileLink.create({ data: { organizationId: ctx.organizationId, fileId: file.id, subjectType: 'BankAccountChange', subjectId: found.change.id, kind: 'BANK_PROOF' } })
    const updated = await tx.bankAccountChange.update({ where: { id: found.change.id }, data: { version: { increment: 1 } }, select: { version: true } })
    return { ok: true, result: { changeId: found.change.id, version: updated.version }, events: [{ type: 'bank_account_change.updated', aggregateType: 'BankAccountChange', aggregateId: found.change.id, data: { fields: ['proof'], last4: last4(found.change.accountNo) } }] }
  },
})

export const detachBankProofCommand = defineCommand({
  name: 'bankAccountChange.detachProof',
  capability: 'bankAccountChange.propose',
  input: ProofInput,
  async execute(tx, input, ctx): Promise<CommandOutcome<{ changeId: string; version: number }>> {
    const who = await proposer(tx, ctx)
    if (!who.ok) return who
    const found = await lockedChange(tx, ctx, input.changeId, 'bankAccountChange.update', input.version)
    if (!found.ok) return found
    const notOwner = ownedBy(found.change, who.memberId)
    if (notOwner) return notOwner
    const removed = await tx.fileLink.deleteMany({ where: { subjectType: 'BankAccountChange', subjectId: found.change.id, fileId: input.fileId, kind: 'BANK_PROOF' } })
    if (removed.count === 0) return fail('NOT_FOUND', 'the file is not attached to this request', { field: 'fileId' })
    const updated = await tx.bankAccountChange.update({ where: { id: found.change.id }, data: { version: { increment: 1 } }, select: { version: true } })
    return { ok: true, result: { changeId: found.change.id, version: updated.version }, events: [{ type: 'bank_account_change.updated', aggregateType: 'BankAccountChange', aggregateId: found.change.id, data: { fields: ['proof'], last4: last4(found.change.accountNo) } }] }
  },
})

export function attachBankProof(ctx: Ctx, input: z.input<typeof ProofInput>, options: RunOptions) {
  return runCommand(ctx, attachBankProofCommand, input, options)
}
export function detachBankProof(ctx: Ctx, input: z.input<typeof ProofInput>, options: RunOptions) {
  return runCommand(ctx, detachBankProofCommand, input, options)
}

// ---------- bankAccountChange.submit ----------

/** The kind and the owner in words for the task's label and the LINE card: no account number, no account name */
export function changeTitle(change: { kind: string; supplier: { code: string } | null }): string {
  const kind = change.kind === 'ADD' ? 'เพิ่มบัญชี' : change.kind === 'CLOSE' ? 'ปิดบัญชี' : 'เปลี่ยนบัญชี'
  return `${kind} ${change.supplier ? `ผู้ขาย ${change.supplier.code}` : 'บัญชีบริษัท'}`
}

/** BR-PAY-08: a bank account change routes in the name of the root department */
export async function rootDepartmentId(tx: TenantTx): Promise<string | null> {
  return (await tx.department.findFirst({ where: { parentId: null }, orderBy: { code: 'asc' }, select: { id: true } }))?.id ?? null
}

const SubmitInput = z.strictObject({ changeId: z.uuid(), version: z.number().int().min(0) })

export const submitBankAccountChangeCommand = defineCommand({
  name: 'bankAccountChange.submit',
  capability: 'bankAccountChange.propose',
  input: SubmitInput,
  async execute(tx, input, ctx): Promise<CommandOutcome<{ changeId: string; number: string; routeId: string }>> {
    const who = await proposer(tx, ctx)
    if (!who.ok) return who
    const found = await lockedChange(tx, ctx, input.changeId, 'bankAccountChange.submit', input.version)
    if (!found.ok) return found
    const { change, to } = found
    const notOwner = ownedBy(change, who.memberId)
    if (notOwner) return notOwner
    // BR-SUP-06: the paper for a new account, and the call to the supplier's number in the register to replace one
    const proofCount = await tx.fileLink.count({ where: { subjectType: 'BankAccountChange', subjectId: change.id, kind: 'BANK_PROOF' } })
    if (change.kind !== 'CLOSE' && proofCount === 0) return fail('VALIDATION_FAILED', 'attach the bank’s or the supplier’s paper first', { field: 'proof', reason: 'PROOF_REQUIRED' })
    if (change.kind === 'REPLACE' && change.ownerKind === 'SUPPLIER' && !change.callVerifiedAt) return fail('VALIDATION_FAILED', 'record the call to the supplier’s number in the register first', { field: 'callVerificationNote', reason: 'CALL_VERIFICATION_REQUIRED' })
    if (change.targetBankAccountId) {
      const target = await checkTarget(tx, ctx, change.targetBankAccountId, { ownerKind: change.ownerKind, supplierId: change.supplierId })
      if (!target.ok) return { ok: false, error: target.error }
    }
    if (change.kind === 'ADD' && change.supplierId && (await tx.bankAccount.count({ where: { supplierId: change.supplierId, status: 'ACTIVE' } })) > 0) {
      return fail('VALIDATION_FAILED', 'the supplier has an account in force: replace it', { field: 'kind', reason: 'ACCOUNT_EXISTS' })
    }
    const department = await rootDepartmentId(tx)
    if (!department) return fail('VALIDATION_FAILED', 'the organization has no departments', { reason: 'NO_DEPARTMENT' })
    // BR-NUM-01: the number at the first send; a returned request keeps it
    const number = change.number ?? (await issueDocumentNumber(tx, ctx, { document: 'BAC' }))
    const route = await startRoute(
      tx,
      ctx,
      { type: 'BANK_ACCOUNT_CHANGE', id: change.id, label: `${number} ${changeTitle(change)}` },
      // BR-PAY-08: no amount; the proposer never approves (BR-SOD-05, BR-DOA-06)
      { documentType: 'BANK_ACCOUNT_CHANGE', requesterMemberId: change.submittedById, chargedDepartmentId: department, conflictMemberIds: [change.submittedById], at: ctx.now },
    )
    if (!route.ok) return { ok: false, error: route.error }
    await tx.bankAccountChange.update({ where: { id: change.id }, data: { number, status: to, submittedAt: ctx.now, currentRouteId: route.data.routeId, version: { increment: 1 } } })
    return {
      ok: true,
      result: { changeId: change.id, number, routeId: route.data.routeId },
      events: [
        { type: 'bank_account_change.submitted', aggregateType: 'BankAccountChange', aggregateId: change.id, data: { number, routeId: route.data.routeId, proofCount, callVerified: change.callVerifiedAt !== null, resubmitted: change.number !== null } },
        ...route.data.events,
      ],
      notifications: route.data.notifications,
    }
  },
})

export function submitBankAccountChange(ctx: Ctx, input: z.input<typeof SubmitInput>, options: RunOptions) {
  return runCommand(ctx, submitBankAccountChangeCommand, input, options)
}

// ---------- bankAccountChange.cancel ----------

const CancelInput = z.strictObject({ changeId: z.uuid(), version: z.number().int().min(0), reason: z.string().trim().min(MIN_REASON_LENGTH).max(REASON_MAX_LENGTH) })

export const cancelBankAccountChangeCommand = defineCommand({
  name: 'bankAccountChange.cancel',
  capability: 'bankAccountChange.propose',
  input: CancelInput,
  async execute(tx, input, ctx): Promise<CommandOutcome<{ changeId: string }>> {
    const who = await proposer(tx, ctx)
    if (!who.ok) return who
    const found = await lockedChange(tx, ctx, input.changeId, 'bankAccountChange.cancel', input.version)
    if (!found.ok) return found
    const { change, to } = found
    const notOwner = ownedBy(change, who.memberId)
    if (notOwner) return notOwner
    const target = change.targetBankAccountId ? await tx.bankAccount.findFirst({ where: { id: change.targetBankAccountId }, select: { accountNo: true } }) : null
    if (namesAccount(input.reason, [change.accountNo, target?.accountNo ?? null])) return namesAccountFail('reason')
    const events: EventDraft[] = []
    if (change.status === 'PENDING_APPROVAL') events.push(...(await closeRoute(tx, { type: 'BANK_ACCOUNT_CHANGE', id: change.id }, 'CANCELLED', 'REQUEST_CANCELLED')))
    await tx.bankAccountChange.update({ where: { id: change.id }, data: { status: to, currentRouteId: null, version: { increment: 1 } } })
    // The reason is free text: kept as a Comment of the request, never in Event.data, which is never erased (NFR-SEC-09)
    const comment = await tx.comment.create({ data: { organizationId: ctx.organizationId, subjectType: 'BankAccountChange', subjectId: change.id, authorMemberId: who.memberId, body: input.reason }, select: { id: true } })
    return {
      ok: true,
      result: { changeId: change.id },
      events: [{ type: 'bank_account_change.cancelled', aggregateType: 'BankAccountChange', aggregateId: change.id, data: { from: change.status as 'DRAFT' | 'PENDING_APPROVAL', reasonCommentId: comment.id } }, ...events],
    }
  },
})

export function cancelBankAccountChange(ctx: Ctx, input: z.input<typeof CancelInput>, options: RunOptions) {
  return runCommand(ctx, cancelBankAccountChangeCommand, input, options)
}

// ---------- the decision of DOA BANK_ACCOUNT_CHANGE (the subject adapter calls it) ----------

/** §10.1 bank_account_change.decided: the proposer hears the decision */
function decidedNotice(change: ChangeRow, outcome: SubjectDecision['outcome'], number: string): NotificationDraft {
  return {
    recipientMemberId: change.submittedById,
    templateKey: 'bank_account_change.decided',
    data: { changeId: change.id, number, kind: change.kind, supplierCode: change.supplier?.code ?? null, outcome },
    urgency: 'IMMEDIATE',
    dedupeKey: `bank_account_change.decided:${change.id}:${change.version}`,
    subjectType: 'BANK_ACCOUNT_CHANGE',
    subjectId: change.id,
  }
}

/**
 * The route's result. A return sends the request back to its proposer's draft, a rejection ends it; neither touches an
 * account. The last approval checks the account it replaces or closes is still in force (TARGET_NOT_ACTIVE: the whole
 * decision rolls back and the task stays open), then supersedes or closes it and puts the new one in force, tells the
 * supplier by e-mail at the address in the register, and tells the preparer of a draft payment run that pays them.
 */
export async function decideBankAccountChange(tx: TenantTx, ctx: Ctx, changeId: string, decision: SubjectDecision): Promise<SubjectDecided> {
  const command: BankAccountChangeCommand = decision.outcome === 'APPROVED' ? 'bankAccountChange.final_approval' : decision.outcome === 'RETURNED' ? 'approval.return' : 'approval.reject'
  const pay = await requireModule(ctx, 'PAY', tx)
  if (!pay.ok) return { ok: false, error: pay.error }
  const found = await lockedChange(tx, ctx, changeId, command)
  // The tests of the shared base route this subject without a request of its own: refused as the empty adapter was
  if (!found.ok) return found.error.code === 'NOT_FOUND' ? { ok: false, error: { code: 'VALIDATION_FAILED', message: 'no bank account change for this task', details: { reason: 'SUBJECT' } } } : found
  const { change, to } = found
  const number = change.number ?? ''
  if (decision.outcome !== 'APPROVED') {
    // A return is no decision of the request: back to the draft without a decision time
    await tx.bankAccountChange.update({ where: { id: change.id }, data: { status: to, ...(to === 'DRAFT' ? { currentRouteId: null } : { decidedAt: ctx.now }), version: { increment: 1 } } })
    return {
      ok: true,
      documentStatus: to,
      events: [{ type: decision.outcome === 'RETURNED' ? 'bank_account_change.returned' : 'bank_account_change.rejected', aggregateType: 'BankAccountChange', aggregateId: change.id, data: { number, reasonCommentId: decision.reasonCommentId } }],
      notifications: [decidedNotice(change, decision.outcome, number)],
    }
  }

  const events: EventDraft[] = []
  const notifications: NotificationDraft[] = []
  let target: { id: string; bankCode: string; accountNo: string } | null = null
  if (change.targetBankAccountId) {
    const checked = await checkTarget(tx, ctx, change.targetBankAccountId, { ownerKind: change.ownerKind, supplierId: change.supplierId })
    if (!checked.ok) return { ok: false, error: checked.error }
    target = checked.target
  }
  if (change.kind === 'ADD' && change.supplierId && (await tx.bankAccount.count({ where: { supplierId: change.supplierId, status: 'ACTIVE' } })) > 0) {
    return { ok: false, error: { code: 'VALIDATION_FAILED', message: 'the supplier has an account in force already', details: { reason: 'ACCOUNT_EXISTS' } } }
  }
  const owner = { ownerKind: change.ownerKind, supplierId: change.supplierId }
  // The account replaced or closed leaves force first: a supplier has one ACTIVE account (INV-PAY-04)
  if (target && change.kind === 'CLOSE') {
    await tx.bankAccount.update({ where: { id: target.id }, data: { status: 'CLOSED', closedAt: ctx.now, version: { increment: 1 } } })
    events.push({ type: 'bank_account.closed', aggregateType: 'BankAccount', aggregateId: target.id, data: { ...owner, bankCode: target.bankCode, last4: target.accountNo.slice(-4), changeId: change.id } })
  }
  if (target && change.kind === 'REPLACE') await tx.bankAccount.update({ where: { id: target.id }, data: { status: 'SUPERSEDED', supersededAt: ctx.now, version: { increment: 1 } } })
  let applied: { id: string; bankCode: string; accountNo: string } | null = null
  if (change.kind !== 'CLOSE') {
    applied = await tx.bankAccount.create({
      data: {
        organizationId: ctx.organizationId,
        ownerKind: change.ownerKind,
        supplierId: change.supplierId,
        bankCode: change.bankCode!,
        accountNo: change.accountNo!,
        accountName: change.accountName!,
        branchName: change.branchName,
        accountType: change.accountType,
        fileTemplateCode: change.fileTemplateCode,
        fileParams: change.fileParams ?? undefined,
        sourceChangeId: change.id,
        activatedAt: ctx.now,
      },
      select: { id: true, bankCode: true, accountNo: true },
    })
    if (target) events.push({ type: 'bank_account.superseded', aggregateType: 'BankAccount', aggregateId: target.id, data: { ...owner, bankCode: target.bankCode, last4: target.accountNo.slice(-4), changeId: change.id, byBankAccountId: applied.id } })
    events.push({ type: 'bank_account.activated', aggregateType: 'BankAccount', aggregateId: applied.id, data: { ...owner, code: null, bankCode: applied.bankCode, last4: applied.accountNo.slice(-4), via: 'CHANGE', changeId: change.id } })
  }
  await tx.bankAccountChange.update({ where: { id: change.id }, data: { status: to, decidedAt: ctx.now, appliedBankAccountId: applied?.id ?? null, version: { increment: 1 } } })
  events.push({ type: 'bank_account_change.approved', aggregateType: 'BankAccountChange', aggregateId: change.id, data: { number, appliedBankAccountId: applied?.id ?? null, targetBankAccountId: change.targetBankAccountId } })

  if (applied && change.supplierId && change.supplier) {
    // BR-SUP-06: the supplier hears at the address in the register, once per account in force; the sweep of
    // supplier-notice-send sends it (a decision carries no outbox)
    const notice = await enqueueSupplierNotice(tx, ctx, {
      templateKey: PAY_SUPPLIER_TEMPLATES.bankAccountNotice,
      supplierId: change.supplierId,
      subjectType: 'BANK_ACCOUNT',
      subjectId: applied.id,
      dedupeKey: `bank_account_notice:${applied.id}`,
      data: { number, kind: change.kind, bankCode: applied.bankCode, last4: applied.accountNo.slice(-4) },
    })
    events.push(...notice.events)
    notifications.push(...notice.notifications)
    // §10.1: the preparer of a draft payment run that pays this supplier sees the account changed before sending it
    const drafts = await tx.paymentRunItem.findMany({ where: { supplierId: change.supplierId, run: { status: 'DRAFT' } }, select: { paymentRunId: true, run: { select: { preparedById: true } } } })
    for (const d of drafts) {
      notifications.push({
        recipientMemberId: d.run.preparedById,
        templateKey: 'payment_run.account_changed',
        data: { paymentRunId: d.paymentRunId, supplierId: change.supplierId, supplierCode: change.supplier.code, bankAccountId: applied.id },
        urgency: 'DIGEST',
        dedupeKey: `payment_run.account_changed:${d.paymentRunId}:${applied.id}`,
        subjectType: 'PAYMENT_RUN',
        subjectId: d.paymentRunId,
      })
    }
  }
  notifications.push(decidedNotice(change, 'APPROVED', number))
  return { ok: true, documentStatus: to, events, notifications }
}
