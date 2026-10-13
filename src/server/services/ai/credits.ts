import { z } from 'zod'
import { creditPeriodMonth } from '@/core/ai-checks'
import { err, ok, type Result } from '@/core/result'
import { BP_WHOLE, REASON_MAX_LENGTH } from '@/lib/constants'
import { aiCreditSettingsOf } from '@/lib/org-settings'
import { authorize } from '@/server/authz'
import { systemCtx, type Ctx } from '@/server/context'
import { isActivePlatformAdmin } from '@/server/db/lookups'
import { forTenant, type TenantTx } from '@/server/db/tenant'
import type { EventDraft } from '@/server/events/append'
import type { NotificationDraft } from '@/server/notifications/create'
import { defineCommand, runCommand, type CommandOutcome, type RunOptions } from '../_pipeline'
import { requireModule } from '../modules'
import { creditBalance } from './gate'
import { activeOrgAdminIds } from './settings'

// AI credits of an organization (BR-AI-23, OQ-143, docs/sub-specs/S13.md "ฐานของโมดูล" AC2). The ledger is
// append-only: the BCS team grants top-ups and sets the monthly amount (platform.ai.credits, contractRef and a reason,
// no break-glass, no business data), the job ai-credit-monthly grants the month on the 1st, and every call that used
// tokens writes one USE row when it completes (actions.ts). After a use, ai_credit.check_usage tells the ORG_ADMINs
// once a month when the spending reaches alertAtBp of the grants and once when nothing is left.

const dateOf = (periodMonth: string) => new Date(`${periodMonth}T00:00:00Z`)

async function readSettings(tx: TenantTx, organizationId: string) {
  const org = await tx.organization.findFirst({ where: { id: organizationId }, select: { settings: true } })
  return { raw: org?.settings ?? {}, ai: aiCreditSettingsOf(org?.settings) }
}

/** The platform admin behind the call when it is an active one, else null */
async function platformActor(ctx: Ctx): Promise<string | null> {
  return ctx.actor.type === 'PLATFORM_ADMIN' && (await isActivePlatformAdmin(ctx.actor.platformAdminId)) ? ctx.actor.platformAdminId : null
}

// ---------- the BCS team: a top-up, and the monthly amount ----------

const GrantInput = z
  .strictObject({
    topUpCredits: z.number().int().min(1).optional(),
    monthlyCredits: z.number().int().min(1).optional(),
    alertAtBp: z.number().int().min(1).max(BP_WHOLE).optional(),
    contractRef: z.string().trim().min(1).max(200),
    reason: z.string().trim().min(3).max(REASON_MAX_LENGTH),
  })
  .refine((i) => i.topUpCredits !== undefined || i.monthlyCredits !== undefined || i.alertAtBp !== undefined, { message: 'nothing to grant or set', path: ['topUpCredits'] })

export const grantCreditsCommand = defineCommand({
  name: 'ai_credit.grant',
  capability: 'platform.ai.credits',
  input: GrantInput,
  async execute(tx, input, ctx): Promise<CommandOutcome<{ periodMonth: string; ledgerEntryId: string | null; monthlyCredits: number; alertAtBp: number }>> {
    const platformAdminId = await platformActor(ctx)
    if (!platformAdminId) return { ok: false, error: { code: 'FORBIDDEN', message: 'only the BCS team grants AI credits' } }
    const allowed = await authorize(tx, ctx, 'platform.ai.credits')
    if (!allowed.ok) return { ok: false, error: allowed.error }
    const periodMonth = creditPeriodMonth(ctx.now)
    const events: EventDraft[] = []
    const settings = await readSettings(tx, ctx.organizationId)
    const next = { monthlyCredits: input.monthlyCredits ?? settings.ai.monthlyCredits, alertAtBp: input.alertAtBp ?? settings.ai.alertAtBp }
    if (input.monthlyCredits !== undefined || input.alertAtBp !== undefined) {
      const raw = settings.raw && typeof settings.raw === 'object' ? (settings.raw as Record<string, unknown>) : {}
      await tx.organization.update({ where: { id: ctx.organizationId }, data: { settings: { ...raw, ai: next } } })
      events.push({ type: 'ai_credit.monthly_set', aggregateType: 'AiCredit', aggregateId: ctx.organizationId, data: { ...next, contractRef: input.contractRef } })
    }
    let ledgerEntryId: string | null = null
    if (input.topUpCredits !== undefined) {
      const row = await tx.aiCreditLedger.create({
        data: {
          organizationId: ctx.organizationId,
          kind: 'GRANT',
          source: 'TOPUP',
          credits: input.topUpCredits,
          periodMonth: dateOf(periodMonth),
          platformAdminId,
          contractRef: input.contractRef,
          reason: input.reason,
          occurredAt: ctx.now,
        },
        select: { id: true },
      })
      ledgerEntryId = row.id
      events.push({ type: 'ai_credit.granted', aggregateType: 'AiCredit', aggregateId: ctx.organizationId, data: { ledgerEntryId, source: 'TOPUP', credits: input.topUpCredits, periodMonth, contractRef: input.contractRef } })
    }
    return { ok: true, result: { periodMonth, ledgerEntryId, ...next }, events }
  },
})

export function grantCredits(ctx: Ctx, input: z.input<typeof GrantInput>, options: RunOptions) {
  return runCommand(ctx, grantCreditsCommand, input, options)
}

// ---------- the job: the month's grant ----------

export const grantMonthlyCommand = defineCommand({
  name: 'ai_credit.grant_monthly',
  capability: 'platform.ai.credits',
  input: z.strictObject({}),
  async execute(tx, _input, ctx): Promise<CommandOutcome<{ periodMonth: string; credits: number }>> {
    if (ctx.actor.type !== 'SYSTEM') return { ok: false, error: { code: 'FORBIDDEN', message: 'only the monthly job grants the month' } }
    const aiModule = await requireModule(ctx, 'AI', tx)
    if (!aiModule.ok) return { ok: false, error: aiModule.error }
    const periodMonth = creditPeriodMonth(ctx.now)
    const exists = await tx.aiCreditLedger.findFirst({ where: { source: 'MONTHLY', periodMonth: dateOf(periodMonth) }, select: { id: true } })
    if (exists) return { ok: false, error: { code: 'NOT_FOUND', message: 'the month is granted already' } }
    const { ai } = await readSettings(tx, ctx.organizationId)
    const row = await tx.aiCreditLedger.create({
      data: { organizationId: ctx.organizationId, kind: 'GRANT', source: 'MONTHLY', credits: ai.monthlyCredits, periodMonth: dateOf(periodMonth), occurredAt: ctx.now },
      select: { id: true },
    })
    return {
      ok: true,
      result: { periodMonth, credits: ai.monthlyCredits },
      events: [{ type: 'ai_credit.granted', aggregateType: 'AiCredit', aggregateId: ctx.organizationId, data: { ledgerEntryId: row.id, source: 'MONTHLY', credits: ai.monthlyCredits, periodMonth, contractRef: null } }],
    }
  },
})

/** What the job ai-credit-monthly (and the seed) runs for one organization; the month is the idempotency key */
export function runMonthlyGrant(organizationId: string, now: Date, job = 'ai-credit-monthly') {
  // The day is the key: the daily run of a month that is granted already is refused (NOT_FOUND) and tried again tomorrow
  return runCommand(systemCtx(organizationId, now, job), grantMonthlyCommand, {}, { idempotencyKey: `ai-credit-monthly:${now.toISOString().slice(0, 10)}` })
}

// ---------- after a use: the 80% notice and the exhausted notice, once a month each ----------

export const checkUsageCommand = defineCommand({
  name: 'ai_credit.check_usage',
  capability: 'platform.ai.credits',
  input: z.strictObject({ periodMonth: z.iso.date() }),
  async execute(tx, input, ctx): Promise<CommandOutcome<{ thresholdReached: boolean; exhausted: boolean }>> {
    if (ctx.actor.type !== 'SYSTEM') return { ok: false, error: { code: 'FORBIDDEN', message: 'only the system checks the credits' } }
    const balance = await creditBalance(tx, input.periodMonth)
    const { ai } = await readSettings(tx, ctx.organizationId)
    const told = await tx.event.findMany({
      where: { aggregateType: 'AiCredit', aggregateId: ctx.organizationId, type: { in: ['ai_credit.threshold_reached', 'ai_credit.exhausted'] }, data: { path: ['periodMonth'], equals: input.periodMonth } },
      select: { type: true },
    })
    const toldTypes = new Set(told.map((e) => e.type))
    const reached = balance.granted > 0 && balance.used * BP_WHOLE >= balance.granted * ai.alertAtBp
    const exhausted = balance.granted > 0 && balance.remaining <= 0
    const events: EventDraft[] = []
    if (reached && !toldTypes.has('ai_credit.threshold_reached')) {
      events.push({ type: 'ai_credit.threshold_reached', aggregateType: 'AiCredit', aggregateId: ctx.organizationId, data: { periodMonth: input.periodMonth, granted: balance.granted, used: balance.used, alertAtBp: ai.alertAtBp } })
    }
    if (exhausted && !toldTypes.has('ai_credit.exhausted')) {
      events.push({ type: 'ai_credit.exhausted', aggregateType: 'AiCredit', aggregateId: ctx.organizationId, data: { periodMonth: input.periodMonth, granted: balance.granted, used: balance.used } })
    }
    if (events.length === 0) return { ok: false, error: { code: 'NOT_FOUND', message: 'nothing to tell' } }
    const admins = await activeOrgAdminIds(tx)
    // TODO(OQ-143): the BCS team hears of it on /platform/tenants/[orgId]/ai; an e-mail to PLATFORM_ADMIN needs a
    // channel to the team that does not exist yet (S13-18)
    const notifications: NotificationDraft[] = events.flatMap((e) =>
      admins.map((recipient) => ({
        recipientMemberId: recipient,
        templateKey: 'admin.ai_credits',
        data: { kind: e.type === 'ai_credit.exhausted' ? 'EXHAUSTED' : 'THRESHOLD', periodMonth: input.periodMonth, granted: balance.granted, used: balance.used },
        urgency: 'IMMEDIATE' as const,
        dedupeKey: `admin.ai_credits:${e.type}:${input.periodMonth}:${recipient}`,
        subjectType: 'Organization',
        subjectId: ctx.organizationId,
      })),
    )
    return { ok: true, result: { thresholdReached: events.some((e) => e.type === 'ai_credit.threshold_reached'), exhausted: events.some((e) => e.type === 'ai_credit.exhausted') }, events, notifications }
  },
})

/** Runs after every USE row; quiet when there is nothing new to tell */
export async function checkCreditUsage(organizationId: string, now: Date, agentActionId: string) {
  const periodMonth = creditPeriodMonth(now)
  return runCommand(systemCtx(organizationId, now, 'ai-credits'), checkUsageCommand, { periodMonth }, { idempotencyKey: `ai-credits:${periodMonth}:${agentActionId}` })
}

// ---------- read: the month's credits ----------

export interface CreditSummaryDto {
  readonly periodMonth: string
  readonly granted: number
  readonly used: number
  readonly remaining: number
  readonly monthlyCredits: number
  readonly alertAtBp: number
  /** GRANT rows of the month, newest first (the platform page shows them) */
  readonly grants: readonly { readonly source: string; readonly credits: number; readonly contractRef: string | null; readonly occurredAt: string }[]
}

/** The credits of the month for ORG_ADMIN (admin.ai.manage) and the BCS team (platform.ai.credits); no business data */
export async function creditSummary(ctx: Ctx): Promise<Result<CreditSummaryDto>> {
  const db = forTenant(ctx.organizationId)
  if (ctx.actor.type === 'PLATFORM_ADMIN' && !(await isActivePlatformAdmin(ctx.actor.platformAdminId))) return err('FORBIDDEN', 'only the BCS team')
  return db.$transaction(async (tx) => {
    const allowed = await authorize(tx, ctx, ctx.actor.type === 'PLATFORM_ADMIN' ? 'platform.ai.credits' : 'admin.ai.manage')
    if (!allowed.ok) return err(allowed.error.code, allowed.error.message, allowed.error.details)
    const periodMonth = creditPeriodMonth(ctx.now)
    const balance = await creditBalance(tx, periodMonth)
    const { ai } = await readSettings(tx, ctx.organizationId)
    const grants = await tx.aiCreditLedger.findMany({
      where: { kind: 'GRANT', periodMonth: dateOf(periodMonth) },
      orderBy: { occurredAt: 'desc' },
      select: { source: true, credits: true, contractRef: true, occurredAt: true },
    })
    return ok({ periodMonth, ...balance, ...ai, grants: grants.map((g) => ({ source: g.source, credits: g.credits, contractRef: g.contractRef, occurredAt: g.occurredAt.toISOString() })) })
  })
}
