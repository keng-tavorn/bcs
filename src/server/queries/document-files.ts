import type { Ctx } from '@/server/context'
import { forTenant } from '@/server/db/tenant'
import { isUuid } from './requests'
import type { TaskSubjectType } from './tasks'

// Whether a file is one of the files a page lists of the document it shows (FR-PLT-004 AC2, §9.9 principle 5). The LIFF
// pages open a file only through that document — the decision page through its task (src/app/liff/tasks/[id]/actions.ts),
// the request page and its form through the request (src/app/liff/requests/actions.ts), the receiving page through
// its purchase order (src/app/liff/gr/[poId]/actions.ts) — so a LINE sign-in reaches the files of the documents its
// member works on there, and no other file the member's roles could read elsewhere in the organization: an export, an
// invoice, a supplier's papers (defence in depth for a session opened with a LINE ID token alone, ADR-046). Queries never
// check permissions: the action checks the member's right on its page first, and the file service checks the document
// the file belongs to again (getDownloadUrl).

/**
 * The document whose files a page lists:
 *  - REQUEST: a request's attachments and its quotations' files (FileLink "Request");
 *  - PURCHASE_ORDER: a purchase order as its approval page shows it — the files of the requests it orders for;
 *  - VARIANCE: the photos and papers of the goods receipt a variance came from (FileLink "GoodsReceipt");
 *  - PO_RECEIPTS: a purchase order as its receiving page shows it — the photos and papers of its goods receipts;
 *  - DOA_VERSION, ORG_AUTHORITY_CHANGE: no files.
 * The first five are the subjects of approval tasks as getTaskAccess names them.
 */
export type FileDocumentType = TaskSubjectType | 'PO_RECEIPTS'

export interface FileDocument {
  readonly subjectType: FileDocumentType
  readonly subjectId: string
}

export async function isDocumentFile(ctx: Ctx, document: FileDocument, fileId: string): Promise<boolean> {
  if (!isUuid(fileId) || !isUuid(document.subjectId)) return false
  const db = forTenant(ctx.organizationId)
  /** The documents of one type this file is linked to */
  const linkedTo = async (subjectType: 'Request' | 'GoodsReceipt') => (await db.fileLink.findMany({ where: { fileId, subjectType }, select: { subjectId: true } })).map((l) => l.subjectId)
  switch (document.subjectType) {
    case 'REQUEST':
      return (await linkedTo('Request')).includes(document.subjectId)
    case 'PURCHASE_ORDER': {
      const requests = await linkedTo('Request')
      return requests.length > 0 && (await db.poLineSource.count({ where: { poLine: { poId: document.subjectId }, requestLine: { requestId: { in: requests } } } })) > 0
    }
    case 'VARIANCE': {
      const variance = await db.variance.findUnique({ where: { id: document.subjectId }, select: { grId: true } })
      return variance?.grId ? (await linkedTo('GoodsReceipt')).includes(variance.grId) : false
    }
    case 'PO_RECEIPTS': {
      const receipts = await linkedTo('GoodsReceipt')
      return receipts.length > 0 && (await db.goodsReceipt.count({ where: { id: { in: receipts }, poId: document.subjectId } })) > 0
    }
    default:
      return false
  }
}

/**
 * A file the member uploaded that nothing is linked to yet: what a form has uploaded and not saved with its document (a
 * quotation's file before the draft is saved). The file service lets its uploader alone open it (getDownloadUrl); this
 * says whether a form may ask for it, so a form opens its own uploads and no other file.
 */
export async function isOwnUnattachedUpload(ctx: Ctx, memberId: string, fileId: string): Promise<boolean> {
  if (!isUuid(fileId) || !isUuid(memberId)) return false
  const file = await forTenant(ctx.organizationId).fileObject.findUnique({ where: { id: fileId }, select: { uploadedById: true, _count: { select: { links: true } } } })
  return file !== null && file.uploadedById === memberId && file._count.links === 0
}
