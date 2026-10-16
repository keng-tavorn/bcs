// What the 90-day backtest panel shows (FR-DOA-103 · BR-WF-13 · FR-WF-103 AC2, S6-07), worked out from the service's
// answer without React so it is tested on its own: the window, the counts, the load per person (who gets more tasks
// and who fewer under the draft, named), and the documents whose route changes — each side's rule, approvers and
// reviewers named, or the engine's refusal as a key the panel says in words. Rows that do not change are left out.
// The shapes copy src/server/services/backtest's BacktestView (screens never import services).

export interface BacktestSideDto {
  readonly rule: string | null
  readonly approvers: readonly string[]
  readonly reviewers: readonly string[]
  readonly error: string | null
}

export interface BacktestRowDto {
  readonly ref: string
  readonly current: BacktestSideDto
  readonly draft: BacktestSideDto
  readonly changed: boolean
}

export type BacktestViewDto =
  | {
      readonly status: 'DONE'
      readonly from: string
      readonly to: string
      readonly documentCount: number
      readonly result: { readonly rows: readonly BacktestRowDto[]; readonly summary: { readonly total: number; readonly changed: number; readonly load: Readonly<Record<string, number>> } }
      readonly documents: ReadonlyArray<{ readonly ref: string; readonly subjectType: string; readonly label: string; readonly sentAt: string }>
      readonly members: Readonly<Record<string, { readonly th: string; readonly en: string | null }>>
    }
  | { readonly status: 'PENDING'; readonly runId: string; readonly documentCount: number }
  | { readonly status: 'FAILED'; readonly runId: string; readonly documentCount: number }

export type BacktestDoneDto = Extract<BacktestViewDto, { status: 'DONE' }>

/** The engine's refusals the panel says in words; any other code is said with its code */
export const SIDE_ERRORS = ['APPROVER_NOT_FOUND', 'REVIEWER_NOT_FOUND', 'NO_HIGHER_AUTHORITY', 'DOA_NOT_CONFIGURED', 'DOA_AMBIGUOUS', 'SOD_VIOLATION'] as const
export type SideErrorKey = (typeof SIDE_ERRORS)[number] | 'OTHER'

/** The kinds of document the panel names; any other is named as a document */
export const SUBJECT_TYPES = ['REQUEST', 'PURCHASE_ORDER', 'VARIANCE', 'BUDGET_TRANSFER', 'BUDGET_OVERRUN', 'INVOICE', 'PO_CHANGE', 'PAYMENT_RUN', 'BANK_ACCOUNT_CHANGE'] as const
export type SubjectTypeKey = (typeof SUBJECT_TYPES)[number] | 'OTHER'

export interface SideModel {
  readonly rule: string | null
  readonly approvers: readonly string[]
  readonly reviewers: readonly string[]
  /** The refusal's key, and its code for OTHER */
  readonly error: { readonly key: SideErrorKey; readonly code: string } | null
}

export interface RowModel {
  readonly ref: string
  readonly label: string
  readonly subjectType: SubjectTypeKey
  readonly sentAt: string | null
  readonly current: SideModel
  readonly draft: SideModel
}

export interface LoadModel {
  readonly memberId: string
  readonly name: string
  readonly delta: number
  /** "+2" or "−1" (a minus sign, not a hyphen) */
  readonly text: string
}

export interface BacktestModel {
  readonly from: string
  readonly to: string
  readonly total: number
  readonly changed: number
  /** More tasks first, then fewer; by name within each */
  readonly load: readonly LoadModel[]
  readonly rows: readonly RowModel[]
}

/** A change of load as the panel writes it: +n or −n */
export function loadText(delta: number): string {
  return delta > 0 ? `+${delta}` : `−${Math.abs(delta)}`
}

/** A member's name in the reader's language (Thai when no English name is given); an unknown id stays as itself */
export function memberNameOf(members: BacktestDoneDto['members'], id: string, locale: string): string {
  const m = members[id]
  if (!m) return id
  return locale === 'en' && m.en ? m.en : m.th
}

export function sideErrorKey(code: string): SideErrorKey {
  return (SIDE_ERRORS as readonly string[]).includes(code) ? (code as SideErrorKey) : 'OTHER'
}

export function subjectTypeKey(type: string): SubjectTypeKey {
  return (SUBJECT_TYPES as readonly string[]).includes(type) ? (type as SubjectTypeKey) : 'OTHER'
}

export function backtestModel(view: BacktestDoneDto, locale: string): BacktestModel {
  const name = (id: string) => memberNameOf(view.members, id, locale)
  const side = (s: BacktestSideDto): SideModel => ({
    rule: s.rule,
    approvers: s.approvers.map(name),
    reviewers: s.reviewers.map(name),
    error: s.error ? { key: sideErrorKey(s.error), code: s.error } : null,
  })
  const documents = new Map(view.documents.map((d) => [d.ref, d]))
  const load = Object.entries(view.result.summary.load)
    .filter(([, delta]) => delta !== 0)
    .map(([memberId, delta]) => ({ memberId, name: name(memberId), delta, text: loadText(delta) }))
    .sort((a, b) => Number(b.delta > 0) - Number(a.delta > 0) || a.name.localeCompare(b.name, locale === 'en' ? 'en' : 'th'))
  const rows = view.result.rows
    .filter((r) => r.changed)
    .map((r) => {
      const doc = documents.get(r.ref)
      return { ref: r.ref, label: doc?.label ?? r.ref, subjectType: subjectTypeKey(doc?.subjectType ?? ''), sentAt: doc?.sentAt ?? null, current: side(r.current), draft: side(r.draft) }
    })
  return { from: view.from, to: view.to, total: view.result.summary.total, changed: view.result.summary.changed, load, rows }
}
