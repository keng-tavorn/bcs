// The public API of the AI module (docs/sub-specs/S13.md "interface"): what routes, screens and other steps call.
// The agents (./agents) join as they are built; the assist contract (./assist-contract) is imported by the services of
// the documents directly and never reaches the adapter (ADR-148).
export {
  agentActionSweepOrganizationIds,
  getAgentAction,
  giveAgentFeedback,
  rejectAgentAction,
  requestAgentAction,
  completeAgentAction,
  expireAgentAction,
  purgeChatIntakeAiContent,
  runAgentActionSweep,
  SUBJECT_TYPES,
  type AgentActionDto,
  type RequestedAction,
} from './actions'
export { DOCUMENT_PURPOSES, readDocument, ReadDocumentInput, runDocumentRead } from './agents/document'
export { approvalBriefOf, BRIEF_PROFILE, briefFacts, runBrief, type ApprovalBriefDto, type BriefFacts } from './agents/brief'
export { AskInput, askInsight, INSIGHT_PROFILE, insightResponse, type InsightAnswer } from './agents/insight'
export { explainSaving, ExplainSavingInput, savingsNoteAvailable, savingsNotesOf, type SavingsNoteDto } from './agents/savings-note'
export { savingsFacts, type SavingsFacts } from './agents/savings-facts'
export { findSuppliersForAsker, listPurchaseOrdersForAsker, runTool, type ToolResult } from './tools'
export { runDoaDraft, startDoaDraft, StartDoaDraftInput, type RuleProblem } from './agents/doa-drafter'
export { intakeFromMessage, IntakeMessageInput, runIntake, startIntake, StartIntakeInput } from './agents/intake'
export { checkCreditUsage, creditSummary, grantCredits, runMonthlyGrant, type CreditSummaryDto } from './credits'
export { agentSwitchedOn, aiRuntime, checkCallGates, creditBalance, isAgentAvailable, setAiRuntimeForTests, type AgentAvailability, type AiRuntime, type CallPlan } from './gate'
export { activeOrgAdminIds, listAgentSettings, updateAgentSetting, type AgentSettingDto } from './settings'
export {
  ACTIVITY_FILTERS,
  ActivityQuery,
  listAgentActivity,
  listSettingChanges,
  monthResults,
  type ActivityFilter,
  type ActivityPageDto,
  type ActivityRowDto,
  type AiAdminAccess,
  type DataUsed,
  type MonthResultsDto,
  type SettingChangeDto,
} from './report'
// S10-16 (FR-AI-305): the Sourcing and Negotiation Agent
export {
  draftRfx,
  DraftRfxInput,
  rfxDraftAiOf,
  rfxSummariesOf,
  summarizeRfx,
  SummarizeRfxInput,
  SUMMARY_PURPOSES,
  writeSummaryAhead,
  type RfxDraftAiDto,
  type RfxDraftDto,
  type RfxSummariesDto,
  type RfxSummaryDto,
  type SummaryAhead,
  type SummaryPurpose,
} from './agents/sourcing'
export { sourcingFacts, sourcingFactsText, type SourcingFacts } from './agents/sourcing-facts'
// S11-13 (FR-AI-306): the Risk Agent
export { closeRiskDrafts, draftRiskAnswers, writeRiskSummary, type RiskDraftRun, type RiskSummaryRun } from './agents/risk'
