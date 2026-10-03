import { z } from 'zod'
import { defineEvents } from '../registry'

// Approval task events (spec §10.2 "approval_task", FR-DOA-005 AC1: every decision names the DOA version and rule, the
// channel, who acted and on whose behalf).

const channel = z.enum(['WEB', 'LIFF', 'LINE_CHAT', 'PWA', 'EMAIL', 'PORTAL', 'SYSTEM', 'API', 'MCP'])

defineEvents('ApprovalTask', {
  // FR-VIS-001 AC2 (MANUAL, from the board) and BR-SLA-02 (SLA, the reminder job of S5)
  'approval_task.reminded': {
    schema: z.object({
      subjectType: z.enum(['REQUEST', 'PURCHASE_ORDER', 'VARIANCE', 'DOA_VERSION', 'ORG_AUTHORITY_CHANGE']),
      subjectId: z.uuid(),
      via: z.enum(['MANUAL', 'SLA']),
    }),
  },
  'approval_task.assigned': {
    schema: z.object({
      subjectType: z.enum(['REQUEST', 'PURCHASE_ORDER', 'VARIANCE', 'DOA_VERSION', 'ORG_AUTHORITY_CHANGE']),
      subjectId: z.uuid(),
      routeId: z.uuid(),
      stepNo: z.number().int().positive(),
      assigneeMemberId: z.uuid(),
      principalMemberId: z.uuid().nullable(),
      resolvedFrom: z.string().min(1),
      dueAt: z.iso.datetime({ offset: true }),
    }),
  },
  'approval_task.decided': {
    schema: z.object({
      decision: z.enum(['APPROVE', 'REJECT', 'RETURN']),
      subjectType: z.enum(['REQUEST', 'PURCHASE_ORDER', 'VARIANCE', 'DOA_VERSION', 'ORG_AUTHORITY_CHANGE']),
      subjectId: z.uuid(),
      doaVersionId: z.uuid(),
      doaRuleCode: z.string().min(1),
      channel,
      actorMemberId: z.uuid(),
      onBehalfOfMemberId: z.uuid().nullable(),
      reasonCommentId: z.uuid().nullable(),
      // BR-DOA-15: the step-up the approver gave for a DOA version or an authority change
      stepUpGrantId: z.uuid().nullable().optional(),
    }),
    // INV-DOA-01: the Event columns name the DOA version and rule of every decision
    requiresDoaRef: true,
  },
  'approval_task.reassigned': {
    schema: z.object({ fromTaskId: z.uuid(), fromMemberId: z.uuid(), toMemberId: z.uuid(), why: z.enum(['ORG_AUTHORITY_CHANGE', 'DELEGATION', 'ADMIN']), changeId: z.uuid().nullable() }),
  },
  'approval_task.cancelled': { schema: z.object({ subjectId: z.uuid(), why: z.enum(['REQUEST_CANCELLED', 'ROUTE_REPLACED', 'DOCUMENT_DECIDED']) }) },
})
