import { isAllowed, scopesFor, type Principal } from '@/server/authz'
import type { Capability, Scope } from '@/server/authz/permissions'
import type { ModuleKey } from '@/server/queries/organization'

// Workspace menu (§9.1 §9.10, FR-PLT-002 AC1): an item shows only when the member holds its capability (§2.4) — with one
// of the listed scopes when `scopes` is set — and its module is switched on. Hiding is convenience only: every
// service checks permissions again (BR-AUTH-05). `ready` turns on when the page exists (its checklist item).
// The sidebar shows the groups of §9.10 in SIDEBAR_GROUPS order (`main` has no heading, `footer` sits at the bottom);
// the pages of `settings` and `admin` are listed on their hub (/settings, /admin), which shows exactly when one of them
// does; the door (`newRequest`) is the main button of the top bar. The ⌘K palette reaches every visible entry.

export type MenuGroup = 'main' | 'procurement' | 'finance' | 'insight' | 'footer' | 'door' | 'settings' | 'admin' | 'platform'
/** The sidebar's groups, top to bottom */
export const SIDEBAR_GROUPS = ['main', 'procurement', 'finance', 'insight', 'footer'] as const satisfies readonly MenuGroup[]
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
  | 'insights'
  | 'board'
  | 'reports'
  | 'audit'
  | 'settings'
  | 'admin'
  | 'members'
  | 'org'
  | 'calendar'
  | 'numbering'
  | 'requestTypes'
  | 'line'
  | 'doa'
  | 'orgAuthority'
  | 'policyHistory'
  | 'modules'
  | 'ai'
  | 'tenants'
  | 'delegation'
  | 'security'
  | 'pin'
  | 'lineLink'
  | 'notifications'

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
  /** A hub page that lists one group's pages: shows exactly when one of them does */
  readonly hubOf?: MenuGroup
}

export const MENU: readonly MenuItem[] = [
  { key: 'home', href: '/', group: 'main', capability: null, module: null, ready: true },
  { key: 'tasks', href: '/tasks', group: 'main', capability: null, module: 'CORE', ready: true },
  { key: 'requests', href: '/requests', group: 'main', capability: 'request.view', module: 'CORE', ready: true },
  { key: 'newRequest', href: '/requests/new', group: 'door', capability: 'request.create', module: 'CORE', ready: true },
  { key: 'pool', href: '/procurement/pool', group: 'procurement', capability: 'procurement.pool.view', module: 'CORE', ready: true },
  // Every PO of the organization: for whoever may see all of them (§9.10, po.view at ORG scope); others open their own
  { key: 'pos', href: '/procurement/pos', group: 'procurement', capability: 'po.view', scopes: ['ORG'], module: 'CORE', ready: true },
  { key: 'receiving', href: '/receiving', group: 'procurement', capability: 'gr.post', scopes: ['DEPT', 'ASSIGNED'], module: 'CORE', ready: true },
  { key: 'suppliers', href: '/suppliers', group: 'procurement', capability: 'supplier.view', module: 'CORE', ready: true },
  { key: 'invoices', href: '/finance/invoices', group: 'finance', capability: 'invoiceConfirmation.record', module: 'CORE', ready: true },
  { key: 'exports', href: '/finance/exports', group: 'finance', capability: 'export.express', module: 'CORE', ready: true },
  { key: 'budgets', href: '/budgets', group: 'finance', capability: 'budget.view', scopes: ['DEPT', 'ORG'], module: 'CORE', ready: true },
  // The executive summary (FR-VIS-007, S16-08) took the KPI entry's place: /kpi still opens, from the control card and
  // its own link to /insights (FR-VIS-007 AC4), and is no longer a menu of its own (§9.10)
  { key: 'insights', href: '/insights', group: 'insight', capability: 'report.view', module: 'CORE', ready: true },
  { key: 'board', href: '/board/pending', group: 'insight', capability: 'board.pending.view', module: 'CORE', ready: true },
  { key: 'reports', href: '/reports', group: 'insight', capability: 'report.view', module: 'CORE', ready: true },
  { key: 'audit', href: '/audit', group: 'insight', capability: 'audit.view', module: 'CORE', ready: true },
  { key: 'settings', href: '/settings', group: 'footer', capability: null, module: null, ready: true, hubOf: 'settings' },
  { key: 'admin', href: '/admin', group: 'footer', capability: null, module: null, ready: true, hubOf: 'admin' },
  { key: 'members', href: '/admin/members', group: 'admin', capability: 'admin.members', module: 'CORE', ready: true },
  { key: 'org', href: '/admin/org', group: 'admin', capability: 'admin.orgStructure.editBasic', module: 'CORE', ready: true },
  { key: 'calendar', href: '/admin/calendar', group: 'admin', capability: 'admin.calendar', module: 'CORE', ready: true },
  { key: 'numbering', href: '/admin/numbering', group: 'admin', capability: 'admin.numbering', module: 'CORE', ready: true },
  { key: 'requestTypes', href: '/admin/request-types', group: 'admin', capability: 'admin.requestTypes', module: 'CORE', ready: true },
  // The organization's LINE channel (FR-ADM-006 AC2 AC3; §9.1 lists the channels after the request types)
  { key: 'line', href: '/admin/line', group: 'admin', capability: 'admin.channels', module: 'CORE', ready: true },
  { key: 'doa', href: '/admin/doa', group: 'admin', capability: 'admin.doa.draft', module: 'CORE', ready: true },
  { key: 'orgAuthority', href: '/admin/org-authority', group: 'admin', capability: 'admin.orgAuthority.propose', module: 'CORE', ready: true },
  { key: 'policyHistory', href: '/admin/policy-history', group: 'admin', capability: 'admin.policyHistory.view', module: 'CORE', ready: false },
  { key: 'modules', href: '/admin/modules', group: 'admin', capability: 'admin.modules.view', module: 'CORE', ready: true },
  // S13-04: the organization's AI assistants and credits, once the BCS team switched the AI module on
  { key: 'ai', href: '/admin/ai', group: 'admin', capability: 'admin.ai.manage', module: 'AI', ready: true },
  { key: 'tenants', href: '/platform/tenants', group: 'platform', capability: 'platform.modules.manage', module: null, ready: true },
  // Acting approvers belong to approvals (CORE); every member may name one for themself (delegation.manage OWN)
  { key: 'delegation', href: '/settings/delegation', group: 'settings', capability: 'delegation.manage', module: 'CORE', ready: true },
  { key: 'security', href: '/settings/security', group: 'settings', capability: 'self.twoFactor', module: null, ready: true },
  // The member's own settings (§9.1 /settings/*: PIN, LINE, notifications), like the account's security not tied to a module
  { key: 'pin', href: '/settings/pin', group: 'settings', capability: 'self.pin', module: null, ready: true },
  { key: 'lineLink', href: '/settings/line', group: 'settings', capability: 'self.lineLink', module: null, ready: true },
  { key: 'notifications', href: '/settings/notifications', group: 'settings', capability: 'self.notificationPrefs', module: null, ready: true },
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
  const pages = MENU.filter((item) => !item.hubOf && (!onlyReady || item.ready) && (item.module === null || modules.has(item.module)) && itemAllowed(principal, item))
  const groups = new Set(pages.map((item) => item.group))
  return MENU.filter((item) => (item.hubOf ? groups.has(item.hubOf) : pages.includes(item)))
}
