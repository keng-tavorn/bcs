// The AI module's configuration (spec §12, docs/sub-specs/S13.md "สถาปัตยกรรม", ADR-141 ADR-143): which prompt each
// purpose uses now, which model each agent asks for, what a token costs, and which (agent, purpose, prompt, model)
// sets passed the evaluation. No I/O: the assist contract, the services and the adapter all read it (§4.10).

export const AI_AGENTS = ['DOCUMENT', 'INTAKE', 'APPROVAL_BRIEF', 'INSIGHT', 'DOA_DRAFTER'] as const
export type AiAgentName = (typeof AI_AGENTS)[number]

export const AI_PURPOSES = ['QUOTATION_READ', 'DELIVERY_NOTE_READ', 'INVOICE_READ', 'INTAKE', 'BRIEF', 'QUESTION', 'DOA_DRAFT'] as const
export type AiPurposeName = (typeof AI_PURPOSES)[number]

/** The agent that serves each purpose (one agent may serve several, e.g. the Document Agent reads three kinds) */
export const AGENT_OF_PURPOSE: Readonly<Record<AiPurposeName, AiAgentName>> = {
  QUOTATION_READ: 'DOCUMENT',
  DELIVERY_NOTE_READ: 'DOCUMENT',
  INVOICE_READ: 'DOCUMENT',
  INTAKE: 'INTAKE',
  BRIEF: 'APPROVAL_BRIEF',
  QUESTION: 'INSIGHT',
  DOA_DRAFT: 'DOA_DRAFTER',
}

/**
 * The prompt each purpose uses now, `<purpose>@<n>` (ADR-143). The prompt text lives in src/integrations/ai/prompts and
 * exports the same number (a test holds them equal). Changing a prompt means a new number and a new evaluation
 * (BR-AI-09); the gates below name the number that passed.
 */
export const PROMPT_VERSIONS: Readonly<Record<AiPurposeName, string>> = {
  QUOTATION_READ: 'QUOTATION_READ@1',
  DELIVERY_NOTE_READ: 'DELIVERY_NOTE_READ@1',
  INVOICE_READ: 'INVOICE_READ@1',
  INTAKE: 'INTAKE@1',
  BRIEF: 'BRIEF@1',
  QUESTION: 'QUESTION@1',
  DOA_DRAFT: 'DOA_DRAFT@1',
}

export const AI_MODELS = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'] as const
export type AiModelId = (typeof AI_MODELS)[number]

// TODO(OQ-145): the model of each agent until S13-13 measures it; reading documents compares Sonnet with Opus there
const DEFAULT_MODEL: Readonly<Record<AiAgentName, AiModelId>> = {
  DOCUMENT: 'claude-sonnet-5-5',
  INTAKE: 'claude-haiku-5-5',
  APPROVAL_BRIEF: 'claude-haiku-5-5',
  INSIGHT: 'claude-sonnet-5-5',
  DOA_DRAFTER: 'claude-opus-5-5',
}

/** The .env variable that overrides one agent's model (spec Appendix B) */
export const MODEL_ENV_OF_AGENT: Readonly<Record<AiAgentName, string>> = {
  DOCUMENT: 'AI_MODEL_DOCUMENT',
  INTAKE: 'AI_MODEL_INTAKE',
  APPROVAL_BRIEF: 'AI_MODEL_BRIEF',
  INSIGHT: 'AI_MODEL_INSIGHT',
  DOA_DRAFTER: 'AI_MODEL_DOA_DRAFTER',
}

/**
 * The model an agent asks for: its own variable, else AI_MODEL_DEFAULT, else OQ-145 (BR-AI-09). The adapter never
 * switches to another model by itself (ADR-141), so a model that is not in the gates below answers AI_NOT_EVALUATED.
 */
export function modelFor(agent: AiAgentName, env: Readonly<Record<string, string | undefined>>): string {
  return env[MODEL_ENV_OF_AGENT[agent]] ?? env.AI_MODEL_DEFAULT ?? DEFAULT_MODEL[agent]
}

/** How hard each agent thinks (ADR-141: set per agent, never the model's default by accident) */
export const EFFORT_OF_AGENT: Readonly<Record<AiAgentName, 'low' | 'medium' | 'high'>> = {
  DOCUMENT: 'medium',
  INTAKE: 'low',
  APPROVAL_BRIEF: 'low',
  INSIGHT: 'medium',
  DOA_DRAFTER: 'high',
}

/** Most tokens one answer may take; a structured result that hits it fails the schema (AI_OUTPUT_INVALID) */
export const MAX_OUTPUT_TOKENS: Readonly<Record<AiAgentName, number>> = {
  DOCUMENT: 16_000,
  INTAKE: 8_000,
  APPROVAL_BRIEF: 4_000,
  INSIGHT: 8_000,
  DOA_DRAFTER: 32_000,
}

/** Micro-USD per million tokens (1 credit = 1,000 micro-USD, BR-AI-23); cacheWrite is the 5-minute TTL (ADR-141) */
export interface TokenPrices {
  readonly input: number
  readonly output: number
  readonly cacheWrite: number
  readonly cacheRead: number
}

export interface ModelPrice extends TokenPrices {
  /** A prompt (input + cacheWrite + cacheRead) above this many tokens bills the whole call at `long` */
  readonly longPromptAbove?: number
  readonly long?: TokenPrices
}

/**
 * Anthropic's first-party prices, checked against the Claude API documentation on PRICES_CHECKED_ON (S13-01).
 * Cache writes cost 1.25 × input for the 5-minute TTL; reads are listed per model.
 */
export const PRICES_CHECKED_ON = '2026-10-13'
export const MODEL_PRICES: Readonly<Record<AiModelId, ModelPrice>> = {
  'claude-opus-5-5': { input: 4_000_000, output: 20_000_000, cacheWrite: 5_000_000, cacheRead: 200_000 },
  'claude-sonnet-5-5': { input: 2_000_000, output: 10_000_000, cacheWrite: 2_500_000, cacheRead: 200_000 },
  'claude-haiku-5-5': {
    input: 100_000,
    output: 500_000,
    cacheWrite: 125_000,
    cacheRead: 10_000,
    longPromptAbove: 100_000,
    long: { input: 500_000, output: 2_500_000, cacheWrite: 625_000, cacheRead: 50_000 },
  },
}

export const priceOf = (model: string): ModelPrice | undefined => (Object.hasOwn(MODEL_PRICES, model) ? MODEL_PRICES[model as AiModelId] : undefined)

/** SYNTHETIC: the synthetic evaluation set (local, staging) · REAL: customers' documents (required in production) */
export type GateTier = 'SYNTHETIC' | 'REAL'

export interface EvalGate {
  readonly agent: AiAgentName
  readonly purpose: AiPurposeName
  readonly promptVersion: string
  readonly model: string
  readonly tier: GateTier
  /** The evaluation report that passed, under docs/reports/ai-eval/ */
  readonly report: string
}

/**
 * The sets that passed the evaluation (ADR-143). Live mode calls only these (BR-AI-11); fixture mode, which answers
 * from recorded results, skips the gate (ADR-142). S13-13 and S13-14 add the SYNTHETIC rows, S13-16 the REAL ones.
 */
export const EVAL_GATES: readonly EvalGate[] = []

/** The tier an environment needs: production only trusts a REAL evaluation (BR-AI-11) */
export const requiredGateTier = (appEnv: string): GateTier => (appEnv === 'production' ? 'REAL' : 'SYNTHETIC')

export function isGated(gates: readonly EvalGate[], call: { agent: AiAgentName; purpose: AiPurposeName; promptVersion: string; model: string; tier: GateTier }): boolean {
  return gates.some(
    (g) => g.agent === call.agent && g.purpose === call.purpose && g.promptVersion === call.promptVersion && g.model === call.model && g.tier === call.tier,
  )
}

/** Limits of BR-AI-11 BR-AI-12 BR-AI-21 and the state machine of AgentAction */
export const AI_LIMITS = {
  /** Calls one member may start per minute (RATE_LIMITED reason AI) */
  callsPerMinutePerMember: 10,
  /** Document Agent files: PDF JPEG PNG WebP up to this size (AI_FILE_UNSUPPORTED) */
  maxFileBytes: 20 * 1024 * 1024,
  /** A PENDING action older than this fails (agent_action.expire) */
  pendingTimeoutMinutes: 15,
  /** An L1 draft nobody applied expires as STALE after this */
  staleDraftHours: 24,
  insightMaxQuestionChars: 500,
  insightMaxToolCalls: 6,
  insightMaxTurns: 10,
  /** Characters of text a member typed that an AgentAction keeps (inputText) */
  maxInputTextChars: 2_000,
} as const
