// Supplier risk (spec §7.24 BR-RSK-01 to BR-RSK-06 and BR-RSK-13 · S11-03): the shapes the engine reads. Every threshold
// comes from the organization's data passed in (RiskTier, RiskPolicy, RiskQuestion); the engine holds none (BR-RSK-02).

/** The tiers in rising order of risk (enum RiskTierCode); the order is the enum's, the thresholds are the data's */
export const RISK_TIER_CODES = ['LOW', 'MEDIUM', 'HIGH'] as const
export type RiskTierCode = (typeof RISK_TIER_CODES)[number]

export const RISK_DOMAINS = ['GENERAL', 'PRIVACY', 'INFOSEC', 'PREMISES', 'FINANCE'] as const
export type RiskDomain = (typeof RISK_DOMAINS)[number]

/** The three screening questions of a request (BR-RSK-01); each is answered Y or N */
export const SCREENING_FIELDS = ['processesPersonalData', 'accessesSystems', 'accessesPremises'] as const
export type ScreeningField = (typeof SCREENING_FIELDS)[number]
export type Screening = Readonly<Record<ScreeningField, 'Y' | 'N'>>

/** The values of a RiskTier row in effect (pending values never reach the engine · BR-RSK-02) */
export interface RiskTierDef {
  readonly code: RiskTierCode
  /** The lower bound of the tier's points; equal to it counts as the tier (BR-RSK-04) */
  readonly minPoints: number
  readonly reviewMonths: number
  readonly reminderDaysBefore: number
  readonly blocksPo: boolean
  /** An answer from evidence does not count for this tier: the contact confirms each one (BR-RSK-06) */
  readonly requiresExplicitAnswers: boolean
}

/** The confirmed RiskPolicy row of the organization: the parts the tier engine reads (BR-RSK-03) */
export interface RiskPolicyDef {
  readonly screeningTierMap: Readonly<Record<ScreeningField, RiskTierCode>>
  readonly highRiskCategories: readonly string[]
}

export interface RiskOption {
  readonly code: string
  /** A whole number ≥ 0 (BR-RSK-04) */
  readonly points: number
  /** Answering this option makes the final tier at least this one */
  readonly minTier?: RiskTierCode
  /** The option that an answer from evidence chooses (BR-RSK-05) */
  readonly evidence?: boolean
}

/** A condition of §7.9 on the screening fields and the variables of BR-RSK-01; $category takes the op anyIn */
export type RiskCondition =
  | { readonly all: readonly RiskCondition[] }
  | { readonly any: readonly RiskCondition[] }
  | { readonly field: string; readonly op: string; readonly value?: unknown }

export interface RiskQuestionDef {
  readonly code: string
  readonly domain: RiskDomain
  readonly options: readonly RiskOption[]
  /** Empty = the question is in every assessment */
  readonly appliesWhen?: RiskCondition | null
  /** Default true: the question must be answered before the assessment is sent (BR-RSK-06) */
  readonly required?: boolean
  readonly sortOrder: number
  /** The document's scope must match evidenceScope and one of the assessment's workScopes (BR-RSK-05) */
  readonly evidenceScopeRequired?: boolean
  readonly evidenceScope?: string | null
}

/** What the assessment is about: copied from the request, or filled in by procurement (BR-RSK-01) */
export interface RiskContext {
  readonly screening: Screening
  readonly categoryCodes: readonly string[]
  readonly payeeType: string
  readonly isForeign: boolean
}
