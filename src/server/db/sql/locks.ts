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
  // S17-10: a device revoked by its owner, by delivery or by deactivation, one change at a time
  'PushDevice',
  // S17-15: a passkey removed by its owner or revoked with their identity, one change at a time
  'MemberPasskey',
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
  // S6
  'WorkflowVersion',
  'BudgetTransfer',
  'BudgetOverrun',
  // S6-10: the agreed prices of one item are added one at a time (BR-PRC-06)
  'CatalogItem',
  // S13-03: an AI action taken into a document (assist-contract.ts)
  'AgentAction',
  // S8
  'Invoice',
  'Retention',
  'PoChange',
  // S9
  'BankAccountChange',
  'BankAccount',
  'PaymentRun',
  // S7: a link used once, a code tried one attempt at a time, a contact changed one change at a time (BR-PORTAL ข้อ 01 ข้อ 02)
  'PortalInviteLink',
  'PortalOtpChallenge',
  'SupplierContact',
  'PortalSession',
  // S7-05: an application decided, routed or changed one at a time (INV-SUP-02)
  'SupplierApplication',
  // S7-06: a document verified, rejected or superseded one change at a time
  'SupplierDocument',
  // S10: an RFx changed one command at a time (its lines, invites, open, close); an invite removed once; a scorecard
  // counted once when the last evaluator submits (BR-RFX-18)
  'RfxEvent',
  'RfxInvite',
  'RfxQuestion',
  // S10-06: a bid saved, submitted, withdrawn or disqualified one command at a time (INV-RFX-02)
  'Bid',
  'Scorecard',
  // S11-04: a tier or the policy proposed, confirmed or discarded one change at a time; a questionnaire version changed
  // one command at a time (BR-RSK-02)
  'RiskTier',
  'RiskPolicy',
  'RiskQuestionnaire',
  // S11-05: an assessment answered, sent, cancelled or given a file one change at a time (INV-RSK-02 · BR-RSK-19)
  'RiskAssessment',
  // S11-07: an override's use by POs counted one PO at a time (BR-RSK-09 ข้อ 4 · BR-RSK-19)
  'RiskOverride',
  // S10-10: an award made, changed, sent, decided or cancelled one command at a time (one open award per RFx)
  'AwardDecision',
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
 * Locks rows FOR SHARE in ascending id order (INV-PLT-03): what a decision reads stays as it was until the decision
 * commits, while others may read it too (BR-RSK-19: the gate before a PO reads the supplier's assessment).
 */
export async function lockRowsForShare(tx: TenantTx, table: LockableTable, organizationId: string, ids: readonly string[]): Promise<string[]> {
  if (!(LOCKABLE as readonly string[]).includes(table) || table === 'Organization' || KEY_COLUMN[table]) throw new Error(`table ${table} is not lockable for share`)
  if (ids.length === 0) return []
  const sorted = [...new Set(ids)].sort()
  const tableSql = Prisma.raw('"' + table + '"')
  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT "id"::text AS id FROM ${tableSql}
    WHERE "organizationId" = ${organizationId}::uuid AND "id" = ANY(${sorted}::uuid[])
    ORDER BY "id" FOR SHARE`
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
