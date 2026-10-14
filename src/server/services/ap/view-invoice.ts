import { err, ok, type Result } from '@/core/result'
import { isAllowed, loadPrincipal } from '@/server/authz'
import type { Ctx } from '@/server/context'
import { forTenant } from '@/server/db/tenant'
import { isUuid } from '@/server/queries/requests'
import { requireModule } from '../modules'
import { suggestionsFor } from './coding'
import { invoiceScopes, mayReadInvoice as mayRead, resolvesInvoice } from './file-policy'

// What the screens of one tier-2 invoice read (S8-13, docs/sub-specs/S8.md "หน้าจอ", FR-AP-101 AC5, FR-AP-102,
// FR-AP-103, FR-AP-105 AC2, FR-AP-108): the page /finance/invoices/[id] — its header with where each value came from
// (BR-AP-03 labels), its lines with the match result, the coding of each line with the suggestion and its source
// (BR-AP-10), the amounts, the differences still open with the role each is sent to (BR-MATCH-09), its file and its
// events — and PROCUREMENT's list of invoices whose differences are theirs to settle (/procurement/invoice-exceptions).
// invoice.view is not a capability of its own yet: FINANCE (invoice.record), the members who may reject an invoice
// (invoice.reject) and the members of the roles its open differences are sent to (invoice.exception.resolve) read it.
// Module PAY must be on (BR-AP-13). What each member may do is worked out here for the buttons only; every command
// checks again (BR-AUTH-05). Reads only.

type Role = 'PROCUREMENT' | 'RECEIVER' | 'FINANCE'
type FieldSource = 'AI_READING' | 'ETAX_XML'

/** The invoice's own rule of who reads it (above), from its open differences' roles */
export interface ApInvoiceLineDto {
  readonly id: string
  readonly lineNo: number
  readonly poLineId: string
  readonly poLineNo: number
  readonly description: string
  readonly quantity: string
  readonly uom: string
  readonly unitPriceSatang: bigint
  readonly poUnitPriceSatang: bigint
  readonly amountSatang: bigint
  readonly netSatang: bigint
  /** The line's amount at the PO price (BR-MATCH-06), and what is over it; 0 until a match ran */
  readonly expectedNetSatang: bigint
  readonly overSatang: bigint
  readonly matchStatus: 'PENDING' | 'MATCHED' | 'EXCEPTION'
  readonly flags: readonly string[]
  readonly accountCode: string | null
  readonly costCenterId: string | null
  readonly costCenterReason: string | null
  readonly codingSource: 'HISTORY' | 'BUDGET_LINE' | 'MANUAL' | 'NONE'
  readonly codingConfirmed: boolean
  readonly whtIncomeTypeCode: string | null
  /** The budget line's cost center: another one needs a reason (BR-AP-10) */
  readonly budgetCostCenterId: string
  /** BR-AP-10: what the history or the budget line offers (a draft read by FINANCE only) */
  readonly suggestion: { readonly accountCode: string | null; readonly source: 'HISTORY' | 'BUDGET_LINE' | 'NONE'; readonly count: number } | null
}

export interface ApInvoiceExceptionDto {
  readonly id: string
  readonly type: string
  readonly amountSatang: bigint
  readonly quantity: string | null
  readonly lineNo: number | null
  readonly assigneeRole: Role
  readonly status: 'OPEN' | 'ACCEPT_REQUESTED'
}

export interface ApInvoiceEventDto {
  readonly id: string
  readonly type: string
  readonly occurredAt: Date
  readonly actor: { readonly th: string; readonly en: string | null } | null
  readonly system: boolean
  readonly reason: string | null
}

export interface ApInvoicePageDto {
  readonly id: string
  readonly number: string | null
  readonly status: string
  readonly version: number
  readonly channel: string
  readonly prefill: string
  readonly supplierInvoiceNo: string | null
  readonly invoiceDate: string | null
  readonly priceIncludesVat: boolean
  readonly isFinal: boolean
  readonly vatRateBp: number | null
  readonly discountSatang: bigint
  readonly netSatang: bigint
  readonly statedVatSatang: bigint
  readonly grossSatang: bigint
  readonly retentionSatang: bigint
  readonly payableSatang: bigint
  readonly expectedWhtSatang: bigint
  readonly dueDate: string | null
  readonly rejectReason: string | null
  readonly cancelReason: string | null
  /** Where a header value came from, for its label (BR-AP-03): only AI_READING and ETAX_XML are named */
  readonly fieldSources: Readonly<Record<string, FieldSource>>
  readonly po: { readonly id: string; readonly number: string | null }
  readonly supplier: { readonly id: string; readonly code: string; readonly nameTh: string; readonly nameEn: string | null }
  readonly file: { readonly id: string; readonly fileName: string } | null
  readonly lines: readonly ApInvoiceLineDto[]
  readonly exceptions: readonly ApInvoiceExceptionDto[]
  /** The choices of the coding (a draft read by FINANCE only; empty otherwise) */
  readonly options: {
    readonly accountCodes: ReadonlyArray<{ readonly code: string; readonly nameTh: string }>
    readonly costCenters: ReadonlyArray<{ readonly id: string; readonly code: string; readonly nameTh: string }>
    readonly incomeTypes: ReadonlyArray<{ readonly code: string; readonly nameTh: string; readonly nameEn: string | null; readonly rateBp: number; readonly confirmed: boolean }>
  }
  readonly events: readonly ApInvoiceEventDto[]
  /** What the member may do now (the buttons; every command checks again) */
  readonly may: {
    readonly edit: boolean
    readonly submit: boolean
    readonly cancel: boolean
    readonly recheck: boolean
    readonly variance: boolean
    readonly dismiss: boolean
    readonly reopen: boolean
    readonly reject: boolean
  }
}

const FIELD_SOURCES = new Set<string>(['AI_READING', 'ETAX_XML'])

function sourcesOf(value: unknown): Record<string, FieldSource> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).filter((e): e is [string, FieldSource] => typeof e[1] === 'string' && FIELD_SOURCES.has(e[1])))
}

const reasonOf = (data: unknown): string | null => {
  const r = data && typeof data === 'object' ? (data as Record<string, unknown>).reason : undefined
  return typeof r === 'string' && r ? r : null
}

/**
 * The page of one tier-2 invoice: NOT_FOUND when the id is not an invoice of the organization (the route then shows the
 * PO of that id, src/app/(workspace)/finance/invoices/[poId]/page.tsx), FORBIDDEN for a member who does not read it,
 * MODULE_DISABLED with PAY off.
 */
export async function getApInvoicePage(ctx: Ctx, invoiceId: string): Promise<Result<ApInvoicePageDto>> {
  if (!isUuid(invoiceId)) return err('NOT_FOUND', 'invoice not found')
  return forTenant(ctx.organizationId).$transaction(async (tx): Promise<Result<ApInvoicePageDto>> => {
    const invoice = await tx.invoice.findFirst({
      where: { id: invoiceId },
      include: {
        po: { select: { id: true, number: true } },
        supplier: { select: { id: true, code: true, nameTh: true, nameEn: true } },
        sourceFile: { select: { id: true, fileName: true, status: true } },
        lines: {
          orderBy: { lineNo: 'asc' },
          include: { poLine: { select: { lineNo: true, unitPriceSatang: true, budgetLine: { select: { costCenterId: true } } } } },
        },
        exceptions: {
          where: { status: { in: ['OPEN', 'ACCEPT_REQUESTED'] } },
          orderBy: { createdAt: 'asc' },
          select: { id: true, type: true, amountSatang: true, quantity: true, assigneeRole: true, status: true, invoiceLine: { select: { lineNo: true } } },
        },
      },
    })
    if (!invoice) return err('NOT_FOUND', 'invoice not found')
    const principal = await loadPrincipal(tx, ctx)
    const openRoles: ReadonlySet<string> = new Set(invoice.exceptions.filter((e) => e.status === 'OPEN').map((e) => e.assigneeRole))
    const scopes = await invoiceScopes(tx, invoice.po.id)
    if (!mayRead(principal, openRoles, scopes)) return err('FORBIDDEN', 'you do not read this invoice', { capability: 'invoice.record' })
    const pay = await requireModule(ctx, 'PAY', tx)
    if (!pay.ok) return pay

    const record = isAllowed(principal, 'invoice.record')
    const draft = invoice.status === 'DRAFT'
    const exception = invoice.status === 'EXCEPTION'
    const open = invoice.exceptions.filter((e) => e.status === 'OPEN')
    const resolves = resolvesInvoice(principal, openRoles, scopes)
    const coding = draft && record
    // One query after another: a transaction runs on one connection
    const suggestions = coding ? await suggestionsFor(tx, invoice.id, ctx.now) : []
    const accountCodes = coding ? await tx.accountCode.findMany({ where: { active: true }, orderBy: { code: 'asc' }, select: { code: true, nameTh: true } }) : []
    const costCenters = coding ? await tx.costCenter.findMany({ where: { active: true }, orderBy: { code: 'asc' }, select: { id: true, code: true, nameTh: true } }) : []
    const incomeTypes = coding ? await tx.whtIncomeType.findMany({ where: { active: true }, orderBy: { code: 'asc' }, select: { code: true, nameTh: true, nameEn: true, rateBp: true, confirmedAt: true } }) : []

    const events = await tx.event.findMany({
      where: { aggregateType: 'Invoice', aggregateId: invoice.id },
      orderBy: { seq: 'asc' },
      select: { id: true, type: true, occurredAt: true, actorType: true, actorMemberId: true, data: true },
    })
    const actorIds = [...new Set(events.map((e) => e.actorMemberId).filter((m): m is string => !!m))]
    const actors = actorIds.length ? await tx.member.findMany({ where: { id: { in: actorIds } }, select: { id: true, displayNameTh: true, displayNameEn: true } }) : []

    return ok({
      id: invoice.id,
      number: invoice.number,
      status: invoice.status,
      version: invoice.version,
      channel: invoice.channel,
      prefill: invoice.prefill,
      supplierInvoiceNo: invoice.supplierInvoiceNo,
      invoiceDate: invoice.invoiceDate?.toISOString().slice(0, 10) ?? null,
      priceIncludesVat: invoice.priceIncludesVat,
      isFinal: invoice.isFinal,
      vatRateBp: invoice.vatRateBp,
      discountSatang: invoice.discountSatang,
      netSatang: invoice.netSatang,
      statedVatSatang: invoice.statedVatSatang,
      grossSatang: invoice.grossSatang,
      retentionSatang: invoice.retentionSatang,
      payableSatang: invoice.payableSatang,
      expectedWhtSatang: invoice.expectedWhtSatang,
      dueDate: invoice.dueDate?.toISOString().slice(0, 10) ?? null,
      rejectReason: invoice.rejectReason,
      cancelReason: invoice.cancelReason,
      fieldSources: sourcesOf(invoice.fieldSources),
      po: invoice.po,
      supplier: invoice.supplier,
      file: invoice.sourceFile && invoice.sourceFile.status === 'AVAILABLE' ? { id: invoice.sourceFile.id, fileName: invoice.sourceFile.fileName } : null,
      lines: invoice.lines.map((l) => {
        const s = suggestions.find((x) => x.invoiceLineId === l.id)
        return {
          id: l.id,
          lineNo: l.lineNo,
          poLineId: l.poLineId,
          poLineNo: l.poLine.lineNo,
          description: l.description,
          quantity: l.quantity.toString(),
          uom: l.uom,
          unitPriceSatang: l.unitPriceSatang,
          poUnitPriceSatang: l.poLine.unitPriceSatang,
          amountSatang: l.amountSatang,
          netSatang: l.netSatang,
          expectedNetSatang: l.expectedNetSatang,
          overSatang: l.overSatang,
          matchStatus: l.matchStatus,
          flags: l.flags,
          accountCode: l.accountCode,
          costCenterId: l.costCenterId,
          costCenterReason: l.costCenterReason,
          codingSource: l.codingSource,
          codingConfirmed: !!l.codingConfirmedAt,
          whtIncomeTypeCode: l.whtIncomeTypeCode,
          budgetCostCenterId: l.poLine.budgetLine.costCenterId,
          suggestion: s ? { accountCode: s.accountCode, source: s.source, count: s.count } : null,
        }
      }),
      exceptions: invoice.exceptions.map((e) => ({
        id: e.id,
        type: e.type,
        amountSatang: e.amountSatang,
        quantity: e.quantity?.toString() ?? null,
        lineNo: e.invoiceLine?.lineNo ?? null,
        assigneeRole: e.assigneeRole,
        status: e.status as 'OPEN' | 'ACCEPT_REQUESTED',
      })),
      options: {
        accountCodes,
        costCenters,
        incomeTypes: incomeTypes.map((t) => ({ code: t.code, nameTh: t.nameTh, nameEn: t.nameEn, rateBp: t.rateBp, confirmed: !!t.confirmedAt })),
      },
      events: events.map((e) => {
        const a = e.actorMemberId ? actors.find((m) => m.id === e.actorMemberId) : undefined
        return { id: e.id, type: e.type, occurredAt: e.occurredAt, actor: a ? { th: a.displayNameTh, en: a.displayNameEn } : null, system: e.actorType === 'SYSTEM', reason: reasonOf(e.data) }
      }),
      may: {
        edit: coding,
        submit: coding,
        cancel: coding,
        recheck: exception && (record || resolves),
        // BR-MATCH-10: a variance is asked for only when every open difference is a price over
        variance: exception && isAllowed(principal, 'invoice.variance.request') && open.length > 0 && open.every((e) => e.type === 'PRICE_OVER'),
        dismiss: exception && record && open.some((e) => e.type === 'POSSIBLE_DUPLICATE'),
        reopen: exception && record,
        reject: exception && isAllowed(principal, 'invoice.reject'),
      },
    })
  })
}

// ---------- /procurement/invoice-exceptions ----------

/** The differences PROCUREMENT settles (BR-MATCH-09): a price over the PO's, a quantity over what was ordered */
const PROCUREMENT_TYPES = ['PRICE_OVER', 'QTY_OVER_ORDERED'] as const

export interface VarianceRowDto {
  readonly invoiceId: string
  readonly number: string | null
  readonly supplierInvoiceNo: string | null
  readonly version: number
  readonly po: { readonly id: string; readonly number: string | null }
  readonly supplier: { readonly code: string; readonly nameTh: string; readonly nameEn: string | null }
  readonly grossSatang: bigint
  /** The open PRICE_OVER and QTY_OVER_ORDERED amounts together */
  readonly overSatang: bigint
  readonly types: readonly string[]
  /** Every open difference is a price over: a variance can be asked for (BR-MATCH-10) */
  readonly canRequest: boolean
}

/** Whether the member may open /procurement/invoice-exceptions (invoice.variance.request, PAY on): a link, not the guard */
export async function mayListVarianceExceptions(ctx: Ctx): Promise<boolean> {
  return forTenant(ctx.organizationId).$transaction(async (tx) => {
    const principal = await loadPrincipal(tx, ctx)
    if (principal.kind !== 'member' || !isAllowed(principal, 'invoice.variance.request')) return false
    return (await requireModule(ctx, 'PAY', tx)).ok
  })
}

/** Invoices in EXCEPTION with an open price or quantity over (invoice.variance.request, PAY on) */
export async function listVarianceExceptions(ctx: Ctx): Promise<Result<readonly VarianceRowDto[]>> {
  return forTenant(ctx.organizationId).$transaction(async (tx): Promise<Result<readonly VarianceRowDto[]>> => {
    const principal = await loadPrincipal(tx, ctx)
    if (principal.kind !== 'member' || !isAllowed(principal, 'invoice.variance.request')) return err('FORBIDDEN', 'missing capability invoice.variance.request', { capability: 'invoice.variance.request' })
    const pay = await requireModule(ctx, 'PAY', tx)
    if (!pay.ok) return pay
    const invoices = await tx.invoice.findMany({
      where: { status: 'EXCEPTION', exceptions: { some: { status: 'OPEN', type: { in: [...PROCUREMENT_TYPES] } } } },
      orderBy: [{ submittedAt: 'asc' }, { id: 'asc' }],
      take: 200,
      select: {
        id: true,
        number: true,
        supplierInvoiceNo: true,
        version: true,
        grossSatang: true,
        po: { select: { id: true, number: true } },
        supplier: { select: { code: true, nameTh: true, nameEn: true } },
        exceptions: { where: { status: 'OPEN' }, select: { type: true, amountSatang: true } },
      },
    })
    return ok(
      invoices.map((i) => {
        const ours = i.exceptions.filter((e) => (PROCUREMENT_TYPES as readonly string[]).includes(e.type))
        return {
          invoiceId: i.id,
          number: i.number,
          supplierInvoiceNo: i.supplierInvoiceNo,
          version: i.version,
          po: i.po,
          supplier: i.supplier,
          grossSatang: i.grossSatang,
          overSatang: ours.reduce((a, e) => a + e.amountSatang, 0n),
          types: [...new Set(i.exceptions.map((e) => e.type))],
          canRequest: i.exceptions.length > 0 && i.exceptions.every((e) => e.type === 'PRICE_OVER'),
        }
      }),
    )
  })
}
