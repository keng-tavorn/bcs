import { toMoneyDto, type MoneyDto } from '@/core/money/dto'
import { isAllowed, type Principal } from '@/server/authz'
import type { TenantTx } from '@/server/db/tenant'
import { dateText } from './dashboard'

// The documents behind the amounts of some budget lines (spec §11.2 "drill-down ถึงเอกสาร", FR-BUD-005 AC2: whichever
// amount is clicked, the documents that make it up) — one line, the lines of a department, or every line a viewer may
// see in a fiscal year — read from the allocation projection the ledger keeps per document line (BudgetAllocation,
// §6.2) and from the ledger itself:
//   planned    the imports that funded the lines (the ledger's OUTSIDE → AVAILABLE rows, by import)
//   reserved   requests, and the extra a PO waiting for approval reserves above its requests (BR-BUD-05)
//   committed  approved POs
//   actual     POs with their confirmed invoices (BR-IVC-04)
//   movements  the latest movements of the ledger: what the available amount went through
// Each section's total is that bucket over every allocation (or import) of the lines, so it equals the lines' own
// amount — the engine keeps every bucket equal to the sum of its allocations (core/budget) and the planned amount equal
// to what was funded. A section lists at most BUDGET_DOCUMENT_LIMIT documents, the largest first, and says how many
// there are. A document links to its own page, and shows its title, requester or supplier, only for a viewer who may
// open that page (request.view, po.view); anyone else sees its number, status and amount, so a budget page never shows
// more of a document than the document's own page would. Movements carry no names (who did what is the audit trail's).

/** Documents listed per section, the largest first; the section says how many there are in all */
export const BUDGET_DOCUMENT_LIMIT = 100
/** Movements shown, newest first; the page says how many there are in all */
export const BUDGET_MOVEMENT_LIMIT = 100

/** The six movements of §7.7, named by what happened */
export type BudgetMovementKind = 'IMPORTED' | 'RESERVED' | 'RESERVATION_RELEASED' | 'COMMITTED' | 'COMMITMENT_RELEASED' | 'ACTUALIZED'

const KIND_OF: Readonly<Record<string, BudgetMovementKind>> = {
  'OUTSIDE>AVAILABLE': 'IMPORTED',
  'AVAILABLE>RESERVED': 'RESERVED',
  'RESERVED>AVAILABLE': 'RESERVATION_RELEASED',
  'AVAILABLE>COMMITTED': 'COMMITTED',
  'COMMITTED>AVAILABLE': 'COMMITMENT_RELEASED',
  'COMMITTED>ACTUAL': 'ACTUALIZED',
}

export interface NameDto {
  readonly th: string
  readonly en: string | null
}

/** A budget line a document holds money on, among the lines shown */
export interface BudgetLineRefDto {
  readonly id: string
  readonly code: string
}

export interface BudgetImportDocDto {
  /** The import: a file imported on the import page, or the initial budget loaded when the organization was set up */
  readonly id: string
  /** The file's name; null for the initial budget */
  readonly fileName: string | null
  /** When the money came in (ISO) */
  readonly at: string
  /** What it funded on these lines */
  readonly amount: MoneyDto
  readonly lines: readonly BudgetLineRefDto[]
}

export interface BudgetRequestDocDto {
  readonly id: string
  readonly number: string | null
  readonly status: string
  readonly submittedAt: string | null
  /** The request's own words: only for a viewer who may open the request (request.view), otherwise null */
  readonly title: string | null
  /** Only for a viewer who may open the request (request.view), otherwise null */
  readonly requester: NameDto | null
  /** What the request holds on these lines */
  readonly amount: MoneyDto
  readonly canOpen: boolean
  readonly lines: readonly BudgetLineRefDto[]
}

export interface BudgetPoDocDto {
  readonly id: string
  readonly number: string | null
  readonly status: string
  /** Only for a viewer who may open the PO (po.view), otherwise null */
  readonly supplier: NameDto | null
  /** What the PO holds in this bucket on these lines */
  readonly amount: MoneyDto
  readonly canOpen: boolean
  readonly lines: readonly BudgetLineRefDto[]
}

export interface BudgetInvoiceDocDto {
  readonly id: string
  readonly invoiceNo: string
  /** YYYY-MM-DD */
  readonly invoiceDate: string
  /** The part of the invoice (before VAT) on these lines' PO lines */
  readonly amount: MoneyDto
}

export interface BudgetActualPoDocDto extends BudgetPoDocDto {
  readonly invoices: readonly BudgetInvoiceDocDto[]
}

export interface BudgetMovementDto {
  readonly seq: number
  /** When the movement happened (its event, business time) */
  readonly at: string
  readonly kind: BudgetMovementKind | null
  readonly from: string
  readonly to: string
  readonly amount: MoneyDto
  /** The budget line it moved money on */
  readonly line: BudgetLineRefDto
  readonly document: {
    readonly type: 'REQUEST' | 'PURCHASE_ORDER' | 'IMPORT'
    readonly id: string
    /** The document number, or an import's file name; null for the initial budget loaded at setup */
    readonly label: string | null
    readonly canOpen: boolean
  }
}

export interface BudgetDocumentsDto {
  readonly planned: { readonly imports: readonly BudgetImportDocDto[]; readonly count: number; readonly total: MoneyDto }
  readonly reserved: {
    readonly requests: readonly BudgetRequestDocDto[]
    readonly requestCount: number
    readonly purchaseOrders: readonly BudgetPoDocDto[]
    readonly purchaseOrderCount: number
    readonly total: MoneyDto
  }
  readonly committed: { readonly purchaseOrders: readonly BudgetPoDocDto[]; readonly count: number; readonly total: MoneyDto }
  readonly actual: { readonly purchaseOrders: readonly BudgetActualPoDocDto[]; readonly count: number; readonly total: MoneyDto }
  readonly movements: { readonly rows: readonly BudgetMovementDto[]; readonly total: number }
}

/** request.view for this request: its requester (OWN), a head of its charged department (DEPT) or an ORG role */
const mayOpenRequest = (principal: Principal, r: { requesterMemberId: string; chargedDepartmentId: string }) =>
  isAllowed(principal, 'request.view', { ownerMemberIds: [r.requesterMemberId], departmentId: r.chargedDepartmentId })

/** po.view for this PO: an ORG role, or the member who drafted it (OWN) */
const mayOpenPo = (principal: Principal, po: { createdById: string | null }) => isAllowed(principal, 'po.view', { ownerMemberIds: po.createdById ? [po.createdById] : [] })

const sum = (values: readonly bigint[]) => values.reduce((total, v) => total + v, 0n)

/** What one document holds in one bucket on the lines shown, and on which of them */
interface Holding {
  amount: bigint
  readonly lineIds: Set<string>
}

function hold(map: Map<string, Holding>, documentId: string, amount: bigint, budgetLineId: string) {
  if (amount <= 0n) return
  const held = map.get(documentId) ?? { amount: 0n, lineIds: new Set<string>() }
  held.amount += amount
  held.lineIds.add(budgetLineId)
  map.set(documentId, held)
}

/** The largest first, then by id so the cut is stable; at most the limit */
const largest = (map: ReadonlyMap<string, Holding>) =>
  [...map.entries()].sort(([ia, a], [ib, b]) => (a.amount === b.amount ? ia.localeCompare(ib) : a.amount > b.amount ? -1 : 1)).slice(0, BUDGET_DOCUMENT_LIMIT)

/** Largest first, then by number, so the documents that use most come first */
const byAmount = (a: { amount: bigint; number: string | null }, b: { amount: bigint; number: string | null }) =>
  a.amount === b.amount ? (a.number ?? '').localeCompare(b.number ?? '') : a.amount > b.amount ? -1 : 1

/** The request and the PO of each request line and PO line */
async function documentLines(tx: TenantTx, requestLineIds: readonly string[], poLineIds: readonly string[]) {
  const [requestLines, poLines] = await Promise.all([
    requestLineIds.length ? tx.requestLine.findMany({ where: { id: { in: [...new Set(requestLineIds)] } }, select: { id: true, requestId: true } }) : [],
    poLineIds.length ? tx.poLine.findMany({ where: { id: { in: [...new Set(poLineIds)] } }, select: { id: true, poId: true } }) : [],
  ])
  return { requestOf: new Map(requestLines.map((l) => [l.id, l.requestId])), poOf: new Map(poLines.map((l) => [l.id, l.poId])) }
}

/** The documents behind each amount of these budget lines, and their latest ledger movements (FR-BUD-005 AC2) */
export async function budgetDocumentsOf(tx: TenantTx, principal: Principal, lines: ReadonlyArray<{ readonly id: string; readonly code: string }>): Promise<BudgetDocumentsDto> {
  const lineIds = lines.map((l) => l.id)
  const codeOf = new Map(lines.map((l) => [l.id, l.code]))
  const refs = (ids: Iterable<string>): BudgetLineRefDto[] =>
    [...new Set(ids)].map((id) => ({ id, code: codeOf.get(id) ?? '' })).sort((a, b) => a.code.localeCompare(b.code))
  const onLines = { budgetLineId: { in: lineIds } }

  // What every document line holds on these lines now, and the request or PO it belongs to
  const allocations = lineIds.length
    ? await tx.budgetAllocation.findMany({
        where: { ...onLines, OR: [{ reservedSatang: { gt: 0n } }, { committedSatang: { gt: 0n } }, { actualSatang: { gt: 0n } }] },
        select: { budgetLineId: true, sourceType: true, sourceId: true, reservedSatang: true, committedSatang: true, actualSatang: true },
      })
    : []
  const { requestOf, poOf } = await documentLines(
    tx,
    allocations.filter((a) => a.sourceType === 'REQUEST_LINE').map((a) => a.sourceId),
    allocations.filter((a) => a.sourceType === 'PO_LINE').map((a) => a.sourceId),
  )
  const requestReserved = new Map<string, Holding>()
  const poHeld = { reserved: new Map<string, Holding>(), committed: new Map<string, Holding>(), actual: new Map<string, Holding>() }
  /** The PO lines of each PO with actual on these lines: their invoices make it up */
  const actualPoLines = new Map<string, string[]>()
  for (const a of allocations) {
    if (a.sourceType === 'REQUEST_LINE') {
      // A request line that still holds money is never removed (removing it gives its reservation back first)
      const requestId = requestOf.get(a.sourceId)
      if (requestId) hold(requestReserved, requestId, a.reservedSatang, a.budgetLineId)
      continue
    }
    const poId = poOf.get(a.sourceId)
    if (!poId) continue
    hold(poHeld.reserved, poId, a.reservedSatang, a.budgetLineId)
    hold(poHeld.committed, poId, a.committedSatang, a.budgetLineId)
    hold(poHeld.actual, poId, a.actualSatang, a.budgetLineId)
    if (a.actualSatang > 0n) actualPoLines.set(poId, [...(actualPoLines.get(poId) ?? []), a.sourceId])
  }
  const bucketTotal = (bucket: 'reservedSatang' | 'committedSatang' | 'actualSatang') => toMoneyDto(sum(allocations.map((a) => a[bucket])))

  // Only the documents listed are read in full
  const shownRequests = largest(requestReserved)
  const shownPos = { reserved: largest(poHeld.reserved), committed: largest(poHeld.committed), actual: largest(poHeld.actual) }
  const poIds = [...new Set([...shownPos.reserved, ...shownPos.committed, ...shownPos.actual].map(([id]) => id))]
  const [requests, purchaseOrders] = await Promise.all([
    shownRequests.length
      ? tx.request.findMany({
          where: { id: { in: shownRequests.map(([id]) => id) } },
          select: {
            id: true,
            number: true,
            title: true,
            status: true,
            submittedAt: true,
            requesterMemberId: true,
            chargedDepartmentId: true,
            requester: { select: { displayNameTh: true, displayNameEn: true } },
          },
        })
      : [],
    poIds.length
      ? tx.purchaseOrder.findMany({ where: { id: { in: poIds } }, select: { id: true, number: true, status: true, createdById: true, supplier: { select: { nameTh: true, nameEn: true } } } })
      : [],
  ])
  const requestById = new Map(requests.map((r) => [r.id, r]))
  const poById = new Map(purchaseOrders.map((p) => [p.id, p]))

  const requestDocs = shownRequests
    .flatMap(([id, held]) => {
      const r = requestById.get(id)
      return r ? [{ r, held, amount: held.amount, number: r.number }] : []
    })
    .sort(byAmount)
    .map(({ r, held }): BudgetRequestDocDto => {
      const canOpen = mayOpenRequest(principal, r)
      return {
        id: r.id,
        number: r.number,
        status: r.status,
        submittedAt: r.submittedAt?.toISOString() ?? null,
        title: canOpen ? r.title : null,
        requester: canOpen ? { th: r.requester.displayNameTh, en: r.requester.displayNameEn } : null,
        amount: toMoneyDto(held.amount),
        canOpen,
        lines: refs(held.lineIds),
      }
    })
  const poDocs = (shown: ReadonlyArray<readonly [string, Holding]>) =>
    shown
      .flatMap(([id, held]) => {
        const po = poById.get(id)
        return po ? [{ po, held, amount: held.amount, number: po.number }] : []
      })
      .sort(byAmount)
      .map(({ po, held }): BudgetPoDocDto => {
        const canOpen = mayOpenPo(principal, po)
        return {
          id: po.id,
          number: po.number,
          status: po.status,
          supplier: canOpen ? { th: po.supplier.nameTh, en: po.supplier.nameEn } : null,
          amount: toMoneyDto(held.amount),
          canOpen,
          lines: refs(held.lineIds),
        }
      })

  // Actual: the confirmed invoices of these PO lines, each with its part on these lines (BR-IVC-04)
  const actualPos = poDocs(shownPos.actual)
  const actualLineIds = actualPos.flatMap((p) => actualPoLines.get(p.id) ?? [])
  const invoiceParts = actualLineIds.length
    ? await tx.invoiceLineAllocation.findMany({
        where: { poLineId: { in: actualLineIds } },
        select: { netSatang: true, invoice: { select: { id: true, poId: true, invoiceNo: true, invoiceDate: true } } },
      })
    : []
  const invoicesOf = (poId: string): BudgetInvoiceDocDto[] => {
    const parts = new Map<string, { invoice: (typeof invoiceParts)[number]['invoice']; net: bigint }>()
    for (const p of invoiceParts.filter((x) => x.invoice.poId === poId)) {
      parts.set(p.invoice.id, { invoice: p.invoice, net: (parts.get(p.invoice.id)?.net ?? 0n) + p.netSatang })
    }
    return [...parts.values()]
      .sort((a, b) => a.invoice.invoiceDate.getTime() - b.invoice.invoiceDate.getTime() || a.invoice.invoiceNo.localeCompare(b.invoice.invoiceNo))
      .map(({ invoice, net }) => ({ id: invoice.id, invoiceNo: invoice.invoiceNo, invoiceDate: dateText(invoice.invoiceDate), amount: toMoneyDto(net) }))
  }

  // Planned: every import that funded these lines, newest first — never cut short by the movements' limit
  const fundings = lineIds.length
    ? await tx.budgetLedgerEntry.findMany({ where: { ...onLines, fromBucket: 'OUTSIDE' }, select: { budgetLineId: true, sourceId: true, amountSatang: true, eventId: true } })
    : []
  const perImport = new Map<string, Holding & { eventId: string }>()
  for (const f of fundings) {
    const held = perImport.get(f.sourceId) ?? { amount: 0n, lineIds: new Set<string>(), eventId: f.eventId }
    held.amount += f.amountSatang
    held.lineIds.add(f.budgetLineId)
    perImport.set(f.sourceId, held)
  }

  // The latest movements of the ledger, with the line and the document that moved the money
  const [entries, movementCount] = lineIds.length
    ? await Promise.all([
        tx.budgetLedgerEntry.findMany({
          where: onLines,
          // One line's own sequence is exact; across lines, the time each was written
          orderBy: lineIds.length === 1 ? [{ seq: 'desc' }] : [{ createdAt: 'desc' }, { budgetLineId: 'asc' }, { seq: 'desc' }],
          take: BUDGET_MOVEMENT_LIMIT,
          select: { seq: true, budgetLineId: true, fromBucket: true, toBucket: true, amountSatang: true, sourceType: true, sourceId: true, eventId: true, createdAt: true },
        }),
        tx.budgetLedgerEntry.count({ where: onLines }),
      ])
    : [[], 0]
  const moved = await documentLines(
    tx,
    entries.filter((e) => e.sourceType === 'REQUEST_LINE').map((e) => e.sourceId),
    entries.filter((e) => e.sourceType === 'PO_LINE').map((e) => e.sourceId),
  )
  const importIds = [...new Set([...perImport.keys(), ...entries.filter((e) => e.sourceType === 'IMPORT').map((e) => e.sourceId)])]
  const eventIds = [...new Set([...entries.map((e) => e.eventId), ...[...perImport.values()].map((i) => i.eventId)])]
  const [events, imports] = await Promise.all([
    eventIds.length ? tx.event.findMany({ where: { id: { in: eventIds } }, select: { id: true, occurredAt: true, data: true } }) : [],
    importIds.length ? tx.budgetImport.findMany({ where: { id: { in: importIds } }, select: { id: true, fileName: true, importedAt: true } }) : [],
  ])
  const occurredAt = new Map(events.map((e) => [e.id, e.occurredAt]))
  const importById = new Map(imports.map((i) => [i.id, i]))
  // A request line removed from a returned request keeps its movements; its request is the event's document (ledger.ts)
  const requestOfEvent = new Map(
    events.flatMap((e) => {
      const data = e.data as { documentType?: unknown; documentId?: unknown } | null
      return data?.documentType === 'REQUEST' && typeof data.documentId === 'string' ? [[e.id, data.documentId] as const] : []
    }),
  )
  const movedRequestIds = [
    ...new Set([
      ...entries.flatMap((e) => (e.sourceType === 'REQUEST_LINE' ? [moved.requestOf.get(e.sourceId) ?? requestOfEvent.get(e.eventId) ?? null] : [])).filter((id): id is string => id !== null),
    ]),
  ]
  const movedPoIds = [...new Set(entries.flatMap((e) => (e.sourceType === 'PO_LINE' ? [moved.poOf.get(e.sourceId) ?? null] : [])).filter((id): id is string => id !== null))]
  const [movedRequests, movedPos] = await Promise.all([
    movedRequestIds.length ? tx.request.findMany({ where: { id: { in: movedRequestIds } }, select: { id: true, number: true, requesterMemberId: true, chargedDepartmentId: true } }) : [],
    movedPoIds.length ? tx.purchaseOrder.findMany({ where: { id: { in: movedPoIds } }, select: { id: true, number: true, createdById: true } }) : [],
  ])
  const movedRequestById = new Map(movedRequests.map((r) => [r.id, r]))
  const movedPoById = new Map(movedPos.map((p) => [p.id, p]))
  const documentOf = (e: (typeof entries)[number]): BudgetMovementDto['document'] => {
    if (e.sourceType === 'REQUEST_LINE') {
      const id = moved.requestOf.get(e.sourceId) ?? requestOfEvent.get(e.eventId)
      const r = id ? movedRequestById.get(id) : undefined
      return { type: 'REQUEST', id: r?.id ?? e.sourceId, label: r?.number ?? null, canOpen: r ? mayOpenRequest(principal, r) : false }
    }
    if (e.sourceType === 'PO_LINE') {
      const id = moved.poOf.get(e.sourceId)
      const po = id ? movedPoById.get(id) : undefined
      return { type: 'PURCHASE_ORDER', id: po?.id ?? e.sourceId, label: po?.number ?? null, canOpen: po ? mayOpenPo(principal, po) : false }
    }
    return { type: 'IMPORT', id: e.sourceId, label: importById.get(e.sourceId)?.fileName ?? null, canOpen: false }
  }

  const importDocs = [...perImport.entries()]
    .map(([id, held]): BudgetImportDocDto => {
      const file = importById.get(id)
      // INV-BUD-04: every ledger row has its event
      const at = file?.importedAt ?? occurredAt.get(held.eventId) ?? new Date(0)
      return { id, fileName: file?.fileName ?? null, at: at.toISOString(), amount: toMoneyDto(held.amount), lines: refs(held.lineIds) }
    })
    .sort((a, b) => b.at.localeCompare(a.at) || a.id.localeCompare(b.id))

  return {
    planned: { imports: importDocs.slice(0, BUDGET_DOCUMENT_LIMIT), count: importDocs.length, total: toMoneyDto(sum(fundings.map((f) => f.amountSatang))) },
    reserved: {
      requests: requestDocs,
      requestCount: requestReserved.size,
      purchaseOrders: poDocs(shownPos.reserved),
      purchaseOrderCount: poHeld.reserved.size,
      total: bucketTotal('reservedSatang'),
    },
    committed: { purchaseOrders: poDocs(shownPos.committed), count: poHeld.committed.size, total: bucketTotal('committedSatang') },
    actual: { purchaseOrders: actualPos.map((p) => ({ ...p, invoices: invoicesOf(p.id) })), count: poHeld.actual.size, total: bucketTotal('actualSatang') },
    movements: {
      rows: entries.map((e) => ({
        seq: e.seq,
        // INV-BUD-04: every ledger row has its event; the row's own time is only a fallback
        at: (occurredAt.get(e.eventId) ?? e.createdAt).toISOString(),
        kind: KIND_OF[`${e.fromBucket}>${e.toBucket}`] ?? null,
        from: e.fromBucket,
        to: e.toBucket,
        amount: toMoneyDto(e.amountSatang),
        line: { id: e.budgetLineId, code: codeOf.get(e.budgetLineId) ?? '' },
        document: documentOf(e),
      })),
      total: movementCount,
    },
  }
}
