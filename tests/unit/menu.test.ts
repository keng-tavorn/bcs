import { describe, expect, it } from 'vitest'
import { visibleMenu, type MenuKey } from '@/app/(workspace)/_shell/menu'
import { memberPrincipal, type Principal } from '@/server/authz'
import type { StoredRole } from '@/server/authz/permissions'

// FR-PLT-002 AC1: the menu shows only what the member may open (§2.4 via §9.1) and hides menus of switched-off
// modules. Expected lists are written out from §9.1/§2.4 by hand, not computed with the code under test.

const CORE = ['CORE'] as const
const keys = (p: Principal, modules: readonly ('CORE' | 'PAY')[] = CORE) => visibleMenu(p, modules).map((i) => i.key)
const member = (...roles: StoredRole[]) => memberPrincipal('m1', roles)
const EVERY_MEMBER: MenuKey[] = ['home', 'newRequest', 'requests', 'tasks', 'suppliers', 'board', 'delegation', 'security']
const withExtra = (extra: MenuKey[]) => EVERY_MEMBER.concat(extra)

describe('[FR-PLT-002/AC1] menus follow §2.4 permissions', () => {
  it('a member without roles sees their own work only', () => {
    expect(keys(member())).toEqual(EVERY_MEMBER)
  })

  it.each<[StoredRole, MenuKey[]]>([
    ['PROCUREMENT', ['pool', 'pos', 'reports', 'kpi']],
    ['FINANCE', ['invoices', 'exports', 'budgets', 'reports', 'kpi']],
    ['BUDGET_ADMIN', ['budgets']],
    ['RECEIVER', ['receiving']],
    ['EXECUTIVE', ['budgets', 'reports', 'kpi']],
    ['AUDITOR', ['budgets', 'reports', 'kpi', 'audit', 'policyHistory']],
    ['ORG_ADMIN', ['audit', 'members', 'org', 'calendar', 'numbering', 'requestTypes', 'doa', 'orgAuthority', 'policyHistory', 'modules']],
  ])('%s also sees %j', (role, extra) => {
    const expected = withExtra(extra)
    const order = visibleMenu(member(...['PROCUREMENT', 'FINANCE', 'BUDGET_ADMIN', 'RECEIVER', 'EXECUTIVE', 'AUDITOR', 'ORG_ADMIN'] as StoredRole[]), CORE).map((i) => i.key)
    expect(keys(member(role))).toEqual(order.filter((k) => expected.includes(k)))
  })

  it('a department head (DM/VP) sees the budgets and reports of their department', () => {
    const head: Principal = { kind: 'member', memberId: 'm1', roles: new Set(), headOfDepartmentIds: new Set(['d1']), departmentIds: new Set() }
    expect(keys(head)).toEqual(['home', 'newRequest', 'requests', 'tasks', 'suppliers', 'budgets', 'board', 'reports', 'delegation', 'security'])
  })

  it('the BCS team (PLATFORM_ADMIN) sees only customer organizations, no business menus', () => {
    expect(keys({ kind: 'platform', platformAdminId: 'pa' })).toEqual(['tenants'])
  })

  it('an inactive member sees nothing', () => {
    expect(keys({ kind: 'inactive', memberId: 'm1' })).toEqual([])
  })

  it('menus of a switched-off module are hidden', () => {
    expect(keys(member('ORG_ADMIN'), [])).toEqual(['home', 'security'])
    expect(keys(member('ORG_ADMIN'), ['PAY'])).toEqual(['home', 'security'])
  })

  it('the screen renders only menus whose pages exist', () => {
    // S1-12: /admin/members and /admin/modules · S2-11 to S2-13 and NEW-06: requests, tasks, the admin pages and acting approvers
    // · S3-08 S4-02 S4-03 S4-04 S4-07: budgets, suppliers (every member reads basic fields), the pool, POs and receiving
    expect(visibleMenu(member('ORG_ADMIN'), CORE, true).map((i) => i.key)).toEqual(['home', 'newRequest', 'requests', 'tasks', 'suppliers', 'members', 'org', 'calendar', 'numbering', 'requestTypes', 'doa', 'orgAuthority', 'modules', 'delegation', 'security'])
    expect(visibleMenu(member(), CORE, true).map((i) => i.key)).toEqual(['home', 'newRequest', 'requests', 'tasks', 'suppliers', 'delegation', 'security'])
    expect(visibleMenu(member('PROCUREMENT'), CORE, true).map((i) => i.key)).toEqual(['home', 'newRequest', 'requests', 'tasks', 'pool', 'pos', 'suppliers', 'delegation', 'security'])
    expect(visibleMenu(member('RECEIVER'), CORE, true).map((i) => i.key)).toEqual(['home', 'newRequest', 'requests', 'tasks', 'receiving', 'suppliers', 'delegation', 'security'])
    expect(visibleMenu(member('FINANCE'), CORE, true).map((i) => i.key)).toEqual(['home', 'newRequest', 'requests', 'tasks', 'suppliers', 'budgets', 'delegation', 'security'])
  })
})
