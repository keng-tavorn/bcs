import { lineNet, type Satang } from '../money/math'

// Goods received not yet invoiced (spec §7.16, BR-RPT-01): per PO line at the cut-off date, the value received is the
// quantity accepted on GRs POSTED up to that date × the unit price before VAT, rounded half up to the satang; the value
// invoiced is the amount before VAT shared to the line (BR-IVC-04) by invoices recorded up to that date. Received not
// invoiced = max(received − invoiced, 0); invoiced before the goods = max(invoiced − received, 0), its own column. The
// first is totalled per cost center and per budget line. The report posts nothing (BR-RPT-02).

export interface GrniLineInput {
  readonly costCenter: string
  readonly budgetLineId?: string | null
  /** Accepted on POSTED GRs up to the cut-off date, decimal text */
  readonly accepted: string
  readonly unitPriceSatang: Satang
  /** Shared to the line by invoices recorded up to the cut-off date */
  readonly invoicedSatang: Satang
}

export interface GrniLine {
  readonly receivedSatang: Satang
  readonly grniSatang: Satang
  readonly invoicedNotReceivedSatang: Satang
}

export interface GrniReport {
  readonly lines: readonly GrniLine[]
  readonly byCostCenter: ReadonlyMap<string, Satang>
  readonly byBudgetLine: ReadonlyMap<string, Satang>
  /** Equals the sum of the lines (FR-VIS-005 AC3) */
  readonly totalSatang: Satang
}

const add = (totals: Map<string, Satang>, key: string, amount: Satang) => totals.set(key, (totals.get(key) ?? 0n) + amount)

export function grniReport(input: readonly GrniLineInput[]): GrniReport {
  const byCostCenter = new Map<string, Satang>()
  const byBudgetLine = new Map<string, Satang>()
  let totalSatang = 0n
  const lines = input.map((l) => {
    if (l.unitPriceSatang < 0n || l.invoicedSatang < 0n) throw new RangeError('a unit price and an invoiced amount of zero or more are needed')
    const receivedSatang = lineNet(l.accepted, l.unitPriceSatang)
    const gap = receivedSatang - l.invoicedSatang
    const grniSatang = gap > 0n ? gap : 0n
    add(byCostCenter, l.costCenter, grniSatang)
    if (l.budgetLineId) add(byBudgetLine, l.budgetLineId, grniSatang)
    totalSatang += grniSatang
    return { receivedSatang, grniSatang, invoicedNotReceivedSatang: gap < 0n ? -gap : 0n }
  })
  return { lines, byCostCenter, byBudgetLine, totalSatang }
}
