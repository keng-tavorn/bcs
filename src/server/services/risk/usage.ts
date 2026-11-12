import type { AppError } from '@/core/result'
import type { TenantTx } from '@/server/db/tenant'
import { questionnaireInEffect } from './questionnaire'
import { riskPolicyInEffect, riskTiersInEffect } from './tiers'

// The RISK module's own rules for organization.set_module (S11-02 · BR-RSK-16 · §4.11). Switching on needs, besides
// SUPPLIER on (MODULE_REQUIRES) and the RO rules of the DOA (BR-DOA-24 · BR-DOA-28), the three tiers and the gate policy
// confirmed by a second person and a questionnaire version in effect: what the engine and the gate read the moment the
// module is on (BR-RSK-02). The values come from the organization (seed or its admins), never from code or BCS (NG-12).
// Switching off waits while an assessment is with its reviewers or an override waits for its approvers (OQ-33).

const LISTED = 20

/** Why RISK cannot be switched on yet, in the order BR-RSK-16 names them; null when it can */
export async function riskNotConfigured(tx: TenantTx, now: Date): Promise<AppError | null> {
  const tiers = await riskTiersInEffect(tx)
  if (!tiers.ok) return tiers.error
  const policy = await riskPolicyInEffect(tx)
  if (!policy.ok) return policy.error
  if (!(await questionnaireInEffect(tx, now))) return { code: 'RISK_QUESTIONNAIRE_NOT_PUBLISHED', message: 'no risk questionnaire version is in effect' }
  return null
}

/** What keeps RISK on: assessments IN_REVIEW and overrides PENDING_APPROVAL, by their numbers (ids before one is given) */
export async function openRiskDocuments(tx: TenantTx): Promise<string[]> {
  const assessments = await tx.riskAssessment.findMany({
    where: { status: 'IN_REVIEW' },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    take: LISTED,
    select: { id: true, number: true },
  })
  const overrides = await tx.riskOverride.findMany({
    where: { status: 'PENDING_APPROVAL' },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    take: LISTED,
    select: { id: true, number: true },
  })
  return [...assessments, ...overrides].map((d) => d.number ?? d.id)
}
