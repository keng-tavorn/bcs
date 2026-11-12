import { lintQuestionnaire, type LintDocumentType } from '@/core/risk'
import { systemCtx } from '@/server/context'
import { forTenant, type TenantTx } from '@/server/db/tenant'
import { appendEvents, type EventDraft } from '@/server/events/append'
import { earliestAssessmentOpen, type RiskSheets } from './risk'
import { dayIn } from './supplier-portal'

// The rows of supplier risk the seed writes itself (S11-12): the configuration of sheets Risk_Tiers Risk_Policy
// Risk_Questionnaire as the organization's admins leave it after the 4-eyes of BR-RSK-02, and the registry flags held
// back while the history is played (src/server/services/demo-seed/risk.ts plays the rest with the real commands).
// src/server/seed/risk.ts reads the sheets without the database.

/**
 * The tiers, policy and questionnaire version 1 of the organization in effect (what organization.set_module asks before
 * RISK is on), once. The questionnaire takes effect with DOA version 1, or from the first day an assessment of the
 * history opens when that is earlier (SP0132's completed 2025-12-15). `documentTypes`: the supplier document types of
 * sheet Supplier_Document_Types the questions are linted against (S7's linkedRiskQuestionCodes · BR-RSK-05).
 */
export async function seedRiskConfigRows(
  organizationId: string,
  sheets: RiskSheets,
  orgCode: string,
  documentTypes: readonly LintDocumentType[],
  now: Date,
  /** The checksum admin.riskQuestionnaire publishes a version with, of the version as stored */
  checksum: (tx: TenantTx, versionId: string) => Promise<string>,
): Promise<{ created: boolean }> {
  const db = forTenant(organizationId)
  if (await db.riskTier.findFirst({ select: { id: true } })) return { created: false }
  const lint = lintQuestionnaire(
    sheets.questions.map((q) => ({ code: q.code, options: q.options, appliesWhen: (q.appliesWhen as never) ?? null, evidenceScopeRequired: q.evidenceScopeRequired, evidenceScope: q.evidenceScope })),
    documentTypes,
  )
  if (lint.errors.length) throw new Error(`ชีต Risk_Questionnaire: แบบประเมินไม่ผ่านการตรวจ ${lint.errors.map((e) => `${e.code} ${e.question ?? e.documentType ?? ''} ${e.reason}`).join(', ')} · แก้ scripts/inputs_p1/p1_risk.py`)
  const ctx = systemCtx(organizationId, now, 'seed')
  const earliest = earliestAssessmentOpen(sheets, dayIn(now, 'Asia/Bangkok'))
  return db.$transaction(async (tx) => {
    const members = await tx.member.findMany({ where: { employeeCode: { in: [...sheets.admins] } }, select: { id: true, employeeCode: true } })
    const memberOf = (code: string) => {
      const m = members.find((x) => x.employeeCode === code)
      if (!m) throw new Error(`ชีต Org (orgAdmins): ไม่มีผู้ใช้ ${code}`)
      return m.id
    }
    const [proposer, confirmer] = [memberOf(sheets.admins[0]), memberOf(sheets.admins[1])]
    const events: EventDraft[] = []
    for (const t of sheets.tiers) {
      const row = await tx.riskTier.create({ data: { organizationId, ...t, updatedById: proposer, confirmedById: confirmer, confirmedAt: now }, select: { id: true } })
      events.push({ type: 'risk_tier.confirmed', aggregateType: 'RiskTier', aggregateId: row.id, data: { code: t.code, changed: [], proposedById: proposer, confirmedById: confirmer } })
    }
    const policy = await tx.riskPolicy.create({
      data: { organizationId, ...sheets.policy, screeningTierMap: { ...sheets.policy.screeningTierMap }, highRiskCategories: [...sheets.policy.highRiskCategories], updatedById: proposer, confirmedById: confirmer, confirmedAt: now },
      select: { id: true },
    })
    events.push({ type: 'risk_policy.confirmed', aggregateType: 'RiskPolicy', aggregateId: policy.id, data: { changed: [], proposedById: proposer, confirmedById: confirmer } })

    const doa = await tx.doaVersion.findFirst({ where: { versionNo: 1, status: { in: ['PUBLISHED', 'SUPERSEDED'] } }, orderBy: { effectiveFrom: 'asc' }, select: { effectiveFrom: true } })
    const starts = [doa?.effectiveFrom ?? now, ...(earliest ? [new Date(`${earliest}T00:00:00+07:00`)] : [])]
    const effectiveFrom = new Date(Math.min(...starts.map((d) => d.getTime())))
    const code = `RQ-${orgCode}`
    const version = await tx.riskQuestionnaire.create({
      data: { organizationId, code, versionNo: 1, status: 'PUBLISHED', effectiveFrom, changeReason: 'ฉบับตั้งต้นจากชีต Risk_Questionnaire (ข้อมูลสังเคราะห์ระยะ 2)', submittedById: proposer, submittedAt: now, publishedById: confirmer, publishedAt: now },
      select: { id: true },
    })
    for (const q of sheets.questions) {
      await tx.riskQuestion.create({ data: { organizationId, questionnaireId: version.id, ...q, options: q.options.map((o) => ({ ...o })), appliesWhen: (q.appliesWhen as object | null) ?? undefined } })
    }
    await tx.riskQuestionnaire.update({ where: { id: version.id }, data: { checksum: await checksum(tx, version.id) } })
    events.push({ type: 'risk_questionnaire.published', aggregateType: 'RiskQuestionnaire', aggregateId: version.id, data: { code, versionNo: 1, effectiveFrom: effectiveFrom.toISOString(), submittedById: proposer, publishedById: confirmer } })
    await appendEvents(tx, ctx, events)
    return { created: true }
  })
}

/** The registry flags of the suppliers held back while the history is played (seedRiskAfterHistory sets them again) */
export async function holdRegistryFlags(organizationId: string): Promise<void> {
  await forTenant(organizationId).supplier.updateMany({ where: { registryFlag: { not: 'NONE' } }, data: { registryFlag: 'NONE', registryFlaggedAt: null } })
}

/** A supplier's registry flag of today, as seedApProfile writes it from sheet SupplierPayment (S8-12) */
export async function setRegistryFlag(organizationId: string, supplierId: string, flag: 'CEASED' | 'VAT_CANCELLED' | 'NOT_FOUND', now: Date): Promise<void> {
  await forTenant(organizationId).supplier.update({ where: { id: supplierId }, data: { registryFlag: flag, registryFlaggedAt: now } })
}
