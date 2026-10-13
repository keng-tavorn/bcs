import { describe, expect, it } from 'vitest'
import { lintDoaVersion } from '@/core/doa'
import { orgSnapshot, versionSnapshots } from '../golden/doa-fixtures'

// S6-09 (BR-WF-17 · OQ-109): a version that separates the DOA administrators needs an active DOA_ADMIN, and nobody
// holding both DOA_ADMIN and ORG_ADMIN. The caller states who holds the roles; a version that does not separate them
// passes no `doaAdmins` and is never refused for it.

const version = versionSnapshots()[0]!
const codes = (doaAdmins?: { active: number; alsoOrgAdmin: number }) => lintDoaVersion(version, orgSnapshot(), version.effectiveFrom, doaAdmins ? { doaAdmins } : {}).errors.map((e) => e.code)

describe('[FR-ADM-101/AC3] the lint of a version that separates the DOA administrators', () => {
  it('passes with an active DOA_ADMIN who is not an ORG_ADMIN, or when the version does not separate them', () => {
    expect(codes()).toEqual([])
    expect(codes({ active: 1, alsoOrgAdmin: 0 })).toEqual([])
  })

  it('refuses it without an active DOA_ADMIN, and when someone holds both roles', () => {
    expect(codes({ active: 0, alsoOrgAdmin: 0 })).toEqual(['DOA_LINT_NO_DOA_ADMIN'])
    expect(codes({ active: 2, alsoOrgAdmin: 1 })).toEqual(['DOA_LINT_ADMIN_ROLES_COMBINED'])
  })
})
