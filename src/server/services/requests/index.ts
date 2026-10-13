import { z } from 'zod'
import { evaluateCondition, evaluateForm } from '@/core/forms'
import { formDataSchema } from '@/core/forms/fields'
import { FORM_TEXTAREA_MAX_LENGTH, FORM_TEXT_MAX_LENGTH } from '@/core/money/constants'
import { documentTotals, lineNet, lineNetsBeforeVat } from '@/core/money/math'
import { REQUEST_MACHINE, SUPPLIER_REQUEST_MACHINE, transition, type RequestCommand, type RequestState, type SupplierRequestState } from '@/core/state-machines'
import type { AppError, Result } from '@/core/result'
import { rateFor, taxDateOf } from '@/core/vat'
import type { Jsonified } from '@/lib/json'
import { REASON_MAX_LENGTH } from '@/lib/constants'
import { newId } from '@/lib/ids'
import { authorize, loadPrincipal, matchingGrants } from '@/server/authz'
import type { Ctx } from '@/server/context'
import { listTaxRates } from '@/server/db/lookups'
import { lockRowsForUpdate } from '@/server/db/sql/locks'
import type { TenantTx } from '@/server/db/tenant'
import type { EventDraft } from '@/server/events/append'
import { defineCommand, runCommand, type CommandOutcome, type RunOptions } from '../_pipeline'
import { requestReviewFacts } from '@/server/workflow/policy'
import { closeRoute, startRoute } from '../approvals/route'
import { issueDocumentNumber } from '../numbering'
import { formDefinition, type FormDefinition } from '@/server/forms/schema'
import { checkCatalogLines } from './catalog-lines'
import { checkQuotations, MAX_QUOTATIONS, QuotationInput, writeQuotations } from './quotations'
import { releaseForRequest, reserveForRequest, resolveBudgetLine } from './budget'
import { reportDoaGap } from './doa-gap'
import { aiAssisted, aiReviewed } from './ai-assist'
import { AiAssistInput } from '../ai/assist-contract'

// Purchase requests (spec §6.4, FR-INT-007, FR-INT-009): a draft with lines, then submit as one transaction — form
// check (BR-FORM-01/03), totals from core/money with the VAT rate of the tax date (BR-VAT-01..03), budget check and
// reservation (BR-BUD-02), DOA route (§7.4), number (BR-NUM-01), first task and events. If any step fails nothing is
// written.
// Amounts arrive as baht text and are kept as satang; totals never come from the client.

const fail = (code: 'VALIDATION_FAILED' | 'NOT_FOUND' | 'INVALID_STATE_TRANSITION' | 'TAX_RATE_NOT_CONFIGURED' | 'CONFLICT_VERSION', message: string, details?: Record<string, unknown>) =>
  ({ ok: false, error: { code, message, ...(details ? { details } : {}) } }) as const

/** Request.version the client last saw (INV-PLT-02, FR-INT-006 AC2); optional, so callers that do not track it still work */
const ExpectedVersion = z.number().int().nonnegative()

/** INV-PLT-02: the same draft changed in two places — what was based on an older version is refused */
function versionConflict(expected: number | undefined, actual: number) {
  return expected !== undefined && expected !== actual ? fail('CONFLICT_VERSION', 'the request changed since it was opened', { expectedVersion: expected, version: actual }) : null
}

const Baht = z.string().regex(/^\d{1,13}(\.\d{1,2})?$/)
// Above zero, as the CHECK request_line_qty_values of §6.3 requires: refused here as VALIDATION_FAILED, not by the database
const Quantity = z
  .string()
  .regex(/^\d{1,14}(\.\d{1,4})?$/)
  .refine((q) => /[1-9]/.test(q), 'the quantity must be above zero')

/** A request carries at most this many lines */
const MAX_LINES = 200

const LineInput = z.strictObject({
  /**
   * The line's own id from an earlier save, or null for a new line. A save that names ids changes each line by its id
   * (the web form always does, so a line keeps its content and the budget it holds whatever is added or taken away
   * around it); a save that names none changes them by their order, as callers before S2-11 did.
   */
  id: z.uuid().nullable().optional(),
  description: z.string().trim().min(1).max(500),
  quantity: Quantity,
  uom: z.string().trim().min(1).max(30),
  unitPrice: Baht,
  vatable: z.boolean().default(true),
  categoryCode: z.string().trim().max(50).optional(),
  serviceEndDate: z.iso.date().optional(),
  /** S6-10: the catalogue item the line is; its agreed price is checked on every save and at submit (BR-PRC-06) */
  catalogItemId: z.uuid().nullable().optional(),
})
type LineRow = z.output<typeof LineInput>

// The answers a draft keeps (BR-FORM-01 is applied on every save, see answersToKeep): field ids of the form only, as
// text, yes/no or lists of text no longer than the form's longest field, so a draft cannot be used to store anything else
const FIELD_ID = /^[A-Za-z][A-Za-z0-9_]{0,63}$/
const DRAFT_ANSWERS_MAX = 100
const DRAFT_LIST_MAX = 200
const DraftAnswer = z.union([
  z.string().max(FORM_TEXTAREA_MAX_LENGTH),
  z.boolean(),
  z.null(),
  z.array(z.string().max(FORM_TEXT_MAX_LENGTH)).max(DRAFT_LIST_MAX),
  z.array(z.record(z.string().regex(FIELD_ID), z.string().max(FORM_TEXT_MAX_LENGTH))).max(DRAFT_LIST_MAX),
])
const DraftAnswers = z.record(z.string().regex(FIELD_ID), DraftAnswer).refine((answers) => Object.keys(answers).length <= DRAFT_ANSWERS_MAX, 'too many answers')

const DraftInput = z.strictObject({
  requestTypeCode: z.string().min(1),
  title: z.string().trim().min(1).max(200),
  /** The department that pays (BR-FORM-02 default: the requester's main department) */
  chargedDepartmentId: z.uuid().optional(),
  urgency: z.enum(['NORMAL', 'URGENT']).default('NORMAL'),
  neededBy: z.iso.date().optional(),
  priceIncludesVat: z.boolean().default(false),
  formData: DraftAnswers.default({}),
  lines: z.array(LineInput).max(MAX_LINES).default([]),
  /** BR-BUD-04: the budget line the request uses; left out, submit takes the department's only open line */
  budgetLineId: z.uuid().optional(),
  /** BR-FORM-06: quotations as data, one chosen; a reason when the chosen one is not the lowest */
  quotations: z.array(QuotationInput).max(MAX_QUOTATIONS).default([]),
  nonLowestQuoteReason: z.string().trim().max(REASON_MAX_LENGTH).optional(),
  /** Where the goods go: one active delivery site of the organization (BR-CONS-01 groups POs by it) */
  deliverySiteId: z.uuid().nullable().optional(),
  /** The supplier the requester suggests; PROCUREMENT chooses per line in the pool (FR-P2P-001 AC2) */
  suggestedSupplierId: z.uuid().nullable().optional(),
  /** S6-10 (BR-PRC-06): why a catalogue item with an agreed price goes to another supplier */
  offAgreementReason: z.string().trim().max(REASON_MAX_LENGTH).optional(),
  /** Values an AI action filled in and the person confirmed (BR-AI-17 of S13 · assist-contract.ts) */
  aiAssist: AiAssistInput.optional(),
})

/** A delivery site and a suggested supplier must exist, the site active and the supplier ACTIVE (S4-02) */
async function checkSiteAndSupplier(tx: TenantTx, input: { deliverySiteId?: string | null; suggestedSupplierId?: string | null }) {
  if (input.deliverySiteId && !(await tx.deliverySite.count({ where: { id: input.deliverySiteId, active: true } }))) {
    return fail('VALIDATION_FAILED', 'unknown delivery site', { field: 'deliverySiteId', reason: 'UNKNOWN' })
  }
  if (input.suggestedSupplierId && !(await tx.supplier.count({ where: { id: input.suggestedSupplierId, status: 'ACTIVE' } }))) {
    return fail('VALIDATION_FAILED', 'unknown or inactive supplier', { field: 'suggestedSupplierId', reason: 'UNKNOWN' })
  }
  return null
}

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

/**
 * Writes the lines of a draft or a returned request. Each saved line keeps its id, and with it the budget it reserved
 * when the request was sent: a returned request keeps its reservation until it is sent again, when the resubmit moves
 * only the difference (§6.4, FR-INT-009 AC2). A line that is no longer there gives back what it reserved at once and
 * goes (docs/sub-specs/S3.md). Lines are matched by the ids the save names; a save that names no id matches them by
 * their order. Returns the id of every line, in the order given.
 */
async function writeLines(tx: TenantTx, ctx: Ctx, requestId: string, lines: readonly LineRow[], agreementIds: ReadonlyArray<string | null>): Promise<{ ok: true; events: EventDraft[]; lineIds: string[] } | { ok: false; error: AppError }> {
  const existing = await tx.requestLine.findMany({ where: { requestId }, orderBy: { lineNo: 'asc' }, select: { id: true, lineNo: true } })
  let targets: Array<string | null>
  if (lines.some((l) => l.id !== undefined)) {
    const known = new Set(existing.map((l) => l.id))
    const named = new Set<string>()
    for (const [i, line] of lines.entries()) {
      if (!line.id) continue
      if (!known.has(line.id) || named.has(line.id)) return fail('VALIDATION_FAILED', 'the line is not one of this request', { field: `lines.${i}.id`, reason: 'LINE_ID' })
      named.add(line.id)
    }
    targets = lines.map((l) => l.id ?? null)
  } else {
    targets = lines.map((_, i) => existing[i]?.id ?? null)
  }
  const kept = new Set(targets.filter((t): t is string => t !== null))
  const removed = existing.filter((l) => !kept.has(l.id))
  const released = await releaseForRequest(tx, ctx, requestId, removed.map((l) => l.id))
  if (!released.ok) return released
  if (removed.length) await tx.requestLine.deleteMany({ where: { id: { in: removed.map((l) => l.id) } } })
  // A kept line that changes its number steps aside first, so numbering them again never meets (request, lineNo) twice
  const moving = existing.filter((l) => kept.has(l.id) && targets.indexOf(l.id) + 1 !== l.lineNo)
  for (const [i, l] of moving.entries()) await tx.requestLine.update({ where: { id: l.id }, data: { lineNo: -(i + 1) } })
  const lineIds: string[] = []
  for (const [i, line] of lines.entries()) {
    const unitPriceSatang = amountToSatang(line.unitPrice)
    const data = {
      lineNo: i + 1,
      description: line.description,
      quantity: line.quantity,
      uom: line.uom,
      unitPriceSatang,
      // BR-MONEY-02 (1): a line amount is rounded once, here
      netSatang: lineNet(line.quantity, unitPriceSatang),
      vatable: line.vatable,
      categoryCode: line.categoryCode ?? null,
      serviceEndDate: line.serviceEndDate ? new Date(`${line.serviceEndDate}T00:00:00Z`) : null,
      catalogItemId: line.catalogItemId ?? null,
      priceAgreementId: agreementIds[i] ?? null,
    }
    const target = targets[i]
    if (target) {
      await tx.requestLine.update({ where: { id: target }, data })
      lineIds.push(target)
    } else {
      const id = newId()
      await tx.requestLine.create({ data: { id, organizationId: ctx.organizationId, requestId, ...data } })
      lineIds.push(id)
    }
  }
  return { ok: true, events: released.events, lineIds }
}

/**
 * BR-FORM-01 on every save of a draft: only the fields of the request's own form are kept, and the answers of fields
 * its conditions hide for the request as it is now (answers, amounts with today's VAT rate) are dropped. The submit
 * checks the visible ones in full.
 */
function answersToKeep(
  form: FormDefinition,
  answers: Readonly<Record<string, unknown>>,
  context: { readonly lines: ReadonlyArray<{ readonly quantity: string; readonly unitPriceSatang: bigint; readonly vatable: boolean }>; readonly priceIncludesVat: boolean; readonly rateBp: number | null; readonly requestTypeCode: string },
): { ok: true; fields: Record<string, unknown> } | { ok: false; field: string } {
  const ids = new Set(form.fields.map((f) => f.id))
  const unknown = Object.keys(answers).find((key) => !ids.has(key))
  if (unknown !== undefined) return { ok: false, field: unknown }
  const totals = context.rateBp === null ? { net: 0n, gross: 0n } : documentTotals(context.lines, context.rateBp, context.priceIncludesVat)
  const shown = evaluateForm({ visibility: form.visibility, rules: [] }, { fields: answers, attachments: {}, variables: { $amountGross: totals.gross, $amountNet: totals.net, $requestType: context.requestTypeCode } })
  return { ok: true, fields: shown.ok ? { ...shown.fields } : { ...answers } }
}

const unknownField = (field: string) => fail('VALIDATION_FAILED', 'the answer is not a field of this form', { field: `formData.${field}`, reason: 'FORM_FIELD_UNKNOWN' })

const catalogFacts = (lines: readonly LineRow[]) => lines.map((l) => ({ catalogItemId: l.catalogItemId ?? null, unitPriceSatang: amountToSatang(l.unitPrice) }))
const amountsOf = (lines: readonly LineRow[]) => lines.map((l) => ({ quantity: l.quantity, unitPriceSatang: amountToSatang(l.unitPrice), vatable: l.vatable }))

// ---------- draft ----------

export const createDraftCommand = defineCommand({
  name: 'request.create_draft',
  capability: 'request.create',
  input: DraftInput,
  async execute(tx, input, ctx): Promise<CommandOutcome<{ requestId: string; version: number; lineIds: string[] }>> {
    const allowed = await authorize(tx, ctx, 'request.create')
    if (!allowed.ok) return { ok: false, error: allowed.error }
    const requesterId = requesterOf(ctx)
    if (!requesterId) return { ok: false, error: { code: 'FORBIDDEN', message: 'only a member can request' } }
    // The catalog, the form and this command agree: an active type whose current form version is published (FR-INT-001)
    const type = await tx.requestType.findFirst({ where: { code: input.requestTypeCode, active: true }, include: { currentFormVersion: { select: { id: true, status: true, schema: true } } } })
    if (!type) return fail('VALIDATION_FAILED', 'unknown request type', { field: 'requestTypeCode' })
    const form = type.currentFormVersion
    if (!form || form.status !== 'PUBLISHED') return fail('VALIDATION_FAILED', 'the request type has no published form', { field: 'requestTypeCode', reason: 'NO_PUBLISHED_FORM' })
    const member = await tx.member.findUniqueOrThrow({ where: { id: requesterId }, select: { primaryDepartmentId: true } })
    if (!member.primaryDepartmentId) return fail('VALIDATION_FAILED', 'the requester has no main department', { field: 'chargedDepartmentId', reason: 'NO_DEPARTMENT' })
    const chargedDepartmentId = input.chargedDepartmentId ?? member.primaryDepartmentId
    if (!(await tx.department.findFirst({ where: { id: chargedDepartmentId, active: true }, select: { id: true } }))) {
      return fail('VALIDATION_FAILED', 'unknown department', { field: 'chargedDepartmentId' })
    }
    const place = await checkSiteAndSupplier(tx, input)
    if (place) return place
    const agreed = await checkCatalogLines(tx, ctx, { lines: catalogFacts(input.lines), supplierId: input.suggestedSupplierId ?? null, priceIncludesVat: input.priceIncludesVat, offAgreementReason: input.offAgreementReason ?? null, submit: false })
    if (!agreed.ok) return agreed
    // A new draft has no saved lines yet: a line naming an id belongs to another request
    const named = input.lines.findIndex((l) => l.id)
    if (named >= 0) return fail('VALIDATION_FAILED', 'the line is not one of this request', { field: `lines.${named}.id`, reason: 'LINE_ID' })
    const rateBp = await todaysRate(ctx)
    const answers = answersToKeep(formDefinition(form.schema), input.formData, { lines: amountsOf(input.lines), priceIncludesVat: input.priceIncludesVat, rateBp, requestTypeCode: type.code })
    if (!answers.ok) return unknownField(answers.field)
    const id = newId()
    await tx.request.create({
      data: {
        id,
        organizationId: ctx.organizationId,
        requestTypeId: type.id,
        formVersionId: form.id,
        documentType: type.documentType,
        title: input.title,
        requesterMemberId: requesterId,
        requesterDepartmentId: member.primaryDepartmentId,
        chargedDepartmentId,
        urgency: input.urgency,
        ...(input.neededBy ? { neededBy: new Date(`${input.neededBy}T00:00:00Z`) } : {}),
        priceIncludesVat: input.priceIncludesVat,
        formData: answers.fields as object,
        nonLowestQuoteReason: input.nonLowestQuoteReason || null,
        ...(input.budgetLineId ? { budgetLineId: input.budgetLineId } : {}),
        ...(input.deliverySiteId ? { deliverySiteId: input.deliverySiteId } : {}),
        ...(input.suggestedSupplierId ? { suggestedSupplierId: input.suggestedSupplierId } : {}),
        ...(input.offAgreementReason ? { offAgreementReason: input.offAgreementReason } : {}),
      },
    })
    const written = await writeLines(tx, ctx, id, input.lines, agreed.agreementIds)
    if (!written.ok) return written
    const quotes = await writeQuotations(tx, ctx, { id, requesterMemberId: requesterId }, input.quotations, rateBp)
    if (quotes) return quotes
    const ai = await aiAssisted(tx, ctx, id, input.aiAssist)
    if (!ai.ok) return ai
    return {
      ok: true,
      // A new request starts at version 0 (§6.1); every later save names the version it was based on and the lines' ids
      result: { requestId: id, version: 0, lineIds: written.lineIds },
      events: [
        { type: 'request.drafted', aggregateType: 'Request', aggregateId: id, data: { requestTypeCode: type.code, lines: input.lines.length, ...(input.aiAssist ? { agentActionId: input.aiAssist.agentActionId } : {}) } },
        ...ai.data,
      ],
    }
  },
})

export function createDraft(ctx: Ctx, input: z.input<typeof DraftInput>, options: RunOptions) {
  return runCommand(ctx, createDraftCommand, input, options)
}

// ---------- submit and resubmit ----------

const SubmitInput = z.strictObject({ requestId: z.uuid(), expectedVersion: ExpectedVersion.optional(), aiAssist: AiAssistInput.optional() })

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
  // BR-PRC-06 (S6-10): the agreed prices in effect today, the reason for another supplier, and each line's agreement
  const agreed = await checkCatalogLines(tx, ctx, { lines: request.lines, supplierId: request.suggestedSupplierId, priceIncludesVat: request.priceIncludesVat, offAgreementReason: request.offAgreementReason, submit: true })
  if (!agreed.ok) return agreed
  for (const [i, line] of request.lines.entries()) {
    if (line.priceAgreementId !== agreed.agreementIds[i]) await tx.requestLine.update({ where: { id: line.id }, data: { priceAgreementId: agreed.agreementIds[i] ?? null } })
  }
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
  // BR-BUD-02 to BR-BUD-04: the budget line, then all lines reserved before VAT against its total, or nothing at all.
  // The department that owns the budget pays, so its approvers decide (BR-DOA-05, FR-BUD-004 AC3)
  const budgetLine = await resolveBudgetLine(tx, ctx, request, taxDate)
  if (!budgetLine.ok) return budgetLine
  const nets = lineNetsBeforeVat(
    request.lines.map((l) => ({ quantity: l.quantity.toString(), unitPriceSatang: l.unitPriceSatang, vatable: l.vatable })),
    rate.rateBp,
    request.priceIncludesVat,
  )
  const reserved = await reserveForRequest(tx, ctx, request.id, budgetLine.line.id, request.lines.map((l, i) => ({ requestLineId: l.id, netSatang: nets[i]! })))
  if (!reserved.ok) return reserved
  const chargedDepartmentId = budgetLine.line.departmentId
  // BR-WF-06: the reviewers of the workflow version in effect read the request as it is sent (S6)
  const review = await requestReviewFacts(tx, {
    requestTypeCode: request.requestType.code,
    grossSatang: totals.gross,
    netSatang: totals.net,
    formData: checked.data,
    budgetLineId: budgetLine.line.id,
    lines: request.lines,
  })
  const route = await startRoute(
    tx,
    ctx,
    { type: 'REQUEST', id: request.id, label: request.number ?? request.title },
    {
      documentType: 'PURCHASE_REQUEST',
      amount: { netSatang: totals.net, vatSatang: totals.vat },
      requesterMemberId: request.requesterMemberId,
      chargedDepartmentId,
      conflictMemberIds: [request.requesterMemberId],
      at: ctx.now,
    },
    review,
  )
  if (!route.ok) return { ok: false as const, error: route.error }
  return { ok: true as const, totals, rateBp: rate.rateBp, taxDate, route: route.data, formData: checked.data, budget: reserved, budgetLineId: budgetLine.line.id, chargedDepartmentId }
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
    // The requester sends what they reviewed: a save from another device since then is refused (FR-INT-006 AC2)
    const conflict = versionConflict(input.expectedVersion, request.version)
    if (conflict) return conflict
    // BR-AI-17 (S13): nothing an AI action filled in may still wait for the person (AI_REVIEW_PENDING)
    const ai = await aiReviewed(tx, ctx, request.id, input.aiAssist)
    if (!ai.ok) return ai
    if (request.documentType === 'SUPPLIER_REQUEST') return withEvents(await submitSupplierRequest(tx, ctx, request), ai.data)
    const moved = move(request.status as RequestState, 'request.submit')
    if (!moved.ok) return moved
    // The number comes first so the approver's task names it; a refusal below rolls it back with everything else
    const department = await tx.department.findUniqueOrThrow({ where: { id: request.chargedDepartmentId }, select: { code: true } })
    const number = await issueDocumentNumber(tx, ctx, { document: 'PR', department: department.code })
    const prepared = await prepareRoute(tx, ctx, { ...request, number })
    if (!prepared.ok) return prepared
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
        budgetLineId: prepared.budgetLineId,
        chargedDepartmentId: prepared.chargedDepartmentId,
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
          // FR-BUD-003 AC3: the budget check of this submit, for the KPI of G-4
          budgetCheck: prepared.budget.check,
        },
      },
      ...prepared.budget.events,
      ...route.events,
      ...ai.data,
    ]
    return { ok: true, result: { number, routeId: route.routeId, assigneeMemberId: route.firstTask.assigneeMemberId }, events, notifications: route.notifications }
  },
})

/** The outcome with events added (the AI events of a submit that goes another way) */
function withEvents<R>(outcome: CommandOutcome<R>, events: readonly EventDraft[]): CommandOutcome<R> {
  return outcome.ok && events.length ? { ...outcome, events: [...outcome.events, ...events] } : outcome
}

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

/**
 * FR-DOA-003 AC3: a submit refused because the DOA names nobody who can approve is reported to ORG_ADMIN by a command
 * that outlives the rolled-back submit (doa-gap.ts). The refusal then says how many administrators were told
 * (details.adminsNotified), so the screen says they were only when it is true.
 */
async function withDoaGapReport<T>(ctx: Ctx, requestId: unknown, result: Result<T>, options: RunOptions): Promise<Result<T>> {
  if (result.ok) return result
  const notified = await reportDoaGap(ctx, requestId, result.error, options)
  if (notified === null) return result
  return { ok: false, error: { ...result.error, details: { ...result.error.details, adminsNotified: notified } } }
}

export async function submitRequest(ctx: Ctx, input: z.input<typeof SubmitInput>, options: RunOptions): Promise<Result<Jsonified<{ number: string; routeId: string; assigneeMemberId: string }>>> {
  return withDoaGapReport(ctx, input.requestId, await runCommand(ctx, submitCommand, input, options), options)
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
    const conflict = versionConflict(input.expectedVersion, request.version)
    if (conflict) return conflict
    // BR-AI-17 (S13): nothing an AI action filled in may still wait for the person (AI_REVIEW_PENDING)
    const ai = await aiReviewed(tx, ctx, request.id, input.aiAssist)
    if (!ai.ok) return ai
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
        budgetLineId: prepared.budgetLineId,
        chargedDepartmentId: prepared.chargedDepartmentId,
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
            budgetCheck: prepared.budget.check,
          },
        },
        ...prepared.budget.events,
        ...route.events,
        ...ai.data,
      ],
      notifications: route.notifications,
    }
  },
})

export async function resubmitRequest(ctx: Ctx, input: z.input<typeof SubmitInput>, options: RunOptions): Promise<Result<Jsonified<{ routeId: string; assigneeMemberId: string }>>> {
  return withDoaGapReport(ctx, input.requestId, await runCommand(ctx, resubmitCommand, input, options), options)
}

// ---------- edit a draft or a returned request ----------

/**
 * A save changes only what it names (FR-INT-006): a part left out stays as it was. So a save sent while a line or a
 * quotation is still being typed leaves the saved ones alone, a blank title never replaces the stored one, and fields the
 * form does not show (urgency, needed-by) keep their values. null clears what may be cleared.
 */
const EditInput = z.strictObject({
  requestId: z.uuid(),
  expectedVersion: ExpectedVersion.optional(),
  title: z.string().trim().min(1).max(200).optional(),
  chargedDepartmentId: z.uuid().optional(),
  urgency: z.enum(['NORMAL', 'URGENT']).optional(),
  neededBy: z.iso.date().nullable().optional(),
  priceIncludesVat: z.boolean().optional(),
  formData: DraftAnswers.optional(),
  lines: z.array(LineInput).max(MAX_LINES).optional(),
  budgetLineId: z.uuid().nullable().optional(),
  quotations: z.array(QuotationInput).max(MAX_QUOTATIONS).optional(),
  nonLowestQuoteReason: z.string().trim().max(REASON_MAX_LENGTH).nullable().optional(),
  /** null clears */
  deliverySiteId: z.uuid().nullable().optional(),
  suggestedSupplierId: z.uuid().nullable().optional(),
  /** S6-10 (BR-PRC-06): null clears */
  offAgreementReason: z.string().trim().max(REASON_MAX_LENGTH).nullable().optional(),
  /** Values an AI action filled in and the person confirmed (BR-AI-17 of S13 · assist-contract.ts) */
  aiAssist: AiAssistInput.optional(),
})

export const editCommand = defineCommand({
  name: 'request.edit',
  capability: 'request.create',
  input: EditInput,
  async execute(tx, input, ctx): Promise<CommandOutcome<{ requestId: string; version: number; lineIds: string[] }>> {
    const request = await lockedRequest(tx, ctx, input.requestId)
    if (!request) return fail('NOT_FOUND', 'request not found')
    const allowed = await authorize(tx, ctx, 'request.create', { ownerMemberIds: [request.requesterMemberId] })
    if (!allowed.ok) return { ok: false, error: allowed.error }
    // FR-INT-006 AC2: the same draft open on two devices — the save based on an older version gets CONFLICT_VERSION
    const conflict = versionConflict(input.expectedVersion, request.version)
    if (conflict) return conflict
    if (request.status !== 'DRAFT' && request.status !== 'RETURNED') return fail('INVALID_STATE_TRANSITION', 'only a draft or a returned request can be edited', { from: request.status })
    const place = await checkSiteAndSupplier(tx, input)
    if (place) return place
    const rateBp = await todaysRate(ctx)
    const form = formDefinition(request.formVersion.schema)
    const priceIncludesVat = input.priceIncludesVat ?? request.priceIncludesVat
    const supplierId = input.suggestedSupplierId !== undefined ? input.suggestedSupplierId : request.suggestedSupplierId
    const offAgreementReason = input.offAgreementReason !== undefined ? input.offAgreementReason : request.offAgreementReason
    const agreed = input.lines ? await checkCatalogLines(tx, ctx, { lines: catalogFacts(input.lines), supplierId, priceIncludesVat, offAgreementReason, submit: false }) : null
    if (agreed && !agreed.ok) return agreed
    const lines = input.lines ? amountsOf(input.lines) : request.lines.map((l) => ({ quantity: l.quantity.toString(), unitPriceSatang: l.unitPriceSatang, vatable: l.vatable }))
    // Answers sent now must be fields of the form; answers kept from an earlier save are only checked again
    const fieldIds = new Set(form.fields.map((f) => f.id))
    const stored = Object.fromEntries(Object.entries((request.formData ?? {}) as Record<string, unknown>).filter(([key]) => fieldIds.has(key)))
    const answers = answersToKeep(form, input.formData ?? stored, { lines, priceIncludesVat, rateBp, requestTypeCode: request.requestType.code })
    if (!answers.ok) return unknownField(answers.field)
    await tx.request.update({
      where: { id: request.id },
      data: {
        ...(input.title !== undefined ? { title: input.title } : {}),
        ...(input.chargedDepartmentId ? { chargedDepartmentId: input.chargedDepartmentId } : {}),
        ...(input.urgency !== undefined ? { urgency: input.urgency } : {}),
        ...(input.neededBy !== undefined ? { neededBy: input.neededBy ? new Date(`${input.neededBy}T00:00:00Z`) : null } : {}),
        priceIncludesVat,
        formData: answers.fields as object,
        ...(input.nonLowestQuoteReason !== undefined ? { nonLowestQuoteReason: input.nonLowestQuoteReason || null } : {}),
        ...(input.budgetLineId !== undefined ? { budgetLineId: input.budgetLineId } : {}),
        ...(input.deliverySiteId !== undefined ? { deliverySiteId: input.deliverySiteId } : {}),
        ...(input.suggestedSupplierId !== undefined ? { suggestedSupplierId: input.suggestedSupplierId } : {}),
        ...(input.offAgreementReason !== undefined ? { offAgreementReason: input.offAgreementReason || null } : {}),
        version: { increment: 1 },
      },
    })
    let lineIds = request.lines.map((l) => l.id)
    const events: EventDraft[] = []
    if (input.lines) {
      const written = await writeLines(tx, ctx, request.id, input.lines, agreed?.ok ? agreed.agreementIds : [])
      if (!written.ok) return written
      lineIds = written.lineIds
      events.push(...written.events)
    }
    if (input.quotations) {
      const quotes = await writeQuotations(tx, ctx, request, input.quotations, rateBp)
      if (quotes) return quotes
    }
    const ai = await aiAssisted(tx, ctx, request.id, input.aiAssist)
    if (!ai.ok) return ai
    return {
      ok: true,
      result: { requestId: request.id, version: request.version + 1, lineIds },
      events: [
        {
          type: 'request.drafted',
          aggregateType: 'Request',
          aggregateId: request.id,
          data: { requestTypeCode: request.requestType.code, lines: lineIds.length, ...(input.aiAssist ? { agentActionId: input.aiAssist.agentActionId } : {}) },
        },
        ...events,
        ...ai.data,
      ],
    }
  },
})

export function editRequest(ctx: Ctx, input: z.input<typeof EditInput>, options: RunOptions) {
  return runCommand(ctx, editCommand, input, options)
}

// ---------- cancel (§6.4, §2.4 request.cancel, FR-INT-009 AC1) ----------

const CancelInput = z.strictObject({ requestId: z.uuid(), reason: z.string().trim().max(REASON_MAX_LENGTH).optional() })
const MIN_CANCEL_REASON_LENGTH = 3

export const cancelCommand = defineCommand({
  name: 'request.cancel',
  capability: 'request.cancel',
  input: CancelInput,
  async execute(tx, input, ctx): Promise<CommandOutcome<{ requestId: string }>> {
    const request = await lockedRequest(tx, ctx, input.requestId)
    if (!request) return fail('NOT_FOUND', 'request not found')
    // §2.4: the requester before any PO (NO_PO_YET); PROCUREMENT for an APPROVED request not yet ordered, with a reason
    const grants = matchingGrants(await loadPrincipal(tx, ctx), 'request.cancel', { ownerMemberIds: [request.requesterMemberId] })
    const asOwner = grants.some((g) => g.condition === 'NO_PO_YET')
    const asProcurement = grants.some((g) => g.condition === 'APPROVED_NOT_ORDERED_WITH_REASON')
    if (!asOwner && !(asProcurement && request.status === 'APPROVED')) return { ok: false, error: { code: 'FORBIDDEN', message: 'missing capability request.cancel', details: { capability: 'request.cancel' } } }
    if (!asOwner && (input.reason ?? '').length < MIN_CANCEL_REASON_LENGTH) return fail('VALIDATION_FAILED', 'a reason is needed', { field: 'reason' })
    // A new-supplier request has its own states (§6.4)
    const transitioned =
      request.documentType === 'SUPPLIER_REQUEST'
        ? transition(SUPPLIER_REQUEST_MACHINE, request.status as SupplierRequestState, 'request.cancel')
        : transition(REQUEST_MACHINE, request.status as RequestState, 'request.cancel')
    if (!transitioned.ok) return fail('INVALID_STATE_TRANSITION', `request.cancel is not allowed from ${request.status}`, { from: request.status, command: 'request.cancel' })
    const moved = { ok: true as const, to: transitioned.to }
    if (request.status === 'APPROVED' && (await tx.poLineSource.count({ where: { requestLine: { requestId: request.id }, poLine: { po: { status: { notIn: ['REJECTED', 'CANCELLED'] } } } } }))) {
      return fail('INVALID_STATE_TRANSITION', 'a line of the request is on a purchase order', { from: request.status, command: 'request.cancel', reason: 'ON_PO' })
    }
    const closed = await closeRoute(tx, { type: 'REQUEST', id: request.id }, 'CANCELLED', 'REQUEST_CANCELLED')
    // FR-INT-009 AC1: the budget the request reserved goes back at once (§6.4)
    const released = await releaseForRequest(tx, ctx, request.id, request.lines.map((l) => l.id))
    if (!released.ok) return released
    let reasonCommentId: string | null = null
    if (input.reason) {
      reasonCommentId = newId()
      await tx.comment.create({ data: { id: reasonCommentId, organizationId: ctx.organizationId, subjectType: 'Request', subjectId: request.id, authorMemberId: requesterOf(ctx), body: input.reason } })
    }
    await tx.request.update({ where: { id: request.id }, data: { status: moved.to, cancelledAt: ctx.now, cancelReason: input.reason ?? null, version: { increment: 1 } } })
    return {
      ok: true,
      result: { requestId: request.id },
      events: [...closed, { type: 'request.cancelled', aggregateType: 'Request', aggregateId: request.id, data: { from: request.status, reasonCommentId } }, ...released.events],
    }
  },
})

export function cancelRequest(ctx: Ctx, input: z.input<typeof CancelInput>, options: RunOptions) {
  return runCommand(ctx, cancelCommand, input, options)
}
