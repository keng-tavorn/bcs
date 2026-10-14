import { z } from 'zod'
import { defineEvents } from '../registry'

// Form versions (spec §10.2 "form_version", FR-ADM-005, S6-14 FR-INT-104): a draft copied from the version in use and
// edited, then published as the type's next version (the one before it retired); requests already made keep theirs.

const ref = { requestTypeCode: z.string().min(1), versionNo: z.number().int().positive() }

defineEvents('FormVersion', {
  'form_version.published': {
    schema: z.object({
      ...ref,
      via: z.enum(['SEED', 'ADMIN']),
      // S6-14 (FR-INT-104 AC3, OQ-115): the attachment rules differ from the version before it — for the policy history
      attachmentRulesChanged: z.boolean().optional(),
    }),
  },
  'form_version.drafted': { schema: z.object({ ...ref, via: z.enum(['ADMIN', 'CONFIG_IMPORT']), fromVersionNo: z.number().int().positive().nullable() }) },
  'form_version.updated': { schema: z.object({ ...ref, fields: z.number().int().nonnegative(), rules: z.number().int().nonnegative() }) },
  'form_version.retired': { schema: z.object({ ...ref, byVersionNo: z.number().int().positive() }) },
})
