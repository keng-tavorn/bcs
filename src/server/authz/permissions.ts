// Permission table of spec §2.4 as data: Record<Capability, Grant[]>. Deny by default (BR-AUTH-01): a capability
// that is not listed is refused. "Approver" is never a role (§2.2): approval.decide and variance.decide come only
// from the DOA assignment of the task (incl. a delegate). tests/generated/permissions.test.ts parses §2.4 from
// spec.md itself and checks this file and isAllowed() against it, allow and deny for every capability.
// FROZEN after S1-08: changing this file is a permission change and needs the user's approval. S16-06 (spec §16.12, approved
// with spec 0.3.1) added request.follow and request.followers.manage, summarised for the user in docs/reports/ux-a2.md.
// S13-02 added the ai.* capabilities the user approved with docs/sub-specs/S13.md in P1-06 (docs/reports/p1-decisions.md).
// S6-09 added the role DOA_ADMIN and its separation from ORG_ADMIN (BR-WF-16, BR-WF-17), approved with docs/sub-specs/S6.md
// in P1-06 (OQ-109, docs/reports/p1-decisions.md §20). S6-10 added catalog.view and catalog.manage (FR-INT-102, OQ-114). S6-11 added priceReference.view
// (FR-DOA-101, BR-PRC-07, OQ-116). S6-12 added request.reorder (FR-INT-101, BR-FORM-07). S6-15 added
// budget.transfer.submit and the ASSIGNED reader of budget.view (FR-BUD-103, OQ-105). S6-16 added budget.overrun.submit
// (FR-BUD-101, OQ-104). S6-21 added config.export, config.import and platform.sandbox.manage (FR-PLT-101, OQ-108).
//
// `condition` names an extra rule from §2.4 that the service enforces on top of grantee + scope.

export const STORED_ROLES = ['PROCUREMENT', 'FINANCE', 'BUDGET_ADMIN', 'RECEIVER', 'EXECUTIVE', 'AUDITOR', 'ORG_ADMIN', 'DOA_ADMIN'] as const
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
  AI_TARGET_DOCUMENT_RIGHTS: "the service also checks the right of the document the AI fills (request.create, gr.post, the invoice's)",
  AI_OWN_SCOPE_ONLY: 'tools answer within the asking member\'s own scopes only (BR-AI-21)',
  AI_DOA_DRAFT_HOLDER: 'only a member holding admin.doa.draft; never PLATFORM_ADMIN (NG-12, OQ-146)',
  AI_METADATA_ONLY: "agent, purpose, status, time, credits and tools only; never another member's inputText or output",
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
/** S6-09 (BR-WF-16): the DOA and the workflow are drafted by ORG_ADMIN and DOA_ADMIN — ORG_ADMIN only until separated */
const DOA_ADMINS = roles(['ORG_ADMIN', 'DOA_ADMIN'], 'ORG')
/** S6-21: who keeps the organization's configuration package — not separable: its DOA and workflow parts need admin.doa.draft and admin.workflow.draft too (BR-WF-17) */
const ORG_DOA_ADMINS_CONFIG = roles(['ORG_ADMIN', 'DOA_ADMIN'], 'ORG')
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
  // S6-12 (FR-INT-101, BR-FORM-07): a new draft from one's own request, or its renewal; the service passes the requester
  // alone as owner, so a follower or a department head never reorders
  'request.reorder': [anyMember('OWN')],
  // Approvals and delegation
  'approval.decide': [doaAssignee()],
  // S6 (BR-WF-09): only who the workflow version in effect names in the reviewer's task (with whoever acts for them)
  'review.decide': [doaAssignee()],
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
  // Budget
  // S6-15: the approver of a transfer reads it (ASSIGNED, the transfer's own route)
  'budget.view': [anyMember('OWN', 'SELECTED_LINE_ONLY'), anyMember('ASSIGNED'), deptHead(), ...roles(['FINANCE', 'BUDGET_ADMIN', 'EXECUTIVE', 'AUDITOR'], 'ORG')],
  'budget.import': [role('BUDGET_ADMIN', 'ORG')],
  'budgetGrant.manage': [role('BUDGET_ADMIN', 'ORG')],
  // S6-15 (FR-BUD-103, BR-BUD-10 · OQ-105): a transfer, increase or decrease sent for approval under the BUDGET_TRANSFER rule
  'budget.transfer.submit': [role('BUDGET_ADMIN', 'ORG'), deptHead()],
  // S6-16 (FR-BUD-101, BR-BUD-12 · OQ-104): the requester asks for the shortfall of their own request under the OVER_BUDGET rule
  'budget.overrun.submit': [anyMember('OWN')],
  // Suppliers, exports, reports
  'supplier.view': [anyMember('ORG', 'BASIC_FIELDS_ONLY'), ...roles(['PROCUREMENT', 'FINANCE', 'AUDITOR'], 'ORG')],
  'supplier.manage': PROCUREMENT_ONLY,
  // S6-10 (FR-INT-102, BR-PRC-06 · OQ-114): every member searches the catalogue; PROCUREMENT keeps it and its agreed prices
  'catalog.view': [anyMember('ORG')],
  'catalog.manage': PROCUREMENT_ONLY,
  // S6-11 (FR-DOA-101, BR-PRC-07 · OQ-116): the price reference of a request comes from the POs of the whole organization,
  // so only who has or had its approval or review task (with whoever acts for them), and who reads every PO
  'priceReference.view': [anyMember('ASSIGNED'), ...roles(['PROCUREMENT', 'FINANCE', 'EXECUTIVE', 'AUDITOR'], 'ORG')],
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
  'admin.doa.draft': DOA_ADMINS,
  'admin.doa.simulate': DOA_ADMINS,
  'admin.doa.submitForPublish': roles(['ORG_ADMIN', 'DOA_ADMIN'], 'ORG', 'APPROVED_BY_DOA_CHANGE'),
  // S6 (FR-WF-103, BR-WF-12): the parallel reviewers, published through the DOA_CHANGE rule with a step-up every time
  'admin.workflow.draft': DOA_ADMINS,
  'admin.workflow.simulate': DOA_ADMINS,
  'admin.workflow.submitForPublish': roles(['ORG_ADMIN', 'DOA_ADMIN'], 'ORG', 'APPROVED_BY_DOA_CHANGE'),
  'admin.policyHistory.view': roles(['AUDITOR', 'ORG_ADMIN'], 'ORG'),
  'admin.policyHistory.export': roles(['AUDITOR', 'ORG_ADMIN'], 'ORG'),
  // Self-service
  'self.lineLink': SELF,
  'self.pin': SELF,
  'self.twoFactor': SELF,
  'self.notificationPrefs': SELF,
  // AI (S13, docs/sub-specs/S13.md "สิทธิ์ event error และการแจ้งเตือน"): no grant to PLATFORM_ADMIN except credits
  'ai.assist': [anyMember('OWN', 'AI_TARGET_DOCUMENT_RIGHTS')],
  'ai.ask': [anyMember('OWN', 'AI_OWN_SCOPE_ONLY')],
  'ai.brief.view': [doaAssignee()],
  'ai.doaDraft': [role('ORG_ADMIN', 'ORG', 'AI_DOA_DRAFT_HOLDER')],
  'ai.actions.view': [role('AUDITOR', 'ORG'), anyMember('OWN'), role('ORG_ADMIN', 'ORG', 'AI_METADATA_ONLY')],
  'admin.ai.manage': ORG_ADMIN_ONLY,
  'platform.ai.credits': [platformAdmin('CONTRACT_REF_AND_REASON')],
  // S6-21 (FR-PLT-101, BR-UAT-01 to BR-UAT-04 · OQ-108): a UAT sandbox of a customer, empty, with the contract; never a
  // copy of its structure or DOA (NG-12). The configuration package is the customer's own: exported and imported as drafts
  'platform.sandbox.manage': [platformAdmin('CONTRACT_REF_AND_REASON')],
  'config.export': ORG_DOA_ADMINS_CONFIG,
  'config.import': ORG_DOA_ADMINS_CONFIG,
} as const satisfies Record<string, readonly Grant[]>

export type Capability = keyof typeof PERMISSIONS
export const CAPABILITIES = Object.keys(PERMISSIONS) as Capability[]

/**
 * S6-09 (BR-WF-17 · OQ-109): what ORG_ADMIN no longer gets once the DOA version in effect separates the DOA
 * administrators (sodPolicy.doaAdminSeparated); DOA_ADMIN keeps them. The table above stays the same (OQ-34).
 */
export const DOA_ADMIN_SEPARABLE: ReadonlySet<Capability> = new Set(CAPABILITIES.filter((c) => c.startsWith('admin.doa.') || c.startsWith('admin.workflow.')))
