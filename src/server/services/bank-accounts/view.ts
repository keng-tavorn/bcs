import { z } from 'zod'
import { BANKS, bankOf, maskAccount } from '@/core/bankfile'
import { err, ok, type Result } from '@/core/result'
import { THAI_TIME_ZONE } from '@/core/thai/date'
import { addDays } from '@/core/thai/day'
import { paymentSettingsOf } from '@/lib/org-settings'
import { isAllowed, loadPrincipal, type Principal } from '@/server/authz'
import type { Ctx } from '@/server/context'
import { forTenant, type TenantTx } from '@/server/db/tenant'
import { recordSensitiveAccess } from '../audit/sensitive-access'
import { requireModule } from '../modules'
import { sharedAccount } from './index'

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

/**
 * The approvers of requests (ASSIGNED of bankAccount.reveal), as the assignee or the delegator: whoever holds the task
 * now or decided it — not a co-assignee whose task was cancelled when the other decided, nor someone the task was
 * taken from (REASSIGNED). openOnly: whoever holds an open task now.
 */
async function approversOf(tx: TenantTx, changeIds: readonly string[], openOnly = false): Promise<string[]> {
  if (changeIds.length === 0) return []
  const statuses = openOnly ? (['OPEN', 'INFO_REQUESTED'] as const) : (['OPEN', 'INFO_REQUESTED', 'APPROVED', 'REJECTED', 'RETURNED'] as const)
  const tasks = await tx.approvalTask.findMany({
    where: { status: { in: [...statuses] }, step: { route: { subjectType: 'BANK_ACCOUNT_CHANGE', subjectId: { in: [...changeIds] } } } },
    select: { assigneeMemberId: true, principalMemberId: true },
  })
  return [...new Set(tasks.flatMap((t) => [t.assigneeMemberId, t.principalMemberId]).filter((m): m is string => !!m))]
}

/** The day of an instant in Thai time, as YYYY-MM-DD */
const thaiDay = (at: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: THAI_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at)

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

/**
 * FINANCE opens an account's number whole, and so does the approver of a request waiting to replace or close it, to
 * compare the two before deciding; logged (NFR-PRIV-03). Once decided, the approver opens the request's numbers only.
 */
export async function revealBankAccount(ctx: Ctx, input: { readonly bankAccountId: string }): Promise<Result<{ accountNo: string }>> {
  if (!isUuid(input.bankAccountId)) return err('NOT_FOUND', 'bank account not found')
  return forTenant(ctx.organizationId).$transaction(async (tx) => {
    const principal = await loadPrincipal(tx, ctx)
    const pay = await requireModule(ctx, 'PAY', tx)
    if (!pay.ok) return pay
    const account = await tx.bankAccount.findFirst({ where: { id: input.bankAccountId }, select: { id: true, accountNo: true } })
    if (!account) return err('NOT_FOUND', 'bank account not found')
    const waiting = await tx.bankAccountChange.findMany({ where: { targetBankAccountId: account.id, status: 'PENDING_APPROVAL' }, select: { id: true } })
    if (!mayReveal(principal, await approversOf(tx, waiting.map((c) => c.id), true))) return err('FORBIDDEN', 'you may not open an account number', { capability: 'bankAccount.reveal' })
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
    const shared = change.bankCode && change.accountNo ? await sharedAccount(tx, change.supplier, change.bankCode, change.accountNo) : false
    let contactChangedRecently = false
    if (change.supplier) {
      const org = await tx.organization.findUniqueOrThrow({ where: { id: ctx.organizationId }, select: { settings: true } })
      // N days back in Thai time, as BR-PAY-06 and BR-SOD-10 count them: from the start of the day N days before
      const until = change.submittedAt ?? ctx.now
      const from = new Date(`${addDays(thaiDay(until), -paymentSettingsOf(org.settings).recentBankChangeDays)}T00:00:00+07:00`)
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

// ---------- the screens of S9-09 (/finance/bank-accounts, a request's page, the supplier's card) ----------

/** A member as the screens name them */
export interface BankPersonDto {
  readonly id: string
  readonly nameTh: string
  readonly nameEn: string | null
}

const PERSON_SELECT = { id: true, displayNameTh: true, displayNameEn: true } as const
const personDto = (m: { id: string; displayNameTh: string; displayNameEn: string | null }): BankPersonDto => ({ id: m.id, nameTh: m.displayNameTh, nameEn: m.displayNameEn })

async function peopleOf(tx: TenantTx, ids: ReadonlyArray<string | null | undefined>): Promise<Map<string, BankPersonDto>> {
  const wanted = [...new Set(ids.filter((id): id is string => !!id))]
  if (wanted.length === 0) return new Map()
  const rows = await tx.member.findMany({ where: { id: { in: wanted } }, select: PERSON_SELECT })
  return new Map(rows.map((m) => [m.id, personDto(m)]))
}

const OPEN_CHANGE = ['DRAFT', 'PENDING_APPROVAL'] as const
/** The tabs of the requests on /finance/bank-accounts: the open ones (a draft or waiting for approval) and every one */
export const BANK_CHANGE_TABS = ['open', 'all'] as const
export type BankChangeTab = (typeof BANK_CHANGE_TABS)[number]
/** The most rows a tab shows; the page says when there are more */
export const BANK_CHANGE_LIST_LIMIT = 200

export interface BankAccountChangeRowDto {
  readonly id: string
  readonly number: string | null
  readonly kind: 'ADD' | 'REPLACE' | 'CLOSE'
  readonly ownerKind: 'SUPPLIER' | 'ORGANIZATION'
  readonly supplier: { readonly id: string; readonly code: string; readonly nameTh: string; readonly nameEn: string | null } | null
  readonly status: BankAccountChangeDto['status']
  readonly proposer: BankPersonDto | null
  readonly submittedAt: string | null
  readonly createdAt: string
}

export interface BankAccountChangeListDto {
  readonly tab: BankChangeTab
  readonly rows: readonly BankAccountChangeRowDto[]
  readonly counts: Readonly<Record<BankChangeTab, number>>
  /** More rows than BANK_CHANGE_LIST_LIMIT: the newest are shown */
  readonly limited: boolean
  /** The reader may propose a change (bankAccountChange.propose: FINANCE) */
  readonly canPropose: boolean
}

const ListChangesInput = z.strictObject({ tab: z.enum(BANK_CHANGE_TABS).optional() })

/** The requests to change an account, newest first, by tab (bankAccount.view); no number in them */
export async function listBankAccountChanges(ctx: Ctx, input: z.input<typeof ListChangesInput> = {}): Promise<Result<BankAccountChangeListDto>> {
  const parsed = ListChangesInput.safeParse(input)
  if (!parsed.success) return err('VALIDATION_FAILED', 'invalid input', { field: parsed.error.issues[0]?.path.join('.') ?? '' })
  const tab = parsed.data.tab ?? 'open'
  return forTenant(ctx.organizationId).$transaction(async (tx) => {
    const principal = await loadPrincipal(tx, ctx)
    if (principal.kind !== 'member' || !isAllowed(principal, 'bankAccount.view')) return err('FORBIDDEN', 'you may not see bank accounts', { capability: 'bankAccount.view' })
    const pay = await requireModule(ctx, 'PAY', tx)
    if (!pay.ok) return pay
    const openWhere = { status: { in: [...OPEN_CHANGE] } }
    // One query at a time: a transaction holds one connection
    const open = await tx.bankAccountChange.count({ where: openWhere })
    const all = await tx.bankAccountChange.count()
    const rows = await tx.bankAccountChange.findMany({
      where: tab === 'open' ? openWhere : {},
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: BANK_CHANGE_LIST_LIMIT + 1,
      select: {
        id: true,
        number: true,
        kind: true,
        ownerKind: true,
        status: true,
        submittedAt: true,
        createdAt: true,
        submittedById: true,
        supplier: { select: { id: true, code: true, nameTh: true, nameEn: true } },
      },
    })
    const shown = rows.slice(0, BANK_CHANGE_LIST_LIMIT)
    const people = await peopleOf(
      tx,
      shown.map((r) => r.submittedById),
    )
    return ok({
      tab,
      rows: shown.map((r) => ({
        id: r.id,
        number: r.number,
        kind: r.kind,
        ownerKind: r.ownerKind,
        supplier: r.supplier,
        status: r.status,
        proposer: people.get(r.submittedById) ?? null,
        submittedAt: r.submittedAt?.toISOString() ?? null,
        createdAt: r.createdAt.toISOString(),
      })),
      counts: { open, all },
      limited: rows.length > BANK_CHANGE_LIST_LIMIT,
      canPropose: isAllowed(principal, 'bankAccountChange.propose'),
    })
  })
}

/** A bank of the list in the program (ADR-131), for the form's choice */
export interface BankChoiceDto {
  readonly code: string
  readonly shortName: string
  readonly nameTh: string
}

const bankChoices = (): BankChoiceDto[] => BANKS.map((b) => ({ code: b.code, shortName: b.shortName, nameTh: b.nameTh }))

/** An account a request may replace or close, masked */
export interface BankTargetDto {
  readonly id: string
  readonly code: string | null
  readonly bankCode: string
  readonly bankName: string | null
  readonly accountNoMasked: string
  readonly accountName: string
  /** A request already open on it (one per account): replacing or closing it waits for that one */
  readonly openChangeId: string | null
}

export interface BankSupplierChoiceDto {
  readonly id: string
  readonly code: string
  readonly nameTh: string
  readonly nameEn: string | null
  readonly active: boolean
  /** The phone in the register: the number the call that confirms a replacement goes to (OQ-133) */
  readonly phone: string | null
  /** The account in force (one per supplier, INV-PAY-04) */
  readonly account: BankTargetDto | null
  /** A request already open for the supplier (one per supplier) */
  readonly openChangeId: string | null
}

export interface BankAccountChangeFormDto {
  readonly banks: readonly BankChoiceDto[]
  readonly suppliers: readonly BankSupplierChoiceDto[]
  readonly organizationAccounts: readonly BankTargetDto[]
}

const targetDto = (a: { id: string; code: string | null; bankCode: string; accountNo: string; accountName: string }, openChangeId: string | null): BankTargetDto => ({
  id: a.id,
  code: a.code,
  bankCode: a.bankCode,
  bankName: bankOf(a.bankCode)?.nameTh ?? null,
  accountNoMasked: maskAccount(a.accountNo),
  accountName: a.accountName,
  openChangeId,
})

/**
 * What the proposal form chooses from (bankAccountChange.propose: FINANCE): the banks of the list, the suppliers of the
 * register with the account each has in force and any request already open, and the organization's accounts in force —
 * every number masked
 */
export async function getBankAccountChangeForm(ctx: Ctx): Promise<Result<BankAccountChangeFormDto>> {
  return forTenant(ctx.organizationId).$transaction(async (tx) => {
    const principal = await loadPrincipal(tx, ctx)
    if (principal.kind !== 'member' || !isAllowed(principal, 'bankAccountChange.propose')) return err('FORBIDDEN', 'you may not propose a bank account', { capability: 'bankAccountChange.propose' })
    const pay = await requireModule(ctx, 'PAY', tx)
    if (!pay.ok) return pay
    const suppliers = await tx.supplier.findMany({ orderBy: { code: 'asc' }, select: { id: true, code: true, nameTh: true, nameEn: true, status: true, phone: true } })
    const accounts = await tx.bankAccount.findMany({
      where: { status: 'ACTIVE' },
      orderBy: [{ code: 'asc' }, { createdAt: 'asc' }],
      select: { id: true, ownerKind: true, supplierId: true, code: true, bankCode: true, accountNo: true, accountName: true },
    })
    const open = await tx.bankAccountChange.findMany({ where: { status: { in: [...OPEN_CHANGE] } }, select: { id: true, supplierId: true, targetBankAccountId: true } })
    const openBySupplier = new Map(open.flatMap((c) => (c.supplierId ? [[c.supplierId, c.id] as const] : [])))
    const openByTarget = new Map(open.flatMap((c) => (c.targetBankAccountId ? [[c.targetBankAccountId, c.id] as const] : [])))
    const accountOf = new Map(accounts.flatMap((a) => (a.ownerKind === 'SUPPLIER' && a.supplierId ? [[a.supplierId, a] as const] : [])))
    return ok({
      banks: bankChoices(),
      suppliers: suppliers.map((s) => {
        const account = accountOf.get(s.id)
        return {
          id: s.id,
          code: s.code,
          nameTh: s.nameTh,
          nameEn: s.nameEn,
          active: s.status === 'ACTIVE',
          phone: s.phone,
          account: account ? targetDto(account, openByTarget.get(account.id) ?? null) : null,
          openChangeId: openBySupplier.get(s.id) ?? null,
        }
      }),
      organizationAccounts: accounts.filter((a) => a.ownerKind === 'ORGANIZATION').map((a) => targetDto(a, openByTarget.get(a.id) ?? null)),
    })
  })
}

/** One line of a request's history, from its events and the decisions of its approval tasks */
export interface BankChangeHistoryDto {
  readonly id: string
  readonly type: string
  readonly at: string
  readonly actor: BankPersonDto | null
  readonly onBehalfOf: BankPersonDto | null
  readonly channel: string
  /** approval_task.decided: what the approver decided */
  readonly decision: string | null
  /** bank_account_change.updated: what changed (never a value) */
  readonly fields: readonly string[]
  /** The reason a person gave (a cancellation, a return, a rejection), kept as a Comment */
  readonly note: string | null
}

export interface BankAccountChangeActivityDto {
  readonly proposer: BankPersonDto | null
  /** Whoever holds an open approval task of the request now */
  readonly waitingFor: readonly BankPersonDto[]
  /** The open approval task the reader holds, or the delegator a delegate holds it for (BR-DLG-04): the decision bar's */
  readonly openTaskId: string | null
  /** The reader is the request's proposer and may still propose (edits, proofs, the call, sending, cancelling) */
  readonly isProposer: boolean
  /** The supplier's phone in the register, for the proposer's call (OQ-133); null for anyone else */
  readonly supplierPhone: string | null
  /** The banks, for the proposer's edit of a draft; empty for anyone else */
  readonly banks: readonly BankChoiceDto[]
  readonly history: readonly BankChangeHistoryDto[]
}

const recordOf = (value: unknown): Record<string, unknown> => (value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {})

/**
 * What a request's page shows besides the request itself (getBankAccountChange): who proposed it and who holds it now,
 * the reader's open task, whether the reader is its proposer, and its history — to bankAccount.view and its approvers
 */
export async function getBankAccountChangeActivity(ctx: Ctx, input: { readonly changeId: string }): Promise<Result<BankAccountChangeActivityDto>> {
  if (!isUuid(input.changeId)) return err('NOT_FOUND', 'bank account change not found')
  return forTenant(ctx.organizationId).$transaction(async (tx) => {
    const principal = await loadPrincipal(tx, ctx)
    const pay = await requireModule(ctx, 'PAY', tx)
    if (!pay.ok) return pay
    const change = await tx.bankAccountChange.findFirst({ where: { id: input.changeId }, select: { id: true, submittedById: true, supplier: { select: { phone: true } } } })
    if (!change) return err('NOT_FOUND', 'bank account change not found')
    const approvers = await approversOf(tx, [change.id])
    if (!mayViewChange(principal, approvers)) return err('FORBIDDEN', 'you may not see this request', { capability: 'bankAccount.view' })
    const me = principal.kind === 'member' ? principal.memberId : null
    const tasks = await tx.approvalTask.findMany({
      where: { step: { route: { subjectType: 'BANK_ACCOUNT_CHANGE', subjectId: change.id } } },
      orderBy: [{ assignedAt: 'asc' }, { id: 'asc' }],
      select: { id: true, status: true, assigneeMemberId: true, principalMemberId: true, step: { select: { route: { select: { status: true } } } } },
    })
    const open = tasks.filter((t) => t.status === 'OPEN' && t.step.route.status === 'ACTIVE')
    const mine = me ? open.find((t) => t.assigneeMemberId === me || t.principalMemberId === me) : undefined
    const own = await tx.event.findMany({ where: { aggregateType: 'BankAccountChange', aggregateId: change.id }, orderBy: { seq: 'asc' } })
    const decided = tasks.length ? await tx.event.findMany({ where: { aggregateType: 'ApprovalTask', aggregateId: { in: tasks.map((t) => t.id) }, type: 'approval_task.decided' }, orderBy: { seq: 'asc' } }) : []
    const events = [...own, ...decided].sort((a, b) => (a.seq < b.seq ? -1 : a.seq > b.seq ? 1 : 0))
    const commentIds = events.map((e) => recordOf(e.data).reasonCommentId).filter((id): id is string => typeof id === 'string')
    const comments = commentIds.length ? await tx.comment.findMany({ where: { id: { in: commentIds }, retractedAt: null }, select: { id: true, body: true } }) : []
    const bodies = new Map(comments.map((c) => [c.id, c.body]))
    const people = await peopleOf(tx, [change.submittedById, ...open.map((t) => t.assigneeMemberId), ...events.flatMap((e) => [e.actorMemberId, e.onBehalfOfMemberId])])
    const isProposer = me === change.submittedById && isAllowed(principal, 'bankAccountChange.propose')
    return ok({
      proposer: people.get(change.submittedById) ?? null,
      waitingFor: [...new Set(open.map((t) => t.assigneeMemberId))].map((id) => people.get(id)).filter((p): p is BankPersonDto => !!p),
      openTaskId: mine?.id ?? null,
      isProposer,
      supplierPhone: isProposer ? (change.supplier?.phone ?? null) : null,
      banks: isProposer ? bankChoices() : [],
      history: events.map((e) => {
        const data = recordOf(e.data)
        return {
          id: e.id,
          type: e.type,
          at: e.occurredAt.toISOString(),
          actor: e.actorMemberId ? (people.get(e.actorMemberId) ?? null) : null,
          onBehalfOf: e.onBehalfOfMemberId ? (people.get(e.onBehalfOfMemberId) ?? null) : null,
          channel: e.channel,
          decision: typeof data.decision === 'string' ? data.decision : null,
          fields: Array.isArray(data.fields) ? data.fields.filter((f): f is string => typeof f === 'string') : [],
          note: typeof data.reasonCommentId === 'string' ? (bodies.get(data.reasonCommentId) ?? null) : null,
        }
      }),
    })
  })
}

export interface SupplierBankCardDto {
  /** The account in force (one per supplier, INV-PAY-04), masked */
  readonly account: BankAccountDto | null
  /** A request open for the supplier: a draft or one waiting for approval */
  readonly pending: { readonly id: string; readonly number: string | null; readonly kind: 'ADD' | 'REPLACE' | 'CLOSE'; readonly status: 'DRAFT' | 'PENDING_APPROVAL' } | null
  /** The reader may open the number whole (revealBankAccount: FINANCE, or the approver of a request waiting on it) */
  readonly canReveal: boolean
  /** The reader may propose a change (FINANCE) */
  readonly canPropose: boolean
}

/**
 * The card "บัญชีรับเงิน" of a supplier's page: null — the card is not shown — when the organization has no PAY, the
 * reader has no bankAccount.view, or the supplier is not found (the page says so itself)
 */
export async function getSupplierBankCard(ctx: Ctx, input: { readonly supplierId: string }): Promise<Result<SupplierBankCardDto | null>> {
  if (!isUuid(input.supplierId)) return ok(null)
  return forTenant(ctx.organizationId).$transaction(async (tx) => {
    const principal = await loadPrincipal(tx, ctx)
    if (principal.kind !== 'member' || !isAllowed(principal, 'bankAccount.view')) return ok(null)
    if (!(await requireModule(ctx, 'PAY', tx)).ok) return ok(null)
    const supplier = await tx.supplier.findFirst({ where: { id: input.supplierId }, select: { id: true } })
    if (!supplier) return ok(null)
    const account = await tx.bankAccount.findFirst({ where: { supplierId: supplier.id, status: 'ACTIVE' }, orderBy: { createdAt: 'desc' }, select: ACCOUNT_SELECT })
    const pending = await tx.bankAccountChange.findFirst({ where: { supplierId: supplier.id, status: { in: [...OPEN_CHANGE] } }, select: { id: true, number: true, kind: true, status: true } })
    // As revealBankAccount decides: FINANCE, or whoever holds the open task of a request waiting to replace or close it
    const waiting = account ? await tx.bankAccountChange.findMany({ where: { targetBankAccountId: account.id, status: 'PENDING_APPROVAL' }, select: { id: true } }) : []
    const approvers = await approversOf(
      tx,
      waiting.map((c) => c.id),
      true,
    )
    return ok({
      account: account ? accountDto(account) : null,
      pending: pending && (pending.status === 'DRAFT' || pending.status === 'PENDING_APPROVAL') ? { id: pending.id, number: pending.number, kind: pending.kind, status: pending.status } : null,
      canReveal: !!account && mayReveal(principal, approvers),
      canPropose: isAllowed(principal, 'bankAccountChange.propose'),
    })
  })
}
