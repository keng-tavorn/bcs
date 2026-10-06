import { TZDate } from '@date-fns/tz'
import { z } from 'zod'
import { DOA_DOCUMENT_TYPES } from '@/core/doa'
import { err, ok, type Result } from '@/core/result'
import { authorize } from '@/server/authz'
import type { Ctx } from '@/server/context'
import { forTenant } from '@/server/db/tenant'
import {
  listDelegateCandidates,
  listDelegationsGiven,
  listDelegationsReceived,
  listHeldPositions,
  type DelegateCandidateDto,
  type DelegationRowDto,
  type HeldPositionDto,
} from '@/server/queries/delegation'
import type { RunOptions } from '../_pipeline'
import { createDelegation } from './index'

// The delegation page of the web (NEW-06, FR-DOA-006 AC2, §7.6): a member's own delegations, who they may choose, and
// a delegation set by whole days in the organization's time zone. The rules stay in createDelegation and core/delegation
// (BR-DLG-01..05); this file only reads and converts what the page sends.

/** Every document type a delegation can be limited to (BR-DLG-01); none chosen = all of them */
export const DELEGATION_DOCUMENT_TYPES = DOA_DOCUMENT_TYPES

export type DelegationState = 'ACTIVE' | 'SCHEDULED' | 'ENDED' | 'REVOKED'

/** What a delegation is at `now`, from its period: the stored status changes only when the S5 job runs */
export function delegationState(row: Pick<DelegationRowDto, 'status' | 'startsAt' | 'endsAt'>, now: Date): DelegationState {
  if (row.status === 'REVOKED') return 'REVOKED'
  if (row.status === 'ENDED' || new Date(row.endsAt).getTime() <= now.getTime()) return 'ENDED'
  return new Date(row.startsAt).getTime() > now.getTime() ? 'SCHEDULED' : 'ACTIVE'
}

export type DelegationViewRow = DelegationRowDto & {
  readonly state: DelegationState
  /** First and last day (YYYY-MM-DD) when the period is whole days in the organization's time zone, else null */
  readonly days: { readonly first: string; readonly last: string } | null
}

export interface MyDelegationsView {
  /** Set by the member (or for them through an authority change), latest start first */
  readonly given: readonly DelegationViewRow[]
  /** Where the member acts for someone else, now or later */
  readonly received: readonly DelegationViewRow[]
  /** Positions held now or later; empty = nothing to delegate (BR-DLG-01) */
  readonly positions: readonly HeldPositionDto[]
  /** Who may act for the member (BR-DLG-03); empty for a member with no position, who has nothing to hand over */
  readonly candidates: readonly DelegateCandidateDto[]
  /** Today in the organization's time zone (YYYY-MM-DD), the first day the form offers */
  readonly today: string
}

const ymd = (d: TZDate) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

async function organizationTimezone(ctx: Ctx): Promise<string> {
  return (await forTenant(ctx.organizationId).organization.findUniqueOrThrow({ where: { id: ctx.organizationId }, select: { timezone: true } })).timezone
}

/** The page's data (delegation.manage, OWN): only the signed-in member's own delegations. */
export async function getMyDelegations(ctx: Ctx): Promise<Result<MyDelegationsView>> {
  const memberId = ctx.actor.type === 'USER' ? ctx.actor.memberId : null
  if (!memberId) return err('FORBIDDEN', 'only a member has delegations')
  const allowed = await forTenant(ctx.organizationId).$transaction((tx) => authorize(tx, ctx, 'delegation.manage', { ownerMemberIds: [memberId] }))
  if (!allowed.ok) return err(allowed.error.code, allowed.error.message, allowed.error.details)
  const [given, received, positions, timezone] = await Promise.all([
    listDelegationsGiven(ctx, memberId),
    listDelegationsReceived(ctx, memberId, ctx.now),
    listHeldPositions(ctx, memberId, ctx.now),
    organizationTimezone(ctx),
  ])
  // The members to choose from (names and main departments) go only to someone who can delegate (BR-DLG-01). Waiting
  // for the user's decision (personal data): every active member of the organization, as now, or only the delegator's
  // own department subtree. The spec says only "active and not the delegator" (BR-DLG-03).
  const candidates = positions.length > 0 ? await listDelegateCandidates(ctx, memberId) : []
  const withState = (r: DelegationRowDto): DelegationViewRow => ({ ...r, state: delegationState(r, ctx.now), days: wholeDays(r, timezone) })
  return ok({ given: given.map(withState), received: received.map(withState), positions, candidates, today: todayIn(ctx.now, timezone) })
}

/** Today (YYYY-MM-DD) in the organization's time zone */
const todayIn = (now: Date, timezone: string) => ymd(new TZDate(now.getTime(), timezone))

/** The days of a period that runs from one local midnight to another, the last day included; null otherwise. */
function wholeDays(row: Pick<DelegationRowDto, 'startsAt' | 'endsAt'>, timezone: string): { first: string; last: string } | null {
  const start = new TZDate(new Date(row.startsAt).getTime(), timezone)
  const end = new TZDate(new Date(row.endsAt).getTime(), timezone)
  const atMidnight = (d: TZDate) => d.getHours() === 0 && d.getMinutes() === 0 && d.getSeconds() === 0 && d.getMilliseconds() === 0
  if (!atMidnight(start) || !atMidnight(end)) return null
  const last = new TZDate(end.getFullYear(), end.getMonth(), end.getDate() - 1, 0, 0, timezone)
  return { first: ymd(start), last: ymd(last) }
}

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/
const AMOUNT = /^\d{1,13}(\.\d{1,2})?$/

/** Local midnight of a calendar day (YYYY-MM-DD) `plusDays` later, in `timezone`; null when it is not a date. */
function midnight(day: string, timezone: string, plusDays = 0): Date | null {
  const m = DAY.exec(day)
  if (!m) return null
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]
  const check = new Date(Date.UTC(y, mo - 1, d))
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d) return null
  return new Date(new TZDate(y, mo - 1, d + plusDays, 0, 0, timezone).getTime())
}

const DaysInput = z.strictObject({
  delegateMemberId: z.string(),
  /** First day of the delegation, from its start (YYYY-MM-DD in the organization's time zone) */
  firstDay: z.string(),
  /** Last day, included: the delegation ends at the next midnight */
  lastDay: z.string(),
  documentTypes: z.array(z.enum(DELEGATION_DOCUMENT_TYPES)).default([]),
  /** Baht; thousands separators and spaces are allowed; blank = no cap */
  maxAmount: z.string().optional(),
  reason: z.string(),
})

/** What the page sends; every value is checked here and again by createDelegation */
export interface DelegationDaysRequest {
  readonly delegateMemberId: string
  readonly firstDay: string
  readonly lastDay: string
  readonly documentTypes?: readonly string[]
  readonly maxAmount?: string
  readonly reason: string
}

/**
 * Sets a delegation by whole days (NEW-06): [first day 00:00, day after the last 00:00) in the organization's time zone,
 * then createDelegation applies BR-DLG-01..03. A blank cap means none. The first day is today or later: a period that
 * has passed would hand over nothing and tell the delegate they act for days that are gone (PAST_FIRST_DAY).
 */
export async function createDelegationForDays(ctx: Ctx, input: DelegationDaysRequest, options: RunOptions) {
  const parsed = DaysInput.safeParse(input)
  if (!parsed.success) return err('VALIDATION_FAILED', 'invalid delegation', { field: parsed.error.issues[0]?.path.join('.') ?? '(input)' })
  const timezone = await organizationTimezone(ctx)
  const startsAt = midnight(parsed.data.firstDay, timezone)
  if (!startsAt) return err('VALIDATION_FAILED', 'the first day is not a date', { field: 'firstDay' })
  if (parsed.data.firstDay < todayIn(ctx.now, timezone)) return err('VALIDATION_FAILED', 'the first day is before today', { field: 'firstDay', reason: 'PAST_FIRST_DAY' })
  const endsAt = midnight(parsed.data.lastDay, timezone, 1)
  if (!endsAt) return err('VALIDATION_FAILED', 'the last day is not a date', { field: 'lastDay' })
  if (endsAt.getTime() <= startsAt.getTime()) return err('VALIDATION_FAILED', 'the last day is before the first day', { field: 'lastDay', reason: 'INVALID_PERIOD' })
  const cap = (parsed.data.maxAmount ?? '').replace(/[\s,]/g, '')
  if (cap && !AMOUNT.test(cap)) return err('VALIDATION_FAILED', 'the cap is not an amount in baht', { field: 'maxAmount' })
  return createDelegation(
    ctx,
    {
      delegateMemberId: parsed.data.delegateMemberId,
      startsAt: startsAt.toISOString(),
      endsAt: endsAt.toISOString(),
      documentTypes: parsed.data.documentTypes,
      ...(cap ? { maxAmount: cap } : {}),
      reason: parsed.data.reason,
    },
    options,
  )
}
