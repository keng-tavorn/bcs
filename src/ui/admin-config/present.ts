// What the configuration-package page (/admin/config, S6-21 · FR-PLT-101 AC2 · BR-UAT-02 BR-UAT-03) shows from the
// answers of its server actions: the screen-safe parts of a refusal (never the raw message, §14.2), the message key that
// says what happened and how to fix it (§9.9 rule 7), the rows of a package that do not fit this organization, the
// drafts an import made with where each is reviewed, and the name of an exported file. Pure: the unit tests read them
// (tests/unit/config-package-present.test.ts).

export const CONFIG_SECTIONS = ['FORMS', 'WORKFLOW', 'DOA', 'CATALOG'] as const
export type ConfigSection = (typeof CONFIG_SECTIONS)[number]

/** Why a row of a package does not fit this organization (src/server/services/config-packages ConfigImportRow) */
export const CONFIG_ROW_REASONS = ['REQUEST_TYPE_NOT_FOUND', 'DRAFT_EXISTS', 'FORM_INVALID', 'POSITION_NOT_FOUND', 'MEMBER_NOT_FOUND', 'CATALOG_CODE_EXISTS', 'SUPPLIER_NOT_FOUND', 'AGREEMENT_INVALID', 'OTHER'] as const
export type ConfigRowReason = (typeof CONFIG_ROW_REASONS)[number]

/** Why a file is not a package this organization may read (CONFIG_PACKAGE_INVALID details.reason) */
export const CONFIG_INVALID_REASONS = ['NOT_JSON', 'NOT_A_PACKAGE', 'SCHEMA_VERSION', 'CHECKSUM'] as const
export type ConfigInvalidReason = (typeof CONFIG_INVALID_REASONS)[number]

export interface ConfigRowView {
  readonly section: ConfigSection
  readonly ref: string
  readonly reason: ConfigRowReason
}

export interface ConfigFailure {
  readonly ok: false
  readonly code: string
  readonly reason?: string
  readonly field?: string
  readonly rows?: readonly ConfigRowView[]
  readonly requestId?: string
}

/** The drafts one import made, in the package's order, with what names each (a request type's code, a workflow's code, an item's code) */
export interface ConfigCreatedView {
  readonly forms: ReadonlyArray<{ readonly id: string; readonly code: string }>
  readonly workflows: ReadonlyArray<{ readonly id: string; readonly code: string }>
  readonly doa: ReadonlyArray<{ readonly id: string }>
  readonly catalog: ReadonlyArray<{ readonly id: string; readonly code: string }>
}

export type ExportOutcome = { readonly ok: true; readonly file: string; readonly checksum: string; readonly fileName: string } | ConfigFailure
export type ImportOutcome = { readonly ok: true; readonly created: ConfigCreatedView } | ConfigFailure

const oneOf = <T extends string>(list: readonly T[], value: unknown, fallback: T): T =>
  typeof value === 'string' && (list as readonly string[]).includes(value) ? (value as T) : fallback

/** Picks the screen-safe parts of a service error: the rows only with the sections and reasons the page has words for */
export function toConfigFailure(error: { code: string; details?: Readonly<Record<string, unknown>> }): ConfigFailure {
  const d = error.details ?? {}
  const rows = Array.isArray(d.rows)
    ? (d.rows as unknown[]).flatMap((r) => {
        if (r === null || typeof r !== 'object') return []
        const row = r as Record<string, unknown>
        if (!(CONFIG_SECTIONS as readonly unknown[]).includes(row.section)) return []
        return [{ section: row.section as ConfigSection, ref: typeof row.ref === 'string' ? row.ref : '', reason: oneOf(CONFIG_ROW_REASONS, row.reason, 'OTHER') }]
      })
    : undefined
  return {
    ok: false,
    code: error.code,
    ...(typeof d.reason === 'string' ? { reason: d.reason } : {}),
    ...(typeof d.field === 'string' ? { field: d.field } : {}),
    ...(rows ? { rows } : {}),
    ...(typeof d.requestId === 'string' ? { requestId: d.requestId } : {}),
  }
}

/** Message keys under configPackages.errors */
export type ConfigErrorKey =
  | `INVALID_${ConfigInvalidReason}`
  | 'ROWS'
  | 'SECTIONS'
  | 'FILE_MISSING'
  | 'FILE_TOO_LARGE'
  | 'DATE'
  | 'DATE_PAST'
  | 'REASON'
  | 'LINT'
  | 'FORBIDDEN'
  | 'CONFLICT'
  | 'UNAUTHENTICATED'
  | 'INTERNAL'
  | 'FAILED'

/** What a refused export or import says (§9.9 rule 7: what happened and how to fix it) */
export function configErrorKey(failure: ConfigFailure): ConfigErrorKey {
  const { code, reason, field } = failure
  if (code === 'CONFIG_PACKAGE_INVALID') return `INVALID_${oneOf(CONFIG_INVALID_REASONS, reason, 'NOT_A_PACKAGE')}`
  if (code === 'VALIDATION_FAILED' && reason === 'CONFIG_PACKAGE_ROWS') return 'ROWS'
  if (code === 'VALIDATION_FAILED' && reason === 'EFFECTIVE_IN_PAST') return 'DATE_PAST'
  if (code === 'VALIDATION_FAILED' && (field === 'effectiveDate' || field === 'effectiveFrom')) return 'DATE'
  if (code === 'VALIDATION_FAILED' && field === 'changeReason') return 'REASON'
  if (code === 'VALIDATION_FAILED' && field === 'sections') return 'SECTIONS'
  if (code === 'VALIDATION_FAILED' && field === 'file') return reason === 'TOO_LARGE' ? 'FILE_TOO_LARGE' : 'FILE_MISSING'
  // A draft the package makes does not pass the checks of the DOA or the workflow here, or another draft's rule refuses it
  if (code === 'DOA_LINT_FAILED' || code === 'WORKFLOW_LINT_FAILED' || code === 'REVIEWER_NOT_FOUND' || code === 'VALIDATION_FAILED' || code === 'INVALID_STATE_TRANSITION') return 'LINT'
  if (code === 'FORBIDDEN') return 'FORBIDDEN'
  if (code === 'IDEMPOTENCY_CONFLICT' || code === 'CONFLICT_VERSION') return 'CONFLICT'
  if (code === 'UNAUTHENTICATED') return 'UNAUTHENTICATED'
  if (code === 'INTERNAL') return 'INTERNAL'
  return 'FAILED'
}

/** The field of the import form a refusal is about, so the page shows it under that field (§9.10: the error under the field) */
export function configErrorField(key: ConfigErrorKey): 'file' | 'effectiveDate' | 'changeReason' | null {
  if (key.startsWith('INVALID_') || key === 'FILE_MISSING' || key === 'FILE_TOO_LARGE') return 'file'
  if (key === 'DATE' || key === 'DATE_PAST') return 'effectiveDate'
  if (key === 'REASON') return 'changeReason'
  return null
}

export interface CreatedLink {
  readonly section: ConfigSection
  /** Message key under configPackages.created */
  readonly key: 'form' | 'workflow' | 'doa' | 'catalog'
  readonly values: Readonly<Record<string, string | number>>
  readonly href: string
}

/** The drafts an import made, each with the page where it is reviewed and sent for its normal approval (BR-UAT-03) */
export function createdLinks(created: ConfigCreatedView): CreatedLink[] {
  return [
    ...created.forms.map((f): CreatedLink => ({ section: 'FORMS', key: 'form', values: { code: f.code }, href: `/admin/request-types/${encodeURIComponent(f.code)}/form` })),
    ...created.workflows.map((w): CreatedLink => ({ section: 'WORKFLOW', key: 'workflow', values: { code: w.code }, href: `/admin/workflows/${encodeURIComponent(w.id)}` })),
    ...created.doa.map((d, i): CreatedLink => ({ section: 'DOA', key: 'doa', values: { n: i + 1 }, href: `/admin/doa/${encodeURIComponent(d.id)}` })),
    // The catalogue's items come in inactive: PROCUREMENT turns each on from the catalogue's management page
    ...(created.catalog.length ? [{ section: 'CATALOG' as const, key: 'catalog' as const, values: { count: created.catalog.length, codes: created.catalog.map((c) => c.code).join(', ') }, href: '/catalog/manage' }] : []),
  ]
}

/** The rows of a package that do not fit, in the order of the package's sections */
export function sortedRows(rows: readonly ConfigRowView[]): ConfigRowView[] {
  return [...rows].sort((a, b) => CONFIG_SECTIONS.indexOf(a.section) - CONFIG_SECTIONS.indexOf(b.section) || a.ref.localeCompare(b.ref))
}

/** The name an exported package is saved under: config-<organization code>-<day exported>.json, read from the file itself */
export function exportFileName(file: string): string {
  try {
    const content = JSON.parse(file) as { organizationCode?: unknown; exportedAt?: unknown }
    const code = typeof content.organizationCode === 'string' ? content.organizationCode.replace(/[^A-Za-z0-9_-]/g, '') : ''
    const day = typeof content.exportedAt === 'string' && /^\d{4}-\d{2}-\d{2}/.test(content.exportedAt) ? content.exportedAt.slice(0, 10) : ''
    return code && day ? `config-${code}-${day}.json` : 'config-package.json'
  } catch {
    return 'config-package.json'
  }
}

/** The sections ticked on the export form, in the package's order */
export function chosenSections(values: readonly unknown[]): ConfigSection[] {
  return CONFIG_SECTIONS.filter((s) => values.includes(s))
}
