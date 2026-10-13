import { creditPeriodMonth, creditsRemaining, mayStartCall } from '@/core/ai-checks'
import { err, ok, type Result } from '@/core/result'
import {
  AGENT_OF_PURPOSE,
  AI_LIMITS,
  AI_PURPOSES,
  DEFAULT_MIN_CONFIDENCE_BP,
  EVAL_GATES,
  isGated,
  LEVEL_OF_AGENT,
  modelFor,
  PROMPT_VERSIONS,
  requiredGateTier,
  type AiAgentName,
  type AiPurposeName,
  type EvalGate,
} from '@/lib/ai-config'
import { MS_PER_MINUTE } from '@/lib/constants'
import { getEnv } from '@/lib/env'
import type { Ctx } from '@/server/context'
import { forTenant, type TenantTx } from '@/server/db/tenant'
import { requireModule } from '../modules'

// The gates in front of every AI call (BR-AI-11), in order: AI_ENABLED · module AI · the agent switched on · in live
// mode an evaluation gate for (agent, purpose, prompt, model) of the tier this environment needs · credits left this
// month · at most 10 calls a minute per member. The first gate that fails names the refusal; the screens then hide the
// AI button and the form works as before (EG-1). Fixture mode skips the evaluation gate only (ADR-142).

export interface AiRuntime {
  readonly enabled: boolean
  readonly mode: 'fixture' | 'live' | undefined
  readonly appEnv: string
  /** AI_MODEL_* of the environment (modelFor) */
  readonly modelEnv: Readonly<Record<string, string | undefined>>
  readonly gates: readonly EvalGate[]
}

let runtimeOverride: AiRuntime | null = null

/** What the environment says about AI (src/lib/env.ts already refused live without a key and fixture outside local) */
export function aiRuntime(): AiRuntime {
  if (runtimeOverride) return runtimeOverride
  const env = getEnv()
  return {
    enabled: Boolean(env.AI_ENABLED),
    mode: env.AI_MODE,
    appEnv: env.APP_ENV,
    modelEnv: {
      AI_MODEL_DEFAULT: env.AI_MODEL_DEFAULT,
      AI_MODEL_DOCUMENT: env.AI_MODEL_DOCUMENT,
      AI_MODEL_INTAKE: env.AI_MODEL_INTAKE,
      AI_MODEL_BRIEF: env.AI_MODEL_BRIEF,
      AI_MODEL_INSIGHT: env.AI_MODEL_INSIGHT,
      AI_MODEL_DOA_DRAFTER: env.AI_MODEL_DOA_DRAFTER,
    },
    gates: EVAL_GATES,
  }
}

/** Tests switch AI on (fixture mode) or hand in gates without touching the process environment; null restores it */
export function setAiRuntimeForTests(runtime: AiRuntime | null): void {
  runtimeOverride = runtime
}

/** What a call that passed the gates runs with */
export interface CallPlan {
  readonly agent: AiAgentName
  readonly purpose: AiPurposeName
  readonly level: 'L0' | 'L1'
  readonly minConfidenceBp: number
  readonly model: string
  readonly promptVersion: string
}

/** Credits of the month the call falls in: Σ GRANT − Σ USE (BR-AI-23) */
export async function creditBalance(tx: TenantTx, periodMonth: string): Promise<{ granted: number; used: number; remaining: number }> {
  const rows = await tx.aiCreditLedger.groupBy({ by: ['kind'], where: { periodMonth: new Date(`${periodMonth}T00:00:00Z`) }, _sum: { credits: true } })
  const sum = (kind: 'GRANT' | 'USE') => rows.find((r) => r.kind === kind)?._sum.credits ?? 0
  const granted = sum('GRANT')
  const used = sum('USE')
  return { granted, used, remaining: creditsRemaining(granted, used) }
}

/**
 * Every gate of BR-AI-11 for one purpose. `memberId` is the member who starts the call (the rate limit counts their
 * calls); SYSTEM calls (Approval Brief) pass null and are not limited.
 */
export async function checkCallGates(tx: TenantTx, ctx: Ctx, purpose: AiPurposeName, memberId: string | null): Promise<Result<CallPlan>> {
  const agent = AGENT_OF_PURPOSE[purpose]
  const runtime = aiRuntime()
  if (!runtime.enabled || !runtime.mode) return err('AI_AGENT_DISABLED', 'AI is switched off for the whole system', { agent, reason: 'AI_OFF' })
  const aiModule = await requireModule(ctx, 'AI', tx)
  if (!aiModule.ok) return aiModule
  const setting = await tx.aiAgentSetting.findFirst({ where: { agent }, select: { enabled: true, level: true, minConfidenceBp: true } })
  if (!setting?.enabled) return err('AI_AGENT_DISABLED', `agent ${agent} is switched off`, { agent, reason: 'AGENT_OFF' })
  const model = modelFor(agent, runtime.modelEnv)
  const promptVersion = PROMPT_VERSIONS[purpose]
  if (runtime.mode === 'live' && !isGated(runtime.gates, { agent, purpose, promptVersion, model, tier: requiredGateTier(runtime.appEnv) })) {
    return err('AI_NOT_EVALUATED', `${agent} ${promptVersion} on ${model} has not passed the evaluation`, { agent, purpose, promptVersion, model })
  }
  const balance = await creditBalance(tx, creditPeriodMonth(ctx.now))
  if (!mayStartCall(balance.remaining)) return err('AI_CREDITS_EXHAUSTED', 'no AI credits left this month', { agent, remaining: balance.remaining })
  if (memberId) {
    const since = new Date(ctx.now.getTime() - MS_PER_MINUTE)
    const recent = await tx.agentAction.count({ where: { requestedById: memberId, createdAt: { gt: since } } })
    if (recent >= AI_LIMITS.callsPerMinutePerMember) return err('RATE_LIMITED', 'too many AI calls this minute', { reason: 'AI', retryAfterSeconds: 60 })
  }
  return ok({ agent, purpose, level: setting.level ?? LEVEL_OF_AGENT[agent], minConfidenceBp: setting.minConfidenceBp ?? DEFAULT_MIN_CONFIDENCE_BP, model, promptVersion })
}

export interface AgentAvailability {
  readonly available: boolean
  /** The refusal code of the first gate that failed (BR-AI-11) */
  readonly reason?: string
}

/**
 * Whether a member may start the agent now (BR-AI-11), for the screens (show the AI button or not) and for S17 (a chat
 * intake or the LIFF form). Never calls the AI. In live mode one evaluated purpose of the agent is enough here; the call
 * itself checks its own purpose.
 */
export async function isAgentAvailable(ctx: Ctx, agent: AiAgentName): Promise<AgentAvailability> {
  const memberId = ctx.actor.type === 'USER' ? ctx.actor.memberId : null
  if (ctx.actor.type === 'PLATFORM_ADMIN') return { available: false, reason: 'FORBIDDEN' }
  const purposes = AI_PURPOSES.filter((p) => AGENT_OF_PURPOSE[p] === agent)
  return forTenant(ctx.organizationId).$transaction(async (tx) => {
    let first: string | undefined
    for (const purpose of purposes) {
      const gate = await checkCallGates(tx, ctx, purpose, memberId)
      if (gate.ok) return { available: true }
      first ??= gate.error.code
      // Only the evaluation gate differs between the purposes of one agent
      if (gate.error.code !== 'AI_NOT_EVALUATED') break
    }
    return { available: false, ...(first ? { reason: first } : {}) }
  })
}
