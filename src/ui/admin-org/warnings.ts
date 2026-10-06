// Warnings a proposer acknowledges one by one (BR-DOA-08, BR-DOA-17) arrive as keys "<CODE>:<subject>"
// (src/server/services/doa/lint-view.ts warningKey, and POSITION_VACANT:<position>@<department code> of an authority
// change). Screens turn a key into a sentence; the key itself is what the service checks.

export type WarningParts =
  | { readonly code: 'POSITION_VACANT'; readonly positionCode: string; readonly departmentCode: string }
  | { readonly code: 'DOA_LINT_VACANT_POSITION' | 'DOA_LINT_MEMBER_APPROVER'; readonly rule: string }
  | { readonly code: 'OTHER'; readonly key: string }

export function warningParts(key: string): WarningParts {
  const at = key.indexOf(':')
  const code = at < 0 ? key : key.slice(0, at)
  const subject = at < 0 ? '' : key.slice(at + 1)
  if (code === 'POSITION_VACANT') {
    const [positionCode = '', departmentCode = ''] = subject.split('@')
    if (positionCode && departmentCode) return { code, positionCode, departmentCode }
  }
  if ((code === 'DOA_LINT_VACANT_POSITION' || code === 'DOA_LINT_MEMBER_APPROVER') && subject) return { code, rule: subject }
  return { code: 'OTHER', key }
}
