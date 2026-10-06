// The five kinds of authority change ORG_ADMIN proposes (spec §6.2 OrgAuthorityChange, FR-DOA-010 AC1). Plain data, so
// server pages and client forms share it.
export const CHANGE_KINDS = ['POSITION_ASSIGN', 'POSITION_END', 'DEPARTMENT_REPARENT', 'DELEGATION_ON_BEHALF', 'IDENTITY_RESET'] as const
export type ChangeKind = (typeof CHANGE_KINDS)[number]
