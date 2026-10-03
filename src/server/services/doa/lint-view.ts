import type { LintIssue } from '@/core/doa'

// How lint results leave the services (BR-DOA-08): the code, the document type and rule it is about, and the band as
// satang text; a warning is acknowledged by its key.

/** A warning is acknowledged by this key: its code and the rule it is about. */
export const warningKey = (issue: LintIssue) => `${issue.code}:${issue.rule ?? issue.documentType ?? ''}`

const satangText = (v: bigint | undefined | null) => (v === undefined || v === null ? null : v.toString())

export const issueView = (i: LintIssue) => ({
  code: i.code,
  ...(i.documentType ? { documentType: i.documentType } : {}),
  ...(i.rule ? { rule: i.rule } : {}),
  ...(i.gt !== undefined ? { gt: satangText(i.gt) } : {}),
  ...(i.lte !== undefined ? { lte: satangText(i.lte) } : {}),
})
