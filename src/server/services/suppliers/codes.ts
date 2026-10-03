// The supplier code a new supplier starts with on /suppliers/new (S4-02): the next code in the organization's own
// pattern, so PROCUREMENT need not invent one. Pure; the user may change it and the register refuses a code in use.

/**
 * The most common prefix before a number, with the next free number at the same width (S1…S5 → S6, V009 → V010).
 * null when no code ends in a number.
 */
export function suggestSupplierCode(codes: readonly string[]): string | null {
  const parts = codes.map((c) => /^(.*?)(\d+)$/.exec(c)).filter((m): m is RegExpExecArray => m !== null)
  if (parts.length === 0) return null
  const counts = new Map<string, number>()
  for (const [, prefix] of parts) counts.set(prefix!, (counts.get(prefix!) ?? 0) + 1)
  const prefix = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]![0]
  const numbers = parts.filter((m) => m[1] === prefix).map((m) => ({ value: BigInt(m[2]!), width: m[2]!.length }))
  const top = numbers.reduce((a, b) => (b.value > a.value ? b : a))
  const taken = new Set(codes)
  for (let next = top.value + 1n; ; next++) {
    const code = `${prefix}${next.toString().padStart(top.width, '0')}`
    if (!taken.has(code)) return code
  }
}
