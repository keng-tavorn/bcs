import { lineNet, parseQuantity, type Satang } from '@/core/money/math'
import { formatQuantity } from '@/core/receiving'
import { OrgSettingsSchema, type OrgSettings } from '@/lib/org-settings'
import type { Ctx } from '@/server/context'
import { forTenant, type TenantDb } from '@/server/db/tenant'
import { isUuid, membersById, type MemberRefDto, type NameDto } from './requests'

// Read-only views for the finance screens (spec §9.1 /finance/invoices and /finance/exports; S4-08, S4-17, S4-09;
// FR-P2P-008, FR-P2P-009): the POs that wait for their supplier's invoice — sent, partly or fully received, and closed
// ones that still hold budget for goods received and not invoiced (BR-IVC-01, BR-BUD-06) — with what was received,
// invoiced and is still held; one PO with each line's figures, the budget of its lines and the invoices recorded on it;
// the invoices recorded lately; the invoices not exported yet, split as the Express file would split them (BR-EXP-04);
// and the Express files made. Money stays BigInt satang. Queries never check permissions:
// src/server/services/invoices/view.ts and src/server/services/exports/view.ts do before they hand anything on.

/** POs an invoice waits for while they are open (§6.4: invoices are recorded from SENT onwards) */
export const INVOICE_OPEN_STATUSES = ['SENT', 'PARTIALLY_RECEIVED', 'RECEIVED'] as const
export type InvoiceablePoStatus = (typeof INVOICE_OPEN_STATUSES)[number] | 'CLOSED'
const LIST_LIMIT = 200
const RECENT_INVOICES = 50
const SEARCH_MAX = 60
const JOBS_LIMIT = 20
/** Invoices each export list shows; the counts and totals cover all of them */
const PENDING_SHOWN = 100
/** Ids sent in one IN list: far below Postgres' limit of bind parameters in one statement, however much is open */
const ID_CHUNK = 500

function chunks<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

const scaled = (d: { toString(): string }): bigint => parseQuantity(d.toString())
const quantityText = (d: { toString(): string }): string => formatQuantity(scaled(d))
const nameOf = (th: string, en: string | null | undefined): NameDto => ({ th, en: en ?? null })
const sum = (values: Iterable<bigint>): bigint => {
  let total = 0n
  for (const v of values) total += v
  return total
}
/** Value received on a line: the quantity accepted on posted receipts × the unit price before VAT (as BR-RPT-01) */
const receivedValue = (line: { receivedQuantity: { toString(): string }; unitPriceSatang: bigint }): Satang => lineNet(quantityText(line.receivedQuantity), line.unitPriceSatang)

const searchText = (q: string | undefined): string => (q ?? '').trim().slice(0, SEARCH_MAX)

/** What each PO line still holds (COMMITTED) and has turned to ACTUAL, by PO line id */
async function lineBudgets(db: TenantDb, poLineIds: readonly string[]): Promise<Map<string, { committed: Satang; actual: Satang }>> {
  if (poLineIds.length === 0) return new Map()
  const rows = (
    await Promise.all(
      chunks([...new Set(poLineIds)], ID_CHUNK).map((ids) =>
        db.budgetAllocation.findMany({ where: { sourceType: 'PO_LINE', sourceId: { in: ids } }, select: { sourceId: true, committedSatang: true, actualSatang: true } }),
      ),
    )
  ).flat()
  const out = new Map<string, { committed: Satang; actual: Satang }>()
  for (const r of rows) {
    const before = out.get(r.sourceId) ?? { committed: 0n, actual: 0n }
    out.set(r.sourceId, { committed: before.committed + r.committedSatang, actual: before.actual + r.actualSatang })
  }
  return out
}

// ---------- the POs waiting for an invoice (/finance/invoices) ----------

export interface InvoiceablePoDto {
  readonly id: string
  readonly number: string | null
  readonly status: InvoiceablePoStatus
  readonly supplier: { readonly id: string; readonly code: string; readonly name: NameDto }
  readonly sentAt: Date | null
  readonly closedAt: Date | null
  readonly netSatang: Satang
  readonly grossSatang: Satang
  /** Value of the goods accepted so far, before VAT */
  readonly receivedSatang: Satang
  /** Invoices recorded so far, before VAT */
  readonly invoicedSatang: Satang
  readonly invoiceCount: number
  /** What the PO's lines still hold (COMMITTED): the most the next invoices may take before VAT (BR-IVC-02) */
  readonly heldSatang: Satang
}

export interface InvoiceablePoListDto {
  readonly rows: readonly InvoiceablePoDto[]
  /** More POs matched than the list shows */
  readonly limited: boolean
}

const PO_ROW_SELECT = {
  id: true,
  number: true,
  status: true,
  sentAt: true,
  closedAt: true,
  netSatang: true,
  grossSatang: true,
  supplier: { select: { id: true, code: true, nameTh: true, nameEn: true } },
  lines: { select: { id: true, receivedQuantity: true, unitPriceSatang: true } },
  invoices: { select: { netSatang: true } },
} as const

/** Ascending with empty values last, as Postgres sorts ascending */
function ascNullsLast<T extends Date | string>(a: T | null, b: T | null): number {
  if (a === null || b === null) return a === b ? 0 : a === null ? 1 : -1
  const [x, y] = a instanceof Date && b instanceof Date ? [a.getTime(), b.getTime()] : [String(a), String(b)]
  return x < y ? -1 : x > y ? 1 : 0
}

/** The list's order, as the queries sort: open POs the longest waiting first, then closed ones, the earliest closed first */
function listOrder(a: { id: string; status: string; number: string | null; sentAt: Date | null; closedAt: Date | null }, b: typeof a): number {
  const closedA = a.status === 'CLOSED'
  if (closedA !== (b.status === 'CLOSED')) return closedA ? 1 : -1
  return (closedA ? ascNullsLast(a.closedAt, b.closedAt) : ascNullsLast(a.sentAt, b.sentAt)) || ascNullsLast(a.number, b.number) || ascNullsLast(a.id, b.id)
}

/**
 * POs that wait for an invoice: open ones (sent, partly or fully received) and closed ones that still hold budget for
 * goods received and not invoiced — none with its last invoice in, and only while a line still holds something (an
 * invoice takes nothing more from a PO that holds nothing, BR-IVC-02). Searched by PO number, supplier name or code.
 * Open ones the longest waiting first, then the closed ones.
 */
export async function listInvoiceablePos(ctx: Ctx, filter: { readonly q?: string } = {}): Promise<InvoiceablePoListDto> {
  const db = forTenant(ctx.organizationId)
  const q = searchText(filter.q)
  const search = q
    ? {
        OR: [
          { number: { contains: q, mode: 'insensitive' as const } },
          { supplier: { is: { nameTh: { contains: q, mode: 'insensitive' as const } } } },
          { supplier: { is: { code: { contains: q, mode: 'insensitive' as const } } } },
        ],
      }
    : {}
  // The PO lines that hold budget now: the work in progress only (open POs, and closed ones with goods received and not
  // invoiced), never the history of settled POs
  const holding = [...new Set((await db.budgetAllocation.findMany({ where: { sourceType: 'PO_LINE', committedSatang: { gt: 0n } }, select: { sourceId: true } })).map((h) => h.sourceId))]
  if (holding.length === 0) return { rows: [], limited: false }
  const take = LIST_LIMIT + 1
  const holdingIn = (ids: string[]) => {
    const holds = { lines: { some: { id: { in: ids } } }, invoices: { none: { isFinal: true } } }
    return Promise.all([
      db.purchaseOrder.findMany({ where: { ...search, ...holds, status: { in: [...INVOICE_OPEN_STATUSES] } }, orderBy: [{ sentAt: 'asc' }, { number: 'asc' }, { id: 'asc' }], take, select: PO_ROW_SELECT }),
      db.purchaseOrder.findMany({ where: { ...search, ...holds, status: 'CLOSED' }, orderBy: [{ closedAt: 'asc' }, { number: 'asc' }, { id: 'asc' }], take, select: PO_ROW_SELECT }),
    ])
  }
  type PoRow = Awaited<ReturnType<typeof holdingIn>>[0][number]
  // In chunks, so no IN list grows with the organization: each chunk's first rows of each kind hold the overall first ones
  const found = new Map<string, PoRow>()
  for (const ids of chunks(holding, ID_CHUNK)) {
    const [open, closed] = await holdingIn(ids)
    for (const p of [...open, ...closed]) found.set(p.id, p)
  }
  const all = [...found.values()].sort(listOrder)
  const limited = all.length > LIST_LIMIT
  const shown = all.slice(0, LIST_LIMIT)
  const budgets = await lineBudgets(
    db,
    shown.flatMap((p) => p.lines.map((l) => l.id)),
  )
  return {
    limited,
    rows: shown.map((p) => ({
      id: p.id,
      number: p.number,
      status: p.status as InvoiceablePoStatus,
      supplier: { id: p.supplier.id, code: p.supplier.code, name: nameOf(p.supplier.nameTh, p.supplier.nameEn) },
      sentAt: p.sentAt,
      closedAt: p.closedAt,
      netSatang: p.netSatang,
      grossSatang: p.grossSatang,
      receivedSatang: sum(p.lines.map(receivedValue)),
      invoicedSatang: sum(p.invoices.map((i) => i.netSatang)),
      invoiceCount: p.invoices.length,
      heldSatang: sum(p.lines.map((l) => budgets.get(l.id)?.committed ?? 0n)),
    })),
  }
}

// ---------- the invoices recorded ----------

export interface RecordedInvoiceDto {
  readonly id: string
  readonly invoiceNo: string
  readonly invoiceDate: Date
  readonly netSatang: Satang
  readonly vatSatang: Satang
  readonly grossSatang: Satang
  readonly isFinal: boolean
  readonly parsedFrom: 'MANUAL' | 'ETAX_XML'
  readonly po: { readonly id: string; readonly number: string | null }
  readonly supplier: { readonly id: string; readonly code: string; readonly name: NameDto }
  readonly recordedBy: MemberRefDto | null
  readonly recordedAt: Date
  readonly exportedAt: Date | null
  readonly file: { readonly id: string; readonly fileName: string } | null
}

const INVOICE_SELECT = {
  id: true,
  invoiceNo: true,
  invoiceDate: true,
  netSatang: true,
  vatSatang: true,
  grossSatang: true,
  isFinal: true,
  parsedFrom: true,
  recordedById: true,
  recordedAt: true,
  exportedAt: true,
  po: { select: { id: true, number: true } },
  supplier: { select: { id: true, code: true, nameTh: true, nameEn: true } },
  sourceFile: { select: { id: true, fileName: true, status: true } },
} as const

type InvoiceRow = {
  id: string
  invoiceNo: string
  invoiceDate: Date
  netSatang: bigint
  vatSatang: bigint
  grossSatang: bigint
  isFinal: boolean
  parsedFrom: string
  recordedById: string
  recordedAt: Date
  exportedAt: Date | null
  po: { id: string; number: string | null }
  supplier: { id: string; code: string; nameTh: string; nameEn: string | null }
  sourceFile: { id: string; fileName: string; status: string } | null
}

function invoiceDto(row: InvoiceRow, people: ReadonlyMap<string, MemberRefDto>): RecordedInvoiceDto {
  return {
    id: row.id,
    invoiceNo: row.invoiceNo,
    invoiceDate: row.invoiceDate,
    netSatang: row.netSatang,
    vatSatang: row.vatSatang,
    grossSatang: row.grossSatang,
    isFinal: row.isFinal,
    parsedFrom: row.parsedFrom === 'ETAX_XML' ? 'ETAX_XML' : 'MANUAL',
    po: row.po,
    supplier: { id: row.supplier.id, code: row.supplier.code, name: nameOf(row.supplier.nameTh, row.supplier.nameEn) },
    recordedBy: people.get(row.recordedById) ?? null,
    recordedAt: row.recordedAt,
    exportedAt: row.exportedAt,
    file: row.sourceFile && row.sourceFile.status === 'AVAILABLE' ? { id: row.sourceFile.id, fileName: row.sourceFile.fileName } : null,
  }
}

/** The invoices recorded last first, searched by invoice number, PO number or supplier */
export async function listRecordedInvoices(ctx: Ctx, filter: { readonly q?: string } = {}): Promise<{ readonly rows: readonly RecordedInvoiceDto[]; readonly limited: boolean }> {
  const db = forTenant(ctx.organizationId)
  const q = searchText(filter.q)
  const where = q
    ? {
        OR: [
          { invoiceNo: { contains: q, mode: 'insensitive' as const } },
          { po: { is: { number: { contains: q, mode: 'insensitive' as const } } } },
          { supplier: { is: { nameTh: { contains: q, mode: 'insensitive' as const } } } },
          { supplier: { is: { code: { contains: q, mode: 'insensitive' as const } } } },
        ],
      }
    : {}
  const rows = await db.invoiceConfirmation.findMany({ where, orderBy: [{ recordedAt: 'desc' }, { id: 'desc' }], take: RECENT_INVOICES + 1, select: INVOICE_SELECT })
  const shown = rows.slice(0, RECENT_INVOICES)
  const people = await membersById(
    db,
    shown.map((r) => r.recordedById),
  )
  return { rows: shown.map((r) => invoiceDto(r, people)), limited: rows.length > RECENT_INVOICES }
}

/** Invoices recorded and not yet in an Express file */
export async function countInvoicesNotExported(ctx: Ctx): Promise<number> {
  return forTenant(ctx.organizationId).invoiceConfirmation.count({ where: { exportedAt: null } })
}

// ---------- one PO (/finance/invoices/[poId]) ----------

export interface InvoicePoLineDto {
  readonly id: string
  readonly lineNo: number
  readonly description: string
  readonly uom: string
  readonly quantity: string
  readonly receivedQuantity: string
  readonly cancelledQuantity: string
  readonly unitPriceSatang: Satang
  readonly netSatang: Satang
  readonly receivedSatang: Satang
  /** Shared to this line by the invoices so far (BR-IVC-04) */
  readonly invoicedSatang: Satang
  /** What the line still holds (COMMITTED) and has turned to ACTUAL */
  readonly committedSatang: Satang
  readonly actualSatang: Satang
  readonly budgetLine: { readonly id: string; readonly code: string; readonly name: string }
}

export interface InvoiceOnPoDto extends RecordedInvoiceDto {
  /** How it was shared over the PO lines (BR-IVC-04) */
  readonly parts: ReadonlyArray<{ readonly poLineId: string; readonly netSatang: Satang }>
}

export interface InvoicePoDto {
  readonly id: string
  readonly number: string | null
  readonly status: string
  readonly supplier: { readonly id: string; readonly code: string; readonly name: NameDto; readonly taxId: string | null; readonly branchCode: string; readonly isVatRegistered: boolean }
  readonly sentAt: Date | null
  readonly closedAt: Date | null
  readonly totals: { readonly netSatang: Satang; readonly vatSatang: Satang; readonly grossSatang: Satang; readonly vatRateBp: number | null }
  readonly lines: readonly InvoicePoLineDto[]
  /** Last recorded first */
  readonly invoices: readonly InvoiceOnPoDto[]
  readonly finalRecorded: boolean
  /** Lines neither received in full nor given up: closing the PO waits for them (FR-P2P-010 AC2) */
  readonly unsettledLines: number
  readonly receivedSatang: Satang
  readonly invoicedSatang: Satang
  readonly heldSatang: Satang
}

export async function getInvoicePo(ctx: Ctx, poId: string): Promise<InvoicePoDto | null> {
  if (!isUuid(poId)) return null
  const db = forTenant(ctx.organizationId)
  const po = await db.purchaseOrder.findUnique({
    where: { id: poId },
    select: {
      id: true,
      number: true,
      status: true,
      sentAt: true,
      closedAt: true,
      netSatang: true,
      vatSatang: true,
      grossSatang: true,
      vatRateBp: true,
      supplier: { select: { id: true, code: true, nameTh: true, nameEn: true, taxId: true, branchCode: true, isVatRegistered: true } },
      lines: {
        orderBy: { lineNo: 'asc' },
        select: {
          id: true,
          lineNo: true,
          description: true,
          uom: true,
          quantity: true,
          receivedQuantity: true,
          cancelledQuantity: true,
          unitPriceSatang: true,
          netSatang: true,
          budgetLine: { select: { id: true, code: true, nameTh: true } },
          invoiceParts: { select: { netSatang: true } },
        },
      },
      invoices: { orderBy: [{ recordedAt: 'desc' }, { id: 'desc' }], select: { ...INVOICE_SELECT, lines: { select: { poLineId: true, netSatang: true } } } },
    },
  })
  if (!po) return null
  const [budgets, people] = await Promise.all([
    lineBudgets(
      db,
      po.lines.map((l) => l.id),
    ),
    membersById(
      db,
      po.invoices.map((i) => i.recordedById),
    ),
  ])
  const lines: InvoicePoLineDto[] = po.lines.map((l) => {
    const budget = budgets.get(l.id) ?? { committed: 0n, actual: 0n }
    return {
      id: l.id,
      lineNo: l.lineNo,
      description: l.description,
      uom: l.uom,
      quantity: quantityText(l.quantity),
      receivedQuantity: quantityText(l.receivedQuantity),
      cancelledQuantity: quantityText(l.cancelledQuantity),
      unitPriceSatang: l.unitPriceSatang,
      netSatang: l.netSatang,
      receivedSatang: receivedValue(l),
      invoicedSatang: sum(l.invoiceParts.map((p) => p.netSatang)),
      committedSatang: budget.committed,
      actualSatang: budget.actual,
      budgetLine: { id: l.budgetLine.id, code: l.budgetLine.code, name: l.budgetLine.nameTh },
    }
  })
  return {
    id: po.id,
    number: po.number,
    status: po.status,
    supplier: {
      id: po.supplier.id,
      code: po.supplier.code,
      name: nameOf(po.supplier.nameTh, po.supplier.nameEn),
      taxId: po.supplier.taxId,
      branchCode: po.supplier.branchCode,
      isVatRegistered: po.supplier.isVatRegistered,
    },
    sentAt: po.sentAt,
    closedAt: po.closedAt,
    totals: { netSatang: po.netSatang, vatSatang: po.vatSatang, grossSatang: po.grossSatang, vatRateBp: po.vatRateBp },
    lines,
    invoices: po.invoices.map((i) => ({ ...invoiceDto(i, people), parts: i.lines.map((p) => ({ poLineId: p.poLineId, netSatang: p.netSatang })) })),
    finalRecorded: po.invoices.some((i) => i.isFinal),
    unsettledLines: po.lines.filter((l) => scaled(l.receivedQuantity) + scaled(l.cancelledQuantity) < scaled(l.quantity)).length,
    receivedSatang: sum(lines.map((l) => l.receivedSatang)),
    invoicedSatang: sum(po.invoices.map((i) => i.netSatang)),
    heldSatang: sum(lines.map((l) => l.committedSatang)),
  }
}

/** The supplier's invoice numbers recorded so far, normalized (BR-IVC-03) */
export async function supplierInvoiceNumbers(ctx: Ctx, supplierId: string): Promise<Set<string>> {
  const rows = await forTenant(ctx.organizationId).invoiceConfirmation.findMany({ where: { supplierId }, select: { invoiceNoNormalized: true } })
  return new Set(rows.map((r) => r.invoiceNoNormalized))
}

// ---------- the Express export (/finance/exports) ----------

export type ExpressSettings = OrgSettings['express']

/** settings.express (BR-EXP-01), or null when it is missing or does not pass the schema */
export async function readExpressSettings(ctx: Ctx): Promise<ExpressSettings | null> {
  const org = await forTenant(ctx.organizationId).organization.findUniqueOrThrow({ where: { id: ctx.organizationId }, select: { settings: true } })
  const parsed = OrgSettingsSchema.shape.express.safeParse((org.settings as { express?: unknown } | null)?.express)
  return parsed.success ? parsed.data : null
}

export interface PendingInvoiceDto {
  readonly id: string
  readonly invoiceNo: string
  readonly invoiceDate: Date
  readonly netSatang: Satang
  readonly vatSatang: Satang
  readonly grossSatang: Satang
  readonly po: { readonly id: string; readonly number: string | null }
  readonly supplier: { readonly id: string; readonly code: string; readonly name: NameDto; readonly expressVendorCode: string | null }
}

export interface PendingGroupDto {
  readonly count: number
  readonly totalSatang: Satang
  /** The first ones, in the order the file takes them (recorded first, first) */
  readonly shown: readonly PendingInvoiceDto[]
}

/** A supplier's Express vendor code is missing when it is empty (as the export command decides, BR-EXP-04) */
const MISSING_CODE = { OR: [{ expressVendorCode: null }, { expressVendorCode: '' }] }
const HAS_CODE = { AND: [{ expressVendorCode: { not: null } }, { expressVendorCode: { not: '' } }] }

/** The first invoices of a group, in the order the file takes them */
async function pendingShown(db: TenantDb, where: object): Promise<PendingInvoiceDto[]> {
  const rows = await db.invoiceConfirmation.findMany({
    where,
    orderBy: [{ recordedAt: 'asc' }, { id: 'asc' }],
    take: PENDING_SHOWN,
    select: {
      id: true,
      invoiceNo: true,
      invoiceDate: true,
      netSatang: true,
      vatSatang: true,
      grossSatang: true,
      po: { select: { id: true, number: true } },
      supplier: { select: { id: true, code: true, nameTh: true, nameEn: true, expressVendorCode: true } },
    },
  })
  return rows.map((r) => ({
    id: r.id,
    invoiceNo: r.invoiceNo,
    invoiceDate: r.invoiceDate,
    netSatang: r.netSatang,
    vatSatang: r.vatSatang,
    grossSatang: r.grossSatang,
    po: r.po,
    supplier: { id: r.supplier.id, code: r.supplier.code, name: nameOf(r.supplier.nameTh, r.supplier.nameEn), expressVendorCode: r.supplier.expressVendorCode },
  }))
}

export interface HeldBackSupplierDto {
  readonly supplier: { readonly id: string; readonly code: string; readonly name: NameDto }
  readonly count: number
  readonly totalSatang: Satang
  readonly invoices: ReadonlyArray<{ readonly id: string; readonly invoiceNo: string; readonly poNumber: string | null; readonly grossSatang: Satang }>
}

export interface HeldBackDto {
  readonly count: number
  readonly totalSatang: Satang
  /** By supplier, the most invoices first */
  readonly suppliers: readonly HeldBackSupplierDto[]
}

/** Invoices each held-back supplier lists, out of the first ones read */
const HELD_SHOWN_PER_SUPPLIER = 20
const HELD_READ_MAX = 500

async function heldBackGroup(db: TenantDb): Promise<HeldBackDto> {
  const where = { exportedAt: null, supplier: { is: MISSING_CODE } }
  const [bySupplier, totals] = await Promise.all([
    db.invoiceConfirmation.groupBy({ by: ['supplierId'], where, _count: { _all: true }, _sum: { grossSatang: true } }),
    db.invoiceConfirmation.aggregate({ where, _count: { _all: true }, _sum: { grossSatang: true } }),
  ])
  if (bySupplier.length === 0) return { count: 0, totalSatang: 0n, suppliers: [] }
  const ids = bySupplier.map((g) => g.supplierId)
  const [suppliers, invoices] = await Promise.all([
    db.supplier.findMany({ where: { id: { in: ids } }, select: { id: true, code: true, nameTh: true, nameEn: true } }),
    db.invoiceConfirmation.findMany({ where, orderBy: [{ recordedAt: 'asc' }, { id: 'asc' }], take: HELD_READ_MAX, select: { id: true, supplierId: true, invoiceNo: true, grossSatang: true, po: { select: { number: true } } } }),
  ])
  const byId = new Map(suppliers.map((s) => [s.id, s]))
  return {
    count: totals._count._all,
    totalSatang: totals._sum.grossSatang ?? 0n,
    suppliers: bySupplier
      .flatMap((g) => {
        const s = byId.get(g.supplierId)
        if (!s) return []
        return [
          {
            supplier: { id: s.id, code: s.code, name: nameOf(s.nameTh, s.nameEn) },
            count: g._count._all,
            totalSatang: g._sum.grossSatang ?? 0n,
            invoices: invoices
              .filter((i) => i.supplierId === s.id)
              .slice(0, HELD_SHOWN_PER_SUPPLIER)
              .map((i) => ({ id: i.id, invoiceNo: i.invoiceNo, poNumber: i.po.number, grossSatang: i.grossSatang })),
          },
        ]
      })
      .sort((a, b) => b.count - a.count || a.supplier.code.localeCompare(b.supplier.code)),
  }
}

/**
 * The invoices not exported yet as the next Express file takes them (BR-EXP-02): `ready` go into it; when the layout
 * has the vendor-code column, invoices of suppliers without a code are `heldBack` (BR-EXP-04), otherwise none are.
 */
export async function listPendingExport(ctx: Ctx, needsVendorCode: boolean): Promise<{ readonly ready: PendingGroupDto; readonly heldBack: HeldBackDto; readonly readyIds: readonly string[] }> {
  const db = forTenant(ctx.organizationId)
  const readyWhere = needsVendorCode ? { exportedAt: null, supplier: { is: HAS_CODE } } : { exportedAt: null }
  const [all, heldBack] = await Promise.all([
    // Every invoice the next file takes, read at once: the count, the total, the rows shown and the list the person
    // confirms (BR-EXP-02) all come from this one read, never from reads that could see different moments
    db.invoiceConfirmation.findMany({ where: readyWhere, orderBy: [{ recordedAt: 'asc' }, { id: 'asc' }], select: { id: true, grossSatang: true } }),
    needsVendorCode ? heldBackGroup(db) : Promise.resolve<HeldBackDto>({ count: 0, totalSatang: 0n, suppliers: [] }),
  ])
  const first = all.slice(0, PENDING_SHOWN).map((i) => i.id)
  const shown = first.length ? await pendingShown(db, { id: { in: first } }) : []
  return { ready: { count: all.length, totalSatang: sum(all.map((i) => i.grossSatang)), shown }, heldBack, readyIds: all.map((i) => i.id) }
}

export interface ExportJobDto {
  readonly id: string
  readonly status: string
  readonly createdAt: Date
  readonly completedAt: Date | null
  readonly requestedBy: MemberRefDto | null
  readonly rowCount: number | null
  readonly totalSatang: Satang | null
  readonly checksum: string | null
  /** Why the same invoices were exported again (BR-EXP-02); null for a first export */
  readonly reason: string | null
  readonly invoiceIds: readonly string[]
  readonly file: { readonly id: string; readonly fileName: string } | null
}

const invoiceIdsOf = (params: unknown): string[] => {
  const ids = (params as { invoiceIds?: unknown } | null)?.invoiceIds
  return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string' && isUuid(id)) : []
}

/** The Express files made, last first */
export async function listExpressJobs(ctx: Ctx): Promise<ExportJobDto[]> {
  const db = forTenant(ctx.organizationId)
  const jobs = await db.exportJob.findMany({
    where: { kind: 'EXPRESS_AP' },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: JOBS_LIMIT,
    select: { id: true, status: true, createdAt: true, completedAt: true, requestedById: true, rowCount: true, totalSatang: true, checksum: true, reason: true, params: true, file: { select: { id: true, fileName: true, status: true } } },
  })
  const people = await membersById(
    db,
    jobs.map((j) => j.requestedById),
  )
  return jobs.map((j) => ({
    id: j.id,
    status: j.status,
    createdAt: j.createdAt,
    completedAt: j.completedAt,
    requestedBy: people.get(j.requestedById) ?? null,
    rowCount: j.rowCount,
    totalSatang: j.totalSatang,
    checksum: j.checksum,
    reason: j.reason,
    invoiceIds: invoiceIdsOf(j.params),
    file: j.file && j.file.status === 'AVAILABLE' ? { id: j.file.id, fileName: j.file.fileName } : null,
  }))
}

/** The invoices an Express file took, or null when there is no such file */
export async function expressJobInvoiceIds(ctx: Ctx, exportJobId: string): Promise<string[] | null> {
  if (!isUuid(exportJobId)) return null
  const job = await forTenant(ctx.organizationId).exportJob.findFirst({ where: { id: exportJobId, kind: 'EXPRESS_AP' }, select: { params: true } })
  return job ? invoiceIdsOf(job.params) : null
}
