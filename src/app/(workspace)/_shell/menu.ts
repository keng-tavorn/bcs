import { isAllowed, scopesFor, type Principal } from '@/server/authz'
import type { Capability, Scope } from '@/server/authz/permissions'
import type { ModuleKey } from '@/server/queries/organization'

// Workspace menu (§9.1, FR-PLT-002 AC1): an item shows only when the member holds its capability (§2.4) — with one
// of the listed scopes when `scopes` is set — and its module is switched on. Hiding is convenience only: every
// service checks permissions again (BR-AUTH-05). `ready` turns on when the page exists (its checklist item).

export type MenuGroup = 'work' | 'procurement' | 'finance' | 'insight' | 'admin' | 'platform' | 'account'
export type MenuKey =
  | 'home'
  | 'newRequest'
  | 'requests'
  | 'tasks'
  | 'receiving'
  | 'pool'
  | 'pos'
  | 'suppliers'
  | 'invoices'
  | 'exports'
  | 'budgets'
  | 'board'
  | 'reports'
  | 'kpi'
  | 'audit'
  | 'members'
  | 'org'
  | 'calendar'
  | 'numbering'
  | 'requestTypes'
  | 'doa'
  | 'orgAuthority'
  | 'policyHistory'
  | 'modules'
  | 'tenants'
  | 'delegation'
  | 'security'

export interface MenuItem {
  readonly key: MenuKey
  readonly href: string
  readonly group: MenuGroup
  /** null = every active member */
  readonly capability: Capability | null
  readonly scopes?: readonly Scope[]
  /** null = not tied to a module (home, own settings) */
  readonly module: ModuleKey | null
  readonly ready: boolean
}

export const MENU: readonly MenuItem[] = [
  { key: 'home', href: '/', group: 'work', capability: null, module: null, ready: true },
  { key: 'newRequest', href: '/requests/new', group: 'work', capability: 'request.create', module: 'CORE', ready: true },
  { key: 'requests', href: '/requests', group: 'work', capability: 'request.view', module: 'CORE', ready: true },
  { key: 'tasks', href: '/tasks', group: 'work', capability: null, module: 'CORE', ready: true },
  { key: 'receiving', href: '/receiving', group: 'work', capability: 'gr.post', scopes: ['DEPT', 'ASSIGNED'], module: 'CORE', ready: true },
  { key: 'pool', href: '/procurement/pool', group: 'procurement', capability: 'procurement.pool.view', module: 'CORE', ready: true },
  { key: 'pos', href: '/procurement/pos', group: 'procurement', capability: 'po.create', module: 'CORE', ready: true },
  { key: 'suppliers', href: '/suppliers', group: 'procurement', capability: 'supplier.view', module: 'CORE', ready: true },
  { key: 'invoices', href: '/finance/invoices', group: 'finance', capability: 'invoiceConfirmation.record', module: 'CORE', ready: true },
  { key: 'exports', href: '/finance/exports', group: 'finance', capability: 'export.express', module: 'CORE', ready: true },
  { key: 'budgets', href: '/budgets', group: 'insight', capability: 'budget.view', scopes: ['DEPT', 'ORG'], module: 'CORE', ready: true },
  { key: 'board', href: '/board/pending', group: 'insight', capability: 'board.pending.view', module: 'CORE', ready: true },
  { key: 'reports', href: '/reports', group: 'insight', capability: 'report.view', module: 'CORE', ready: true },
  // KPI G-1..G-5 are organization-wide figures for executives (FR-VIS-003 AC2), so the page needs an ORG-scoped report.view
  { key: 'kpi', href: '/kpi', group: 'insight', capability: 'report.view', scopes: ['ORG'], module: 'CORE', ready: true },
  { key: 'audit', href: '/audit', group: 'insight', capability: 'audit.view', module: 'CORE', ready: true },
  { key: 'members', href: '/admin/members', group: 'admin', capability: 'admin.members', module: 'CORE', ready: true },
  { key: 'org', href: '/admin/org', group: 'admin', capability: 'admin.orgStructure.editBasic', module: 'CORE', ready: true },
  { key: 'calendar', href: '/admin/calendar', group: 'admin', capability: 'admin.calendar', module: 'CORE', ready: true },
  { key: 'numbering', href: '/admin/numbering', group: 'admin', capability: 'admin.numbering', module: 'CORE', ready: true },
  { key: 'requestTypes', href: '/admin/request-types', group: 'admin', capability: 'admin.requestTypes', module: 'CORE', ready: true },
  { key: 'doa', href: '/admin/doa', group: 'admin', capability: 'admin.doa.draft', module: 'CORE', ready: true },
  { key: 'orgAuthority', href: '/admin/org-authority', group: 'admin', capability: 'admin.orgAuthority.propose', module: 'CORE', ready: true },
  { key: 'policyHistory', href: '/admin/policy-history', group: 'admin', capability: 'admin.policyHistory.view', module: 'CORE', ready: false },
  { key: 'modules', href: '/admin/modules', group: 'admin', capability: 'admin.modules.view', module: 'CORE', ready: true },
  { key: 'tenants', href: '/platform/tenants', group: 'platform', capability: 'platform.modules.manage', module: null, ready: true },
  // Acting approvers belong to approvals (CORE); every member may name one for themself (delegation.manage OWN)
  { key: 'delegation', href: '/settings/delegation', group: 'account', capability: 'delegation.manage', module: 'CORE', ready: true },
  { key: 'security', href: '/settings/security', group: 'account', capability: 'self.twoFactor', module: null, ready: true },
]

function itemAllowed(principal: Principal, item: MenuItem): boolean {
  if (item.capability === null) return principal.kind === 'member'
  if (!item.scopes) return isAllowed(principal, item.capability)
  const scopes = scopesFor(principal, item.capability)
  return item.scopes.some((s) => scopes.has(s))
}

/** Menu entries this principal may open, in menu order. Pass `onlyReady` for what the screen renders. */
export function visibleMenu(principal: Principal, enabledModules: readonly ModuleKey[], onlyReady = false): MenuItem[] {
  const modules = new Set(enabledModules)
  return MENU.filter((item) => (!onlyReady || item.ready) && (item.module === null || modules.has(item.module)) && itemAllowed(principal, item))
}
