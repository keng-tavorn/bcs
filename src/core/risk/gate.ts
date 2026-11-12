import type { RiskTierCode, RiskTierDef } from './types'

// BR-RSK-09 and BR-RSK-12 (FR-RSK-203 · ADR-225 · golden risk-gate): whether a purchase order may go out to its supplier
// — at po.submit, po.send and a PO change. The tier is the higher of the PO's inherent tier and the supplier's assessed
// one; the organization's tiers say which tier blocks; its policy says whether a registry flag blocks. Amounts are satang
// (bigint), dates calendar days in Asia/Bangkok written YYYY-MM-DD so they order as text. Pure.

export const PO_GATE_TRIGGERS = ['SUBMIT', 'SEND', 'PO_CHANGE'] as const
export type PoGateTrigger = (typeof PO_GATE_TRIGGERS)[number]

/** Supplier.registryFlag (S4 · S9): what the registry last said of the supplier */
export type RegistryFlag = 'NONE' | 'CEASED' | 'VAT_CANCELLED' | 'NOT_FOUND'

/**
 * The supplier's assessment on the PO's day: NONE (never assessed and none open) · IN_PROGRESS (one open, none completed)
 * · CURRENT (a COMPLETED one whose validUntil is today or later) · OVERDUE (the COMPLETED one is past its validUntil)
 */
export type GateAssessment = 'NONE' | 'IN_PROGRESS' | 'CURRENT' | 'OVERDUE'

/** The gate policy of the confirmed RiskPolicy row (BR-RSK-02): what a registry flag and an overdue MEDIUM do */
export interface GatePolicy {
  readonly registryFlagBlocks: boolean
  readonly mediumOverdueBlocks: boolean
}

/** A RiskOverride of the supplier (ADR-226): only APPROVED counts; EXPIRED is an APPROVED one the daily job closed */
export interface GateOverride {
  readonly status: string
  /** null = for every PO of the supplier; another PO's id = not for this one (GC-RSK-55) */
  readonly poId: string | null
  /** The last day it may be used, that day included */
  readonly expiresOn: string
  readonly capGrossSatang: bigint
  /** The gross of the POs it already lets out, this PO's share included when it counts already (OQ-224) */
  readonly usedGrossSatang: bigint
}

export interface PoGateInput {
  /** The higher of the PO's inherent tier and Supplier.riskTier (BR-RSK-09) */
  readonly tier: RiskTierCode
  readonly tiers: readonly Pick<RiskTierDef, 'code' | 'blocksPo'>[]
  readonly policy: GatePolicy
  readonly registryFlag: RegistryFlag
  /** The supplier's COMPLETED assessment came after the flag was set (BR-RSK-12) */
  readonly assessedAfterFlag: boolean
  readonly assessment: GateAssessment
  /** Every screening answer Y of the PO is Y in the assessment, and its high-risk categories are the assessment's */
  readonly screeningCovered: boolean
  readonly override: GateOverride | null
  readonly poId: string
  /** The PO's day: ctx.now in Asia/Bangkok */
  readonly poDate: string
  readonly grossSatang: bigint
  /** What of this PO the override's usedGrossSatang already holds (its gross before a PO change · 0 when it is new to it) */
  readonly countedGrossSatang: bigint
  readonly trigger: PoGateTrigger
}

/** Warnings of a gate passed: the first two need a reason on the PO (BR-SUP-04), OVERRIDE_USED is told to AUDITOR */
export type GateWarning = 'REGISTRY_FLAGGED' | 'REASSESSMENT_OVERDUE' | 'OVERRIDE_USED'
export const REASON_WARNINGS: readonly GateWarning[] = ['REGISTRY_FLAGGED', 'REASSESSMENT_OVERDUE']

export type GateSource = 'NOT_REQUIRED' | 'ASSESSMENT' | 'OVERRIDE'
export type GateError = 'RISK_ASSESSMENT_REQUIRED' | 'RISK_REASSESSMENT_REQUIRED' | 'RISK_BLOCKED'
export type GateReason =
  | 'NOT_ASSESSED'
  | 'IN_PROGRESS'
  | 'SCOPE_EXPANDED'
  | 'VALIDITY_LAPSED'
  | 'REGISTRY_CEASED'
  | 'REGISTRY_FLAGGED'
  | 'OVERRIDE_EXPIRED'
  | 'OVERRIDE_CAP_EXCEEDED'

export type PoGateResult =
  | { readonly allowed: true; readonly source: GateSource; readonly warnings: readonly GateWarning[]; readonly requiresReason: boolean }
  | { readonly allowed: false; readonly error: GateError; readonly reason: GateReason }

const blocked = (error: GateError, reason: GateReason): PoGateResult => ({ allowed: false, error, reason })

function passed(source: GateSource, warnings: readonly GateWarning[]): PoGateResult {
  return { allowed: true, source, warnings, requiresReason: warnings.some((w) => REASON_WARNINGS.includes(w)) }
}

/** An override that speaks for this PO: APPROVED (or closed EXPIRED by the job), for every PO or for this one */
export function overrideApplies(override: GateOverride | null, poId: string): override is GateOverride {
  return override !== null && (override.status === 'APPROVED' || override.status === 'EXPIRED') && (override.poId === null || override.poId === poId)
}

/**
 * BR-RSK-09 in its order: (1) a registry flag (BR-RSK-12) · (2) a tier that does not block passes NOT_REQUIRED, an overdue
 * assessment a warning · (3) a blocking tier with a current assessment that covers the PO passes ASSESSMENT · (4) an
 * override for this PO, not past its day and within its cumulative cap, passes OVERRIDE — past its day or over its cap it
 * blocks, before the assessment is looked at again · (5) else the assessment says what is missing.
 */
export function poGate(input: PoGateInput): PoGateResult {
  const warnings: GateWarning[] = []

  // (1) CEASED never clears by reassessing; VAT_CANCELLED and NOT_FOUND clear with an assessment completed after the flag
  if (input.registryFlag !== 'NONE' && (input.registryFlag === 'CEASED' || !input.assessedAfterFlag)) {
    if (input.policy.registryFlagBlocks) return blocked('RISK_BLOCKED', input.registryFlag === 'CEASED' ? 'REGISTRY_CEASED' : 'REGISTRY_FLAGGED')
    warnings.push('REGISTRY_FLAGGED')
  }

  // (2) the organization's tiers say which tier blocks; an overdue MEDIUM blocks only when the policy says so (OQ-226)
  const tierBlocks = input.tiers.find((t) => t.code === input.tier)?.blocksPo ?? false
  const overdueBlocks = input.tier === 'MEDIUM' && input.assessment === 'OVERDUE' && input.policy.mediumOverdueBlocks
  if (!tierBlocks && !overdueBlocks) {
    if (input.assessment === 'OVERDUE') warnings.push('REASSESSMENT_OVERDUE')
    return passed('NOT_REQUIRED', warnings)
  }

  // (3)
  if (input.assessment === 'CURRENT' && input.screeningCovered) return passed('ASSESSMENT', warnings)

  // (4) the cap holds every PO let out under the override: what it holds, less this PO's old share, plus its gross now
  if (overrideApplies(input.override, input.poId)) {
    const o = input.override
    if (o.expiresOn < input.poDate) return blocked('RISK_BLOCKED', 'OVERRIDE_EXPIRED')
    if (o.usedGrossSatang - input.countedGrossSatang + input.grossSatang > o.capGrossSatang) return blocked('RISK_BLOCKED', 'OVERRIDE_CAP_EXCEEDED')
    return passed('OVERRIDE', [...warnings, 'OVERRIDE_USED'])
  }

  // (5)
  if (input.assessment === 'CURRENT') return blocked('RISK_REASSESSMENT_REQUIRED', 'SCOPE_EXPANDED')
  if (input.assessment === 'OVERDUE') return blocked('RISK_REASSESSMENT_REQUIRED', 'VALIDITY_LAPSED')
  return blocked('RISK_ASSESSMENT_REQUIRED', input.assessment === 'IN_PROGRESS' ? 'IN_PROGRESS' : 'NOT_ASSESSED')
}

/**
 * Whether a COMPLETED assessment covers the work of a PO (BR-RSK-09 step 3): every screening answer Y of the PO is Y in
 * the assessment, and every category of the PO is one the assessment was made for or one the policy does not hold high.
 */
export function screeningCovers(
  assessment: { readonly screening: Readonly<Record<string, 'Y' | 'N'>>; readonly categoryCodes: readonly string[] },
  po: { readonly screening: Readonly<Record<string, 'Y' | 'N' | undefined>>; readonly categoryCodes: readonly string[] },
  highRiskCategories: readonly string[],
): boolean {
  const answers = Object.entries(po.screening).every(([field, v]) => v !== 'Y' || assessment.screening[field] === 'Y')
  return answers && po.categoryCodes.every((c) => assessment.categoryCodes.includes(c) || !highRiskCategories.includes(c))
}
