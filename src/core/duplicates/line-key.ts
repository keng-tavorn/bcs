// The key of a request or PO line (spec §7.17, BR-DUP-01): its catalogue item when it has one; otherwise its
// description in Unicode NFC, trimmed, inner spaces collapsed and in lower case, then "|" and its unit. Two lines with the
// same key are the same thing bought: the duplicate check (S6-13) and the price reference (S6-11, BR-PRC-01) use it.

export interface KeyedLine {
  readonly catalogItemId?: string | null
  readonly description: string
  readonly uom: string
}

export function lineKey(line: KeyedLine): string {
  if (line.catalogItemId) return `item:${line.catalogItemId}`
  return `${line.description.normalize('NFC').trim().replace(/\s+/g, ' ').toLowerCase()}|${line.uom}`
}
