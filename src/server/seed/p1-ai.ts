import { creditPeriodMonth } from '@/core/ai-checks'
import { AI_AGENTS, AI_CREDIT_DEFAULTS, DEFAULT_MIN_CONFIDENCE_BP, LEVEL_OF_AGENT } from '@/lib/ai-config'
import { systemCtx } from '@/server/context'
import { forTenant } from '@/server/db/tenant'
import { appendEvents, type EventDraft } from '@/server/events/append'

// The AI of the synthetic phase-1 organization (docs/sub-specs/S13.md "Entity และ migration" seed, local and staging
// only): every agent switched on and the month's credits granted, as ai_agent.update and the job ai-credit-monthly
// write them. The AI module itself comes from seedP1Modules (P1-07); the demo organization keeps AI off, so the @demo
// scenes do not change. A second run changes nothing.

export async function seedP1Ai(organizationId: string, now: Date): Promise<{ agents: number; granted: number }> {
  const ctx = systemCtx(organizationId, now, 'seed')
  return forTenant(organizationId).$transaction(async (tx) => {
    const events: EventDraft[] = []
    let agents = 0
    for (const agent of AI_AGENTS) {
      if (await tx.aiAgentSetting.findFirst({ where: { agent }, select: { id: true } })) continue
      const level = LEVEL_OF_AGENT[agent]
      const row = await tx.aiAgentSetting.create({ data: { organizationId, agent, enabled: true, level, minConfidenceBp: DEFAULT_MIN_CONFIDENCE_BP }, select: { id: true } })
      events.push({ type: 'ai_agent.enabled', aggregateType: 'AiAgentSetting', aggregateId: row.id, data: { agent, level, minConfidenceBp: DEFAULT_MIN_CONFIDENCE_BP } })
      agents++
    }
    const periodMonth = creditPeriodMonth(now)
    const month = new Date(`${periodMonth}T00:00:00Z`)
    let granted = 0
    if (!(await tx.aiCreditLedger.findFirst({ where: { source: 'MONTHLY', periodMonth: month }, select: { id: true } }))) {
      const credits = AI_CREDIT_DEFAULTS.monthlyCredits
      const row = await tx.aiCreditLedger.create({ data: { organizationId, kind: 'GRANT', source: 'MONTHLY', credits, periodMonth: month, occurredAt: now }, select: { id: true } })
      events.push({ type: 'ai_credit.granted', aggregateType: 'AiCredit', aggregateId: organizationId, data: { ledgerEntryId: row.id, source: 'MONTHLY', credits, periodMonth, contractRef: null } })
      granted = credits
    }
    if (events.length) await appendEvents(tx, ctx, events)
    return { agents, granted }
  })
}
