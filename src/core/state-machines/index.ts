// State machines (spec §6.4) as data tables, never scattered if-else. A pair (state, command) that is not in a table
// is refused with INVALID_STATE_TRANSITION; tests walk every pair and count them (§15.3).

export interface Transition<S extends string, C extends string> {
  readonly from: readonly S[]
  readonly command: C
  readonly to: S
}

export interface StateMachine<S extends string, C extends string> {
  readonly name: string
  readonly states: readonly S[]
  readonly commands: readonly C[]
  readonly transitions: readonly Transition<S, C>[]
}

export type TransitionResult<S extends string> = { readonly ok: true; readonly to: S } | { readonly ok: false; readonly error: 'INVALID_STATE_TRANSITION'; readonly from: S; readonly command: string }

export function transition<S extends string, C extends string>(machine: StateMachine<S, C>, from: S, command: C): TransitionResult<S> {
  const found = machine.transitions.find((t) => t.command === command && t.from.includes(from))
  return found ? { ok: true, to: found.to } : { ok: false, error: 'INVALID_STATE_TRANSITION', from, command }
}

function machine<S extends string, C extends string>(name: string, states: readonly S[], commands: readonly C[], transitions: readonly Transition<S, C>[]): StateMachine<S, C> {
  return { name, states, commands, transitions }
}

// ---------- purchase request (PR) ----------

export const REQUEST_STATES = ['DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'REJECTED', 'RETURNED', 'CANCELLED', 'PARTIALLY_ORDERED', 'ORDERED', 'COMPLETED'] as const
export type RequestState = (typeof REQUEST_STATES)[number]
export const REQUEST_COMMANDS = [
  'request.submit',
  'request.final_approval',
  'approval.reject',
  'approval.return',
  'request.resubmit',
  'request.cancel',
  'po.approved_partially',
  'po.approved_fully',
  'request.cancel_remaining',
  'po.all_closed',
  'po.cancelled_to_pool_partially',
  'po.cancelled_to_pool_fully',
] as const
export type RequestCommand = (typeof REQUEST_COMMANDS)[number]

export const REQUEST_MACHINE = machine<RequestState, RequestCommand>('Request', REQUEST_STATES, REQUEST_COMMANDS, [
  { from: ['DRAFT'], command: 'request.submit', to: 'PENDING_APPROVAL' },
  { from: ['PENDING_APPROVAL'], command: 'request.final_approval', to: 'APPROVED' },
  { from: ['PENDING_APPROVAL'], command: 'approval.reject', to: 'REJECTED' },
  { from: ['PENDING_APPROVAL'], command: 'approval.return', to: 'RETURNED' },
  { from: ['RETURNED'], command: 'request.resubmit', to: 'PENDING_APPROVAL' },
  // §6.4: by the requester before approval; by PROCUREMENT once APPROVED, with a reason and no line on a PO yet (the
  // service checks who and when)
  { from: ['DRAFT', 'RETURNED', 'PENDING_APPROVAL', 'APPROVED'], command: 'request.cancel', to: 'CANCELLED' },
  { from: ['APPROVED'], command: 'po.approved_partially', to: 'PARTIALLY_ORDERED' },
  { from: ['APPROVED', 'PARTIALLY_ORDERED'], command: 'po.approved_fully', to: 'ORDERED' },
  { from: ['APPROVED', 'PARTIALLY_ORDERED'], command: 'request.cancel_remaining', to: 'ORDERED' },
  { from: ['ORDERED'], command: 'po.all_closed', to: 'COMPLETED' },
  // NEW-23: an approved PO cancelled with RETURN_TO_POOL (BR-BUD-06) gives its lines back to the pool, so the request
  // is ordered again only in part, or not at all
  { from: ['ORDERED'], command: 'po.cancelled_to_pool_partially', to: 'PARTIALLY_ORDERED' },
  { from: ['ORDERED', 'PARTIALLY_ORDERED'], command: 'po.cancelled_to_pool_fully', to: 'APPROVED' },
])

// ---------- new-supplier request (tier 1: no DOA, OQ-23) ----------

export const SUPPLIER_REQUEST_STATES = ['DRAFT', 'SUBMITTED', 'DONE', 'REJECTED', 'CANCELLED'] as const
export type SupplierRequestState = (typeof SUPPLIER_REQUEST_STATES)[number]
export const SUPPLIER_REQUEST_COMMANDS = ['request.submit', 'supplier_request.done', 'supplier_request.reject', 'request.cancel'] as const
export type SupplierRequestCommand = (typeof SUPPLIER_REQUEST_COMMANDS)[number]

export const SUPPLIER_REQUEST_MACHINE = machine<SupplierRequestState, SupplierRequestCommand>('SupplierRequest', SUPPLIER_REQUEST_STATES, SUPPLIER_REQUEST_COMMANDS, [
  { from: ['DRAFT'], command: 'request.submit', to: 'SUBMITTED' },
  { from: ['SUBMITTED'], command: 'supplier_request.done', to: 'DONE' },
  { from: ['SUBMITTED'], command: 'supplier_request.reject', to: 'REJECTED' },
  { from: ['DRAFT', 'SUBMITTED'], command: 'request.cancel', to: 'CANCELLED' },
])

// ---------- approval task ----------

export const TASK_STATES = ['OPEN', 'INFO_REQUESTED', 'APPROVED', 'REJECTED', 'RETURNED', 'CANCELLED', 'REASSIGNED'] as const
export type TaskState = (typeof TASK_STATES)[number]
export const TASK_COMMANDS = ['approval.approve', 'approval.reject', 'approval.return', 'approval.requestInfo', 'request.provideInfo', 'task.reassign', 'task.cancel'] as const
export type TaskCommand = (typeof TASK_COMMANDS)[number]

export const TASK_MACHINE = machine<TaskState, TaskCommand>('ApprovalTask', TASK_STATES, TASK_COMMANDS, [
  { from: ['OPEN'], command: 'approval.approve', to: 'APPROVED' },
  { from: ['OPEN'], command: 'approval.reject', to: 'REJECTED' },
  { from: ['OPEN'], command: 'approval.return', to: 'RETURNED' },
  { from: ['OPEN'], command: 'approval.requestInfo', to: 'INFO_REQUESTED' },
  { from: ['INFO_REQUESTED'], command: 'request.provideInfo', to: 'OPEN' },
  // delegation starts or ends, or ORG_ADMIN reassigns
  { from: ['OPEN', 'INFO_REQUESTED'], command: 'task.reassign', to: 'REASSIGNED' },
  // the route is cancelled, or another assignee of the step decided first
  { from: ['OPEN', 'INFO_REQUESTED'], command: 'task.cancel', to: 'CANCELLED' },
])

// ---------- DOA version ----------

export const DOA_VERSION_STATES = ['DRAFT', 'PENDING_APPROVAL', 'PUBLISHED', 'SUPERSEDED', 'REJECTED', 'WITHDRAWN'] as const
export type DoaVersionState = (typeof DOA_VERSION_STATES)[number]
export const DOA_VERSION_COMMANDS = ['doa.submit', 'doa.approve', 'doa.reject', 'doa.supersede', 'doa.withdraw', 'doa.requestWithdrawal', 'doa.rejectWithdrawal'] as const
export type DoaVersionCommand = (typeof DOA_VERSION_COMMANDS)[number]

export const DOA_VERSION_MACHINE = machine<DoaVersionState, DoaVersionCommand>('DoaVersion', DOA_VERSION_STATES, DOA_VERSION_COMMANDS, [
  { from: ['DRAFT'], command: 'doa.submit', to: 'PENDING_APPROVAL' },
  { from: ['PENDING_APPROVAL'], command: 'doa.approve', to: 'PUBLISHED' },
  { from: ['PENDING_APPROVAL'], command: 'doa.reject', to: 'REJECTED' },
  { from: ['PUBLISHED'], command: 'doa.supersede', to: 'SUPERSEDED' },
  // S6 (BR-DOA-18): an approved version not yet in effect may be withdrawn; the service refuses it before S6
  { from: ['PUBLISHED'], command: 'doa.withdraw', to: 'WITHDRAWN' },
  // S6 (FR-DOA-104): the withdrawal waits for its own DOA_CHANGE route; the version stays PUBLISHED until it is decided
  // (the service checks effectiveFrom > now: ALREADY_EFFECTIVE)
  { from: ['PUBLISHED'], command: 'doa.requestWithdrawal', to: 'PUBLISHED' },
  { from: ['PUBLISHED'], command: 'doa.rejectWithdrawal', to: 'PUBLISHED' },
])

// ---------- workflow version (S6 · FR-WF-103 · BR-WF-12) ----------

// Created DRAFT by workflowVersion.draft (a copy of the latest version), like a DOA version
export const WORKFLOW_VERSION_STATES = DOA_VERSION_STATES
export type WorkflowVersionState = DoaVersionState
export const WORKFLOW_VERSION_COMMANDS = [
  'workflowVersion.update',
  'workflowVersion.submit',
  'workflowVersion.approve',
  'workflowVersion.reject',
  'workflowVersion.supersede',
  'workflowVersion.requestWithdrawal',
  'workflowVersion.withdraw',
  'workflowVersion.rejectWithdrawal',
] as const
export type WorkflowVersionCommand = (typeof WORKFLOW_VERSION_COMMANDS)[number]

export const WORKFLOW_VERSION_MACHINE = machine<WorkflowVersionState, WorkflowVersionCommand>('WorkflowVersion', WORKFLOW_VERSION_STATES, WORKFLOW_VERSION_COMMANDS, [
  // an update clears dryRunAt; submit needs lint, test cases and a dry-run of the latest draft (the service checks)
  { from: ['DRAFT'], command: 'workflowVersion.update', to: 'DRAFT' },
  { from: ['DRAFT'], command: 'workflowVersion.submit', to: 'PENDING_APPROVAL' },
  // the last step of the DOA_CHANGE route, with step-up, by someone other than the submitter
  { from: ['PENDING_APPROVAL'], command: 'workflowVersion.approve', to: 'PUBLISHED' },
  { from: ['PENDING_APPROVAL'], command: 'workflowVersion.reject', to: 'REJECTED' },
  // job workflow-version-activate at the next version's effectiveFrom
  { from: ['PUBLISHED'], command: 'workflowVersion.supersede', to: 'SUPERSEDED' },
  // not yet in effect (the service checks): the withdrawal has its own route, as a DOA version's (BR-DOA-18)
  { from: ['PUBLISHED'], command: 'workflowVersion.requestWithdrawal', to: 'PUBLISHED' },
  { from: ['PUBLISHED'], command: 'workflowVersion.withdraw', to: 'WITHDRAWN' },
  { from: ['PUBLISHED'], command: 'workflowVersion.rejectWithdrawal', to: 'PUBLISHED' },
])

// ---------- form version (S6 · FR-INT-104 · BR-FORM-09) ----------

// Created DRAFT by formVersion.draft or config.import (one draft per request type); a draft is never thrown away
export const FORM_VERSION_STATES = ['DRAFT', 'PUBLISHED', 'RETIRED'] as const
export type FormVersionState = (typeof FORM_VERSION_STATES)[number]
export const FORM_VERSION_COMMANDS = ['formVersion.update', 'formVersion.publish', 'formVersion.retire'] as const
export type FormVersionCommand = (typeof FORM_VERSION_COMMANDS)[number]

export const FORM_VERSION_MACHINE = machine<FormVersionState, FormVersionCommand>('FormVersion', FORM_VERSION_STATES, FORM_VERSION_COMMANDS, [
  { from: ['DRAFT'], command: 'formVersion.update', to: 'DRAFT' },
  { from: ['DRAFT'], command: 'formVersion.publish', to: 'PUBLISHED' },
  // the next version of the same request type is published in the same transaction
  { from: ['PUBLISHED'], command: 'formVersion.retire', to: 'RETIRED' },
])

// ---------- approval step with slots (S6 · BR-WF-01) ----------

export const STEP_STATES = ['WAITING', 'ACTIVE', 'DONE', 'CANCELLED'] as const
export type StepState = (typeof STEP_STATES)[number]
export const STEP_COMMANDS = ['step.activate', 'step.group_decided', 'step.decided', 'step.cancel'] as const
export type StepCommand = (typeof STEP_COMMANDS)[number]

export const STEP_MACHINE = machine<StepState, StepCommand>('ApprovalStep', STEP_STATES, STEP_COMMANDS, [
  // the step before is APPROVED, or this is the first step: a task for every slot at once
  { from: ['WAITING'], command: 'step.activate', to: 'ACTIVE' },
  // a group of a REVIEW step is APPROVED while the step is still OPEN: the group's other open tasks are cancelled
  { from: ['ACTIVE'], command: 'step.group_decided', to: 'ACTIVE' },
  // stepOutcome is no longer OPEN: the step's open tasks are cancelled
  { from: ['ACTIVE'], command: 'step.decided', to: 'DONE' },
  // the route is cancelled
  { from: ['WAITING', 'ACTIVE'], command: 'step.cancel', to: 'CANCELLED' },
])

// ---------- budget transfer (S6 · FR-BUD-103 · BR-BUD-10) ----------

export const BUDGET_TRANSFER_STATES = ['DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'REJECTED', 'RETURNED', 'CANCELLED'] as const
export type BudgetTransferState = (typeof BUDGET_TRANSFER_STATES)[number]
export const BUDGET_TRANSFER_COMMANDS = ['budgetTransfer.submit', 'budgetTransfer.final_approval', 'approval.reject', 'approval.return', 'budgetTransfer.cancel'] as const
export type BudgetTransferCommand = (typeof BUDGET_TRANSFER_COMMANDS)[number]

// Created DRAFT by budgetTransfer.create
export const BUDGET_TRANSFER_MACHINE = machine<BudgetTransferState, BudgetTransferCommand>('BudgetTransfer', BUDGET_TRANSFER_STATES, BUDGET_TRANSFER_COMMANDS, [
  // reserves the source line (TRANSFER, DECREASE), issues the number and starts the BUDGET_TRANSFER route
  { from: ['DRAFT', 'RETURNED'], command: 'budgetTransfer.submit', to: 'PENDING_APPROVAL' },
  // releases the reservation and moves the amount out of the source and into the target in one transaction
  { from: ['PENDING_APPROVAL'], command: 'budgetTransfer.final_approval', to: 'APPROVED' },
  { from: ['PENDING_APPROVAL'], command: 'approval.reject', to: 'REJECTED' },
  { from: ['PENDING_APPROVAL'], command: 'approval.return', to: 'RETURNED' },
  { from: ['DRAFT', 'RETURNED', 'PENDING_APPROVAL'], command: 'budgetTransfer.cancel', to: 'CANCELLED' },
])

// ---------- over-budget approval (S6 · FR-BUD-101 · BR-BUD-12 to 18) ----------

export const BUDGET_OVERRUN_STATES = ['PENDING_APPROVAL', 'APPROVED', 'REJECTED', 'RETURNED', 'CANCELLED', 'CONSUMED', 'LAPSED'] as const
export type BudgetOverrunState = (typeof BUDGET_OVERRUN_STATES)[number]
export const BUDGET_OVERRUN_COMMANDS = [
  'budgetOverrun.final_approval',
  'approval.reject',
  'approval.return',
  'budgetOverrun.cancel',
  'request.cancel',
  'budgetOverrun.lapse',
  'budgetOverrun.consume',
  'budgetOverrun.returnUnused',
] as const
export type BudgetOverrunCommand = (typeof BUDGET_OVERRUN_COMMANDS)[number]

// Created PENDING_APPROVAL by budgetOverrun.submit with its OVER_BUDGET route; REJECTED and RETURNED are final (the
// requester asks again with a new overrun)
export const BUDGET_OVERRUN_MACHINE = machine<BudgetOverrunState, BudgetOverrunCommand>('BudgetOverrun', BUDGET_OVERRUN_STATES, BUDGET_OVERRUN_COMMANDS, [
  // funds X and earmarks it for the request (BR-BUD-13)
  { from: ['PENDING_APPROVAL'], command: 'budgetOverrun.final_approval', to: 'APPROVED' },
  { from: ['PENDING_APPROVAL'], command: 'approval.reject', to: 'REJECTED' },
  { from: ['PENDING_APPROVAL'], command: 'approval.return', to: 'RETURNED' },
  // by the requester, or with its request: before approval nothing moved; after, X goes back outside (BR-BUD-15)
  { from: ['PENDING_APPROVAL'], command: 'budgetOverrun.cancel', to: 'CANCELLED' },
  { from: ['APPROVED'], command: 'budgetOverrun.cancel', to: 'LAPSED' },
  { from: ['PENDING_APPROVAL'], command: 'request.cancel', to: 'CANCELLED' },
  { from: ['APPROVED'], command: 'request.cancel', to: 'LAPSED' },
  // job budget-overrun-lapse at lapsesAt
  { from: ['APPROVED'], command: 'budgetOverrun.lapse', to: 'LAPSED' },
  // the request's submit or resubmit succeeds (BR-BUD-14)
  { from: ['APPROVED'], command: 'budgetOverrun.consume', to: 'CONSUMED' },
  // a later command gives the request's budget back: the unused part goes outside (BR-BUD-18)
  { from: ['CONSUMED'], command: 'budgetOverrun.returnUnused', to: 'CONSUMED' },
])

// ---------- organization authority change ----------

export const ORG_CHANGE_STATES = ['DRAFT', 'PENDING_APPROVAL', 'SCHEDULED', 'APPLIED', 'REJECTED', 'CANCELLED'] as const
export type OrgChangeState = (typeof ORG_CHANGE_STATES)[number]
export const ORG_CHANGE_COMMANDS = ['org_change.submit', 'org_change.approve', 'org_change.approve_immediate', 'org_change.reject', 'org_change.cancel', 'org_change.apply'] as const
export type OrgChangeCommand = (typeof ORG_CHANGE_COMMANDS)[number]

export const ORG_CHANGE_MACHINE = machine<OrgChangeState, OrgChangeCommand>('OrgAuthorityChange', ORG_CHANGE_STATES, ORG_CHANGE_COMMANDS, [
  { from: ['DRAFT'], command: 'org_change.submit', to: 'PENDING_APPROVAL' },
  { from: ['PENDING_APPROVAL'], command: 'org_change.approve', to: 'SCHEDULED' },
  // IDENTITY_RESET takes effect as soon as it is approved
  { from: ['PENDING_APPROVAL'], command: 'org_change.approve_immediate', to: 'APPLIED' },
  { from: ['PENDING_APPROVAL'], command: 'org_change.reject', to: 'REJECTED' },
  { from: ['DRAFT', 'PENDING_APPROVAL'], command: 'org_change.cancel', to: 'CANCELLED' },
  // job org-authority-apply at effectiveFrom
  { from: ['SCHEDULED'], command: 'org_change.apply', to: 'APPLIED' },
])

// ---------- delegation ----------

export const DELEGATION_STATES = ['SCHEDULED', 'ACTIVE', 'ENDED', 'REVOKED'] as const
export type DelegationState = (typeof DELEGATION_STATES)[number]
export const DELEGATION_COMMANDS = ['delegation.start', 'delegation.end', 'delegation.revoke'] as const
export type DelegationCommand = (typeof DELEGATION_COMMANDS)[number]

export const DELEGATION_MACHINE = machine<DelegationState, DelegationCommand>('Delegation', DELEGATION_STATES, DELEGATION_COMMANDS, [
  { from: ['SCHEDULED'], command: 'delegation.start', to: 'ACTIVE' },
  { from: ['ACTIVE'], command: 'delegation.end', to: 'ENDED' },
  { from: ['SCHEDULED', 'ACTIVE'], command: 'delegation.revoke', to: 'REVOKED' },
])

// ---------- purchase order (PO) ----------

export const PO_STATES = ['DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'SENT', 'PARTIALLY_RECEIVED', 'RECEIVED', 'CLOSED', 'CANCELLED', 'REJECTED'] as const
export type PoState = (typeof PO_STATES)[number]
export const PO_COMMANDS = ['po.submit', 'po.final_approval', 'approval.reject', 'approval.return', 'po.send', 'gr.posted_partially', 'gr.posted_fully', 'gr.reversed_partially', 'gr.reversed_fully', 'po.cancel', 'po.close'] as const
export type PoCommand = (typeof PO_COMMANDS)[number]

export const PO_MACHINE = machine<PoState, PoCommand>('PurchaseOrder', PO_STATES, PO_COMMANDS, [
  { from: ['DRAFT'], command: 'po.submit', to: 'PENDING_APPROVAL' },
  { from: ['PENDING_APPROVAL'], command: 'po.final_approval', to: 'APPROVED' },
  { from: ['PENDING_APPROVAL'], command: 'approval.reject', to: 'REJECTED' },
  { from: ['PENDING_APPROVAL'], command: 'approval.return', to: 'DRAFT' },
  { from: ['APPROVED'], command: 'po.send', to: 'SENT' },
  // a GR is posted: what was accepted so far decides between partly and fully received
  { from: ['SENT', 'PARTIALLY_RECEIVED'], command: 'gr.posted_partially', to: 'PARTIALLY_RECEIVED' },
  { from: ['SENT', 'PARTIALLY_RECEIVED'], command: 'gr.posted_fully', to: 'RECEIVED' },
  // a GR is reversed before any invoice (§6.4 GR): back to what the GRs still posted say
  { from: ['PARTIALLY_RECEIVED', 'RECEIVED'], command: 'gr.reversed_partially', to: 'PARTIALLY_RECEIVED' },
  { from: ['PARTIALLY_RECEIVED', 'RECEIVED'], command: 'gr.reversed_fully', to: 'SENT' },
  { from: ['APPROVED', 'SENT'], command: 'po.cancel', to: 'CANCELLED' },
  { from: ['SENT', 'PARTIALLY_RECEIVED', 'RECEIVED'], command: 'po.close', to: 'CLOSED' },
])

// ---------- goods receipt (GR) ----------

export const GR_STATES = ['DRAFT', 'POSTED', 'REVERSED'] as const
export type GrState = (typeof GR_STATES)[number]
export const GR_COMMANDS = ['gr.post', 'gr.reverse'] as const
export type GrCommand = (typeof GR_COMMANDS)[number]

export const GR_MACHINE = machine<GrState, GrCommand>('GoodsReceipt', GR_STATES, GR_COMMANDS, [
  { from: ['DRAFT'], command: 'gr.post', to: 'POSTED' },
  // PROCUREMENT with a reason, before any invoice of the PO is confirmed
  { from: ['POSTED'], command: 'gr.reverse', to: 'REVERSED' },
])

// ---------- variance (BR-GR-03) ----------

export const VARIANCE_STATES = ['RECORDED', 'PENDING_APPROVAL', 'APPROVED', 'REJECTED'] as const
export type VarianceState = (typeof VARIANCE_STATES)[number]
export const VARIANCE_COMMANDS = ['variance.final_approval', 'approval.reject'] as const
export type VarianceCommand = (typeof VARIANCE_COMMANDS)[number]

// A variance is created RECORDED (no approval needed) or PENDING_APPROVAL (GR_VARIANCE route)
export const VARIANCE_MACHINE = machine<VarianceState, VarianceCommand>('Variance', VARIANCE_STATES, VARIANCE_COMMANDS, [
  { from: ['PENDING_APPROVAL'], command: 'variance.final_approval', to: 'APPROVED' },
  { from: ['PENDING_APPROVAL'], command: 'approval.reject', to: 'REJECTED' },
])

export const MACHINES = [
  REQUEST_MACHINE,
  SUPPLIER_REQUEST_MACHINE,
  TASK_MACHINE,
  DOA_VERSION_MACHINE,
  ORG_CHANGE_MACHINE,
  DELEGATION_MACHINE,
  PO_MACHINE,
  GR_MACHINE,
  VARIANCE_MACHINE,
  // S6
  WORKFLOW_VERSION_MACHINE,
  FORM_VERSION_MACHINE,
  STEP_MACHINE,
  BUDGET_TRANSFER_MACHINE,
  BUDGET_OVERRUN_MACHINE,
] as const
