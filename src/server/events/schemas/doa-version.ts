import { z } from 'zod'
import { defineEvents } from '../registry'

// DOA version events (spec §10.2 "doa_version"). The rules themselves are on DoaVersion and DoaRule; events name the
// version. The demo seed publishes version 1 directly (Appendix A, local and staging only; NG-12).

const version = { code: z.string().min(1), versionNo: z.number().int().positive() }

defineEvents('DoaVersion', {
  // via YAML: imported (FR-DOA-001 AC2); via COPY: saved from the editor's table as a copy of the version fromVersionId,
  // edition fromVersionNo (FR-DOA-001 AC1), which the history names as where the draft started
  'doa_version.drafted': {
    schema: z.object({
      ...version,
      via: z.enum(['YAML', 'COPY']),
      rules: z.number().int().positive(),
      fromVersionId: z.uuid().optional(),
      fromVersionNo: z.number().int().positive().optional(),
      // S13: the AI action whose draft the person confirmed and imported (BR-AI-22); the actor is still the person
      agentActionId: z.uuid().optional(),
    }),
  },
  // initialPackageHolders: the holders sent with the first version to the contract signatory (BR-DOA-19);
  // boundaryTableConfirmed: the drafter ticked the boundary table the version was sent with (FR-DOA-009 AC3)
  'doa_version.submitted': {
    schema: z.object({
      ...version,
      warningsAcknowledged: z.number().int().nonnegative(),
      routeId: z.uuid(),
      initialPackageHolders: z.number().int().positive().optional(),
      boundaryTableConfirmed: z.boolean().optional(),
    }),
  },
  'doa_version.superseded': { schema: z.object({ ...version, supersededBy: z.uuid() }) },
  'doa_version.rejected': { schema: z.object({ ...version, reasonCommentId: z.uuid() }) },
  'doa_version.published': {
    schema: z.object({ ...version, effectiveFrom: z.iso.datetime({ offset: true }), via: z.enum(['SEED', 'APPROVAL']), rules: z.number().int().positive() }),
  },
  // S6-07 (FR-DOA-104 · BR-DOA-18, one rule for DOA and workflow versions): a version approved but not yet in effect is
  // asked to be withdrawn on a DOA_CHANGE route of its own; approved, it is WITHDRAWN and the version before it runs on
  // (previousVersionId, effectiveTo: its new end, null for none); rejected, it stays PUBLISHED; reaching its effective
  // time while asked, the request is cancelled (ALREADY_EFFECTIVE)
  'doa_version.withdrawal_requested': { schema: z.object({ ...version, routeId: z.uuid(), reasonCommentId: z.uuid() }) },
  'doa_version.withdrawn': { schema: z.object({ ...version, previousVersionId: z.uuid().nullable(), effectiveTo: z.iso.datetime({ offset: true }).nullable() }) },
  'doa_version.withdrawal_rejected': { schema: z.object({ ...version, reasonCommentId: z.uuid().nullable() }) },
  'doa_version.withdrawal_cancelled': { schema: z.object({ ...version, reason: z.literal('ALREADY_EFFECTIVE') }) },
})
