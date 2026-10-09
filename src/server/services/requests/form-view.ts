import type { AttachmentRule, Condition, VisibilityRule } from '@/core/forms'
import type { FieldDef } from '@/core/forms/fields'
import { satangToAmount, toMoneyDto, type MoneyDto } from '@/core/money/dto'
import { err, ok, type Result } from '@/core/result'
import { rateFor, taxDateOf } from '@/core/vat'
import { authorize, isAllowed, type Principal } from '@/server/authz'
import type { Ctx } from '@/server/context'
import { listTaxRates } from '@/server/db/lookups'
import { forTenant, type TenantTx } from '@/server/db/tenant'
import { formDefinition, type FormStep } from '@/server/forms/schema'
import {
  defaultBudgetLineId,
  defaultDeliverySiteId,
  listFormBudgetLines,
  listFormDeliverySites,
  listFormSuppliers,
  type FormBudgetLineDto,
  type FormDeliverySiteDto,
  type FormSupplierDto,
  type ScreenLocale,
} from '@/server/queries/request-form'
import { attachableKinds, type FileLinkKind } from './attachments'

// What the request form shows (S2-11, spec §7.9, FR-INT-002, FR-INT-003, BR-FORM-02): the form of the request type as
// data — fields with their Thai and English labels, conditions and attachment rules — the context it is filled from, and
// for an existing draft or returned request everything saved so far. Read only. Only the requester opens their own
// request for editing (request.create OWN); the services check every save and the submit again.

export interface RequestFormDefinitionDto {
  readonly fields: readonly FieldDef[]
  readonly visibility: readonly VisibilityRule[]
  readonly rules: readonly AttachmentRule[]
  /** serviceEndDate.when: lines must carry the day the service ends while it holds (BR-FORM-05) */
  readonly lines: { readonly serviceEndDate?: { readonly when: Condition } }
  /** The form's own steps, when it has them (FR-INT-011 AC2) */
  readonly steps?: readonly FormStep[]
}

export interface DraftLineDto {
  /** The line's id: every save names it, so the line keeps its content and its budget (FR-INT-006, §6.4) */
  readonly id: string
  /** What the line holds on the budget line while the request is RETURNED (§6.4: a return keeps the reservation) */
  readonly reserved: MoneyDto | null
  readonly description: string
  readonly quantity: string
  readonly uom: string
  /** Baht with two decimals, as typed in the form */
  readonly unitPrice: string
  readonly vatable: boolean
  /** YYYY-MM-DD */
  readonly serviceEndDate: string | null
}

export interface DraftQuotationDto {
  readonly supplierName: string
  readonly amount: string
  readonly includesVat: boolean
  readonly fileId: string | null
  readonly fileName: string | null
  readonly selected: boolean
}

export interface AttachmentDto {
  readonly fileId: string
  readonly fileName: string
  readonly kind: FileLinkKind
}

export interface RequestDraftDto {
  readonly requestId: string
  /** Request.version: every save names it (FR-INT-006 AC2) */
  readonly version: number
  readonly status: 'DRAFT' | 'RETURNED'
  readonly title: string
  readonly budgetLineId: string | null
  readonly priceIncludesVat: boolean
  readonly formData: Readonly<Record<string, unknown>>
  readonly lines: readonly DraftLineDto[]
  readonly quotations: readonly DraftQuotationDto[]
  readonly nonLowestQuoteReason: string
  /** Files attached one by one (not the files of quotations) */
  readonly attachments: readonly AttachmentDto[]
  /** Why the approver returned it, for a RETURNED request */
  readonly returnReason: string | null
  /** Where the goods go (S4-02, BR-CONS-01); null: not chosen yet */
  readonly deliverySiteId: string | null
  /** The supplier the requester suggests (FR-P2P-001 AC2) */
  readonly suggestedSupplierId: string | null
}

export interface RequestFormDto {
  readonly type: { readonly code: string; readonly name: string; readonly description: string | null; readonly documentType: 'PURCHASE_REQUEST' | 'SUPPLIER_REQUEST' }
  readonly form: RequestFormDefinitionDto
  readonly requesterDepartmentName: string | null
  readonly budgetLines: readonly FormBudgetLineDto[]
  /** BR-FORM-02: the line the form starts with */
  readonly defaultBudgetLineId: string | null
  /** VAT rate of today for the totals the form shows as the requester types; submit computes them again (BR-VAT-01) */
  readonly vatRateBp: number | null
  /** Kinds the requester may attach one by one (not QUOTATION: quotation files come with their quotation) */
  readonly attachmentKinds: readonly FileLinkKind[]
  /** A purchase request's delivery sites (the active ones) and the one the form starts with (BR-FORM-02) */
  readonly deliverySites: readonly FormDeliverySiteDto[]
  readonly defaultDeliverySiteId: string | null
  /** Active suppliers of the register a requester may suggest, basic details only (§2.4 supplier.view) */
  readonly suppliers: readonly FormSupplierDto[]
  readonly draft: RequestDraftDto | null
}

const day = (d: Date) => d.toISOString().slice(0, 10)

async function todaysRate(ctx: Ctx): Promise<number | null> {
  const rate = rateFor(taxDateOf(ctx.now), await listTaxRates())
  return rate.ok ? rate.rateBp : null
}

function definitionOf(schema: unknown): RequestFormDefinitionDto {
  const form = formDefinition(schema)
  return { fields: form.fields, visibility: form.visibility, rules: form.rules, lines: form.lines, ...(form.steps ? { steps: form.steps } : {}) }
}

async function departmentName(tx: TenantTx, memberId: string, locale: ScreenLocale): Promise<string | null> {
  const member = await tx.member.findUnique({ where: { id: memberId }, select: { primaryDepartment: { select: { nameTh: true, nameEn: true } } } })
  const d = member?.primaryDepartment
  return d ? ((locale === 'en' ? d.nameEn : null) ?? d.nameTh) : null
}

/**
 * The context every form of a type is filled from (BR-FORM-02): budget lines, the default one, today's VAT rate, the
 * delivery sites with the one the requester used last, and the suppliers they may suggest. A requester without a usable
 * line is told to ask the budget administrators by their role, not by name: whose names a requester may see is a
 * personal-data decision the spec leaves open (unit a's needs). Supplier names are read only when the reader holds
 * supplier.view (§2.4: every member, basic details).
 * TODO(S10): BR-FORM-02 also prefills the category's preferred supplier (PreferredSupplier, S10) and then the latest
 * supplier of the same category; tier-1 forms have no category, so the suggested supplier starts empty.
 */
async function formContext(ctx: Ctx, principal: Principal, type: { code: string; documentType: 'PURCHASE_REQUEST' | 'SUPPLIER_REQUEST' }, locale: ScreenLocale) {
  if (type.documentType === 'SUPPLIER_REQUEST') return { budgetLines: [], defaultBudgetLineId: null, vatRateBp: null, deliverySites: [], defaultDeliverySiteId: null, suppliers: [] }
  const [budgetLines, deliverySites, suppliers] = await Promise.all([
    listFormBudgetLines(ctx, taxDateOf(ctx.now), locale),
    listFormDeliverySites(ctx),
    isAllowed(principal, 'supplier.view') ? listFormSuppliers(ctx, locale) : Promise.resolve([]),
  ])
  return {
    budgetLines,
    defaultBudgetLineId: await defaultBudgetLineId(ctx, type.code, budgetLines),
    vatRateBp: await todaysRate(ctx),
    deliverySites,
    defaultDeliverySiteId: await defaultDeliverySiteId(ctx, deliverySites),
    suppliers,
  }
}

/** The form for a new request of one type (FR-INT-002, FR-INT-003): NOT_FOUND for a type that is off or has no form */
export async function getNewRequestForm(ctx: Ctx, typeCode: string, locale: ScreenLocale): Promise<Result<RequestFormDto>> {
  const loaded = await forTenant(ctx.organizationId).$transaction(async (tx) => {
    const allowed = await authorize(tx, ctx, 'request.create')
    if (!allowed.ok || allowed.data.kind !== 'member') return { kind: 'forbidden' as const }
    const type = await tx.requestType.findFirst({ where: { code: typeCode, active: true }, include: { currentFormVersion: { select: { schema: true, status: true } } } })
    if (!type?.currentFormVersion || type.currentFormVersion.status !== 'PUBLISHED') return { kind: 'missing' as const }
    return { kind: 'ok' as const, type, principal: allowed.data, requesterDepartmentName: await departmentName(tx, allowed.data.memberId, locale) }
  })
  if (loaded.kind === 'forbidden') return err('FORBIDDEN', 'members only')
  if (loaded.kind === 'missing') return err('NOT_FOUND', 'unknown request type')
  const { type } = loaded
  const form = definitionOf(type.currentFormVersion!.schema)
  return ok({
    type: { code: type.code, name: (locale === 'en' ? type.nameEn : null) ?? type.nameTh, description: type.descriptionTh, documentType: type.documentType },
    form,
    requesterDepartmentName: loaded.requesterDepartmentName,
    ...(await formContext(ctx, loaded.principal, type, locale)),
    attachmentKinds: attachableKinds(form.rules),
    draft: null,
  })
}

/**
 * A draft or a returned request, for its requester to go on with (FR-INT-006: on any device). It keeps the form
 * version it was created with (§6.2). FORBIDDEN for anyone else; INVALID_STATE_TRANSITION (with the status) once it
 * was sent.
 */
export async function getRequestForEdit(ctx: Ctx, requestId: string, locale: ScreenLocale): Promise<Result<RequestFormDto>> {
  const loaded = await forTenant(ctx.organizationId).$transaction(async (tx) => {
    const request = await tx.request.findFirst({
      where: { id: requestId },
      include: { lines: { orderBy: { lineNo: 'asc' } }, quotations: { orderBy: { createdAt: 'asc' } }, formVersion: { select: { schema: true } }, requestType: true },
    })
    if (!request) return { kind: 'missing' as const }
    const allowed = await authorize(tx, ctx, 'request.create', { ownerMemberIds: [request.requesterMemberId] })
    if (!allowed.ok) return { kind: 'forbidden' as const }
    if (request.status !== 'DRAFT' && request.status !== 'RETURNED') return { kind: 'sent' as const, status: request.status }
    const links = await tx.fileLink.findMany({ where: { subjectType: 'Request', subjectId: request.id }, select: { fileId: true, kind: true }, orderBy: { createdAt: 'asc' } })
    const fileIds = [...new Set([...links.map((l) => l.fileId), ...request.quotations.flatMap((q) => (q.fileId ? [q.fileId] : []))])]
    const files = fileIds.length ? await tx.fileObject.findMany({ where: { id: { in: fileIds } }, select: { id: true, fileName: true } }) : []
    const nameOf = new Map(files.map((f) => [f.id, f.fileName]))
    let returnReason: string | null = null
    const reserved = new Map<string, bigint>()
    if (request.status === 'RETURNED') {
      const returned = await tx.event.findFirst({ where: { aggregateType: 'Request', aggregateId: request.id, type: 'request.returned' }, orderBy: { seq: 'desc' }, select: { data: true } })
      const commentId = (returned?.data as { reasonCommentId?: unknown } | null)?.reasonCommentId
      if (typeof commentId === 'string') returnReason = (await tx.comment.findFirst({ where: { id: commentId }, select: { body: true } }))?.body ?? null
      // §6.4: a returned request keeps what its lines reserved; the requester sees it before taking a line away
      const held = await tx.budgetAllocation.findMany({ where: { sourceType: 'REQUEST_LINE', sourceId: { in: request.lines.map((l) => l.id) }, reservedSatang: { gt: 0n } }, select: { sourceId: true, reservedSatang: true } })
      for (const h of held) reserved.set(h.sourceId, (reserved.get(h.sourceId) ?? 0n) + h.reservedSatang)
    }
    return { kind: 'ok' as const, request, links, nameOf, returnReason, reserved, principal: allowed.data, requesterDepartmentName: await departmentName(tx, request.requesterMemberId, locale) }
  })
  if (loaded.kind === 'missing') return err('NOT_FOUND', 'request not found')
  if (loaded.kind === 'forbidden') return err('FORBIDDEN', 'only the requester edits a request')
  if (loaded.kind === 'sent') return err('INVALID_STATE_TRANSITION', 'the request was sent already', { status: loaded.status })
  const { request, links, nameOf, reserved } = loaded
  const type = request.requestType
  const form = definitionOf(request.formVersion.schema)
  return ok({
    type: { code: type.code, name: (locale === 'en' ? type.nameEn : null) ?? type.nameTh, description: type.descriptionTh, documentType: type.documentType },
    form,
    requesterDepartmentName: loaded.requesterDepartmentName,
    ...(await formContext(ctx, loaded.principal, type, locale)),
    attachmentKinds: attachableKinds(form.rules),
    draft: {
      requestId: request.id,
      version: request.version,
      status: request.status as 'DRAFT' | 'RETURNED',
      title: request.title,
      budgetLineId: request.budgetLineId,
      priceIncludesVat: request.priceIncludesVat,
      formData: (request.formData ?? {}) as Record<string, unknown>,
      lines: request.lines.map((l) => ({
        id: l.id,
        reserved: reserved.has(l.id) ? toMoneyDto(reserved.get(l.id)!) : null,
        description: l.description,
        quantity: l.quantity.toString(),
        uom: l.uom,
        unitPrice: satangToAmount(l.unitPriceSatang),
        vatable: l.vatable,
        serviceEndDate: l.serviceEndDate ? day(l.serviceEndDate) : null,
      })),
      quotations: request.quotations.map((q) => ({
        supplierName: q.supplierName,
        amount: satangToAmount(q.amountSatang),
        includesVat: q.includesVat,
        fileId: q.fileId,
        fileName: q.fileId ? (nameOf.get(q.fileId) ?? null) : null,
        selected: q.isSelected,
      })),
      nonLowestQuoteReason: request.nonLowestQuoteReason ?? '',
      attachments: links.filter((l) => l.kind !== 'QUOTATION').map((l) => ({ fileId: l.fileId, fileName: nameOf.get(l.fileId) ?? '', kind: l.kind as FileLinkKind })),
      returnReason: loaded.returnReason,
      deliverySiteId: request.deliverySiteId,
      suggestedSupplierId: request.suggestedSupplierId,
    },
  })
}
