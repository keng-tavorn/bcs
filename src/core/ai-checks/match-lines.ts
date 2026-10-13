// The PO line a delivery note's line names (BR-AI-25): the reading has no PO line number, so the code — never the AI —
// matches the words of the line to the PO's lines. The same words (spaces and case aside) name that line; otherwise the
// only PO line whose words the note's line contains, or that contains them. None or more than one → null: mapDeliveryNote
// flags it PO_LINE_UNKNOWN and the receiver fills that line by hand.

export interface PoLineText {
  readonly lineNo: number
  readonly description: string
}

const words = (s: string) => s.normalize('NFC').toLowerCase().replace(/\s+/g, ' ').trim()

export function matchPoLine(description: string | null | undefined, poLines: readonly PoLineText[]): number | null {
  const read = words(description ?? '')
  if (!read) return null
  const only = (found: readonly PoLineText[]) => (found.length === 1 ? found[0]!.lineNo : null)
  const same = poLines.filter((p) => words(p.description) === read)
  if (same.length) return only(same)
  return only(
    poLines.filter((p) => {
      const po = words(p.description)
      return po !== '' && (read.includes(po) || po.includes(read))
    }),
  )
}
