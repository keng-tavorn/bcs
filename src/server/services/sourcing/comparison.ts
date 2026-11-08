import { createHash } from 'node:crypto'
import ExcelJS from 'exceljs'
import { z } from 'zod'
import { lineKey } from '@/core/duplicates'
import { satangToAmount } from '@/core/money/dto'
import type { Satang } from '@/core/money/math'
import { priceStats } from '@/core/pricing'
import type { Result } from '@/core/result'
import { compareBids, priceAnomaly, type BidPrice, type PriceFlag, type PriceRefSource } from '@/core/sourcing'
import { taxDateOf } from '@/core/vat'
import { putObject } from '@/integrations/storage'
import { MS_PER_DAY } from '@/lib/constants'
import { newId } from '@/lib/ids'
import { s6SettingsOf, sourcingSettingsOf } from '@/lib/org-settings'
import type { Ctx } from '@/server/context'
import { forTenant, type TenantTx } from '@/server/db/tenant'
import { priceSamples } from '@/server/queries/price-reference'
import { defineCommand, runCommand, type CommandOutcome, type RunOptions } from '../_pipeline'
import { enabledModules, requireModule } from '../modules'
import { rfxReading } from './access'
import { supplierRiskStatus } from './risk-link'

// The comparison table of an RFx (S10-09 · BR-RFX-08 BR-RFX-11 · FR-SRC-202 AC5 · FR-SRC-203 AC4): every bid sent, its
// amounts before VAT by compareBids (a bid quoted with VAT is brought to its amount before VAT and spread over its lines
// by largest remainder), the price as quoted, its tags (VAT included, not registered for VAT, abroad, the incumbent,
// recorded on behalf, sent before revision n), and per line and bid the reference price and its one flag
// (ABOVE_AGREEMENT before HIGH/LOW): the bidder's own agreed price, else the lowest agreed price of another supplier,
// else the catalogue's, else the median of the history (priceStats of S6 when it has enough samples), else the price
// procurement typed. With RISK on, each bidder's tier and whether S11's gate would stop a PO (a tag, never a score).
// Sealed before the close: nothing but sealed: true. Read by those who read the RFx's prices (access.ts). The facts for
// an approver and the AI (comparisonFacts) are numbers and codes only — no supplier's free text, no contact — and an
// individual supplier is named by code. Excel export with its sha256 (ExportJob kind REPORT · RFX_COMPARISON).

export type ComparisonTag = 'VAT_INCLUDED' | 'NOT_VAT_REGISTERED' | 'FOREIGN' | 'INCUMBENT' | 'ON_BEHALF' | 'BEFORE_REVISION'

export interface ComparisonReference {
  readonly unitPrice: string
  readonly source: PriceRefSource
}

export interface ComparisonBidLine {
  readonly rfxLineId: string
  readonly offered: boolean
  /** As quoted: before VAT, or with VAT when the bid included it */
  readonly quotedUnitPrice: string | null
  /** The line's share of the bid's amount before VAT */
  readonly lineNet: string | null
  readonly reference: ComparisonReference | null
  readonly deviationBp: number | null
  readonly flag: PriceFlag | null
  /** The lowest amount before VAT on this line */
  readonly lowest: boolean
}

export interface ComparisonBid {
  readonly bidId: string
  readonly supplierId: string
  readonly supplierCode: string
  readonly supplierName: string
  readonly individual: boolean
  readonly net: string
  readonly vat: string
  readonly gross: string
  readonly vatRateBp: number
  readonly partial: boolean
  /** One of the lowest complete bids by amount before VAT */
  readonly lowest: boolean
  readonly tags: readonly ComparisonTag[]
  /** The revision of the RFx the bid answered (BEFORE_REVISION when below the RFx's) */
  readonly revisionNoAtSubmit: number | null
  readonly risk: { readonly tier: string | null; readonly blocked: boolean } | null
  readonly lines: readonly ComparisonBidLine[]
}

export interface RfxComparison {
  readonly rfx: { readonly id: string; readonly number: string | null; readonly title: string; readonly status: string; readonly revisionNo: number; readonly priceAnomalyBp: number }
  /** Before the close of a sealed RFx: true, and no bid */
  readonly sealed: boolean
  readonly lines: ReadonlyArray<{ readonly id: string; readonly lineNo: number; readonly description: string; readonly quantity: string; readonly uom: string }>
  readonly bids: readonly ComparisonBid[]
}

const BEFORE_CLOSE = new Set(['DRAFT', 'OPEN'])
const PO_DONE = ['SENT', 'PARTIALLY_RECEIVED', 'RECEIVED', 'CLOSED'] as const

/** The table itself, for a reader already allowed (the callers check rfxReading) */
export async function comparisonOf(tx: TenantTx, organizationId: string, rfxEventId: string, now: Date): Promise<RfxComparison | null> {
  const rfx = await tx.rfxEvent.findUnique({ where: { id: rfxEventId }, select: { id: true, number: true, title: true, status: true, revisionNo: true, sealed: true, openedAt: true, categoryCode: true } })
  if (!rfx) return null
  const org = await tx.organization.findUniqueOrThrow({ where: { id: organizationId }, select: { settings: true } })
  const sourcing = sourcingSettingsOf(org.settings)
  const head = { id: rfx.id, number: rfx.number, title: rfx.title, status: rfx.status, revisionNo: rfx.revisionNo, priceAnomalyBp: sourcing.priceAnomalyBp }
  const lines = await tx.rfxLine.findMany({ where: { rfxEventId }, orderBy: { lineNo: 'asc' }, select: { id: true, lineNo: true, description: true, quantity: true, uom: true, catalogItemId: true, refUnitPriceSatang: true, refSource: true } })
  const lineRows = lines.map((l) => ({ id: l.id, lineNo: l.lineNo, description: l.description, quantity: l.quantity.toString(), uom: l.uom }))
  // BR-RFX-06: before the close of a sealed RFx nobody inside sees a price
  if (rfx.sealed && BEFORE_CLOSE.has(rfx.status)) return { rfx: head, sealed: true, lines: lineRows, bids: [] }
  const bids = await tx.bid.findMany({
    where: { rfxEventId, status: 'SUBMITTED' },
    orderBy: [{ submittedAt: 'asc' }, { id: 'asc' }],
    select: {
      id: true,
      supplierId: true,
      priceIncludesVat: true,
      vatRateBp: true,
      isVatRegistered: true,
      revisionNoAtSubmit: true,
      submittedByMemberId: true,
      supplier: { select: { code: true, nameTh: true, isForeign: true, payeeType: true } },
      lines: { select: { rfxLineId: true, offered: true, unitPriceSatang: true } },
    },
  })
  const comparison = compareBids(
    lines.map((l) => ({ ref: l.id, quantity: l.quantity.toString() })),
    bids.map((b) => ({ ref: b.id, priceIncludesVat: b.priceIncludesVat, vatRateBp: b.vatRateBp ?? 0, unitPrices: Object.fromEntries(b.lines.filter((l) => l.offered && l.unitPriceSatang !== null).map((l) => [l.rfxLineId, l.unitPriceSatang!])) })),
  )
  const byBid = new Map(comparison.bids.map((c) => [c.ref, c]))
  const lowest = new Set(comparison.lowest)
  const lineLowest = new Map(comparison.lineLowest)

  // the references of BR-RFX-11 as of the day the RFx opened
  const day = new Date(`${taxDateOf(rfx.openedAt ?? now)}T00:00:00Z`)
  const items = [...new Set(lines.map((l) => l.catalogItemId).filter((id): id is string => id !== null))]
  const agreements = items.length
    ? await tx.priceAgreement.findMany({ where: { catalogItemId: { in: items }, validFrom: { lte: day }, validTo: { gt: day }, endedAt: null, unitPriceSatang: { gt: 0n } }, select: { catalogItemId: true, supplierId: true, unitPriceSatang: true } })
    : []
  const catalog = new Map(items.length ? (await tx.catalogItem.findMany({ where: { id: { in: items } }, select: { id: true, refUnitPriceSatang: true } })).map((c) => [c.id, c.refUnitPriceSatang]) : [])
  const s6 = s6SettingsOf(org.settings)
  const samples = await priceSamples(
    tx,
    lines.map((l) => ({ description: l.description, uom: l.uom, catalogItemId: l.catalogItemId })),
    new Date(day.getTime() - s6.priceRefWindowDays * MS_PER_DAY),
    day,
  )
  const history = new Map<string, Satang>()
  for (const l of lines) {
    const stats = priceStats(samples.get(lineKey({ catalogItemId: l.catalogItemId, description: l.description, uom: l.uom })) ?? [], day, { windowDays: s6.priceRefWindowDays, minSamples: s6.priceRefMinSamples, alertBp: 0 })
    if (stats.status === 'OK' && stats.median !== null && stats.median > 0n) history.set(l.id, stats.median)
  }
  function referenceOf(line: (typeof lines)[number], supplierId: string): { unitPriceSatang: Satang; source: PriceRefSource } | null {
    if (line.catalogItemId) {
      const own = agreements.filter((a) => a.catalogItemId === line.catalogItemId && a.supplierId === supplierId).sort((a, b) => (a.unitPriceSatang < b.unitPriceSatang ? -1 : 1))[0]
      if (own) return { unitPriceSatang: own.unitPriceSatang, source: 'AGREEMENT' }
      const other = agreements.filter((a) => a.catalogItemId === line.catalogItemId && a.supplierId !== supplierId).sort((a, b) => (a.unitPriceSatang < b.unitPriceSatang ? -1 : 1))[0]
      if (other) return { unitPriceSatang: other.unitPriceSatang, source: 'AGREEMENT_OTHER' }
      const item = catalog.get(line.catalogItemId)
      if (item && item > 0n) return { unitPriceSatang: item, source: 'CATALOG' }
    }
    const median = history.get(line.id)
    if (median) return { unitPriceSatang: median, source: 'HISTORY' }
    return line.refSource === 'MANUAL' && line.refUnitPriceSatang && line.refUnitPriceSatang > 0n ? { unitPriceSatang: line.refUnitPriceSatang, source: 'MANUAL' } : null
  }

  // the incumbents: suppliers of a purchase order of this category in the window of the price reference
  const incumbents = new Set(
    bids.length
      ? (
          await tx.purchaseOrder.findMany({
            where: { supplierId: { in: bids.map((b) => b.supplierId) }, status: { in: [...PO_DONE] }, approvedAt: { gte: new Date(day.getTime() - s6.priceRefWindowDays * MS_PER_DAY) }, lines: { some: { sources: { some: { requestLine: { categoryCode: rfx.categoryCode } } } } } },
            select: { supplierId: true },
          })
        ).map((p) => p.supplierId)
      : [],
  )
  const riskOn = bids.length > 0 && (await enabledModules(tx)).includes('RISK')
  const anomalyBp = sourcing.priceAnomalyBp
  const out: ComparisonBid[] = []
  for (const b of bids) {
    const c = byBid.get(b.id)!
    const lineNet = new Map(c.lineNet)
    const tags: ComparisonTag[] = []
    if (b.priceIncludesVat) tags.push('VAT_INCLUDED')
    if (!b.isVatRegistered) tags.push('NOT_VAT_REGISTERED')
    if (b.supplier.isForeign) tags.push('FOREIGN')
    if (incumbents.has(b.supplierId)) tags.push('INCUMBENT')
    if (b.submittedByMemberId) tags.push('ON_BEHALF')
    if (b.revisionNoAtSubmit !== null && b.revisionNoAtSubmit < rfx.revisionNo) tags.push('BEFORE_REVISION')
    out.push({
      bidId: b.id,
      supplierId: b.supplierId,
      supplierCode: b.supplier.code,
      supplierName: b.supplier.nameTh,
      individual: b.supplier.payeeType === 'INDIVIDUAL',
      net: satangToAmount(c.net),
      vat: satangToAmount(c.vat),
      gross: satangToAmount(c.gross),
      vatRateBp: b.vatRateBp ?? 0,
      partial: c.partial,
      lowest: lowest.has(b.id),
      tags,
      revisionNoAtSubmit: b.revisionNoAtSubmit,
      risk: riskOn ? await supplierRiskStatus(tx, organizationId, b.supplierId, now) : null,
      lines: lines.map((l) => {
        const mine = b.lines.find((x) => x.rfxLineId === l.id)
        const offered = Boolean(mine?.offered && mine.unitPriceSatang !== null)
        const net = lineNet.get(l.id)
        const reference = referenceOf(l, b.supplierId)
        // a bid with VAT is flagged through its line's amount before VAT over the quantity (BR-RFX-11)
        const price: BidPrice | null = !offered ? null : b.priceIncludesVat ? { lineNetSatang: net!, quantity: l.quantity.toString() } : { unitPriceSatang: mine!.unitPriceSatang! }
        const check = price ? priceAnomaly(price, reference, anomalyBp) : { deviationBp: null, flag: null }
        return {
          rfxLineId: l.id,
          offered,
          quotedUnitPrice: offered ? satangToAmount(mine!.unitPriceSatang!) : null,
          lineNet: net === undefined ? null : satangToAmount(net),
          reference: reference ? { unitPrice: satangToAmount(reference.unitPriceSatang), source: reference.source } : null,
          deviationBp: check.deviationBp,
          flag: check.flag,
          lowest: lineLowest.get(l.id) === b.id,
        }
      }),
    })
  }
  return { rfx: head, sealed: false, lines: lineRows, bids: out }
}

/** The comparison table for a member who reads the RFx's prices (PROCUREMENT FINANCE EXECUTIVE AUDITOR, its evaluators) */
export async function rfxComparison(ctx: Ctx, rfxEventId: string): Promise<Result<RfxComparison>> {
  return forTenant(ctx.organizationId).$transaction(async (tx): Promise<Result<RfxComparison>> => {
    const on = await requireModule(ctx, 'SOURCING', tx)
    if (!on.ok) return on
    const exists = await tx.rfxEvent.findUnique({ where: { id: rfxEventId }, select: { id: true } })
    if (!exists) return { ok: false, error: { code: 'NOT_FOUND', message: 'RFx not found' } }
    const may = await rfxReading(tx, ctx, rfxEventId)
    if (!may.ok) return may
    if (may.data !== 'PRICES') return { ok: false, error: { code: 'FORBIDDEN', message: 'a requester sees the RFx, not its prices', details: { reason: 'PRICES' } } }
    const table = await comparisonOf(tx, ctx.organizationId, rfxEventId, ctx.now)
    return table ? { ok: true, data: table } : { ok: false, error: { code: 'NOT_FOUND', message: 'RFx not found' } }
  })
}

// ---------- the facts for an approver and the AI (numbers and codes only · BR-AI-32) ----------

export interface ComparisonFacts {
  readonly sealed: boolean
  readonly priceAnomalyBp: number
  readonly lines: ReadonlyArray<{ readonly lineNo: number; readonly quantity: string; readonly uom: string }>
  readonly bids: ReadonlyArray<{
    readonly supplierCode: string
    /** The supplier's name, or "ผู้ขายบุคคลธรรมดา <code>" for an individual (BR-AI-32) */
    readonly supplier: string
    readonly net: string
    readonly vat: string
    readonly gross: string
    readonly partial: boolean
    readonly lowest: boolean
    readonly tags: readonly ComparisonTag[]
    readonly risk: { readonly tier: string | null; readonly blocked: boolean } | null
    readonly lines: ReadonlyArray<{ readonly lineNo: number; readonly quotedUnitPrice: string | null; readonly lineNet: string | null; readonly referenceSource: PriceRefSource | null; readonly deviationBp: number | null; readonly flag: PriceFlag | null }>
  }>
}

/** The short facts of the table: no line description, no brand or note of a supplier, no contact, an individual by code */
export function comparisonFacts(table: RfxComparison): ComparisonFacts {
  const lineNo = new Map(table.lines.map((l) => [l.id, l.lineNo]))
  return {
    sealed: table.sealed,
    priceAnomalyBp: table.rfx.priceAnomalyBp,
    lines: table.lines.map((l) => ({ lineNo: l.lineNo, quantity: l.quantity, uom: l.uom })),
    bids: table.bids.map((b) => ({
      supplierCode: b.supplierCode,
      supplier: b.individual ? `ผู้ขายบุคคลธรรมดา ${b.supplierCode}` : b.supplierName,
      net: b.net,
      vat: b.vat,
      gross: b.gross,
      partial: b.partial,
      lowest: b.lowest,
      tags: b.tags,
      risk: b.risk,
      lines: b.lines.map((l) => ({ lineNo: lineNo.get(l.rfxLineId)!, quotedUnitPrice: l.quotedUnitPrice, lineNet: l.lineNet, referenceSource: l.reference?.source ?? null, deviationBp: l.deviationBp, flag: l.flag })),
    })),
  }
}

// ---------- rfx.exportComparison: the table as an Excel file with its sha256 ----------

const SHEET = 'เทียบราคา'
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'

async function workbookOf(table: RfxComparison): Promise<{ bytes: Uint8Array; rows: number }> {
  const workbook = new ExcelJS.Workbook()
  const sheet = workbook.addWorksheet(SHEET)
  sheet.addRow([table.rfx.number ?? '', table.rfx.title])
  sheet.addRow(['ผู้ขาย', 'รหัส', 'บรรทัด', 'รายการ', 'จำนวน', 'หน่วย', 'ราคาที่ยื่น', 'ยอดก่อน VAT ของบรรทัด', 'ราคาอ้างอิง', 'ที่มา', 'ส่วนต่าง (bp)', 'ธง'])
  let rows = 0
  for (const b of table.bids) {
    for (const l of b.lines) {
      const line = table.lines.find((x) => x.id === l.rfxLineId)!
      sheet.addRow([b.individual ? `ผู้ขายบุคคลธรรมดา ${b.supplierCode}` : b.supplierName, b.supplierCode, line.lineNo, line.description, line.quantity, line.uom, l.quotedUnitPrice ?? 'ไม่เสนอ', l.lineNet ?? '', l.reference?.unitPrice ?? '', l.reference?.source ?? '', l.deviationBp ?? '', l.flag ?? ''])
      rows += 1
    }
    sheet.addRow([b.individual ? `ผู้ขายบุคคลธรรมดา ${b.supplierCode}` : b.supplierName, b.supplierCode, 'รวม', b.tags.join(' '), '', '', '', b.net, `VAT ${b.vat}`, `รวม ${b.gross}`, b.partial ? 'ไม่ครบ' : '', b.lowest ? 'ต่ำสุด' : ''])
  }
  return { bytes: new Uint8Array(await workbook.xlsx.writeBuffer()), rows }
}

export const exportComparisonCommand = defineCommand({
  name: 'rfx.exportComparison',
  capability: 'sourcing.view',
  input: z.strictObject({ rfxEventId: z.uuid() }),
  async execute(tx, input, ctx): Promise<CommandOutcome<{ exportJobId: string; fileId: string; rowCount: number; checksum: string }>> {
    const on = await requireModule(ctx, 'SOURCING', tx)
    if (!on.ok) return { ok: false, error: on.error }
    const may = await rfxReading(tx, ctx, input.rfxEventId)
    if (!may.ok) return { ok: false, error: may.error }
    if (may.data !== 'PRICES') return { ok: false, error: { code: 'FORBIDDEN', message: 'a requester sees the RFx, not its prices', details: { reason: 'PRICES' } } }
    const table = await comparisonOf(tx, ctx.organizationId, input.rfxEventId, ctx.now)
    if (!table) return { ok: false, error: { code: 'NOT_FOUND', message: 'RFx not found' } }
    if (table.sealed) return { ok: false, error: { code: 'FORBIDDEN', message: 'sealed until the close', details: { reason: 'SEALED' } } }
    const { bytes, rows } = await workbookOf(table)
    const checksum = createHash('sha256').update(bytes).digest('hex')
    const fileId = newId()
    const exportJobId = newId()
    const fileName = `${table.rfx.number ?? 'rfx'}-comparison.xlsx`
    const memberId = ctx.actor.type === 'USER' ? ctx.actor.memberId : null
    const key = `${ctx.organizationId}/exports/${exportJobId}.xlsx`
    await putObject(key, bytes, XLSX)
    await tx.fileObject.create({ data: { id: fileId, organizationId: ctx.organizationId, storageKey: key, fileName, mimeType: XLSX, sizeBytes: bytes.length, sha256: checksum, status: 'AVAILABLE', uploadedById: memberId } })
    await tx.exportJob.create({
      data: { id: exportJobId, organizationId: ctx.organizationId, kind: 'REPORT', params: { reportCode: 'RFX_COMPARISON', rfxEventId: input.rfxEventId }, status: 'COMPLETED', fileId, rowCount: rows, checksum, requestedById: memberId!, completedAt: ctx.now },
    })
    return {
      ok: true,
      result: { exportJobId, fileId, rowCount: rows, checksum },
      events: [{ type: 'export.generated', aggregateType: 'ExportJob', aggregateId: exportJobId, data: { kind: 'REPORT', rowCount: rows, totalSatang: '0', checksum, fileId, invoiceIds: [], excludedInvoiceIds: [], again: false } }],
    }
  },
})

export const exportComparison = (ctx: Ctx, input: { rfxEventId: string }, opts: RunOptions) => runCommand(ctx, exportComparisonCommand, input, opts)
