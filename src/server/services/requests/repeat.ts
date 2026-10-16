import { z } from 'zod'
import { daysLeft, renewalMilestoneDue, reorderDraft } from '@/core/forms'
import { satangToAmount } from '@/core/money/dto'
import { agreementDay } from '@/core/pricing'
import { MS_PER_DAY } from '@/lib/constants'
import { s6SettingsOf } from '@/lib/org-settings'
import { authorize } from '@/server/authz'
import { systemCtx, type Ctx } from '@/server/context'
import type { TenantTx } from '@/server/db/tenant'
import type { EventDraft } from '@/server/events/append'
import { formDefinition } from '@/server/forms/schema'
import type { NotificationDraft } from '@/server/notifications/create'
import { defineCommand, runCommand, type CommandOutcome, type RunOptions } from '../_pipeline'
import { draftIn, type DraftFields, type DraftOrigin } from './index'

// Asking again (S6-12 · FR-INT-101): a reorder makes a new draft from one's own request (BR-FORM-07), a renewal makes one
// from a service line that ends soon (renewalOfRequestLineId), and a daily job reminds the requester (IMMEDIATE) and
// PROCUREMENT (DIGEST) of a service line at each milestone before it ends, once (BR-FORM-08). Nothing needs the module
// CONTRACTS. Only the requester reorders or renews (request.reorder, OWN = the requester alone): a follower or a
// department head is refused. The draft goes through the same checks as one typed in (draftIn).

type DraftResult = CommandOutcome<{ requestId: string; version: number; lineIds: string[] }>
const fail = (code: 'NOT_FOUND' | 'VALIDATION_FAILED' | 'FORBIDDEN' | 'INVALID_STATE_TRANSITION', message: string, details?: Record<string, unknown>) =>
  ({ ok: false, error: { code, message, ...(details ? { details } : {}) } }) as const

const SOURCE_SELECT = {
  id: true,
  status: true,
  title: true,
  requesterMemberId: true,
  priceIncludesVat: true,
  formData: true,
  deliverySiteId: true,
  suggestedSupplierId: true,
  requestType: { select: { code: true, active: true, currentFormVersion: { select: { status: true, schema: true } } } },
  lines: { orderBy: { lineNo: 'asc' as const }, select: { id: true, description: true, categoryCode: true, quantity: true, uom: true, unitPriceSatang: true, vatable: true, catalogItemId: true, serviceEndDate: true } },
} as const

type Source = NonNullable<Awaited<ReturnType<typeof loadSource>>>

async function loadSource(tx: TenantTx, requestId: string) {
  return tx.request.findFirst({ where: { id: requestId }, select: SOURCE_SELECT })
}

/** BR-FORM-07 for the lines given (all of them for a reorder, the one line for a renewal) */
async function draftFrom(tx: TenantTx, ctx: Ctx, source: Source, lines: Source['lines'], origin: DraftOrigin): Promise<DraftResult> {
  if (source.status === 'DRAFT') return fail('INVALID_STATE_TRANSITION', 'a draft is not reordered: edit it', { from: 'DRAFT' })
  const form = source.requestType.currentFormVersion
  if (!source.requestType.active || !form || form.status !== 'PUBLISHED') return fail('VALIDATION_FAILED', 'the request type is no longer offered', { field: 'requestTypeCode', reason: 'TYPE_INACTIVE' })
  // What still exists today: active items, an active suggested supplier and delivery site, the agreed prices in effect
  const items = [...new Set(lines.map((l) => l.catalogItemId).filter((id): id is string => Boolean(id)))]
  const active = new Set((await tx.catalogItem.findMany({ where: { id: { in: items }, active: true }, select: { id: true } })).map((i) => i.id))
  const supplierId = source.suggestedSupplierId && (await tx.supplier.count({ where: { id: source.suggestedSupplierId, status: 'ACTIVE' } })) ? source.suggestedSupplierId : null
  const siteId = source.deliverySiteId && (await tx.deliverySite.count({ where: { id: source.deliverySiteId, active: true } })) ? source.deliverySiteId : null
  const day = new Date(`${agreementDay(ctx.now)}T00:00:00Z`)
  const agreements = await tx.priceAgreement.findMany({ where: { catalogItemId: { in: [...active] }, validFrom: { lte: day }, validTo: { gt: day } }, select: { catalogItemId: true, supplierId: true, unitPriceSatang: true } })
  const draft = reorderDraft({
    currentFields: formDefinition(form.schema).fields.map((f) => f.id),
    fields: (source.formData ?? {}) as Record<string, unknown>,
    lines: lines.map((l) => ({ description: l.description, categoryCode: l.categoryCode, quantity: l.quantity.toString(), uom: l.uom, unitPriceSatang: l.unitPriceSatang, catalogItemId: l.catalogItemId && active.has(l.catalogItemId) ? l.catalogItemId : null })),
    supplierId,
    priceIncludesVat: source.priceIncludesVat,
    agreements,
  })
  const input: DraftFields = {
    requestTypeCode: source.requestType.code,
    title: source.title,
    urgency: 'NORMAL',
    priceIncludesVat: source.priceIncludesVat,
    formData: draft.fields as DraftFields['formData'],
    lines: draft.lines.map((l, i) => ({
      description: l.description,
      quantity: l.quantity,
      uom: l.uom,
      unitPrice: satangToAmount(l.unitPriceSatang),
      vatable: lines[i]!.vatable,
      ...(l.categoryCode ? { categoryCode: l.categoryCode } : {}),
      catalogItemId: l.catalogItemId,
    })),
    quotations: [],
    ...(siteId ? { deliverySiteId: siteId } : {}),
    ...(supplierId ? { suggestedSupplierId: supplierId } : {}),
  }
  return draftIn(tx, ctx, input, origin)
}

// ---------- reorder (BR-FORM-07) ----------

const ReorderInput = z.strictObject({ requestId: z.uuid() })

export const reorderCommand = defineCommand({
  name: 'request.reorder',
  capability: 'request.reorder',
  input: ReorderInput,
  async execute(tx, input, ctx): Promise<DraftResult> {
    const source = await loadSource(tx, input.requestId)
    if (!source) return fail('NOT_FOUND', 'request not found')
    const allowed = await authorize(tx, ctx, 'request.reorder', { ownerMemberIds: [source.requesterMemberId] })
    if (!allowed.ok) return { ok: false, error: allowed.error }
    return draftFrom(tx, ctx, source, source.lines, { source: 'REORDER', sourceRequestId: source.id })
  },
})

export function reorderRequest(ctx: Ctx, input: z.input<typeof ReorderInput>, options: RunOptions) {
  return runCommand(ctx, reorderCommand, input, options)
}

// ---------- renewal of a service line (BR-FORM-08) ----------

const RenewInput = z.strictObject({ requestLineId: z.uuid() })

export const renewCommand = defineCommand({
  name: 'request.renew',
  capability: 'request.reorder',
  input: RenewInput,
  async execute(tx, input, ctx): Promise<DraftResult> {
    const line = await tx.requestLine.findFirst({ where: { id: input.requestLineId }, select: { requestId: true } })
    if (!line) return fail('NOT_FOUND', 'request line not found')
    const source = (await loadSource(tx, line.requestId))!
    const allowed = await authorize(tx, ctx, 'request.reorder', { ownerMemberIds: [source.requesterMemberId] })
    if (!allowed.ok) return { ok: false, error: allowed.error }
    const own = source.lines.find((l) => l.id === input.requestLineId)!
    if (!own.serviceEndDate) return fail('VALIDATION_FAILED', 'only a service line with an end date is renewed', { field: 'requestLineId', reason: 'NOT_A_SERVICE_LINE' })
    return draftFrom(tx, ctx, source, [own], { source: 'RENEWAL', sourceRequestId: source.id, renewalOfRequestLineId: own.id })
  },
})

export function renewRequestLine(ctx: Ctx, input: z.input<typeof RenewInput>, options: RunOptions) {
  return runCommand(ctx, renewCommand, input, options)
}

// ---------- the daily reminders (job renewal-reminders) ----------

/** Requests whose service lines are reminded: ordered at least in part, or done (BR-FORM-08) */
const REMINDED_STATUSES = ['PARTIALLY_ORDERED', 'ORDERED', 'COMPLETED'] as const
/** A renewal that went out (sent, and neither cancelled nor rejected) stops the reminders of its line */
const LIVE_RENEWAL = { submittedAt: { not: null }, status: { notIn: ['CANCELLED' as const, 'REJECTED' as const] } }

export const remindRenewalsCommand = defineCommand({
  name: 'request.remind_renewals',
  capability: 'request.reorder',
  input: z.strictObject({}),
  async execute(tx, _input, ctx): Promise<CommandOutcome<{ reminded: number }>> {
    if (ctx.actor.type !== 'SYSTEM') return fail('FORBIDDEN', 'only the scheduled job reminds renewals')
    const org = await tx.organization.findUniqueOrThrow({ where: { id: ctx.organizationId }, select: { settings: true } })
    const milestones = s6SettingsOf(org.settings).renewalMilestoneDays
    const furthest = new Date(ctx.now.getTime() + (Math.max(...milestones) + 1) * MS_PER_DAY)
    const lines = await tx.requestLine.findMany({
      where: { serviceEndDate: { not: null, lte: furthest }, request: { status: { in: [...REMINDED_STATUSES] } }, renewals: { none: LIVE_RENEWAL } },
      select: { id: true, serviceEndDate: true, request: { select: { id: true, number: true, title: true, requesterMemberId: true } } },
    })
    if (lines.length === 0) return fail('NOT_FOUND', 'no service line ends soon')
    const sent = await tx.event.findMany({ where: { type: 'request.renewal_reminded', aggregateId: { in: [...new Set(lines.map((l) => l.request.id))] } }, select: { data: true } })
    const sentByLine = new Map<string, number[]>()
    for (const e of sent) {
      const d = e.data as { requestLineId: string; milestone: number }
      sentByLine.set(d.requestLineId, [...(sentByLine.get(d.requestLineId) ?? []), d.milestone])
    }
    const procurement = [...new Set((await tx.roleAssignment.findMany({ where: { role: 'PROCUREMENT', revokedAt: null, member: { status: 'ACTIVE' } }, select: { memberId: true } })).map((r) => r.memberId))]
    const events: EventDraft[] = []
    const notifications: NotificationDraft[] = []
    for (const line of lines) {
      const end = line.serviceEndDate!.toISOString().slice(0, 10)
      const milestone = renewalMilestoneDue(daysLeft(ctx.now, end), sentByLine.get(line.id) ?? [], milestones)
      if (milestone === null) continue
      const r = line.request
      events.push({ type: 'request.renewal_reminded', aggregateType: 'Request', aggregateId: r.id, data: { requestLineId: line.id, milestone, serviceEndDate: end } })
      const data = { requestId: r.id, number: r.number, title: r.title, milestone, serviceEndDate: end }
      for (const [recipientMemberId, urgency] of [[r.requesterMemberId, 'IMMEDIATE'] as const, ...procurement.filter((m) => m !== r.requesterMemberId).map((m) => [m, 'DIGEST'] as const)]) {
        notifications.push({ recipientMemberId, templateKey: 'request.renewal_due', data, urgency, dedupeKey: `request.renewal_due:${line.id}:${milestone}:${recipientMemberId}`, subjectType: 'REQUEST', subjectId: r.id })
      }
    }
    if (events.length === 0) return fail('NOT_FOUND', 'every reminder due was sent already')
    return { ok: true, result: { reminded: events.length }, events, notifications }
  },
})

/** What the job renewal-reminders runs for one organization on one day; the day is the idempotency key */
export function runRenewalReminders(organizationId: string, now: Date) {
  return runCommand(systemCtx(organizationId, now, 'renewal-reminders'), remindRenewalsCommand, {}, { idempotencyKey: `renewal-reminders:${agreementDay(now)}` })
}
