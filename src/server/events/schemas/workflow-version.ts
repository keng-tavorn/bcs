import { z } from 'zod'
import { defineEvents } from '../registry'

// Workflow version events (spec §10.2 "workflow_version", S6-04 · FR-WF-103): the parallel reviewers of an organization,
// versioned like the DOA. The rules are on WorkflowVersion and WorkflowRule; events name the version. The seed of the
// phase-1 organization publishes version 1 directly (local and staging only; NG-12). Withdrawal comes with S6-07.

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
})
