// The shapes the risk admin screens pass between their server actions and their client parts (S11-04 · BR-RSK-02): plain
// data, no import of the server. A refusal comes back as its code and the screen-safe reason only (§9.9 · §14.2).

export const RISK_TIERS = ['LOW', 'MEDIUM', 'HIGH'] as const
export type RiskTierCodeUi = (typeof RISK_TIERS)[number]

export const SCREENING_KEYS = ['processesPersonalData', 'accessesSystems', 'accessesPremises'] as const
export type ScreeningKey = (typeof SCREENING_KEYS)[number]

export const RISK_DOMAINS_UI = ['GENERAL', 'PRIVACY', 'INFOSEC', 'PREMISES', 'FINANCE'] as const
export type RiskDomainUi = (typeof RISK_DOMAINS_UI)[number]

export interface TierValues {
  readonly minPoints: number
  readonly reviewMonths: number
  readonly reminderDaysBefore: number
  readonly blocksPo: boolean
  readonly requiresExplicitAnswers: boolean
}

export type TierChangeInput = Partial<TierValues>

export type RiskAdminOutcome =
  | { readonly ok: true; readonly id?: string; /** a file to open: a link of a few minutes (S11-05) */ readonly url?: string }
  | {
      readonly ok: false
      readonly code: string
      /** VALIDATION_FAILED and others: the reason the screen can say (SAME_EDITOR, TIER_ORDER, RISK_LINT …) */
      readonly reason?: string
      /** RISK_LINT: the codes of what fails, for the lint panel */
      readonly lint?: readonly { readonly code: string; readonly question?: string; readonly documentType?: string; readonly reason: string }[]
      /** RISK_ANSWERS_INCOMPLETE: the question codes still to answer */
      readonly missing?: readonly string[]
    }
