import { escapeLike } from '@/server/db/like'
import type { TenantTx } from '@/server/db/tenant'

/**
 * Photos of a receipt (BR-GR-05, FR-P2P-006 AC1): pictures the actor uploaded (an image, not a PDF or an office file),
 * still available and attached to nothing yet — a request's document, a quotation or an earlier receipt is not new
 * evidence of this delivery. gr.post and its preview ask the same.
 */
export async function photosUsable(tx: Pick<TenantTx, 'fileObject'>, actor: string, photoFileIds: readonly string[]): Promise<boolean> {
  const ids = [...new Set(photoFileIds)]
  if (ids.length === 0) return true
  const usable = await tx.fileObject.count({
    where: { id: { in: ids }, uploadedById: actor, status: 'AVAILABLE', mimeType: { startsWith: escapeLike('image/') }, links: { none: {} }, requestQuotations: { none: {} } },
  })
  return usable === ids.length
}
