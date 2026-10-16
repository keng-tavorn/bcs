import { describe, expect, it } from 'vitest'
import { MENU, menuLabelKey, SIDEBAR_GROUPS, visibleMenu, type MenuKey } from '@/app/(workspace)/_shell/menu'
import { memberPrincipal, type Principal } from '@/server/authz'
import type { StoredRole } from '@/server/authz/permissions'

// FR-PLT-002 AC1: the menu shows only what the member may open (§2.4 via §9.1) and hides menus of switched-off
// modules. Expected lists are written out from §9.1/§9.10/§2.4 by hand, not computed with the code under test. Menu
// order is §9.10's: the sidebar's groups, then the door, the hubs' pages and the platform's.

const CORE = ['CORE'] as const
const keys = (p: Principal, modules: readonly ('CORE' | 'PAY')[] = CORE) => visibleMenu(p, modules).map((i) => i.key)
const member = (...roles: StoredRole[]) => memberPrincipal('m1', roles)
// Every member's own settings (§9.1 /settings/*): acting approver, account security, transaction PIN, LINE and notifications
const OWN_SETTINGS: MenuKey[] = ['delegation', 'security', 'pin', 'lineLink', 'notifications']
const EVERY_MEMBER: MenuKey[] = ['home', 'tasks', 'requests', 'newRequest', 'suppliers', 'catalog', 'board', 'settings', ...OWN_SETTINGS]
const withExtra = (extra: MenuKey[]) => EVERY_MEMBER.concat(extra)

describe('[FR-PLT-002/AC1] menus follow §2.4 permissions', () => {
  it('a member without roles sees their own work only', () => {
    expect(keys(member())).toEqual(EVERY_MEMBER)
  })

  it.each<[StoredRole, MenuKey[]]>([
    ['PROCUREMENT', ['pool', 'pos', 'insights', 'reports']],
    ['FINANCE', ['pos', 'invoices', 'exports', 'budgets', 'insights', 'reports']],
    ['BUDGET_ADMIN', ['budgets']],
    ['RECEIVER', ['receiving']],
    ['EXECUTIVE', ['pos', 'budgets', 'insights', 'reports']],
    // The policy history is an admin page, so its hub shows with it
    ['AUDITOR', ['pos', 'budgets', 'insights', 'reports', 'audit', 'admin', 'policyHistory']],
    ['ORG_ADMIN', ['audit', 'admin', 'members', 'org', 'calendar', 'numbering', 'requestTypes', 'line', 'doa', 'workflows', 'orgAuthority', 'policyHistory', 'modules', 'config']],
  ])('%s also sees %j', (role, extra) => {
    const expected = withExtra(extra)
    const order = visibleMenu(member(...['PROCUREMENT', 'FINANCE', 'BUDGET_ADMIN', 'RECEIVER', 'EXECUTIVE', 'AUDITOR', 'ORG_ADMIN'] as StoredRole[]), CORE).map((i) => i.key)
    expect(keys(member(role))).toEqual(order.filter((k) => expected.includes(k)))
  })

  it('a department head (DM/VP) sees the budgets and reports of their department', () => {
    const head: Principal = { kind: 'member', memberId: 'm1', roles: new Set(), headOfDepartmentIds: new Set(['d1']), departmentIds: new Set() }
    expect(keys(head)).toEqual(['home', 'tasks', 'requests', 'newRequest', 'suppliers', 'catalog', 'budgets', 'insights', 'board', 'reports', 'settings', ...OWN_SETTINGS])
  })

  it('the BCS team (PLATFORM_ADMIN) sees only customer organizations, no business menus', () => {
    expect(keys({ kind: 'platform', platformAdminId: 'pa' })).toEqual(['tenants'])
  })

  it('an inactive member sees nothing', () => {
    expect(keys({ kind: 'inactive', memberId: 'm1' })).toEqual([])
  })

  it('menus of a switched-off module are hidden', () => {
    // The member's own account settings belong to no module; the LINE channel page belongs to CORE like the other admin pages
    expect(keys(member('ORG_ADMIN'), [])).toEqual(['home', 'settings', 'security', 'pin', 'lineLink', 'notifications'])
    expect(keys(member('ORG_ADMIN'), ['PAY'])).toEqual(['home', 'settings', 'security', 'pin', 'lineLink', 'notifications'])
  })

  it('S9-09: with PAY on, FINANCE and AUDITOR see the payment runs and the bank accounts, PROCUREMENT the bank accounts only; an approver reaches a run from the task', () => {
    const pay = ['CORE', 'PAY'] as const
    const finance = (role: StoredRole) => keys(member(role), pay).filter((k) => k === 'payments' || k === 'bankAccounts')
    expect(finance('FINANCE')).toEqual(['payments', 'bankAccounts'])
    expect(finance('AUDITOR')).toEqual(['payments', 'bankAccounts'])
    expect(finance('PROCUREMENT')).toEqual(['bankAccounts'])
    expect(finance('EXECUTIVE')).toEqual([])
    expect(keys(member()).includes('payments')).toBe(false)
  })

  it('[FR-PLT-013/AC2] S8-13: with PAY on the invoices of the finance group are named "ใบแจ้งหนี้" (§9.10), the rest keep their names', () => {
    const invoices = MENU.find((item) => item.key === 'invoices')!
    expect(menuLabelKey(invoices, ['CORE'])).toBe('invoices')
    expect(menuLabelKey(invoices, ['CORE', 'PAY'])).toBe('invoicesAp')
    for (const item of MENU.filter((i) => i.key !== 'invoices')) expect(menuLabelKey(item, ['CORE', 'PAY']), item.key).toBe(item.key)
  })

  it('the screen renders only menus whose pages exist', () => {
    // S1-12: /admin/members and /admin/modules · S2-11 to S2-13 and NEW-06: requests, tasks, the admin pages and acting approvers
    // · S3-08 S4-02 to S4-11 S5-12: budgets, suppliers (every member reads basic fields), the pool, POs, receiving, finance,
    // the board (every member sees their own documents), reports, KPI and the audit
    const ready = (...roles: StoredRole[]) => visibleMenu(member(...roles), CORE, true).map((i) => i.key)
    // S5 (wave 4): /admin/line for the ORG_ADMIN, and /settings/pin, /settings/line and /settings/notifications for every member
    // S16-04: the hubs /settings and /admin, and the admin hub hides with no ready admin page (the AUDITOR's policy
    // history is not built yet) · S16-08: the executive summary /insights in place of the KPI entry (§9.10)
    // · S6-10: the catalogue /catalog for every member (catalog.view)
    const own = ['settings', 'delegation', 'security', 'pin', 'lineLink', 'notifications']
    const admin = ['admin', 'members', 'org', 'calendar', 'numbering', 'requestTypes', 'line', 'doa', 'workflows', 'orgAuthority', 'modules', 'config']
    expect(ready('ORG_ADMIN')).toEqual(['home', 'tasks', 'requests', 'newRequest', 'suppliers', 'catalog', 'board', 'audit', 'settings', ...admin, ...own.slice(1)])
    expect(ready()).toEqual(['home', 'tasks', 'requests', 'newRequest', 'suppliers', 'catalog', 'board', ...own])
    expect(ready('PROCUREMENT')).toEqual(['home', 'tasks', 'requests', 'newRequest', 'pool', 'pos', 'suppliers', 'catalog', 'insights', 'board', 'reports', ...own])
    expect(ready('RECEIVER')).toEqual(['home', 'tasks', 'requests', 'newRequest', 'receiving', 'suppliers', 'catalog', 'board', ...own])
    expect(ready('FINANCE')).toEqual(['home', 'tasks', 'requests', 'newRequest', 'pos', 'suppliers', 'catalog', 'invoices', 'exports', 'budgets', 'insights', 'board', 'reports', ...own])
    expect(ready('EXECUTIVE')).toEqual(['home', 'tasks', 'requests', 'newRequest', 'pos', 'suppliers', 'catalog', 'budgets', 'insights', 'board', 'reports', ...own])
    expect(ready('AUDITOR')).toEqual(['home', 'tasks', 'requests', 'newRequest', 'pos', 'suppliers', 'catalog', 'budgets', 'insights', 'board', 'reports', 'audit', ...own])
  })
})

describe('[FR-PLT-013/AC2] [FR-PLT-002/AC1] the sidebar follows the table of §9.10', () => {
  // §9.10 "แถบเมนูซ้าย", top to bottom: group, entry, address (written out from the spec's table)
  const TABLE: Array<[string, MenuKey, string]> = [
    ['main', 'home', '/'],
    ['main', 'tasks', '/tasks'],
    ['main', 'requests', '/requests'],
    ['procurement', 'pool', '/procurement/pool'],
    ['procurement', 'pos', '/procurement/pos'],
    ['procurement', 'receiving', '/receiving'],
    ['procurement', 'suppliers', '/suppliers'],
    // S6-10 (FR-INT-102): the catalogue with its agreed prices, every member's (catalog.view)
    ['procurement', 'catalog', '/catalog'],
    ['finance', 'invoices', '/finance/invoices'],
    // S9-09: shown only while module PAY is on (docs/sub-specs/S9.md "หน้าจอ")
    ['finance', 'payments', '/finance/payments'],
    ['finance', 'bankAccounts', '/finance/bank-accounts'],
    ['finance', 'exports', '/finance/exports'],
    ['finance', 'budgets', '/budgets'],
    ['insight', 'insights', '/insights'],
    ['insight', 'board', '/board/pending'],
    ['insight', 'reports', '/reports'],
    ['insight', 'audit', '/audit'],
    ['footer', 'settings', '/settings'],
    ['footer', 'admin', '/admin'],
  ]

  it('holds the table entries in its groups and order, and nothing else', () => {
    const sidebar = MENU.filter((item) => (SIDEBAR_GROUPS as readonly string[]).includes(item.group))
    expect(SIDEBAR_GROUPS).toEqual(['main', 'procurement', 'finance', 'insight', 'footer'])
    expect(sidebar.map((item) => [item.group, item.key, item.href])).toEqual(TABLE)
    // The door is the top bar's main button, not a sidebar entry (§9.10 "แถบบน")
    expect(MENU.find((item) => item.key === 'newRequest')?.group).toBe('door')
  })

  it('a hub shows exactly when one of its pages does', () => {
    expect(keys(member()).filter((k) => k === 'settings' || k === 'admin')).toEqual(['settings'])
    expect(keys(member('ORG_ADMIN')).filter((k) => k === 'settings' || k === 'admin')).toEqual(['settings', 'admin'])
    expect(keys({ kind: 'inactive', memberId: 'm1' })).toEqual([])
    // Every admin and settings page sits under its hub's address, so the hub is its parent in the trail
    for (const item of MENU.filter((i) => i.group === 'admin' || i.group === 'settings')) expect(item.href.startsWith('/' + item.group + '/'), item.key).toBe(true)
  })
})
