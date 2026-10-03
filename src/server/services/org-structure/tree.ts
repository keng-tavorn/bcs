// The department tree in reading order (§6.2: one tree per organization): the root first, every department followed by
// its children (by code), each with its depth. A department whose parent is missing (never in a valid organization) is
// listed at the end at depth 0, so nothing disappears from a screen. Pure.

export function treeOrder<T extends { readonly id: string; readonly parentId: string | null; readonly code: string }>(rows: readonly T[]): Array<T & { readonly depth: number }> {
  const children = new Map<string | null, T[]>()
  for (const row of rows) {
    const siblings = children.get(row.parentId) ?? []
    siblings.push(row)
    children.set(row.parentId, siblings)
  }
  for (const siblings of children.values()) siblings.sort((a, b) => a.code.localeCompare(b.code))
  const ordered: Array<T & { depth: number }> = []
  const placed = new Set<string>()
  const visit = (row: T, depth: number) => {
    if (placed.has(row.id)) return
    placed.add(row.id)
    ordered.push({ ...row, depth })
    for (const child of children.get(row.id) ?? []) visit(child, depth + 1)
  }
  for (const root of children.get(null) ?? []) visit(root, 0)
  for (const row of [...rows].sort((a, b) => a.code.localeCompare(b.code))) visit(row, 0)
  return ordered
}
