import type { Ctx } from '@/server/context'
import { forTenant } from '@/server/db/tenant'
import { isUuid } from './requests'
import type { TaskAccessDto } from './tasks'

// Whether a file belongs to the document an approval task decides, as the task's decision page lists that document's
// files (§9.9 principle 5, FR-PLT-004 AC2): a request's attachments and quotation files (FileLink "Request"); a purchase
// order's source requests' files; a variance's goods-receipt photos and papers (FileLink "GoodsReceipt"). A DOA version
// or an authority change has none. The LIFF decision page opens a file only through its task
// (src/app/liff/tasks/[id]/actions.ts), so a LINE sign-in reaches the files of the documents its member decides and no
// other file the member's roles could read elsewhere in the organization. Queries never check permissions: the page
// checks the member's right on the task first, and the file service checks the document's again (getDownloadUrl).

export async function isTaskDocumentFile(ctx: Ctx, task: Pick<TaskAccessDto, 'subjectType' | 'subjectId'>, fileId: string): Promise<boolean> {
  if (!isUuid(fileId) || !isUuid(task.subjectId)) return false
  const db = forTenant(ctx.organizationId)
  const linkedTo = async (subjectType: 'Request' | 'GoodsReceipt', subjectIds: readonly string[]) =>
    subjectIds.length > 0 && (await db.fileLink.count({ where: { fileId, subjectType, subjectId: { in: [...subjectIds] } } })) > 0
  switch (task.subjectType) {
    case 'REQUEST':
      return linkedTo('Request', [task.subjectId])
    case 'PURCHASE_ORDER': {
      const sources = await db.poLineSource.findMany({ where: { poLine: { poId: task.subjectId } }, select: { requestLine: { select: { requestId: true } } } })
      return linkedTo('Request', [...new Set(sources.map((s) => s.requestLine.requestId))])
    }
    case 'VARIANCE': {
      const variance = await db.variance.findUnique({ where: { id: task.subjectId }, select: { grId: true } })
      return variance?.grId ? linkedTo('GoodsReceipt', [variance.grId]) : false
    }
    default:
      return false
  }
}
