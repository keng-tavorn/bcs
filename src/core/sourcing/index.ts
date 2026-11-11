// Sourcing engine of S10 (spec §7.23 · BR-RFX · ADR-201 to ADR-209): pure functions only; the services of
// src/server/services/sourcing load the RFx, bids and settings and call these.
export { compareBids, type BidComparison, type BidInput, type Comparison, type RfxLineInput } from './compare'
export {
  criterionScoreBp,
  formatScore,
  priceScoreBp,
  rankBids,
  scorecardReveal,
  validateScorecard,
  weightedScoreBp,
  type CriterionInput,
  type CriterionKind,
  type EvaluatorStatus,
  type RankBidInput,
  type RankedBid,
  type Ranking,
  type Reveal,
} from './score'
export {
  bidValidUntil,
  businessDayMinutes,
  earliestCloseAt,
  isBidExpired,
  isLateBid,
  preferredInEffect,
  preferredWindow,
  questionCutoffAt,
  validateCloseAt,
  type PreferredWindow,
  type RfxKind,
  type SourcingTimeSettings,
} from './timing'
export {
  AWARD_REASON_CODES,
  awardAmount,
  awardTotals,
  confirmedNetPriceCap,
  netUnitPriceCeiling,
  orderReasonCodes,
  riskCleared,
  type AwardReasonCode,
  minInvites,
  priceAnomaly,
  priceAnomalyFlags,
  type AwardAmount,
  type AwardLineInput,
  type BidPrice,
  type MinInvites,
  type PriceCheck,
  type PriceFlag,
  type PriceRefSource,
} from './award'
export { cycleDaysTenths, cycleMedianDays, formatTenths, quotationShare, savings, savingsTotal, type BaselineKind, type BaselinePart, type Saving } from './kpi'
