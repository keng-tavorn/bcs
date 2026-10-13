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
export const DOA_VERSION_COMMANDS = ['doa.submit', 'doa.approve', 'doa.reject', 'doa.supersede', 'doa.withdraw'] as const
export type DoaVersionCommand = (typeof DOA_VERSION_COMMANDS)[number]

export const DOA_VERSION_MACHINE = machine<DoaVersionState, DoaVersionCommand>('DoaVersion', DOA_VERSION_STATES, DOA_VERSION_COMMANDS, [
  { from: ['DRAFT'], command: 'doa.submit', to: 'PENDING_APPROVAL' },
  { from: ['PENDING_APPROVAL'], command: 'doa.approve', to: 'PUBLISHED' },
  { from: ['PENDING_APPROVAL'], command: 'doa.reject', to: 'REJECTED' },
  { from: ['PUBLISHED'], command: 'doa.supersede', to: 'SUPERSEDED' },
  // S6 (BR-DOA-18): an approved version not yet in effect may be withdrawn; the service refuses it before S6
  { from: ['PUBLISHED'], command: 'doa.withdraw', to: 'WITHDRAWN' },
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

// ---------- invoice, tier 2 (S8 · docs/sub-specs/S8.md "State machine") ----------

export const INVOICE_STATES = ['DRAFT', 'EXCEPTION', 'PENDING_APPROVAL', 'READY_FOR_PAYMENT', 'IN_PAYMENT_RUN', 'PAID', 'REJECTED', 'CANCELLED'] as const
export type InvoiceState = (typeof INVOICE_STATES)[number]
export const INVOICE_COMMANDS = [
  'invoice.update',
  'invoice.submit_matched',
  'invoice.submit_exception',
  'invoice.recheck_matched',
  'invoice.recheck_exception',
  'invoice.requestVarianceApproval',
  'invoice.final_approval',
  'approval.reject',
  'approval.return',
  'invoice.reopen',
  'invoice.reject',
  'invoice.cancel',
  'invoice.hold_for_payment',
  'invoice.release_from_payment',
  'invoice.record_payment',
] as const
export type InvoiceCommand = (typeof INVOICE_COMMANDS)[number]

export const INVOICE_MACHINE = machine<InvoiceState, InvoiceCommand>('Invoice', INVOICE_STATES, INVOICE_COMMANDS, [
  // invoice.update and invoice.confirmCoding change a draft only
  { from: ['DRAFT'], command: 'invoice.update', to: 'DRAFT' },
  // invoice.submit: the match decides where it goes
  { from: ['DRAFT'], command: 'invoice.submit_matched', to: 'READY_FOR_PAYMENT' },
  { from: ['DRAFT'], command: 'invoice.submit_exception', to: 'EXCEPTION' },
  // invoice.recheck by FINANCE, the assignee of an exception, or SYSTEM after a GR or an approved PO change
  { from: ['EXCEPTION'], command: 'invoice.recheck_matched', to: 'READY_FOR_PAYMENT' },
  { from: ['EXCEPTION'], command: 'invoice.recheck_exception', to: 'EXCEPTION' },
  // BR-MATCH-10: every open exception of a fresh match is PRICE_OVER (the service checks it)
  { from: ['EXCEPTION'], command: 'invoice.requestVarianceApproval', to: 'PENDING_APPROVAL' },
  { from: ['PENDING_APPROVAL'], command: 'invoice.final_approval', to: 'READY_FOR_PAYMENT' },
  { from: ['PENDING_APPROVAL'], command: 'approval.reject', to: 'EXCEPTION' },
  { from: ['PENDING_APPROVAL'], command: 'approval.return', to: 'EXCEPTION' },
  { from: ['EXCEPTION'], command: 'invoice.reopen', to: 'DRAFT' },
  { from: ['DRAFT', 'EXCEPTION'], command: 'invoice.reject', to: 'REJECTED' },
  { from: ['DRAFT'], command: 'invoice.cancel', to: 'CANCELLED' },
  // BR-AP-12: only the functions S9 calls inside its own commands
  { from: ['READY_FOR_PAYMENT'], command: 'invoice.hold_for_payment', to: 'IN_PAYMENT_RUN' },
  { from: ['IN_PAYMENT_RUN'], command: 'invoice.release_from_payment', to: 'READY_FOR_PAYMENT' },
  { from: ['IN_PAYMENT_RUN'], command: 'invoice.record_payment', to: 'PAID' },
])

// ---------- match exception (BR-MATCH-09, BR-MATCH-10) ----------

export const MATCH_EXCEPTION_STATES = ['OPEN', 'ACCEPT_REQUESTED', 'APPROVED', 'RESOLVED', 'DISMISSED', 'CLOSED'] as const
export type MatchExceptionState = (typeof MATCH_EXCEPTION_STATES)[number]
export const MATCH_EXCEPTION_COMMANDS = [
  'match_exception.resolve',
  'match_exception.dismiss',
  'match_exception.request_acceptance',
  'match_exception.approve',
  'match_exception.decline',
  'match_exception.close',
] as const
export type MatchExceptionCommand = (typeof MATCH_EXCEPTION_COMMANDS)[number]

export const MATCH_EXCEPTION_MACHINE = machine<MatchExceptionState, MatchExceptionCommand>('MatchException', MATCH_EXCEPTION_STATES, MATCH_EXCEPTION_COMMANDS, [
  // a recheck no longer finds it
  { from: ['OPEN'], command: 'match_exception.resolve', to: 'RESOLVED' },
  // POSSIBLE_DUPLICATE only, by FINANCE with a reason (the service checks it)
  { from: ['OPEN'], command: 'match_exception.dismiss', to: 'DISMISSED' },
  // the variance is sent for approval, then approved or not
  { from: ['OPEN'], command: 'match_exception.request_acceptance', to: 'ACCEPT_REQUESTED' },
  { from: ['ACCEPT_REQUESTED'], command: 'match_exception.approve', to: 'APPROVED' },
  { from: ['ACCEPT_REQUESTED'], command: 'match_exception.decline', to: 'OPEN' },
  // the invoice is rejected or reopened
  { from: ['OPEN', 'ACCEPT_REQUESTED'], command: 'match_exception.close', to: 'CLOSED' },
])

// ---------- performance retention (ADR-124, BR-RET-04, BR-AP-12) ----------

export const RETENTION_STATES = ['HELD', 'RELEASABLE', 'IN_PAYMENT_RUN', 'PAID'] as const
export type RetentionState = (typeof RETENTION_STATES)[number]
export const RETENTION_COMMANDS = ['retention.release', 'retention.hold_for_payment', 'retention.release_from_payment', 'retention.record_payment'] as const
export type RetentionCommand = (typeof RETENTION_COMMANDS)[number]

export const RETENTION_MACHINE = machine<RetentionState, RetentionCommand>('Retention', RETENTION_STATES, RETENTION_COMMANDS, [
  // FINANCE from releaseDueOn (RETENTION_NOT_DUE before it)
  { from: ['HELD'], command: 'retention.release', to: 'RELEASABLE' },
  // only the functions S9 calls inside its own commands
  { from: ['RELEASABLE'], command: 'retention.hold_for_payment', to: 'IN_PAYMENT_RUN' },
  { from: ['IN_PAYMENT_RUN'], command: 'retention.release_from_payment', to: 'RELEASABLE' },
  { from: ['IN_PAYMENT_RUN'], command: 'retention.record_payment', to: 'PAID' },
])

// ---------- PO change (ADR-125, BR-POC-01 to BR-POC-05) ----------

export const PO_CHANGE_STATES = ['DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'REJECTED', 'CANCELLED'] as const
export type PoChangeState = (typeof PO_CHANGE_STATES)[number]
export const PO_CHANGE_COMMANDS = ['po_change.update', 'po_change.submit', 'po_change.submit_auto', 'po_change.final_approval', 'approval.reject', 'approval.return', 'po_change.cancel'] as const
export type PoChangeCommand = (typeof PO_CHANGE_COMMANDS)[number]

export const PO_CHANGE_MACHINE = machine<PoChangeState, PoChangeCommand>('PoChange', PO_CHANGE_STATES, PO_CHANGE_COMMANDS, [
  { from: ['DRAFT'], command: 'po_change.update', to: 'DRAFT' },
  // a price or a quantity changed: DOA PO_CHANGE
  { from: ['DRAFT'], command: 'po_change.submit', to: 'PENDING_APPROVAL' },
  // only the delivery date or the notes changed: approved at submit, no task, no budget move (BR-POC-02)
  { from: ['DRAFT'], command: 'po_change.submit_auto', to: 'APPROVED' },
  { from: ['PENDING_APPROVAL'], command: 'po_change.final_approval', to: 'APPROVED' },
  { from: ['PENDING_APPROVAL'], command: 'approval.reject', to: 'REJECTED' },
  { from: ['PENDING_APPROVAL'], command: 'approval.return', to: 'DRAFT' },
  { from: ['DRAFT', 'PENDING_APPROVAL'], command: 'po_change.cancel', to: 'CANCELLED' },
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
  INVOICE_MACHINE,
  MATCH_EXCEPTION_MACHINE,
  RETENTION_MACHINE,
  PO_CHANGE_MACHINE,
] as const
