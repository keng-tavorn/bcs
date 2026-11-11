// Sourcing (S10 · docs/sub-specs/S10.md): RFQ RFP RFI, invites, bids, scorecards and awards. The commands of each part live
// in their own file; the screens and the jobs import from here.

export * from './rfx'
export { answerQuestion, askQuestion, concludeRfx } from './questions'
export { bidForMember, declineRfx, disqualifyBid, recordBidOnBehalf, saveBid, submitBid, viewRfx, withdrawBid, type MemberBidView } from './bids'
export { bidFileScanned, removeBidFile, requestPortalRfxFile, uploadBidFile } from './bid-files'
export { assignEvaluators, recuseEvaluator, saveScores, scoreEntriesOf, scoreSheet, submitScores, type ScoreSheet } from './scores'
export { comparisonFacts, comparisonOf, exportComparison, rfxComparison, type ComparisonBid, type ComparisonFacts, type ComparisonTag, type RfxComparison } from './comparison'
export { rfxReading, type RfxReading } from './access'
export { rankingOf, type RankedRow, type RfxRanking } from './ranking'
export { registerSupplierRiskProvider, type SupplierRiskProvider, type SupplierRiskStatus } from './risk-link'
export { openSourcingDocuments } from './usage'
export { cancelAward, createAward, submitAward, updateAward, type AwardPlan, type AwardSnapshot } from './awards'
export { applyAward, decideAward } from './award-decide'
export { confirmNetPrices, releaseAwardPo } from './award-apply'
export {
  createPreferredSupplier,
  endPreferredSupplier,
  preferredInEffect,
  preferredSuppliersFor,
  runPreferredSupplierExpiry,
  PREFERRED_EXPIRY_WARNING_DAYS,
  type PreferredRisk,
  type PreferredSupplierEntry,
} from './preferred'
export { awardWorkspace, getAwardTaskView, type AwardFactsDto, type AwardRoutePreview, type AwardWorkspaceDto } from './award-view'
// S10-16: the RFx as a subject of the AI-assist contract (registered on load) and what the Sourcing Agent reads
export { isRfxRequiredPath, RFX_ASSIST_TYPE, rfxBidFacts, rfxDraftSource, rfxSummarizable, type RfxBidFacts, type RfxDraftSource } from './ai-assist'
