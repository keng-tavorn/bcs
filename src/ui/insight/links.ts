// Where a document on the board, the audit trail or a KPI list opens, for this reader (spec §9.9: every figure leads to
// its documents). The page says what the reader may open (§2.4: request.view, po.view, admin.doa.draft,
// admin.orgAuthority.propose); a document the reader may not open stays text rather than a link that ends in a refusal.
// The pages behind the links check again.

export interface DocumentRef {
  readonly type: string
  readonly id: string
  /** The purchase order a variance, a receipt or an invoice belongs to */
  readonly poId?: string | null
}

export interface LinkRights {
  /** request.view — the request page checks the reader's scope itself */
  readonly requests: boolean
  /** po.view over the organization */
  readonly purchaseOrders: boolean
  /** admin.doa.draft */
  readonly doaVersions: boolean
  /** admin.orgAuthority.propose */
  readonly orgAuthorityChanges: boolean
}

/** The page of a document, or the reader's own task when the document has no page they may open */
export function documentHref(doc: DocumentRef, rights: LinkRights, ownTaskId?: string | null): string | null {
  if (doc.type === 'REQUEST' && rights.requests) return `/requests/${doc.id}`
  if (doc.type === 'PURCHASE_ORDER' && rights.purchaseOrders) return `/procurement/pos/${doc.id}`
  if (['VARIANCE', 'GOODS_RECEIPT', 'INVOICE'].includes(doc.type) && rights.purchaseOrders && doc.poId) return `/procurement/pos/${doc.poId}`
  if (doc.type === 'DOA_VERSION' && rights.doaVersions) return `/admin/doa/${doc.id}`
  if (doc.type === 'ORG_AUTHORITY_CHANGE' && rights.orgAuthorityChanges) return '/admin/org-authority'
  return ownTaskId ? `/tasks/${ownTaskId}` : null
}

/** The DOA version page for readers who may open it (FR-DOA-005 AC2) */
export const doaVersionHref = (versionId: string, rights: LinkRights): string | null => (rights.doaVersions ? `/admin/doa/${versionId}` : null)
