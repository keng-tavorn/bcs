import { prisma } from '../client'

// Raw SQL lives only here (spec §4.8). organizationId is always an explicit parameter.

export type RecentDocumentKind = 'REQUEST' | 'PURCHASE_ORDER' | 'GOODS_RECEIPT'

/**
 * The documents a member acted on last, newest first, each once (FR-PLT-014 "ล่าสุด"): Events with them as the actor on a
 * request, PO or receipt, and their approval decisions counted for the document decided (data.subjectType/subjectId).
 * Grouped in the database, so many events on one document (a draft's autosaves) never push the others out. Reads the
 * index Event(organizationId, actorMemberId, seq). Who may see each document is checked afterwards by the caller.
 */
export async function recentDocumentsOf(organizationId: string, memberId: string, limit: number): Promise<Array<{ kind: RecentDocumentKind; id: string }>> {
  const rows = await prisma.$queryRaw<Array<{ kind: RecentDocumentKind; id: string }>>`
    SELECT kind, id FROM (
      SELECT
        CASE "aggregateType"
          WHEN 'Request' THEN 'REQUEST'
          WHEN 'PurchaseOrder' THEN 'PURCHASE_ORDER'
          WHEN 'GoodsReceipt' THEN 'GOODS_RECEIPT'
          ELSE CASE WHEN "data"->>'subjectType' IN ('REQUEST', 'PURCHASE_ORDER') THEN "data"->>'subjectType' END
        END AS kind,
        CASE WHEN "aggregateType" = 'ApprovalTask' THEN "data"->>'subjectId' ELSE "aggregateId"::text END AS id,
        "seq"
      FROM "Event"
      WHERE "organizationId" = ${organizationId}::uuid AND "actorMemberId" = ${memberId}::uuid
        AND "aggregateType" IN ('Request', 'PurchaseOrder', 'GoodsReceipt', 'ApprovalTask')
    ) e
    WHERE kind IS NOT NULL AND id ~ '^[0-9a-fA-F-]{36}$'
    GROUP BY kind, id
    ORDER BY max("seq") DESC
    LIMIT ${limit}`
  return rows
}
