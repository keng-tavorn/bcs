import { z } from 'zod'
import { defineEvents } from '../registry'

// Organization events (spec §10.2). Organizations are created by PLATFORM_ADMIN, or by the demo seed in
// local/staging/preview only (Appendix A).
const moduleKey = z.enum(['CORE', 'PAY', 'SUPPLIER', 'SOURCING', 'RISK', 'CONTRACTS', 'AI', 'INTEGRATION', 'DOA_EVERYWHERE', 'BCS_GO'])

defineEvents('Organization', {
  'organization.created': {
    schema: z.object({ code: z.string().min(1), via: z.enum(['SEED', 'PLATFORM_ADMIN']), contractSignatoryMemberId: z.uuid().nullable() }),
  },
  // The reason of every change is a Comment on the organization (§4.11 rule 1, BR-AUTH-08); the event points to it, so
  // the history keeps each reason while OrgModule holds only the latest (§6.2: the change history lives in Event)
  'organization.module_enabled': { schema: z.object({ module: moduleKey, contractRef: z.string().min(1), reasonCommentId: z.uuid() }) },
  'organization.module_disabled': { schema: z.object({ module: moduleKey, contractRef: z.string().min(1), reasonCommentId: z.uuid() }) },
  // One section of Organization.settings saved (FR-PLT-001 AC2); the values are on the row, the event names the section
  'organization.settings_updated': { schema: z.object({ section: z.enum(['businessCalendar', 'numbering']) }) },
})
