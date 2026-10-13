import {
  DOA_DOCUMENT_TYPES,
  NO_AMOUNT_DOCUMENT_TYPES,
  bandOf,
  boundaryTable,
  chooseRule,
  type AmountBasis,
  type ApproverSpec,
  type DoaDocumentType,
  type DoaRuleSnapshot,
  type DoaVersionSnapshot,
} from '@/core/doa'

// What a new DOA version changes in who may approve what (FR-DOA-009 AC1, AC3; BR-DOA-08 (ช), BR-DOA-14), next to the
// rule-by-rule diff of diff.ts: the positions (or named people) that gain or lose authority, per document type and
// amount band, and the boundary table of two versions side by side — the rule and approvers at every band's upper end
// and one satang above, in either version. Rules are chosen with the engine's own chooseRule (BR-DOA-03), the same one
// boundaryTable and resolveRoute use; authority means the approvers a rule names, before any conflict moves a document
// to the next band (BR-DOA-06). Amounts are compared as numbers on each version's own basis: when the two versions read
// amounts on different bases (amountBasisChange), the same number is a different document in each, which the screens
// say beside both comparisons. Pure: rules in, data out; money as satang text.

/** What the comparisons read of a version: its rules (version-wide policies are compared by diffVersions) */
export interface VersionRules {
  readonly rules: readonly DoaRuleSnapshot[]
}

export type AuthorityChangeKind = 'GAIN' | 'LOSE'

export interface AuthorityChange {
  readonly change: AuthorityChangeKind
  readonly approver: ApproverSpec
  readonly documentType: DoaDocumentType
  /** Amounts above `gt` up to `lte` (satang text, null = no upper end); null for documents without an amount */
  readonly band: { readonly gt: string; readonly lte: string | null } | null
}

export interface BoundarySide {
  /** null when no rule, or more than one rule, ranks first at this amount */
  readonly ruleCode: string | null
  readonly approvers: readonly ApproverSpec[]
}

export interface BoundaryCompareRow {
  /** satang text */
  readonly amount: string
  /** The version compared with; null when there is none */
  readonly before: BoundarySide | null
  readonly after: BoundarySide
  /** The approvers at this amount differ between the two versions */
  readonly changed: boolean
}

export interface BoundaryCompareTable {
  readonly documentType: DoaDocumentType
  readonly rows: readonly BoundaryCompareRow[]
}

const EPOCH = new Date(0)

/** chooseRule reads a version's rules only; the other fields of the snapshot do not take part */
function snapshotOf(version: VersionRules): DoaVersionSnapshot {
  return {
    id: '',
    code: '',
    versionNo: 1,
    status: 'DRAFT',
    effectiveFrom: EPOCH,
    effectiveTo: null,
    amountBasis: 'GROSS',
    selfApprovalPolicy: 'ESCALATE_NEXT_BAND',
    collapseDuplicateApprovers: true,
    rules: version.rules,
  }
}

/** One approver as a comparable key */
export const approverKey = (a: ApproverSpec) => (a.kind === 'MEMBER' ? `MEMBER:${a.memberId}` : `${a.kind}:${a.position}`)

/** The rule the engine picks for this document type and amount, and the approvers it names */
function sideAt(version: DoaVersionSnapshot, documentType: DoaDocumentType, amount: bigint | null): BoundarySide {
  const choice = chooseRule(version, documentType, amount)
  if (choice.kind !== 'rule') return { ruleCode: null, approvers: [] }
  return { ruleCode: choice.rule.code, approvers: choice.rule.steps.map((s) => s.approver) }
}

const sameApprovers = (a: BoundarySide, b: BoundarySide) => a.approvers.map(approverKey).join('|') === b.approvers.map(approverKey).join('|')

/** Band ends of a document type in either version (satang, lower ends exclusive), from zero up, distinct and sorted */
function bandEdges(versions: readonly DoaVersionSnapshot[], documentType: DoaDocumentType): bigint[] {
  const edges = new Set<bigint>([0n])
  for (const version of versions) {
    for (const rule of version.rules) {
      if (rule.documentType !== documentType || !rule.when.amount) continue
      const band = bandOf(rule.when.amount)
      for (const edge of [band.lower, band.upper]) if (edge !== null && edge > 0n) edges.add(edge)
    }
  }
  // distinct values (a Set), so no two compare equal
  return [...edges].sort((a, b) => (a < b ? -1 : 1))
}

/**
 * Who gains and who loses authority from `before` to `after`: for every document type, the amounts are cut at every
 * band end of both versions, and in each piece the approvers the two versions name are compared. Adjacent pieces with
 * the same change are joined. Documents without an amount (NO_AMOUNT_DOCUMENT_TYPES) are compared once.
 * Ordered by document type, then amount, gains before losses.
 */
export function authorityChanges(before: VersionRules, after: VersionRules): AuthorityChange[] {
  const old = snapshotOf(before)
  const now = snapshotOf(after)
  const changes: AuthorityChange[] = []
  for (const documentType of DOA_DOCUMENT_TYPES) {
    if (NO_AMOUNT_DOCUMENT_TYPES.includes(documentType)) {
      const a = sideAt(old, documentType, null)
      const b = sideAt(now, documentType, null)
      const was = new Set(a.approvers.map(approverKey))
      const is = new Set(b.approvers.map(approverKey))
      for (const approver of b.approvers.filter((x) => !was.has(approverKey(x)))) changes.push({ change: 'GAIN', approver, documentType, band: null })
      for (const approver of a.approvers.filter((x) => !is.has(approverKey(x)))) changes.push({ change: 'LOSE', approver, documentType, band: null })
      continue
    }
    const edges = bandEdges([old, now], documentType)
    // The change of the piece just before, by change and approver, so the next piece can extend it
    let open = new Map<string, { change: AuthorityChangeKind; approver: ApproverSpec; gt: bigint; lte: bigint | null }>()
    const pieces: Array<{ change: AuthorityChangeKind; approver: ApproverSpec; gt: bigint; lte: bigint | null }> = []
    edges.forEach((lower, i) => {
      const upper = edges[i + 1] ?? null
      // Every amount of the piece (lower, upper] picks the same rules, so its first satang speaks for all of it
      const a = sideAt(old, documentType, lower + 1n)
      const b = sideAt(now, documentType, lower + 1n)
      const was = new Set(a.approvers.map(approverKey))
      const is = new Set(b.approvers.map(approverKey))
      const here = [
        ...b.approvers.filter((x) => !was.has(approverKey(x))).map((approver) => ({ change: 'GAIN' as const, approver })),
        ...a.approvers.filter((x) => !is.has(approverKey(x))).map((approver) => ({ change: 'LOSE' as const, approver })),
      ]
      const next = new Map<string, (typeof pieces)[number]>()
      for (const { change, approver } of here) {
        const id = `${change}|${approverKey(approver)}`
        if (next.has(id)) continue
        const previous = open.get(id)
        if (previous && previous.lte === lower) {
          previous.lte = upper
          next.set(id, previous)
        } else {
          const piece = { change, approver, gt: lower, lte: upper }
          pieces.push(piece)
          next.set(id, piece)
        }
      }
      open = next
    })
    pieces.sort((x, y) => (x.gt === y.gt ? (x.change === y.change ? 0 : x.change === 'GAIN' ? -1 : 1) : x.gt < y.gt ? -1 : 1))
    for (const p of pieces) changes.push({ change: p.change, approver: p.approver, documentType, band: { gt: p.gt.toString(), lte: p.lte === null ? null : p.lte.toString() } })
  }
  return changes
}

/**
 * The amount bases of two versions when they differ (BR-DOA-02: GROSS reads net + VAT, NET the net amount), else null.
 * Bands are then on different bases: 20,000.00 including VAT and 20,000.00 before VAT are different documents, so a
 * boundary row or a band piece that names the same approvers in both versions does not mean the same documents do.
 */
export function amountBasisChange(before: { readonly amountBasis: AmountBasis }, after: { readonly amountBasis: AmountBasis }): { readonly before: AmountBasis; readonly after: AmountBasis } | null {
  return before.amountBasis === after.amountBasis ? null : { before: before.amountBasis, after: after.amountBasis }
}

/**
 * The boundary table (BR-DOA-08 (ช)) of `after`, beside the same amounts in `before`: every upper band end of either
 * version and one satang above it, with the rule and approvers of each version. Without `before` the rows are exactly
 * boundaryTable(after) (GC-DOA-22). Only document types whose rules have amount bands get a table.
 */
export function boundaryComparison(before: VersionRules | null, after: VersionRules): BoundaryCompareTable[] {
  const old = before ? snapshotOf(before) : null
  const now = snapshotOf(after)
  const tables: BoundaryCompareTable[] = []
  for (const documentType of DOA_DOCUMENT_TYPES) {
    const amounts = new Set<bigint>()
    for (const version of old ? [old, now] : [now]) for (const row of boundaryTable(version, documentType)) amounts.add(row.amountSatang)
    if (amounts.size === 0) continue
    // distinct values (a Set), so no two compare equal
    const rows = [...amounts]
      .sort((a, b) => (a < b ? -1 : 1))
      .map((amount): BoundaryCompareRow => {
        const b = sideAt(now, documentType, amount)
        const a = old ? sideAt(old, documentType, amount) : null
        // No rule at all names no approver, so a rule appearing or disappearing at an amount is a change too
        return { amount: amount.toString(), before: a, after: b, changed: a !== null && !sameApprovers(a, b) }
      })
    tables.push({ documentType, rows })
  }
  return tables
}
