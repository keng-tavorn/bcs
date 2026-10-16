import { z } from 'zod'
import { APPROVAL_SUBJECTS } from '@/core/sod'
import { defineEvents } from '../registry'

// Approval task events (spec §10.2 "approval_task", FR-DOA-005 AC1: every decision names the DOA version and rule, the
// channel, who acted and on whose behalf).

const channel = z.enum(['WEB', 'LIFF', 'LINE_CHAT', 'PWA', 'APP', 'EMAIL', 'PORTAL', 'SYSTEM', 'API', 'MCP'])

defineEvents('ApprovalTask', {
  // FR-VIS-001 AC2 (MANUAL, from the board) and BR-SLA-02 (SLA, the reminder job of S5)
  'approval_task.reminded': {
    schema: z.object({
      subjectType: z.enum(APPROVAL_SUBJECTS),
      subjectId: z.uuid(),
      via: z.enum(['MANUAL', 'SLA']),
    }),
  },
  'approval_task.assigned': {
    schema: z.object({
      subjectType: z.enum(APPROVAL_SUBJECTS),
      subjectId: z.uuid(),
      routeId: z.uuid(),
      stepNo: z.number().int().positive(),
      assigneeMemberId: z.uuid(),
      principalMemberId: z.uuid().nullable(),
      resolvedFrom: z.string().min(1),
      dueAt: z.iso.datetime({ offset: true }),
      // S6 (BR-WF-01): the slot of a committee or reviewer step; absent = slot 1 of a step of one approver
      slotNo: z.number().int().positive().optional(),
      // S6 (INV-WF-04): the reviewer version and rules of a REVIEW task
      workflowVersionId: z.uuid().optional(),
      workflowRuleCodes: z.array(z.string().min(1)).optional(),
      // S6-08 (BR-WF-14): the step went to the holder of now, not to whom the route would have given it when made
      holderChangedFrom: z.uuid().optional(),
    }),
  },
  'approval_task.decided': {
    schema: z.object({
      decision: z.enum(['APPROVE', 'REJECT', 'RETURN']),
      subjectType: z.enum(APPROVAL_SUBJECTS),
      subjectId: z.uuid(),
      doaVersionId: z.uuid(),
      doaRuleCode: z.string().min(1),
      channel,
      actorMemberId: z.uuid(),
      onBehalfOfMemberId: z.uuid().nullable(),
      reasonCommentId: z.uuid().nullable(),
      // BR-DOA-15, FR-AUTH-005 AC2: the PIN step-up of a policy decision, or of any decision at or above the version's stepUpThreshold
      stepUpGrantId: z.uuid().nullable().optional(),
      // FR-DOA-009 AC3: the approver of a DOA version ticked its boundary table before approving
      boundaryTableConfirmed: z.boolean().optional(),
      // S6 (BR-WF-01, INV-WF-04): the slot decided, and the reviewer version and rules of a REVIEW task
      slotNo: z.number().int().positive().optional(),
      workflowVersionId: z.uuid().optional(),
      workflowRuleCodes: z.array(z.string().min(1)).optional(),
    }),
    // INV-DOA-01: the Event columns name the DOA version and rule of every decision
    requiresDoaRef: true,
  },
  'approval_task.reassigned': {
    schema: z.object({ fromTaskId: z.uuid(), fromMemberId: z.uuid(), toMemberId: z.uuid(), why: z.enum(['ORG_AUTHORITY_CHANGE', 'DELEGATION', 'ADMIN']), changeId: z.uuid().nullable() }),
  },
  // §6.4: the route ended (the request cancelled, a new route replaced it, the document decided), or another task of
  // the same step was decided first — the co-assignee of an escalated step, or the first assignee when the co-assignee
  // decided (BR-SLA-04, NEW-47: CO_ASSIGNEE_DECIDED, src/server/services/approvals/step-complete.ts) · S6 (BR-WF-01): a
  // group of a REVIEW step came to its result (GROUP_DECIDED) or a step of several slots did (STEP_DECIDED) · S6-07: a
  // withdrawal still asked when its version took effect (ALREADY_EFFECTIVE)
  'approval_task.cancelled': {
    schema: z.object({ subjectId: z.uuid(), why: z.enum(['REQUEST_CANCELLED', 'ROUTE_REPLACED', 'DOCUMENT_DECIDED', 'CO_ASSIGNEE_DECIDED', 'GROUP_DECIDED', 'STEP_DECIDED', 'ALREADY_EFFECTIVE']) }),
  },
  // BR-SLA-02, BR-SLA-04, FR-NOTI-003 AC1 (S5-07): the SLA job marks an open task past its due time; the assignee and,
  // for acknowledgement, the approver of the next amount band are told (nextBandMemberId, null when there is none)
  'approval_task.overdue': {
    schema: z.object({
      subjectType: z.enum(APPROVAL_SUBJECTS),
      subjectId: z.uuid(),
      dueAt: z.iso.datetime({ offset: true }),
      escalateAt: z.iso.datetime({ offset: true }),
      nextBandMemberId: z.uuid().nullable(),
    }),
  },
  // BR-SLA-04, FR-NOTI-003 AC2 (S5-08): past escalateAt the approver of the next band joins the step as co-assignee
  // (whoever decides first decides), on any step of the route (NEW-47) — the event keeps the route's own DOA reference
  // (doaVersionId, doaRuleCode, also on the Event columns) and both tasks carry escalatedAt; with no next band, ORG_ADMIN
  // and the requester are told.
  'approval_task.escalated': {
    schema: z.object({
      subjectType: z.enum(APPROVAL_SUBJECTS),
      subjectId: z.uuid(),
      stepId: z.uuid(),
      outcome: z.enum(['CO_ASSIGNED', 'NO_NEXT_BAND']),
      // NOT_LAST_STEP is no longer produced: the first draft of S5-08 escalated only the last step of a route and gave
      // it for a step with steps after it, until NEW-47 opened every step (ADR-048 item 5). Events of schema version 1
      // stored before that still carry it, so it stays readable here; nothing writes it any more.
      // SLOTTED_STEP (S6 · BR-WF-15): a committee or reviewer step adds no co-assignee; its slot holder is told instead
      reason: z.enum(['NO_HIGHER_BAND', 'APPROVER_NOT_FOUND', 'DOA_AMBIGUOUS', 'NOT_LAST_STEP', 'SLOTTED_STEP']).nullable(),
      coAssigneeTaskId: z.uuid().nullable(),
      coAssigneeMemberId: z.uuid().nullable(),
      coAssigneePrincipalMemberId: z.uuid().nullable(),
      resolvedFrom: z.string().min(1).nullable(),
      doaVersionId: z.uuid(),
      doaRuleCode: z.string().min(1),
      nextRuleCode: z.string().min(1).nullable(),
    }),
  },
})
