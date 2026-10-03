// What an org-structure, authority-change or DOA server action returns to its form: success, or the error code with the
// parts of `details` the screen needs to say what happened and how to fix it (§9.9 rule 7, §14.2). Never the raw
// message: screens render their own Thai or English text from these codes.

/** A lint result as the services send it (BR-DOA-08): code, document type or rule, and the band in satang text */
export interface IssueView {
  readonly code: string
  readonly documentType?: string
  readonly rule?: string
  readonly gt?: string | null
  readonly lte?: string | null
}

/** A problem in an imported YAML file: where it is and what kind of problem (src/server/doa/yaml.ts) */
export interface ProblemView {
  readonly path: string
  readonly issue: string
  readonly keys?: readonly string[]
}

export interface ActionFailure {
  readonly ok: false
  readonly code: string
  readonly reason?: string
  readonly field?: string
  /** The kind of authority change to propose instead (reason USE_ORG_AUTHORITY_CHANGE) */
  readonly kind?: string
  /** Warning keys still to acknowledge one by one (reason WARNINGS_NOT_ACKNOWLEDGED) */
  readonly warnings?: readonly string[]
  /** Governance rules nobody could approve after the change (reason GOVERNANCE_UNRESOLVABLE) */
  readonly rules?: readonly string[]
  /** The separation-of-duties rule (SOD_VIOLATION) */
  readonly rule?: string
  /** Lint errors (DOA_LINT_FAILED) */
  readonly errors?: readonly IssueView[]
  /** YAML problems of an import */
  readonly problems?: readonly ProblemView[]
  /** The DOA code and version number named by VERSION_EXISTS or LATER_VERSION_SCHEDULED */
  readonly doaCode?: string
  readonly versionNo?: number
  /** Position slots of the initial package that must be listed (reason UNLISTED_HOLDER) */
  readonly slots?: ReadonlyArray<{ readonly positionCode: string; readonly departmentId: string }>
  /** The reference of an unexpected error (§14.2 INTERNAL), so support can find it in the logs */
  readonly requestId?: string
}

const strings = (value: unknown): string[] | undefined =>
  Array.isArray(value) && value.every((v) => typeof v === 'string') ? (value as string[]) : undefined

const text = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined)

function issues(value: unknown): IssueView[] | undefined {
  if (!Array.isArray(value)) return undefined
  return value
    .filter((v): v is Record<string, unknown> => typeof v === 'object' && v !== null && typeof (v as Record<string, unknown>).code === 'string')
    .map((v) => ({
      code: v.code as string,
      ...(text(v.documentType) ? { documentType: text(v.documentType) } : {}),
      ...(text(v.rule) ? { rule: text(v.rule) } : {}),
      ...(v.gt === null || typeof v.gt === 'string' ? { gt: v.gt as string | null } : {}),
      ...(v.lte === null || typeof v.lte === 'string' ? { lte: v.lte as string | null } : {}),
    }))
}

function problems(value: unknown): ProblemView[] | undefined {
  if (!Array.isArray(value)) return undefined
  return value
    .filter((v): v is Record<string, unknown> => typeof v === 'object' && v !== null && typeof (v as Record<string, unknown>).path === 'string')
    .map((v) => ({ path: v.path as string, issue: text(v.issue) ?? 'SHAPE', ...(strings(v.keys) ? { keys: strings(v.keys) } : {}) }))
}

function slots(value: unknown): Array<{ positionCode: string; departmentId: string }> | undefined {
  if (!Array.isArray(value)) return undefined
  return value
    .filter((v): v is Record<string, unknown> => typeof v === 'object' && v !== null)
    .filter((v) => typeof v.positionCode === 'string' && typeof v.departmentId === 'string')
    .map((v) => ({ positionCode: v.positionCode as string, departmentId: v.departmentId as string }))
}

/** Picks the screen-safe parts of a service error. */
export function toActionFailure(error: { code: string; details?: Readonly<Record<string, unknown>> }): ActionFailure {
  const d = error.details ?? {}
  const found = {
    reason: text(d.reason),
    field: text(d.field),
    kind: text(d.kind),
    warnings: strings(d.warnings),
    rules: strings(d.rules),
    rule: text(d.rule),
    errors: issues(d.errors),
    problems: problems(d.problems),
    doaCode: text(d.doaCode),
    versionNo: typeof d.versionNo === 'number' ? d.versionNo : undefined,
    slots: slots(d.slots),
    requestId: text(d.requestId),
  }
  return { ok: false, code: error.code, ...Object.fromEntries(Object.entries(found).filter(([, v]) => v !== undefined)) }
}

/** Message keys every admin form understands, after the reasons of its own namespace */
export const COMMON_ERROR_KEYS = ['INPUT', 'FORBIDDEN', 'NOT_FOUND', 'STATE', 'UNAUTHENTICATED', 'CONFLICT', 'BUSY', 'INTERNAL', 'NO_APPROVER', 'NO_ANSWER', 'FAILED'] as const
export type CommonErrorKey = (typeof COMMON_ERROR_KEYS)[number]

/** The key of a failure: its reason when the namespace knows it, otherwise one of COMMON_ERROR_KEYS. */
export function failureKey<K extends string>(failure: ActionFailure, reasons: readonly K[]): K | CommonErrorKey {
  const byReason = reasons.find((k) => k === failure.reason || (failure.reason === undefined && k === failure.code))
  if (byReason) return byReason
  switch (failure.code) {
    case 'VALIDATION_FAILED':
      return 'INPUT'
    case 'UNAUTHENTICATED':
      return 'UNAUTHENTICATED'
    case 'FORBIDDEN':
      return 'FORBIDDEN'
    case 'NOT_FOUND':
      return 'NOT_FOUND'
    case 'INVALID_STATE_TRANSITION':
      return 'STATE'
    case 'IDEMPOTENCY_CONFLICT':
      return 'CONFLICT'
    case 'RATE_LIMITED':
      return 'BUSY'
    case 'INTERNAL':
      return 'INTERNAL'
    // useAction: no answer came back, so the form's key is kept for a retry (src/ui/admin-org/use-action.ts)
    case 'NO_ANSWER':
      return 'NO_ANSWER'
    case 'DOA_NOT_CONFIGURED':
    case 'DOA_AMBIGUOUS':
    case 'APPROVER_NOT_FOUND':
    case 'NO_HIGHER_AUTHORITY':
      return 'NO_APPROVER'
    default:
      return 'FAILED'
  }
}
