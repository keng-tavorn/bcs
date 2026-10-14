import { systemDb } from '../system'

// The sweep of supplier-notice-send (ADR-126) reads across organizations: e-mails to suppliers no event sent yet, oldest
// first. Only ids leave here; each notice is then read and sent through its organization's scoped client.

export async function pendingSupplierNotices(createdBefore: Date, limit: number): Promise<Array<{ id: string; organizationId: string }>> {
  return systemDb.supplierNotice.findMany({ where: { status: 'PENDING', createdAt: { lte: createdBefore } }, orderBy: { createdAt: 'asc' }, take: limit, select: { id: true, organizationId: true } })
}
