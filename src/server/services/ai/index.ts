// The public API of the AI module (docs/sub-specs/S13.md "interface"): what routes, screens and other steps call.
// The agents (./agents) join as they are built; the assist contract (./assist-contract) is imported by the services of
// the documents directly and never reaches the adapter (ADR-148).
export {
  getAgentAction,
  giveAgentFeedback,
  rejectAgentAction,
  requestAgentAction,
  completeAgentAction,
  expireAgentAction,
  runAgentActionSweep,
  SUBJECT_TYPES,
  type AgentActionDto,
  type RequestedAction,
} from './actions'
export { DOCUMENT_PURPOSES, readDocument, ReadDocumentInput, runDocumentRead } from './agents/document'
export { approvalBriefOf, BRIEF_PROFILE, briefFacts, runBrief, type ApprovalBriefDto, type BriefFacts } from './agents/brief'
export { AskInput, askInsight, INSIGHT_PROFILE, insightResponse, type InsightAnswer } from './agents/insight'
export { findSuppliersForAsker, listPurchaseOrdersForAsker, runTool, type ToolResult } from './tools'
export { intakeFromMessage, IntakeMessageInput, runIntake, startIntake, StartIntakeInput } from './agents/intake'
export { checkCreditUsage, creditSummary, grantCredits, runMonthlyGrant, type CreditSummaryDto } from './credits'
export { aiRuntime, checkCallGates, creditBalance, isAgentAvailable, setAiRuntimeForTests, type AgentAvailability, type AiRuntime, type CallPlan } from './gate'
export { activeOrgAdminIds, listAgentSettings, updateAgentSetting, type AgentSettingDto } from './settings'
