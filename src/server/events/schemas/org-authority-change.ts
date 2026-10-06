import { z } from 'zod'
import { defineEvents } from '../registry'

// Authority change events (spec §10.2 "org_authority_change", FR-DOA-010). The payload and reason stay on the row.

const kind = z.enum(['POSITION_ASSIGN', 'POSITION_END', 'DEPARTMENT_REPARENT', 'DELEGATION_ON_BEHALF', 'IDENTITY_RESET'])

defineEvents('OrgAuthorityChange', {
  'org_authority_change.submitted': { schema: z.object({ kind, effectiveFrom: z.iso.datetime({ offset: true }), routeId: z.uuid() }) },
  'org_authority_change.approved': { schema: z.object({ kind, status: z.enum(['SCHEDULED', 'APPLIED']), effectiveFrom: z.iso.datetime({ offset: true }) }) },
  'org_authority_change.rejected': { schema: z.object({ kind }) },
  'org_authority_change.cancelled': { schema: z.object({ kind }) },
  'org_authority_change.applied': { schema: z.object({ kind }) },
})
