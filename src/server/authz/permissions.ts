// Permission table of spec §2.4 as data: Record<Capability, Grant[]>. Deny by default (BR-AUTH-01): a capability
// that is not listed is refused. "Approver" is never a role (§2.2): approval.decide and variance.decide come only
// from the DOA assignment of the task (incl. a delegate). tests/generated/permissions.test.ts parses §2.4 from
// spec.md itself and checks this file and isAllowed() against it, allow and deny for every capability.
// FROZEN after S1-08: changing this file is a permission change and needs the user's approval. S16-06 (spec §16.12, approved
// with spec 0.3.1) added request.follow and request.followers.manage, summarised for the user in docs/reports/ux-a2.md.
//
// `condition` names an extra rule from §2.4 that the service enforces on top of grantee + scope.

export const STORED_ROLES = ['PROCUREMENT', 'FINANCE', 'BUDGET_ADMIN', 'RECEIVER', 'EXECUTIVE', 'AUDITOR', 'ORG_ADMIN'] as const
export type StoredRole = (typeof STORED_ROLES)[number]

export const SCOPES = ['OWN', 'ASSIGNED', 'DEPT', 'ORG'] as const
export type Scope = (typeof SCOPES)[number]

export type Grantee =
  | { readonly kind: 'ANY_MEMBER' }
  | { readonly kind: 'ROLE'; readonly role: StoredRole }
  | { readonly kind: 'DEPT_HEAD' }
  | { readonly kind: 'PLATFORM_ADMIN' }
  | { readonly kind: 'DOA_ASSIGNEE' }

export const CONDITIONS = {
  NO_PO_YET: 'requester cancels only before a PO exists',
  APPROVED_NOT_ORDERED_WITH_REASON: 'only APPROVED requests not yet ordered, with a reason',
  DOA_EQUIVALENT_ASSIGNEE_WITH_REASON: 'new assignee holds the same or higher DOA authority without SoD conflict, with a reason',
  REQUESTER_MAY_RECEIVE: "only when the effective DOA version's sodPolicy.requesterMayReceive is true (OQ-04)",
  WITH_REASON_BEFORE_INVOICE: 'with a reason, before the invoice confirmation',
  GR_VARIANCE_RULE: 'DOA rule GR_VARIANCE decides who approves',
  SELECTED_LINE_ONLY: 'remaining balance of the budget line chosen in the own request form only',
  BASIC_FIELDS_ONLY: 'name and basic details only',
  CONTRACT_REF_AND_REASON: 'contractRef and a reason are required (BR-AUTH-08)',
  APPROVED_BY_ORG_AUTHORITY_CHANGE: 'takes effect only after approval under DOA rule ORG_AUTHORITY_CHANGE (BR-DOA-17)',
  APPROVED_BY_DOA_CHANGE: 'publishing needs approval under DOA rule DOA_CHANGE; submitter != approver',
  SELF_ONLY_NOT_REQUESTER: 'follows or unfollows only themselves; the requester does not follow their own request',
  ADDED_MEMBER_ALREADY_VIEWS: 'the member added must already have request.view of the request (OQ-39)',
} as const
export type Condition = keyof typeof CONDITIONS

export interface Grant {
  readonly grantee: Grantee
  readonly scope: Scope
  readonly condition?: Condition
}

const role = (r: StoredRole, scope: Scope, condition?: Condition): Grant => ({ grantee: { kind: 'ROLE', role: r }, scope, ...(condition ? { condition } : {}) })
const roles = (rs: readonly StoredRole[], scope: Scope, condition?: Condition): Grant[] => rs.map((r) => role(r, scope, condition))
const anyMember = (scope: Scope, condition?: Condition): Grant => ({ grantee: { kind: 'ANY_MEMBER' }, scope, ...(condition ? { condition } : {}) })
const deptHead = (): Grant => ({ grantee: { kind: 'DEPT_HEAD' }, scope: 'DEPT' })
const doaAssignee = (condition?: Condition): Grant => ({ grantee: { kind: 'DOA_ASSIGNEE' }, scope: 'ASSIGNED', ...(condition ? { condition } : {}) })
const platformAdmin = (condition: Condition): Grant => ({ grantee: { kind: 'PLATFORM_ADMIN' }, scope: 'ORG', condition })

const PROCUREMENT_ONLY = [role('PROCUREMENT', 'ORG')]
const ORG_ADMIN_ONLY = [role('ORG_ADMIN', 'ORG')]
const SELF = [anyMember('OWN')]
/** request.view (§2.4). OWN of a request is the requester and its followers here; for the commands that change the
 *  request (request.create on a draft, request.submit, request.cancel, request.followers.manage) the services pass
 *  the requester alone as owner, so a follower never sends, edits, cancels or adds followers (FR-INT-013 AC3). */
const REQUEST_VIEWERS = [anyMember('OWN'), anyMember('ASSIGNED'), deptHead(), ...roles(['PROCUREMENT', 'FINANCE', 'EXECUTIVE', 'AUDITOR', 'ORG_ADMIN'], 'ORG')]

export const PERMISSIONS = {
  // Requests
  'request.create': SELF,
  'request.submit': SELF,
  'request.view': REQUEST_VIEWERS,
  'request.cancel': [anyMember('OWN', 'NO_PO_YET'), role('PROCUREMENT', 'ORG', 'APPROVED_NOT_ORDERED_WITH_REASON')],
  // FR-INT-013 AC1: whoever may view the request follows it; only the requester adds or removes others
  'request.follow': REQUEST_VIEWERS.map((g) => ({ ...g, condition: 'SELF_ONLY_NOT_REQUESTER' as const })),
  'request.followers.manage': [anyMember('OWN', 'ADDED_MEMBER_ALREADY_VIEWS')],
  // Approvals and delegation
  'approval.decide': [doaAssignee()],
  'approval.reassign': [role('ORG_ADMIN', 'ORG', 'DOA_EQUIVALENT_ASSIGNEE_WITH_REASON')],
  // ORG_ADMIN sets a delegation for someone else only through admin.orgAuthority.propose (DELEGATION_ON_BEHALF)
  'delegation.manage': SELF,
  // Purchase orders
  'procurement.pool.view': PROCUREMENT_ONLY,
  'po.create': PROCUREMENT_ONLY,
  'po.edit': PROCUREMENT_ONLY,
  'po.submit': PROCUREMENT_ONLY,
  'po.send': PROCUREMENT_ONLY,
  'po.cancel': PROCUREMENT_ONLY,
  'po.close': PROCUREMENT_ONLY,
  'po.view': [...roles(['PROCUREMENT', 'FINANCE', 'EXECUTIVE', 'AUDITOR'], 'ORG'), anyMember('OWN'), anyMember('ASSIGNED')],
  // Receiving and invoices
  'gr.post': [role('RECEIVER', 'DEPT'), role('RECEIVER', 'ASSIGNED'), anyMember('OWN', 'REQUESTER_MAY_RECEIVE')],
  'gr.reverse': [role('PROCUREMENT', 'ORG', 'WITH_REASON_BEFORE_INVOICE')],
  'variance.decide': [doaAssignee('GR_VARIANCE_RULE')],
  'invoiceConfirmation.record': [role('FINANCE', 'ORG')],
  // S8 tier-2 invoices (module PAY, BR-AP-13): draft, edit, code, submit and throw away
  'invoice.record': [role('FINANCE', 'ORG')],
  'invoice.reject': roles(['FINANCE', 'PROCUREMENT'], 'ORG'),
  // BR-MATCH-09: each holder checks again only the differences sent to their role (the service checks the role)
  'invoice.exception.resolve': [...roles(['FINANCE', 'PROCUREMENT'], 'ORG'), role('RECEIVER', 'DEPT'), role('RECEIVER', 'ASSIGNED')],
  'invoice.variance.request': [role('PROCUREMENT', 'ORG')],
  // Budget
  'budget.view': [anyMember('OWN', 'SELECTED_LINE_ONLY'), deptHead(), ...roles(['FINANCE', 'BUDGET_ADMIN', 'EXECUTIVE', 'AUDITOR'], 'ORG')],
  'budget.import': [role('BUDGET_ADMIN', 'ORG')],
  'budgetGrant.manage': [role('BUDGET_ADMIN', 'ORG')],
  // Suppliers, exports, reports
  'supplier.view': [anyMember('ORG', 'BASIC_FIELDS_ONLY'), ...roles(['PROCUREMENT', 'FINANCE', 'AUDITOR'], 'ORG')],
  'supplier.manage': PROCUREMENT_ONLY,
  'export.express': [role('FINANCE', 'ORG')],
  'report.view': [...roles(['FINANCE', 'PROCUREMENT', 'EXECUTIVE', 'AUDITOR'], 'ORG'), deptHead()],
  'report.schedule': roles(['FINANCE', 'EXECUTIVE'], 'ORG'),
  'board.pending.view': [anyMember('OWN'), anyMember('ASSIGNED'), deptHead(), ...roles(['EXECUTIVE', 'PROCUREMENT', 'FINANCE', 'AUDITOR'], 'ORG')],
  // Audit
  'audit.view': roles(['AUDITOR', 'ORG_ADMIN'], 'ORG'),
  'audit.export': [role('AUDITOR', 'ORG')],
  // Organization administration (approval of authority changes happens through DOA rules, not roles)
  'admin.members': ORG_ADMIN_ONLY,
  'admin.orgStructure.editBasic': ORG_ADMIN_ONLY,
  'admin.calendar': ORG_ADMIN_ONLY,
  'admin.numbering': ORG_ADMIN_ONLY,
  'admin.requestTypes': ORG_ADMIN_ONLY,
  'admin.channels': ORG_ADMIN_ONLY,
  'admin.modules.view': ORG_ADMIN_ONLY,
  'platform.modules.manage': [platformAdmin('CONTRACT_REF_AND_REASON')],
  'admin.orgAuthority.propose': [role('ORG_ADMIN', 'ORG', 'APPROVED_BY_ORG_AUTHORITY_CHANGE')],
  'admin.doa.draft': ORG_ADMIN_ONLY,
  'admin.doa.simulate': ORG_ADMIN_ONLY,
  'admin.doa.submitForPublish': [role('ORG_ADMIN', 'ORG', 'APPROVED_BY_DOA_CHANGE')],
  'admin.policyHistory.view': roles(['AUDITOR', 'ORG_ADMIN'], 'ORG'),
  'admin.policyHistory.export': roles(['AUDITOR', 'ORG_ADMIN'], 'ORG'),
  // Self-service
  'self.lineLink': SELF,
  'self.pin': SELF,
  'self.twoFactor': SELF,
  'self.notificationPrefs': SELF,
} as const satisfies Record<string, readonly Grant[]>

export type Capability = keyof typeof PERMISSIONS
export const CAPABILITIES = Object.keys(PERMISSIONS) as Capability[]
