import { bankOf } from '@/core/bankfile/banks'
import { flagsKey, itemFlags, PAYMENT_FLAGS, type PaymentFlag } from '@/core/payment'
import { taxDateOf } from '@/core/vat'
import { paymentSettingsOf } from '@/lib/org-settings'
import type { Ctx } from '@/server/context'
import { forTenant, type TenantTx } from '@/server/db/tenant'

// Payment runs as they stand now (S9-05, S9-06, BR-PAY-06, BR-PAY-07): the facts of the suppliers a run pays — their
// ACTIVE account, when it came into force and whose change made it — and the flags of each item worked out again from
// the register, the open bank account changes and the documents' history. The service of runs writes them at adding,
// removing and sending; the approval and the decision pages read them as they are at that moment, so the flags the
// approver acknowledges are the flags the decision checks. Account numbers leave here masked.

/** BR-PAY-06: the first four flags need the preparer's reason before the run is sent */
export const REASON_FLAGS: readonly PaymentFlag[] = PAYMENT_FLAGS.slice(0, 4)

export interface SupplierFacts {
  readonly id: string
  readonly code: string
  readonly nameTh: string
  readonly taxId: string | null
  readonly registryFlag: string
  readonly status: string
  readonly account: {
    readonly id: string
    readonly bankCode: string
    readonly accountNo: string
    readonly accountName: string
    /** The Thai day it came into force */
    readonly activatedOn: string
    /** Made by the seed of a sample organization (INV-PAY-04): never "recently changed" */
    readonly fromSeed: boolean
    /** Who proposed the change that put it in force (BR-SOD-10) */
    readonly proposerMemberId: string | null
  } | null
}

export async function supplierFacts(tx: TenantTx, supplierIds: readonly string[]): Promise<Map<string, SupplierFacts>> {
  if (supplierIds.length === 0) return new Map()
  const ids = [...new Set(supplierIds)]
  const suppliers = await tx.supplier.findMany({ where: { id: { in: ids } }, select: { id: true, code: true, nameTh: true, taxId: true, registryFlag: true, status: true } })
  const accounts = await tx.bankAccount.findMany({
    where: { ownerKind: 'SUPPLIER', status: 'ACTIVE', supplierId: { in: ids } },
    select: { id: true, supplierId: true, bankCode: true, accountNo: true, accountName: true, activatedAt: true, createdAt: true, sourceChangeId: true, sourceChange: { select: { submittedById: true } } },
  })
  const byOwner = new Map(accounts.map((a) => [a.supplierId!, a]))
  return new Map(
    suppliers.map((s) => {
      const a = byOwner.get(s.id)
      const account = a
        ? { id: a.id, bankCode: a.bankCode, accountNo: a.accountNo, accountName: a.accountName, activatedOn: taxDateOf(a.activatedAt ?? a.createdAt), fromSeed: a.sourceChangeId === null, proposerMemberId: a.sourceChange?.submittedById ?? null }
        : null
      return [s.id, { id: s.id, code: s.code, nameTh: s.nameTh, taxId: s.taxId, registryFlag: s.registryFlag, status: s.status, account }]
    }),
  )
}

/** BR-PAY-06: the flags of one item now, from its supplier, its documents and the run's pay date */
export async function itemFlagsNow(
  tx: TenantTx,
  input: { readonly payDate: string; readonly recentBankChangeDays: number; readonly supplier: SupplierFacts; readonly docIds: readonly string[] },
): Promise<{ readonly flags: PaymentFlag[]; readonly requiresReason: boolean }> {
  const { supplier } = input
  // one query at a time: they share the transaction's connection
  const exported = input.docIds.length
    ? await tx.paymentRunDocument.count({ where: { status: 'RELEASED', releasedAfterExport: true, OR: [{ invoiceId: { in: [...input.docIds] } }, { retentionId: { in: [...input.docIds] } }] } })
    : 0
  const pending = await tx.bankAccountChange.count({ where: { supplierId: supplier.id, status: { in: ['DRAFT', 'PENDING_APPROVAL'] } } })
  const sameAccount = supplier.account
    ? await tx.bankAccount.findMany({ where: { ownerKind: 'SUPPLIER', status: 'ACTIVE', bankCode: supplier.account.bankCode, accountNo: supplier.account.accountNo, supplierId: { not: supplier.id } }, select: { supplier: { select: { taxId: true } } } })
    : []
  const flagged = itemFlags(
    {
      payDate: input.payDate,
      supplier: { registryFlag: supplier.registryFlag, status: supplier.status, taxId: supplier.taxId },
      // without an account in force no account flag is due; sending refuses it (BANK_ACCOUNT_NOT_APPROVED)
      account: supplier.account ? { activatedOn: supplier.account.activatedOn, fromSeed: supplier.account.fromSeed } : { activatedOn: '0000-01-01', fromSeed: true },
      // FR-PAY-101 AC6: the approvals past a risk come with S11 (phase 2); none in phase 1, so RISK_OVERRIDE_EXPIRED never arises
      riskOverrides: [],
      previouslyExported: exported > 0,
      pendingChange: pending > 0,
      sameAccountTaxIds: sameAccount.map((o) => o.supplier?.taxId ?? null),
    },
    { recentBankChangeDays: input.recentBankChangeDays },
  )
  return { flags: [...flagged.flags], requiresReason: flagged.requiresReason }
}

export interface RunFlagsNow {
  readonly payDate: string
  readonly items: ReadonlyArray<{
    readonly itemId: string
    readonly supplier: SupplierFacts
    /** The flags written on the item when it was last worked out (adding, removing, sending) */
    readonly storedFlags: readonly PaymentFlag[]
    readonly flags: readonly PaymentFlag[]
    readonly requiresReason: boolean
    readonly flagReason: string | null
  }>
  /** BR-PAY-07 of the flags now */
  readonly flagsKey: string
}

/** The flags of every item of the run now, from its documents still held (BR-PAY-06, BR-PAY-07) */
export async function runFlagsNow(tx: TenantTx, organizationId: string, paymentRunId: string): Promise<RunFlagsNow | null> {
  const run = await tx.paymentRun.findFirst({ where: { id: paymentRunId }, select: { payDate: true } })
  if (!run) return null
  const org = await tx.organization.findUniqueOrThrow({ where: { id: organizationId }, select: { settings: true } })
  const { recentBankChangeDays } = paymentSettingsOf(org.settings)
  const payDate = run.payDate.toISOString().slice(0, 10)
  const items = await tx.paymentRunItem.findMany({ where: { paymentRunId }, select: { id: true, supplierId: true, flags: true, flagReason: true } })
  const links = await tx.paymentRunDocument.findMany({ where: { paymentRunId, status: { in: ['HELD', 'PAID'] } }, select: { paymentRunItemId: true, invoiceId: true, retentionId: true } })
  const facts = await supplierFacts(
    tx,
    items.map((i) => i.supplierId),
  )
  const out = []
  for (const item of items) {
    const supplier = facts.get(item.supplierId)!
    const docIds = links.filter((l) => l.paymentRunItemId === item.id).map((l) => l.invoiceId ?? l.retentionId!)
    const now = await itemFlagsNow(tx, { payDate, recentBankChangeDays, supplier, docIds })
    out.push({ itemId: item.id, supplier, storedFlags: item.flags as PaymentFlag[], flags: now.flags, requiresReason: now.requiresReason, flagReason: item.flagReason })
  }
  out.sort((a, b) => (a.supplier.code < b.supplier.code ? -1 : 1))
  return { payDate, items: out, flagsKey: flagsKey(out.map((i) => ({ code: i.supplier.code, flags: i.flags }))) }
}

// ---------- the run on an approval page (web and LIFF) ----------

export interface PaymentRunTaskViewDto {
  readonly id: string
  readonly number: string | null
  readonly status: string
  readonly payDate: string
  readonly payer: { readonly code: string | null; readonly bankCode: string; readonly bankName: string | null; readonly last4: string }
  readonly totalPayableSatang: bigint
  readonly totalWhtSatang: bigint
  readonly totalTransferSatang: bigint
  readonly itemCount: number
  readonly documentCount: number
  /** BR-PAY-07: the flags now, which the approval sends back */
  readonly flagsKey: string
  /** The items with flags first, then by supplier code (BR-PAY-07): masked accounts only */
  readonly items: ReadonlyArray<{
    readonly supplierCode: string
    readonly supplierName: string
    readonly transferSatang: bigint
    readonly flags: readonly PaymentFlag[]
    readonly flagReason: string | null
    readonly accountLast4: string | null
  }>
}

/** The run of an approval task as its approver reads it: totals, the payer masked, the items with flags first */
export async function getPaymentRunTaskView(ctx: Ctx, paymentRunId: string): Promise<PaymentRunTaskViewDto | null> {
  return forTenant(ctx.organizationId).$transaction(async (tx) => {
    const run = await tx.paymentRun.findFirst({ where: { id: paymentRunId }, include: { payer: { select: { code: true, bankCode: true, accountNo: true } } } })
    if (!run) return null
    const now = await runFlagsNow(tx, ctx.organizationId, paymentRunId)
    if (!now) return null
    const amounts = new Map((await tx.paymentRunItem.findMany({ where: { paymentRunId }, select: { id: true, transferSatang: true, payeeAccountNo: true } })).map((i) => [i.id, i]))
    const items = now.items.map((i) => {
      const row = amounts.get(i.itemId)!
      const accountNo = row.payeeAccountNo ?? i.supplier.account?.accountNo ?? null
      return { supplierCode: i.supplier.code, supplierName: i.supplier.nameTh, transferSatang: row.transferSatang, flags: i.flags, flagReason: i.flagReason, accountLast4: accountNo ? accountNo.slice(-4) : null }
    })
    items.sort((a, b) => (a.flags.length > 0) !== (b.flags.length > 0) ? (a.flags.length > 0 ? -1 : 1) : a.supplierCode < b.supplierCode ? -1 : 1)
    return {
      id: run.id,
      number: run.number,
      status: run.status,
      payDate: now.payDate,
      payer: { code: run.payer.code, bankCode: run.payer.bankCode, bankName: bankOf(run.payer.bankCode)?.nameTh ?? null, last4: run.payer.accountNo.slice(-4) },
      totalPayableSatang: run.totalPayableSatang,
      totalWhtSatang: run.totalWhtSatang,
      totalTransferSatang: run.totalTransferSatang,
      itemCount: run.itemCount,
      documentCount: run.documentCount,
      flagsKey: now.flagsKey,
      items,
    }
  })
}
