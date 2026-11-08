import type { Ctx } from '@/server/context'
import { forTenant } from '@/server/db/tenant'
import { aiReadingOf, type AiReading } from '@/server/services/suppliers/ai-assist'
import { portalWhere } from './db'

// S7-14 (FR-AI-304 AC2 AC3 · BR-AI-30): what the Supplier Onboarding Agent read off the documents of the contact's own
// application, through portalWhere (INV-SUP-01) — each DRAFT reading with the values it proposes for the application,
// the confidence and the check of each, which wait one by one, and which the person took in already. Nothing when the
// AI read nothing (AI off, supplier.aiAssist N, a type the AI does not read): the form is filled by hand (EG-1).

export type { AiReading as PortalAiReading, AiReadingField as PortalAiField, DocumentCheck as PortalAiDocumentCheck } from '@/server/services/suppliers/ai-assist'
export { SUPPLIER_ASSIST_PATHS as PORTAL_AI_PATHS } from '@/server/services/suppliers/ai-assist'

export async function listPortalAiReadings(ctx: Ctx): Promise<AiReading[]> {
  if (ctx.actor.type !== 'SUPPLIER') throw new Error('a portal query needs a portal context')
  if (!ctx.actor.applicationId) return []
  const db = forTenant(ctx.organizationId)
  const actions = await db.agentAction.findMany({
    where: { AND: [portalWhere(ctx, 'agentAction'), { status: 'DRAFT' }] },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: 20,
    select: { id: true, createdAt: true, review: true, fieldConfidence: true, verification: true, inputRefs: true },
  })
  const docIds = actions.map((a) => (a.inputRefs as { documentId?: string } | null)?.documentId).filter((id): id is string => Boolean(id))
  const docs = docIds.length ? await db.supplierDocument.findMany({ where: { AND: [portalWhere(ctx, 'supplierDocument'), { id: { in: docIds } }] }, select: { id: true, documentTypeCode: true, file: { select: { fileName: true } } } }) : []
  const docOf = new Map(docs.map((d) => [d.id, d]))
  return actions.map((a) => aiReadingOf(a, docOf))
}
