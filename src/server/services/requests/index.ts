import { z } from 'zod'
import { evaluateCondition, evaluateForm } from '@/core/forms'
import { formDataSchema } from '@/core/forms/fields'
import { documentTotals, lineNet } from '@/core/money/math'
import { REQUEST_MACHINE, SUPPLIER_REQUEST_MACHINE, transition, type RequestCommand, type RequestState, type SupplierRequestState } from '@/core/state-machines'
import { rateFor, taxDateOf } from '@/core/vat'
import { REASON_MAX_LENGTH } from '@/lib/constants'
import { newId } from '@/lib/ids'
import { authorize } from '@/server/authz'
import type { Ctx } from '@/server/context'
import { listTaxRates } from '@/server/db/lookups'
import { lockRowsForUpdate } from '@/server/db/sql/locks'
import type { TenantTx } from '@/server/db/tenant'
import type { EventDraft } from '@/server/events/append'
import { defineCommand, runCommand, type CommandOutcome, type RunOptions } from '../_pipeline'
import { closeRoute, startRoute } from '../approvals/route'
import { issueDocumentNumber } from '../numbering'
import { formDefinition } from '@/server/forms/schema'
import { checkQuotations, MAX_QUOTATIONS, QuotationInput, writeQuotations } from './quotations'

// Purchase requests (spec §6.4, FR-INT-007, FR-INT-009): a draft with lines, then submit as one transaction — form
// check (BR-FORM-01/03), totals from core/money with the VAT rate of the tax date (BR-VAT-01..03), budget check (stub
// until S3-05), DOA route (§7.4), number (BR-NUM-01), first task and events. If any step fails nothing is written.
// Amounts arrive as baht text and are kept as satang; totals never come from the client.

const fail = (code: 'VALIDATION_FAILED' | 'NOT_FOUND' | 'INVALID_STATE_TRANSITION' | 'TAX_RATE_NOT_CONFIGURED', message: string, details?: Record<string, unknown>) =>
  ({ ok: false, error: { code, message, ...(details ? { details } : {}) } }) as const

const Baht = z.string().regex(/^\d{1,13}(\.\d{1,2})?$/)
const Quantity = z.string().regex(/^\d{1,14}(\.\d{1,4})?$/)

const LineInput = z.strictObject({
  description: z.string().trim().min(1).max(500),
  quantity: Quantity,
  uom: z.string().trim().min(1).max(30),
  unitPrice: Baht,
  vatable: z.boolean().default(true),
  categoryCode: z.string().trim().max(50).optional(),
  serviceEndDate: z.iso.date().optional(),
})

const DraftInput = z.strictObject({
  requestTypeCode: z.string().min(1),
  title: z.string().trim().min(1).max(200),
  /** The department that pays (BR-FORM-02 default: the requester's main department) */
  chargedDepartmentId: z.uuid().optional(),
  urgency: z.enum(['NORMAL', 'URGENT']).default('NORMAL'),
  neededBy: z.iso.date().optional(),
  priceIncludesVat: z.boolean().default(false),
  formData: z.record(z.string(), z.unknown()).default({}),
  lines: z.array(LineInput).max(200).default([]),
  /** BR-FORM-06: quotations as data, one chosen; a reason when the chosen one is not the lowest */
  quotations: z.array(QuotationInput).max(MAX_QUOTATIONS).default([]),
  nonLowestQuoteReason: z.string().trim().max(REASON_MAX_LENGTH).optional(),
})

/** Today's VAT rate for the prices before VAT of draft quotations; submit computes them again (BR-FORM-06) */
async function todaysRate(ctx: Ctx): Promise<number | null> {
  const rate = rateFor(taxDateOf(ctx.now), await listTaxRates())
  return rate.ok ? rate.rateBp : null
}

const amountToSatang = (baht: string) => {
  const [whole, fraction = ''] = baht.split('.')
  return BigInt(whole!) * 100n + BigInt(fraction.padEnd(2, '0'))
}

function requesterOf(ctx: Ctx): string | null {
  return ctx.actor.type === 'USER' ? ctx.actor.memberId : null
}

function move(from: RequestState, command: RequestCommand) {
  const t = transition(REQUEST_MACHINE, from, command)
  return t.ok ? { ok: true as const, to: t.to } : fail('INVALID_STATE_TRANSITION', `${command} is not allowed from ${from}`, { from, command })
}

async function writeLines(tx: TenantTx, ctx: Ctx, requestId: string, lines: z.output<typeof LineInput>[]): Promise<void> {
  await tx.requestLine.deleteMany({ where: { requestId } })
  for (const [i, line] of lines.entries()) {
    const unitPriceSatang = amountToSatang(line.unitPrice)
    await tx.requestLine.create({
      data: {
        organizationId: ctx.organizationId,
        requestId,
        lineNo: i + 1,
        description: line.description,
        quantity: line.quantity,
        uom: line.uom,
        unitPriceSatang,
        // BR-MONEY-02 (1): a line amount is rounded once, here
        netSatang: lineNet(line.quantity, unitPriceSatang),
        vatable: line.vatable,
        ...(line.categoryCode ? { categoryCode: line.categoryCode } : {}),
        ...(line.serviceEndDate ? { serviceEndDate: new Date(`${line.serviceEndDate}T00:00:00Z`) } : {}),
      },
    })
  }
}

// ---------- draft ----------

export const createDraftCommand = defineCommand({
  name: 'request.create_draft',
  capability: 'request.create',
  input: DraftInput,
  async execute(tx, input, ctx): Promise<CommandOutcome<{ requestId: string }>> {
    const allowed = await authorize(tx, ctx, 'request.create')
    if (!allowed.ok) return { ok: false, error: allowed.error }
    const requesterId = requesterOf(ctx)
    if (!requesterId) return { ok: false, error: { code: 'FORBIDDEN', message: 'only a member can request' } }
    const type = await tx.requestType.findFirst({ where: { code: input.requestTypeCode, active: true } })
    if (!type) return fail('VALIDATION_FAILED', 'unknown request type', { field: 'requestTypeCode' })
    if (!type.currentFormVersionId) return fail('VALIDATION_FAILED', 'the request type has no published form', { field: 'requestTypeCode', reason: 'NO_PUBLISHED_FORM' })
    const member = await tx.member.findUniqueOrThrow({ where: { id: requesterId }, select: { primaryDepartmentId: true } })
    if (!member.primaryDepartmentId) return fail('VALIDATION_FAILED', 'the requester has no main department', { field: 'chargedDepartmentId', reason: 'NO_DEPARTMENT' })
    const chargedDepartmentId = input.chargedDepartmentId ?? member.primaryDepartmentId
    if (!(await tx.department.findFirst({ where: { id: chargedDepartmentId, active: true }, select: { id: true } }))) {
      return fail('VALIDATION_FAILED', 'unknown department', { field: 'chargedDepartmentId' })
    }
    const id = newId()
    await tx.request.create({
      data: {
        id,
        organizationId: ctx.organizationId,
        requestTypeId: type.id,
        formVersionId: type.currentFormVersionId,
        documentType: type.documentType,
        title: input.title,
        requesterMemberId: requesterId,
        requesterDepartmentId: member.primaryDepartmentId,
        chargedDepartmentId,
        urgency: input.urgency,
        ...(input.neededBy ? { neededBy: new Date(`${input.neededBy}T00:00:00Z`) } : {}),
        priceIncludesVat: input.priceIncludesVat,
        formData: input.formData as object,
        nonLowestQuoteReason: input.nonLowestQuoteReason ?? null,
      },
    })
    await writeLines(tx, ctx, id, input.lines)
    const quotes = await writeQuotations(tx, ctx, { id, requesterMemberId: requesterId }, input.quotations, await todaysRate(ctx))
    if (quotes) return quotes
    return {
      ok: true,
      result: { requestId: id },
      events: [{ type: 'request.drafted', aggregateType: 'Request', aggregateId: id, data: { requestTypeCode: type.code, lines: input.lines.length } }],
    }
  },
})

export function createDraft(ctx: Ctx, input: z.input<typeof DraftInput>, options: RunOptions) {
  return runCommand(ctx, createDraftCommand, input, options)
}

// ---------- submit and resubmit ----------

const SubmitInput = z.strictObject({ requestId: z.uuid() })

/** Loads the request locked, with what the requester (OWN) owns, for submit, resubmit and cancel. */
async function lockedRequest(tx: TenantTx, ctx: Ctx, requestId: string) {
  const [locked] = await lockRowsForUpdate(tx, 'Request', ctx.organizationId, [requestId])
  if (!locked) return null
  return tx.request.findUniqueOrThrow({ where: { id: requestId }, include: { lines: { orderBy: { lineNo: 'asc' } }, formVersion: true, requestType: true } })
}

type LoadedRequest = NonNullable<Awaited<ReturnType<typeof lockedRequest>>>

/** Form check, totals and route: the shared part of submit and resubmit. */
async function prepareRoute(tx: TenantTx, ctx: Ctx, request: LoadedRequest) {
  // BR-FORM-01 and BR-FORM-03: hidden fields are dropped, visible ones checked, attachment rules met
  const form = formDefinition(request.formVersion.schema)
  if (request.lines.length === 0) return fail('VALIDATION_FAILED', 'a request needs at least one line', { field: 'lines', reason: 'NO_LINES' })
  const rates = await listTaxRates()
  const taxDate = taxDateOf(ctx.now)
  const rate = rateFor(taxDate, rates)
  if (!rate.ok) return fail('TAX_RATE_NOT_CONFIGURED', 'no VAT rate covers the tax date', { date: taxDate })
  const totals = documentTotals(
    request.lines.map((l) => ({ quantity: l.quantity.toString(), unitPriceSatang: l.unitPriceSatang, vatable: l.vatable })),
    rate.rateBp,
    request.priceIncludesVat,
  )
  const links = await tx.fileLink.groupBy({ by: ['kind'], where: { subjectType: 'Request', subjectId: request.id }, _count: { _all: true } })
  const attachments = Object.fromEntries(links.map((l) => [l.kind, l._count._all]))
  const evaluated = evaluateForm(form, {
    fields: request.formData as Record<string, unknown>,
    attachments,
    variables: { $amountGross: totals.gross, $amountNet: totals.net, $requestType: request.requestType.code },
  })
  if (!evaluated.ok) {
    return { ok: false as const, error: { code: 'ATTACHMENT_RULE_FAILED' as const, message: 'attachment rule failed', details: { rule: evaluated.rule, failures: evaluated.failures } } }
  }
  const visible = form.fields.filter((f) => !evaluated.droppedFields.includes(f.id))
  const checked = formDataSchema(visible).safeParse(evaluated.fields)
  if (!checked.success) {
    const issue = checked.error.issues[0]
    return fail('VALIDATION_FAILED', 'the form is not complete', { field: `formData.${issue?.path.join('.') ?? ''}`, reason: 'FORM' })
  }
  // BR-FORM-05: service and licence lines carry the day the service ends, when the form asks for it
  const endDate = form.lines.serviceEndDate
  if (endDate && evaluateCondition(endDate.when, { fields: evaluated.fields, attachments, variables: { $amountGross: totals.gross, $amountNet: totals.net, $requestType: request.requestType.code } })) {
    const missing = request.lines.findIndex((l) => !l.serviceEndDate)
    if (missing >= 0) return fail('VALIDATION_FAILED', 'the line needs the day the service ends', { field: `lines.${missing}.serviceEndDate`, reason: 'SERVICE_END_DATE' })
  }
  // BR-FORM-06: quotations compared before VAT with the rate of the tax date
  const quotes = await checkQuotations(tx, request, rate.rateBp)
  if (quotes) return quotes
  // The budget check and reservation of §6.4 ("ตรวจและจองงบ") arrive with S3-05; until then no request is refused for
  // budget, which the demo data respects
  const route = await startRoute(
    tx,
    ctx,
    { type: 'REQUEST', id: request.id, label: request.number ?? request.title },
    {
      documentType: 'PURCHASE_REQUEST',
      amount: { netSatang: totals.net, vatSatang: totals.vat },
      requesterMemberId: request.requesterMemberId,
      chargedDepartmentId: request.chargedDepartmentId,
      conflictMemberIds: [request.requesterMemberId],
      at: ctx.now,
    },
  )
  if (!route.ok) return { ok: false as const, error: route.error }
  return { ok: true as const, totals, rateBp: rate.rateBp, taxDate, route: route.data, formData: checked.data }
}

export const submitCommand = defineCommand({
  name: 'request.submit',
  capability: 'request.submit',
  input: SubmitInput,
  async execute(tx, input, ctx): Promise<CommandOutcome<{ number: string; routeId: string; assigneeMemberId: string }>> {
    const request = await lockedRequest(tx, ctx, input.requestId)
    if (!request) return fail('NOT_FOUND', 'request not found')
    const allowed = await authorize(tx, ctx, 'request.submit', { ownerMemberIds: [request.requesterMemberId] })
    if (!allowed.ok) return { ok: false, error: allowed.error }
    if (request.documentType === 'SUPPLIER_REQUEST') return submitSupplierRequest(tx, ctx, request)
    const moved = move(request.status as RequestState, 'request.submit')
    if (!moved.ok) return moved
    const prepared = await prepareRoute(tx, ctx, request)
    if (!prepared.ok) return prepared
    const department = await tx.department.findUniqueOrThrow({ where: { id: request.chargedDepartmentId }, select: { code: true } })
    const number = await issueDocumentNumber(tx, ctx, { document: 'PR', department: department.code })
    const { totals, route } = prepared
    await tx.request.update({
      where: { id: request.id },
      data: {
        status: moved.to,
        number,
        formData: prepared.formData as object,
        netSatang: totals.net,
        vatSatang: totals.vat,
        grossSatang: totals.gross,
        vatRateBp: prepared.rateBp,
        taxPointDate: new Date(`${prepared.taxDate}T00:00:00Z`),
        submittedAt: ctx.now,
        currentRouteId: route.routeId,
        version: { increment: 1 },
      },
    })
    const events: EventDraft[] = [
      {
        type: 'request.submitted',
        aggregateType: 'Request',
        aggregateId: request.id,
        data: {
          number,
          netSatang: totals.net.toString(),
          vatSatang: totals.vat.toString(),
          grossSatang: totals.gross.toString(),
          vatRateBp: prepared.rateBp,
          routeId: route.routeId,
          doaVersionId: route.route.doaVersionId,
          doaRuleCode: route.route.ruleCode,
          escalatedFromRuleCode: route.route.escalatedFromRuleCode,
        },
      },
      ...route.events,
    ]
    return { ok: true, result: { number, routeId: route.routeId, assigneeMemberId: route.firstTask.assigneeMemberId }, events, notifications: route.notifications }
  },
})

/**
 * A new-supplier request (OQ-23, FR-INT-007 AC3): no amount and no DOA route; its form is checked, it gets an RQ number
 * and goes to the procurement queue, whose members are told.
 */
async function submitSupplierRequest(tx: TenantTx, ctx: Ctx, request: LoadedRequest): Promise<CommandOutcome<{ number: string; routeId: string; assigneeMemberId: string }>> {
  const t = transition(SUPPLIER_REQUEST_MACHINE, request.status as SupplierRequestState, 'request.submit')
  if (!t.ok) return fail('INVALID_STATE_TRANSITION', `request.submit is not allowed from ${request.status}`, { from: request.status, command: 'request.submit' })
  const form = formDefinition(request.formVersion.schema)
  const evaluated = evaluateForm(form, { fields: request.formData as Record<string, unknown>, attachments: {}, variables: { $amountGross: 0n, $amountNet: 0n, $requestType: request.requestType.code } })
  if (!evaluated.ok) return { ok: false, error: { code: 'ATTACHMENT_RULE_FAILED', message: 'attachment rule failed', details: { rule: evaluated.rule, failures: evaluated.failures } } }
  const checked = formDataSchema(form.fields.filter((f) => !evaluated.droppedFields.includes(f.id))).safeParse(evaluated.fields)
  if (!checked.success) {
    const issue = checked.error.issues[0]
    return fail('VALIDATION_FAILED', 'the form is not complete', { field: `formData.${issue?.path.join('.') ?? ''}`, reason: 'FORM' })
  }
  const number = await issueDocumentNumber(tx, ctx, { document: 'RQ' })
  await tx.request.update({ where: { id: request.id }, data: { status: t.to, number, formData: checked.data as object, submittedAt: ctx.now, version: { increment: 1 } } })
  const procurement = await tx.roleAssignment.findMany({ where: { role: 'PROCUREMENT', revokedAt: null, member: { status: 'ACTIVE' } }, select: { memberId: true } })
  return {
    ok: true,
    result: { number, routeId: '', assigneeMemberId: '' },
    events: [{ type: 'request.submitted', aggregateType: 'Request', aggregateId: request.id, data: { number, queue: 'PROCUREMENT' } }],
    notifications: [...new Set(procurement.map((p) => p.memberId))].map((memberId) => ({
      recipientMemberId: memberId,
      templateKey: 'supplier_request.submitted',
      data: { requestId: request.id, number, title: request.title },
      urgency: 'IMMEDIATE' as const,
      dedupeKey: `supplier_request.submitted:${request.id}:${memberId}`,
      subjectType: 'REQUEST',
      subjectId: request.id,
    })),
  }
}

export function submitRequest(ctx: Ctx, input: z.input<typeof SubmitInput>, options: RunOptions) {
  return runCommand(ctx, submitCommand, input, options)
}

export const resubmitCommand = defineCommand({
  name: 'request.resubmit',
  capability: 'request.submit',
  input: SubmitInput,
  async execute(tx, input, ctx): Promise<CommandOutcome<{ routeId: string; assigneeMemberId: string }>> {
    const request = await lockedRequest(tx, ctx, input.requestId)
    if (!request) return fail('NOT_FOUND', 'request not found')
    const allowed = await authorize(tx, ctx, 'request.submit', { ownerMemberIds: [request.requesterMemberId] })
    if (!allowed.ok) return { ok: false, error: allowed.error }
    const moved = move(request.status as RequestState, 'request.resubmit')
    if (!moved.ok) return moved
    // BR-DOA-09: a new route with the version in effect now; earlier approvals do not count
    const replaced = await closeRoute(tx, { type: 'REQUEST', id: request.id }, 'CANCELLED', 'ROUTE_REPLACED')
    const prepared = await prepareRoute(tx, ctx, request)
    if (!prepared.ok) return prepared
    const { totals, route } = prepared
    await tx.request.update({
      where: { id: request.id },
      data: {
        status: moved.to,
        formData: prepared.formData as object,
        netSatang: totals.net,
        vatSatang: totals.vat,
        grossSatang: totals.gross,
        vatRateBp: prepared.rateBp,
        taxPointDate: new Date(`${prepared.taxDate}T00:00:00Z`),
        submittedAt: ctx.now,
        currentRouteId: route.routeId,
        version: { increment: 1 },
      },
    })
    return {
      ok: true,
      result: { routeId: route.routeId, assigneeMemberId: route.firstTask.assigneeMemberId },
      events: [
        ...replaced,
        {
          type: 'request.resubmitted',
          aggregateType: 'Request',
          aggregateId: request.id,
          data: {
            netSatang: totals.net.toString(),
            vatSatang: totals.vat.toString(),
            grossSatang: totals.gross.toString(),
            routeId: route.routeId,
            doaVersionId: route.route.doaVersionId,
            doaRuleCode: route.route.ruleCode,
          },
        },
        ...route.events,
      ],
      notifications: route.notifications,
    }
  },
})

export function resubmitRequest(ctx: Ctx, input: z.input<typeof SubmitInput>, options: RunOptions) {
  return runCommand(ctx, resubmitCommand, input, options)
}

// ---------- edit a draft or a returned request ----------

const EditInput = DraftInput.omit({ requestTypeCode: true }).extend({ requestId: z.uuid() })

export const editCommand = defineCommand({
  name: 'request.edit',
  capability: 'request.create',
  input: EditInput,
  async execute(tx, input, ctx): Promise<CommandOutcome<{ requestId: string }>> {
    const request = await lockedRequest(tx, ctx, input.requestId)
    if (!request) return fail('NOT_FOUND', 'request not found')
    const allowed = await authorize(tx, ctx, 'request.create', { ownerMemberIds: [request.requesterMemberId] })
    if (!allowed.ok) return { ok: false, error: allowed.error }
    if (request.status !== 'DRAFT' && request.status !== 'RETURNED') return fail('INVALID_STATE_TRANSITION', 'only a draft or a returned request can be edited', { from: request.status })
    await tx.request.update({
      where: { id: request.id },
      data: {
        title: input.title,
        ...(input.chargedDepartmentId ? { chargedDepartmentId: input.chargedDepartmentId } : {}),
        urgency: input.urgency,
        neededBy: input.neededBy ? new Date(`${input.neededBy}T00:00:00Z`) : null,
        priceIncludesVat: input.priceIncludesVat,
        formData: input.formData as object,
        nonLowestQuoteReason: input.nonLowestQuoteReason ?? null,
        version: { increment: 1 },
      },
    })
    await writeLines(tx, ctx, request.id, input.lines)
    const quotes = await writeQuotations(tx, ctx, request, input.quotations, await todaysRate(ctx))
    if (quotes) return quotes
    return { ok: true, result: { requestId: request.id }, events: [{ type: 'request.drafted', aggregateType: 'Request', aggregateId: request.id, data: { requestTypeCode: request.requestType.code, lines: input.lines.length } }] }
  },
})

export function editRequest(ctx: Ctx, input: z.input<typeof EditInput>, options: RunOptions) {
  return runCommand(ctx, editCommand, input, options)
}

// ---------- cancel by the requester (§6.4, FR-INT-009 AC1) ----------

const CancelInput = z.strictObject({ requestId: z.uuid(), reason: z.string().trim().max(REASON_MAX_LENGTH).optional() })

export const cancelCommand = defineCommand({
  name: 'request.cancel',
  capability: 'request.cancel',
  input: CancelInput,
  async execute(tx, input, ctx): Promise<CommandOutcome<{ requestId: string }>> {
    const request = await lockedRequest(tx, ctx, input.requestId)
    if (!request) return fail('NOT_FOUND', 'request not found')
    const allowed = await authorize(tx, ctx, 'request.cancel', { ownerMemberIds: [request.requesterMemberId] })
    if (!allowed.ok) return { ok: false, error: allowed.error }
    const moved = move(request.status as RequestState, 'request.cancel')
    if (!moved.ok) return moved
    const closed = await closeRoute(tx, { type: 'REQUEST', id: request.id }, 'CANCELLED', 'REQUEST_CANCELLED')
    let reasonCommentId: string | null = null
    if (input.reason) {
      reasonCommentId = newId()
      await tx.comment.create({ data: { id: reasonCommentId, organizationId: ctx.organizationId, subjectType: 'Request', subjectId: request.id, authorMemberId: requesterOf(ctx), body: input.reason } })
    }
    // The budget reservation is released here once S3-05 reserves it (FR-INT-009 AC1 "งบคืนทันที")
    await tx.request.update({ where: { id: request.id }, data: { status: moved.to, cancelledAt: ctx.now, cancelReason: input.reason ?? null, version: { increment: 1 } } })
    return {
      ok: true,
      result: { requestId: request.id },
      events: [...closed, { type: 'request.cancelled', aggregateType: 'Request', aggregateId: request.id, data: { from: request.status, reasonCommentId } }],
    }
  },
})

export function cancelRequest(ctx: Ctx, input: z.input<typeof CancelInput>, options: RunOptions) {
  return runCommand(ctx, cancelCommand, input, options)
}
