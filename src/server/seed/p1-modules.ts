import { systemCtx } from '@/server/context'
import { forTenant } from '@/server/db/tenant'
import { appendEvents, type EventDraft } from '@/server/events/append'
import { moduleRequiredDocumentTypes } from '@/core/doa'

// The modules of the synthetic phase-1 organization (ADR-070, FR-PLT-007 AC4 AC5): PAY AI BCS_GO switched on once, after
// DOA-SIMEC version 1 is seeded, with organization.module_enabled per module as the BCS team's switch writes it (CORE is
// on already, from seedDemoOrganization). The rule of §4.11 rule 7 holds here too: a module whose DOA rules are missing
// is not switched on — the seed stops instead (the same check as organization.set_module, on the version in effect). The phase-1 sheet Org has no list of modules, so the list is here; the
// lanes never seed modules again. A second run changes nothing.

export const P1_SEED_MODULES = ['PAY', 'AI', 'BCS_GO'] as const
const CONTRACT_REF = 'SEED-P1'
// Shown in the organization's history like any other reason, so it is written in Thai like the demo data
const REASON = 'เปิดโมดูลของระยะ 1 สำหรับข้อมูลสังเคราะห์ (ADR-070)'

export async function seedP1Modules(organizationId: string, now: Date): Promise<{ enabled: number }> {
  const ctx = systemCtx(organizationId, now, 'seed')
  return forTenant(organizationId).$transaction(async (tx) => {
    const events: EventDraft[] = []
    // The document types of the DOA in effect (the seed publishes version 1 from a date in the past)
    const live = await tx.doaRule.findMany({ where: { doaVersion: { status: 'PUBLISHED', effectiveFrom: { lte: now } } }, select: { documentType: true } })
    const has = new Set<string>(live.map((r) => r.documentType))
    for (const key of P1_SEED_MODULES) {
      if (await tx.orgModule.findFirst({ where: { module: key }, select: { id: true } })) continue
      const missing = moduleRequiredDocumentTypes(key).filter((t) => !has.has(t))
      if (missing.length) throw new Error(`DOA ของข้อมูลระยะ 1 ยังไม่มีข้อของ ${missing.join(' ')} ที่โมดูล ${key} ต้องมี จึงเปิดโมดูลไม่ได้ (§4.11 ข้อ 7) · แก้ scripts/inputs_p1/p1_master.py แล้วสร้างไฟล์ใหม่`)
      await tx.orgModule.create({ data: { organizationId, module: key, enabled: true, enabledAt: now, contractRef: CONTRACT_REF, reason: REASON } })
      const comment = await tx.comment.create({ data: { organizationId, subjectType: 'Organization', subjectId: organizationId, authorMemberId: null, body: REASON }, select: { id: true } })
      events.push({ type: 'organization.module_enabled', aggregateType: 'Organization', aggregateId: organizationId, data: { module: key, contractRef: CONTRACT_REF, reasonCommentId: comment.id } })
    }
    if (events.length) await appendEvents(tx, ctx, events)
    return { enabled: events.length }
  })
}
