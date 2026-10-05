import { amountToSatang, satangToAmount } from '@/core/money/dto'
import type { Satang } from '@/core/money/math'
import type { DemoHistoryRow } from '@/server/seed/sheets'

// The quotations a row of sheet Demo_History is sent with when its form's attachment rule asks for them (ATT-QUOTES
// above its amount, BR-FORM-04): the chosen one at the row's net, and two comparison quotations at exactly 104 % and
// 107 % of it. Nothing here is rounded: BR-MONEY-02 rounds only a line's amount, a document's VAT, withholding tax and
// largest-remainder shares, so a comparison that is not a whole satang is refused, never rounded. The sheet gives its
// nets in whole baht, whose 104 % and 107 % always are whole satang; as 107 shares no factor with 100, no other net's
// are. No database here: the seed checks every row before it writes anything, and a unit test runs it without one.

/** The two comparison quotations, in percent of the chosen one */
const COMPARISON_PERCENT = [104n, 107n] as const
const WHOLE_PERCENT = 100n

/** A row whose net is not whole baht: one of its comparison quotations is not a whole satang, and nothing rounds it */
export class DemoHistoryNetError extends Error {
  constructor(
    readonly ref: string,
    /** The row's net in baht, two decimals */
    readonly net: string,
    /** The comparison that is not a whole satang, in percent of the net */
    readonly percent: bigint,
  ) {
    super(`Demo_History ${ref}: a comparison quotation of ${percent}% of ${net} is not a whole satang and is never rounded (BR-MONEY-02): give the net in whole baht`)
    this.name = 'DemoHistoryNetError'
  }
}

/** A row's three quotation amounts: its net and the two comparisons, exact. Throws DemoHistoryNetError when a comparison is not a whole satang. */
export function quotationAmounts(row: Pick<DemoHistoryRow, 'ref' | 'net'>): Satang[] {
  const net = amountToSatang(row.net)
  const comparisons = COMPARISON_PERCENT.map((percent) => {
    const hundredths = net * percent
    if (hundredths % WHOLE_PERCENT !== 0n) throw new DemoHistoryNetError(row.ref, satangToAmount(net), percent)
    return hundredths / WHOLE_PERCENT
  })
  return [net, ...comparisons]
}
