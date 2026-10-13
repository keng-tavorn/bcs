import { Prisma } from '../generated/client'
import type { TenantTx } from '../tenant'

// Raw SQL lives only here (spec §4.8). organizationId is always an explicit parameter.

/**
 * Serializes concurrent runs of the same command (same organization + idempotencyKey) inside the current
 * transaction, so the second run sees the first one's CommandLog row (INV-PLT-01).
 */
export async function lockIdempotencyKey(tx: TenantTx, organizationId: string, idempotencyKey: string): Promise<void> {
  const lockKey = organizationId + ':' + idempotencyKey
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`
}

// Tables whose aggregates are locked with SELECT … FOR UPDATE. Identifiers come only from this list.
const LOCKABLE = [
  'Organization',
  'OrgModule',
  'Member',
  'Request',
  'ApprovalTask',
  'PurchaseOrder',
  'GoodsReceipt',
  'DoaVersion',
  'BudgetLineBalance',
  'Supplier',
  'DocumentSequence',
  'OrgAuthorityChange',
  'Delegation',
  // S8
  'Invoice',
  'Retention',
] as const
export type LockableTable = (typeof LOCKABLE)[number]
/** Tables whose key is not "id": a budget line's balance is keyed by the line (§6.2) */
const KEY_COLUMN: Partial<Record<LockableTable, string>> = { BudgetLineBalance: 'budgetLineId' }

/**
 * Locks rows in ascending id order (INV-PLT-03) and returns the ids that exist for this organization.
 * Organization itself is keyed by id = organizationId.
 */
export async function lockRowsForUpdate(
  tx: TenantTx,
  table: LockableTable,
  organizationId: string,
  ids: readonly string[],
): Promise<string[]> {
  if (!(LOCKABLE as readonly string[]).includes(table)) throw new Error(`table ${table} is not lockable`)
  if (ids.length === 0) return []
  const sorted = [...new Set(ids)].sort()
  const tableSql = Prisma.raw('"' + table + '"')
  const orgColumn = Prisma.raw(table === 'Organization' ? '"id"' : '"organizationId"')
  const keyColumn = Prisma.raw('"' + (KEY_COLUMN[table] ?? 'id') + '"')
  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT ${keyColumn}::text AS id FROM ${tableSql}
    WHERE ${orgColumn} = ${organizationId}::uuid AND ${keyColumn} = ANY(${sorted}::uuid[])
    ORDER BY ${keyColumn} FOR UPDATE`
  return rows.map((r) => r.id)
}

/**
 * Serializes the submits of invoices that carry the same supplier number (S8, INV-AP-06): two invoices on different
 * POs lock different POs, so without this both could pass the duplicate check before either commits.
 */
export async function lockSupplierInvoiceNumber(tx: TenantTx, organizationId: string, supplierId: string, normalizedNo: string): Promise<void> {
  const lockKey = `${organizationId}:supplier-invoice:${supplierId}:${normalizedNo}`
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`
}
