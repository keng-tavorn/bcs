import { z } from 'zod'
import { bankOf, maskAccount } from '@/core/bankfile'
import { err, ok, type Result } from '@/core/result'
import { MS_PER_DAY } from '@/lib/constants'
import { paymentSettingsOf } from '@/lib/org-settings'
import { isAllowed, loadPrincipal, type Principal } from '@/server/authz'
import type { Ctx } from '@/server/context'
import { forTenant, type TenantTx } from '@/server/db/tenant'
import { recordSensitiveAccess } from '../audit/sensitive-access'
import { requireModule } from '../modules'

// Reading bank accounts and their change requests (S9-04, BR-SUP-07, BR-AUTH-04, NFR-PRIV-03). Every page shows an
// account number masked — "••••••0016" — to whoever may see accounts (bankAccount.view: FINANCE, PROCUREMENT, AUDITOR)
// and to the approvers of a request. The whole number is opened one at a time with bankAccount.reveal (FINANCE, and
// whoever has or had the approval task of that request), and each opening is a SensitiveAccessLog row written in the
// transaction that hands the value out. AUDITOR sees masked numbers only (BR-AUTH-04). The proofs attached to a request
// show the number whole, so they are downloaded under the same rule and logged too (./file-policy.ts).

const isUuid = (v: string) => z.uuid().safeParse(v).success

export interface BankAccountDto {
  readonly id: string
  readonly ownerKind: 'SUPPLIER' | 'ORGANIZATION'
  readonly supplierId: string | null
  readonly supplierCode: string | null
  readonly code: string | null
  readonly bankCode: string
  readonly bankName: string | null
  /** Every digit but the last four hidden */
  readonly accountNoMasked: string
  readonly last4: string
  readonly accountName: string
  readonly branchName: string | null
  readonly accountType: 'CURRENT' | 'SAVINGS' | null
  readonly status: 'ACTIVE' | 'SUPERSEDED' | 'CLOSED'
  readonly fileTemplateCode: string | null
  /** Null for the seed of a sample organization (INV-PAY-04) */
  readonly sourceChangeId: string | null
  readonly activatedAt: string | null
}

type AccountRow = {
  id: string
  ownerKind: 'SUPPLIER' | 'ORGANIZATION'
  supplierId: string | null
  code: string | null
  bankCode: string
  accountNo: string
  accountName: string
  branchName: string | null
  accountType: 'CURRENT' | 'SAVINGS' | null
  status: 'ACTIVE' | 'SUPERSEDED' | 'CLOSED'
  fileTemplateCode: string | null
  sourceChangeId: string | null
  activatedAt: Date | null
  supplier: { code: string } | null
}

function accountDto(a: AccountRow): BankAccountDto {
  return {
    id: a.id,
    ownerKind: a.ownerKind,
    supplierId: a.supplierId,
    supplierCode: a.supplier?.code ?? null,
    code: a.code,
    bankCode: a.bankCode,
    bankName: bankOf(a.bankCode)?.nameTh ?? null,
    accountNoMasked: maskAccount(a.accountNo),
    last4: a.accountNo.slice(-4),
    accountName: a.accountName,
    branchName: a.branchName,
    accountType: a.accountType,
    status: a.status,
    fileTemplateCode: a.fileTemplateCode,
    sourceChangeId: a.sourceChangeId,
    activatedAt: a.activatedAt?.toISOString() ?? null,
  }
}

const ACCOUNT_SELECT = {
  id: true,
  ownerKind: true,
  supplierId: true,
  code: true,
  bankCode: true,
  accountNo: true,
  accountName: true,
  branchName: true,
  accountType: true,
  status: true,
  fileTemplateCode: true,
  sourceChangeId: true,
  activatedAt: true,
  supplier: { select: { code: true } },
} as const

/** Whoever has or had a task on a request's routes, as the assignee or the delegator (ASSIGNED of bankAccount.reveal) */
async function approversOf(tx: TenantTx, changeIds: readonly string[]): Promise<string[]> {
  if (changeIds.length === 0) return []
  const tasks = await tx.approvalTask.findMany({ where: { step: { route: { subjectType: 'BANK_ACCOUNT_CHANGE', subjectId: { in: [...changeIds] } } } }, select: { assigneeMemberId: true, principalMemberId: true } })
  return [...new Set(tasks.flatMap((t) => [t.assigneeMemberId, t.principalMemberId]).filter((m): m is string => !!m))]
}

const mayReveal = (principal: Principal, approverIds: readonly string[]) => principal.kind === 'member' && isAllowed(principal, 'bankAccount.reveal', { assigneeMemberIds: approverIds })
/** bankAccount.view, or an approver of the request (who decides it must see it) */
const mayViewChange = (principal: Principal, approverIds: readonly string[]) => principal.kind === 'member' && (isAllowed(principal, 'bankAccount.view') || mayReveal(principal, approverIds))

// ---------- accounts ----------

const ListInput = z.strictObject({ supplierId: z.uuid().optional(), ownerKind: z.enum(['SUPPLIER', 'ORGANIZATION']).optional(), activeOnly: z.boolean().optional() })

/** The accounts, masked (bankAccount.view) */
export async function listBankAccounts(ctx: Ctx, input: z.input<typeof ListInput> = {}): Promise<Result<BankAccountDto[]>> {
  const parsed = ListInput.safeParse(input)
  if (!parsed.success) return err('VALIDATION_FAILED', 'invalid input', { field: parsed.error.issues[0]?.path.join('.') ?? '' })
  return forTenant(ctx.organizationId).$transaction(async (tx) => {
    const principal = await loadPrincipal(tx, ctx)
    if (principal.kind !== 'member' || !isAllowed(principal, 'bankAccount.view')) return err('FORBIDDEN', 'you may not see bank accounts', { capability: 'bankAccount.view' })
    const pay = await requireModule(ctx, 'PAY', tx)
    if (!pay.ok) return pay
    const { supplierId, ownerKind, activeOnly } = parsed.data
    const rows = await tx.bankAccount.findMany({
      where: { ...(supplierId ? { supplierId } : {}), ...(ownerKind ? { ownerKind } : {}), ...(activeOnly ? { status: 'ACTIVE' as const } : {}) },
      orderBy: [{ ownerKind: 'asc' }, { code: 'asc' }, { createdAt: 'desc' }],
      select: ACCOUNT_SELECT,
    })
    return ok(rows.map(accountDto))
  })
}

/** FINANCE, or an approver of a request about this account, opens its number whole; logged (NFR-PRIV-03) */
export async function revealBankAccount(ctx: Ctx, input: { readonly bankAccountId: string }): Promise<Result<{ accountNo: string }>> {
  if (!isUuid(input.bankAccountId)) return err('NOT_FOUND', 'bank account not found')
  return forTenant(ctx.organizationId).$transaction(async (tx) => {
    const principal = await loadPrincipal(tx, ctx)
    const pay = await requireModule(ctx, 'PAY', tx)
    if (!pay.ok) return pay
    const account = await tx.bankAccount.findFirst({ where: { id: input.bankAccountId }, select: { id: true, accountNo: true } })
    if (!account) return err('NOT_FOUND', 'bank account not found')
    const changes = await tx.bankAccountChange.findMany({ where: { OR: [{ targetBankAccountId: account.id }, { appliedBankAccountId: account.id }] }, select: { id: true } })
    if (!mayReveal(principal, await approversOf(tx, changes.map((c) => c.id)))) return err('FORBIDDEN', 'you may not open an account number', { capability: 'bankAccount.reveal' })
    await recordSensitiveAccess(tx, ctx, { subjectType: 'BankAccount', subjectId: account.id, fields: ['accountNo'], purpose: 'bankAccount.reveal' })
    return ok({ accountNo: account.accountNo })
  })
}

// ---------- change requests ----------

export interface BankAccountChangeDto {
  readonly id: string
  readonly number: string | null
  readonly kind: 'ADD' | 'REPLACE' | 'CLOSE'
  readonly ownerKind: 'SUPPLIER' | 'ORGANIZATION'
  readonly supplier: { readonly id: string; readonly code: string; readonly nameTh: string } | null
  readonly status: 'DRAFT' | 'PENDING_APPROVAL' | 'APPROVED' | 'REJECTED' | 'CANCELLED'
  readonly proposed: { readonly bankCode: string; readonly bankName: string | null; readonly accountNoMasked: string; readonly last4: string; readonly accountName: string; readonly branchName: string | null; readonly accountType: 'CURRENT' | 'SAVINGS' | null } | null
  readonly target: BankAccountDto | null
  readonly applied: BankAccountDto | null
  readonly reason: string
  readonly callVerifiedAt: string | null
  readonly callVerificationNote: string | null
  readonly proofs: ReadonlyArray<{ readonly fileId: string; readonly fileName: string; readonly mimeType: string }>
  readonly submittedById: string
  readonly submittedAt: string | null
  readonly decidedAt: string | null
  readonly version: number
  /** The same account is the ACTIVE account of a supplier with another tax id (a warning, BR-PAY-06) */
  readonly sharedAccount: boolean
  /** The supplier's e-mail or phone in the register changed within payment.recentBankChangeDays before it was sent */
  readonly contactChangedRecently: boolean
  /** Whether the reader may open the numbers whole (bankAccount.reveal) */
  readonly canReveal: boolean
}

/** A request, masked: to bankAccount.view and to its approvers */
export async function getBankAccountChange(ctx: Ctx, input: { readonly changeId: string }): Promise<Result<BankAccountChangeDto>> {
  if (!isUuid(input.changeId)) return err('NOT_FOUND', 'bank account change not found')
  return forTenant(ctx.organizationId).$transaction(async (tx) => {
    const principal = await loadPrincipal(tx, ctx)
    const pay = await requireModule(ctx, 'PAY', tx)
    if (!pay.ok) return pay
    const change = await tx.bankAccountChange.findFirst({
      where: { id: input.changeId },
      include: { supplier: { select: { id: true, code: true, nameTh: true, taxId: true } }, target: { select: ACCOUNT_SELECT }, applied: { select: ACCOUNT_SELECT } },
    })
    if (!change) return err('NOT_FOUND', 'bank account change not found')
    const approvers = await approversOf(tx, [change.id])
    if (!mayViewChange(principal, approvers)) return err('FORBIDDEN', 'you may not see this request', { capability: 'bankAccount.view' })
    const proofs = await tx.fileLink.findMany({ where: { subjectType: 'BankAccountChange', subjectId: change.id, kind: 'BANK_PROOF' }, orderBy: { createdAt: 'asc' }, select: { file: { select: { id: true, fileName: true, mimeType: true } } } })
    let shared = false
    if (change.supplier && change.bankCode && change.accountNo) {
      const others = await tx.bankAccount.findMany({ where: { ownerKind: 'SUPPLIER', status: 'ACTIVE', bankCode: change.bankCode, accountNo: change.accountNo, supplierId: { not: change.supplier.id } }, select: { supplier: { select: { taxId: true } } } })
      shared = others.some((o) => !o.supplier?.taxId || !change.supplier!.taxId || o.supplier.taxId !== change.supplier!.taxId)
    }
    let contactChangedRecently = false
    if (change.supplier) {
      const org = await tx.organization.findUniqueOrThrow({ where: { id: ctx.organizationId }, select: { settings: true } })
      const until = change.submittedAt ?? ctx.now
      const from = new Date(until.getTime() - paymentSettingsOf(org.settings).recentBankChangeDays * MS_PER_DAY)
      const updates = await tx.event.findMany({ where: { aggregateType: 'Supplier', aggregateId: change.supplier.id, type: 'supplier.updated', occurredAt: { gte: from, lte: until } }, select: { data: true } })
      contactChangedRecently = updates.some((e) => {
        const changed = (e.data as { changed?: unknown }).changed
        return Array.isArray(changed) && changed.some((f) => f === 'email' || f === 'phone')
      })
    }
    return ok({
      id: change.id,
      number: change.number,
      kind: change.kind,
      ownerKind: change.ownerKind,
      supplier: change.supplier ? { id: change.supplier.id, code: change.supplier.code, nameTh: change.supplier.nameTh } : null,
      status: change.status,
      proposed:
        change.bankCode && change.accountNo && change.accountName
          ? { bankCode: change.bankCode, bankName: bankOf(change.bankCode)?.nameTh ?? null, accountNoMasked: maskAccount(change.accountNo), last4: change.accountNo.slice(-4), accountName: change.accountName, branchName: change.branchName, accountType: change.accountType }
          : null,
      target: change.target ? accountDto(change.target) : null,
      applied: change.applied ? accountDto(change.applied) : null,
      reason: change.reason,
      callVerifiedAt: change.callVerifiedAt?.toISOString() ?? null,
      callVerificationNote: change.callVerificationNote,
      proofs: proofs.map((p) => ({ fileId: p.file.id, fileName: p.file.fileName, mimeType: p.file.mimeType })),
      submittedById: change.submittedById,
      submittedAt: change.submittedAt?.toISOString() ?? null,
      decidedAt: change.decidedAt?.toISOString() ?? null,
      version: change.version,
      sharedAccount: shared,
      contactChangedRecently,
      canReveal: mayReveal(principal, approvers),
    })
  })
}

/** The numbers of a request whole — the one proposed and the one it replaces or closes — for FINANCE and its approvers; logged */
export async function revealBankAccountChange(ctx: Ctx, input: { readonly changeId: string }): Promise<Result<{ accountNo: string | null; targetAccountNo: string | null }>> {
  if (!isUuid(input.changeId)) return err('NOT_FOUND', 'bank account change not found')
  return forTenant(ctx.organizationId).$transaction(async (tx) => {
    const principal = await loadPrincipal(tx, ctx)
    const pay = await requireModule(ctx, 'PAY', tx)
    if (!pay.ok) return pay
    const change = await tx.bankAccountChange.findFirst({ where: { id: input.changeId }, select: { id: true, accountNo: true, target: { select: { id: true, accountNo: true } } } })
    if (!change) return err('NOT_FOUND', 'bank account change not found')
    if (!mayReveal(principal, await approversOf(tx, [change.id]))) return err('FORBIDDEN', 'you may not open an account number', { capability: 'bankAccount.reveal' })
    if (change.accountNo) await recordSensitiveAccess(tx, ctx, { subjectType: 'BankAccountChange', subjectId: change.id, fields: ['accountNo'], purpose: 'bankAccount.reveal' })
    if (change.target) await recordSensitiveAccess(tx, ctx, { subjectType: 'BankAccount', subjectId: change.target.id, fields: ['accountNo'], purpose: 'bankAccount.reveal' })
    return ok({ accountNo: change.accountNo, targetAccountNo: change.target?.accountNo ?? null })
  })
}

/** Who may download a request's proofs, which show the number whole: as bankAccount.reveal of that request (./file-policy.ts) */
export async function mayReadBankProof(tx: TenantTx, ctx: Ctx, principal: Principal, changeId: string): Promise<boolean> {
  if (!(await requireModule(ctx, 'PAY', tx)).ok) return false
  const change = await tx.bankAccountChange.findFirst({ where: { id: changeId }, select: { id: true } })
  if (!change) return false
  return mayReveal(principal, await approversOf(tx, [change.id]))
}
