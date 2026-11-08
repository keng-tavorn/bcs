import { formatScore } from '@/core/sourcing/score'

// The shapes the score page (S10-08 · /sourcing/[id]/score) passes between its server actions and its form.

export interface ScoreEntryInput {
  readonly bidId: string
  readonly criterionCode: string
  readonly score: number
  readonly comment?: string
}

export type ScoreOutcome =
  | { readonly ok: true; readonly revealed: boolean }
  | {
      readonly ok: false
      readonly code: string
      /** VALIDATION_FAILED and others: the reason the screen can say */
      readonly reason?: string
      /** SCORES_INCOMPLETE: how many scores are still missing */
      readonly missing?: number
    }

/** A score in basis points as the page shows it: 9538 → "95.38" (BR-RFX-10) */
export const scoreText = (bp: number): string => formatScore(bp)
