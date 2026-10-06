import { scopesFor, type Principal } from '@/server/authz'

// Who reads a report (spec §2.4 report.view, FR-VIS-002 AC3): the whole organization for FINANCE, PROCUREMENT,
// EXECUTIVE and AUDITOR, the departments a department head heads, nobody else — and whether a reader's scope covers what
// a report file was made for, so a file never reaches someone the report itself would refuse: the recipients of a
// scheduled report (createReportSchedule, the scheduled run) and whoever downloads a report file. This module imports
// nothing of the report framework, so the file policy of exports can use it.

/** What a report may read for one reader: null for the whole organization, the departments for a head, 'NONE' */
export type ReportScope = readonly string[] | null | 'NONE'

/** FR-VIS-002 AC3: the departments a report may read for this principal, null for the whole organization */
export function reportScope(principal: Principal): ReportScope {
  if (principal.kind !== 'member') return 'NONE'
  const scopes = scopesFor(principal, 'report.view')
  if (scopes.has('ORG')) return null
  if (scopes.has('DEPT') && principal.headOfDepartmentIds.size > 0) return [...principal.headOfDepartmentIds]
  return 'NONE'
}

/** A reader of scope `reader` may read a report made for `made` (null: the whole organization) */
export function scopeCovers(reader: ReportScope, made: readonly string[] | null): boolean {
  if (reader === 'NONE') return false
  if (reader === null) return true
  if (made === null) return false
  const own = new Set(reader)
  return made.every((department) => own.has(department))
}

/**
 * The scope a report file was made for, from its ExportJob params ({ scope: 'ORG' | departmentIds }, written with the
 * file). Anything else reads as the whole organization's, the strictest.
 */
export function fileScope(params: unknown): readonly string[] | null {
  const scope = params !== null && typeof params === 'object' ? (params as { scope?: unknown }).scope : undefined
  if (Array.isArray(scope) && scope.length > 0 && scope.every((d) => typeof d === 'string')) return scope as string[]
  return null
}

/**
 * FR-VIS-002 AC3 for the file of a report (ExportJob of kind REPORT): readable by a member whose report.view covers the
 * scope it was made for — an organization-wide file only by readers of the whole organization, a department's file by
 * readers of that department. For the ExportJob file policy (src/server/services/exports/file-policy.ts).
 */
export function reportFileReadable(principal: Principal, params: unknown): boolean {
  return scopeCovers(reportScope(principal), fileScope(params))
}
