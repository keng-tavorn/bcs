import { z } from 'zod'
import { defineEvents } from '../registry'

// Form versions (spec §10.2 "form_version", FR-ADM-005): a new version of a request type's form is published; requests
// already made keep the version they were made with.

defineEvents('FormVersion', {
  'form_version.published': { schema: z.object({ requestTypeCode: z.string().min(1), versionNo: z.number().int().positive(), via: z.enum(['SEED', 'ADMIN']) }) },
})
