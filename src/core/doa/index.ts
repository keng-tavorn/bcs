// DOA engine (spec §7.4): route resolution, version lint and the boundary table. Pure functions over snapshots.
export * from './types'
export { bandOf, inBand, chooseRule, type Band, type RuleChoice } from './band'
export { resolveApprover, departmentPath, rootDepartment, holderAt } from './approvers'
export { resolveRoute, versionAt, type RoutePolicy } from './resolve-route'
export { lintDoaVersion, boundaryTable, type LintIssue, type LintCode, type LintResult, type BoundaryRow } from './lint'
export { explainRouteTh, bandTextTh } from './explain'
