import { z } from 'zod'
import { checkAiText, renderValue } from '@/core/ai-checks'
import { err, ok, type Result } from '@/core/result'
import { answerStreamResponse, getAiClient, type AiUsage } from '@/integrations/ai'
import { AI_LIMITS, DECISION_ADVICE_WORDS, modelForPurpose } from '@/lib/ai-config'
import { BriefText, INSIGHT_TOOLS, QuestionPlan, insightAnswerText, questionInputText, type InsightTool } from '@/lib/ai-schemas/agents'
import { getEnv } from '@/lib/env'
import type { Ctx } from '@/server/context'
import { forTenant } from '@/server/db/tenant'
import type { RunOptions } from '../../_pipeline'
import { completeAgentAction, requestAgentAction } from '../actions'
import { aiRuntime } from '../gate'
import { runTool, toolValues, type ToolResult } from '../tools'

// Insight Agent (FR-AI-307 AC1–AC5, FR-AI-309 AC3, BR-AI-07 BR-AI-21 BR-AI-27, ADR-144 ADR-147). A question becomes an
// L0 AgentAction with its credits and the tools it used. The AI first names the read-only tools that answer it (at most
// 6); code runs them under the asking member's ctx, each checking rights and scope itself; then the AI writes sentences
// whose every value is a placeholder of a tool's result. Each sentence is checked before anything is sent: one that
// fails stops the text and the tools' rows are shown as a table with their links. Nothing in the member's scope → "not
// found in your access", never a guess; a question outside procurement → what the assistant answers.

/** Insight profile of BR-AI-27: at most 8 sentences of 200 characters */
export const INSIGHT_PROFILE = { maxSentences: 8, maxChars: 200 } as const

export const AskInput = z.strictObject({
  question: z.string().trim().min(1).max(AI_LIMITS.insightMaxQuestionChars),
  conversationId: z.uuid().optional(),
})

export interface InsightAnswer {
  readonly agentActionId: string
  /** ANSWER: sentences checked · TABLE: a sentence failed, the rows instead · NOT_FOUND: nothing in the member's scope · SCOPE: outside procurement */
  readonly kind: 'ANSWER' | 'TABLE' | 'NOT_FOUND' | 'SCOPE'
  readonly sentences: readonly string[]
  readonly tables: ReadonlyArray<{ readonly tool: InsightTool; readonly rows: ReadonlyArray<{ readonly href: string | null; readonly cells: ReadonlyArray<{ readonly key: string; readonly text: string }> }> }>
}

const sum = (a: AiUsage, b: AiUsage): AiUsage => ({ input: a.input + b.input, output: a.output + b.output, cacheRead: a.cacheRead + b.cacheRead, cacheWrite: a.cacheWrite + b.cacheWrite })
const tablesOf = (results: readonly ToolResult[]) =>
  results.filter((r) => r.rows.length).map((r) => ({ tool: r.tool, rows: r.rows.map((row) => ({ href: row.href, cells: Object.entries(row.values).map(([key, v]) => ({ key, text: renderValue(v) })) })) }))

export async function askInsight(ctx: Ctx, rawInput: z.input<typeof AskInput>, options: RunOptions): Promise<Result<InsightAnswer>> {
  if (ctx.actor.type !== 'USER') return err('FORBIDDEN', 'only a member of the organization asks')
  const parsed = AskInput.safeParse(rawInput)
  if (!parsed.success) return err('VALIDATION_FAILED', 'a question of 1 to 500 characters', { field: 'question' })
  const { question, conversationId } = parsed.data
  const started = await requestAgentAction(ctx, { purpose: 'QUESTION', inputText: question, ...(conversationId ? { conversationId } : {}) }, options)
  if (!started.ok) return started
  const agentActionId = started.data.agentActionId
  // A key used before replays its action, already answered: the AI is never asked again without credits (BR-AI-11)
  const row = await forTenant(ctx.organizationId).agentAction.findFirst({ where: { id: agentActionId }, select: { status: true } })
  if (row?.status !== 'PENDING') return err('IDEMPOTENCY_CONFLICT', 'this question was asked with this key already', { field: 'idempotencyKey' })
  const model = modelForPurpose('QUESTION', aiRuntime().modelEnv)
  const client = getAiClient(getEnv())
  const finish = (input: Omit<Parameters<typeof completeAgentAction>[3], 'agentActionId' | 'requestedModel'>) => completeAgentAction(ctx.organizationId, ctx.now, started.data.promptVersion, { agentActionId, requestedModel: model, ...input })

  const plan = await client.write({ purpose: 'QUESTION', model, schema: QuestionPlan, text: questionInputText(question) })
  if (!plan.ok) {
    await finish({ outcome: 'FAILED', model: plan.model ?? null, errorCode: plan.errorCode, usage: plan.usage, latencyMs: plan.latencyMs })
    return err('EXTERNAL_SERVICE_ERROR', 'the assistant could not answer', { service: 'Claude', reason: plan.errorCode })
  }
  const tools = [...new Set(plan.output.tools.filter((t) => (INSIGHT_TOOLS as readonly string[]).includes(t)))].slice(0, AI_LIMITS.insightMaxToolCalls)
  const answer = async (kind: InsightAnswer['kind'], sentences: readonly string[], results: readonly ToolResult[], usage: AiUsage, latencyMs: number, reason?: string) => {
    // An answer is shown only once its usage and credits are recorded
    const done = await finish({ outcome: 'DRAFT', model: plan.model, output: { tools, kind, ...(reason ? { reason } : {}) }, usage, latencyMs })
    if (!done.ok) return done
    return ok({ agentActionId, kind, sentences, tables: tablesOf(results) })
  }
  // Outside procurement: no tool, and the AI's words checked like any (no value of its own)
  if (tools.length === 0) {
    const checked = checkAiText(plan.output.sentences, {}, INSIGHT_PROFILE, DECISION_ADVICE_WORDS)
    return answer('SCOPE', checked.ok ? checked.rendered : [], [], plan.usage, plan.latencyMs, checked.ok ? undefined : checked.reason)
  }
  const results: ToolResult[] = []
  for (const tool of tools) results.push(await runTool(ctx, tool, question))
  const values = toolValues(results)
  if (Object.keys(values).length === 0) return answer('NOT_FOUND', [], results, plan.usage, plan.latencyMs)

  const written = await client.write({ purpose: 'QUESTION', model, schema: BriefText, text: insightAnswerText(question, Object.fromEntries(Object.entries(values).map(([k, v]) => [k, renderValue(v)]))) })
  const usage = sum(plan.usage, written.usage)
  const latencyMs = plan.latencyMs + written.latencyMs
  if (!written.ok) return answer('TABLE', [], results, usage, latencyMs, written.errorCode)
  const checked = checkAiText(written.output.sentences, values, INSIGHT_PROFILE, DECISION_ADVICE_WORDS)
  return checked.ok ? answer('ANSWER', checked.rendered, results, usage, latencyMs) : answer('TABLE', [], results, usage, latencyMs, checked.reason)
}

/** The answer as the chat's stream: the checked sentences, then the tools' rows and links as its data (FR-AI-309 AC2) */
export function insightResponse(answer: InsightAnswer): Response {
  return answerStreamResponse({ sentences: answer.sentences, data: { agentActionId: answer.agentActionId, kind: answer.kind, tables: answer.tables } })
}
