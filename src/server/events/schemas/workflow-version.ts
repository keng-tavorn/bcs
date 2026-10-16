import { z } from 'zod'
import { defineEvents } from '../registry'

// Workflow version events (spec §10.2 "workflow_version", S6-04 · FR-WF-103): the parallel reviewers of an organization,
// versioned like the DOA. The rules are on WorkflowVersion and WorkflowRule; events name the version. The seed of the
// phase-1 organization publishes version 1 directly (local and staging only; NG-12).

const version = { code: z.string().min(1), versionNo: z.number().int().positive() }

defineEvents('WorkflowVersion', {
  // via COPY: a copy of fromVersionId to edit (FR-WF-103 AC1); via CONFIG_IMPORT: from a configuration package (S6-21)
  'workflow_version.drafted': {
    schema: z.object({ ...version, via: z.enum(['COPY', 'CONFIG_IMPORT']), rules: z.number().int().nonnegative(), fromVersionId: z.uuid().optional(), fromVersionNo: z.number().int().positive().optional() }),
  },
  // The draft's rules, test cases, effective time or reason changed: its dry-run has to run again
  'workflow_version.updated': { schema: z.object({ ...version, rules: z.number().int().nonnegative(), testCases: z.number().int().nonnegative() }) },
  // The dry-run of the latest draft ran (dryRunAt): what submit asks for
  'workflow_version.dry_run': { schema: z.object({ ...version, documents: z.number().int().positive() }) },
  'workflow_version.submitted': { schema: z.object({ ...version, warningsAcknowledged: z.number().int().nonnegative(), routeId: z.uuid() }) },
  'workflow_version.approved': { schema: z.object({ ...version, approvedById: z.uuid() }) },
  'workflow_version.rejected': { schema: z.object({ ...version, reasonCommentId: z.uuid().nullable() }) },
  'workflow_version.published': {
    schema: z.object({ ...version, effectiveFrom: z.iso.datetime({ offset: true }), via: z.enum(['SEED', 'APPROVAL']), rules: z.number().int().nonnegative() }),
  },
  'workflow_version.superseded': { schema: z.object({ ...version, supersededBy: z.uuid() }) },
  // S6-07 (FR-DOA-104 · BR-DOA-18, one rule for DOA and workflow versions): a version approved but not yet in effect is
  // asked to be withdrawn on a DOA_CHANGE route of its own; approved, it is WITHDRAWN and the version before it runs on
  // (previousVersionId, effectiveTo: its new end, null for none); rejected, it stays PUBLISHED; reaching its effective
  // time while asked, the request is cancelled (ALREADY_EFFECTIVE)
  'workflow_version.withdrawal_requested': { schema: z.object({ ...version, routeId: z.uuid(), reasonCommentId: z.uuid() }) },
  'workflow_version.withdrawn': { schema: z.object({ ...version, previousVersionId: z.uuid().nullable(), effectiveTo: z.iso.datetime({ offset: true }).nullable() }) },
  'workflow_version.withdrawal_rejected': { schema: z.object({ ...version, reasonCommentId: z.uuid().nullable() }) },
  'workflow_version.withdrawal_cancelled': { schema: z.object({ ...version, reason: z.literal('ALREADY_EFFECTIVE') }) },
})
