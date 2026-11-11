import { z } from 'zod'
import { defineEvents } from '../registry'

// A supplier application (S7-05 · ADR-181 · docs/sub-specs/S7.md "event"): codes and ids only — never a taxpayer id, an
// account number or a contact's e-mail (NFR-SEC-09).

const warningCode = z.enum(['SAME_TAXID_OTHER_BRANCH', 'DUPLICATE_NAME', 'DUPLICATE_EMAIL'])
const actorSide = z.enum(['CONTACT', 'ON_BEHALF'])

defineEvents('SupplierApplication', {
  'supplier_application.invited': { schema: z.object({ kind: z.enum(['NEW', 'EXISTING']), contactId: z.uuid(), linkId: z.uuid(), supplierId: z.uuid().nullable(), warnings: z.array(warningCode), reinvite: z.boolean() }) },
  'supplier_application.drafted': { schema: z.object({ contactId: z.uuid() }) },
  'supplier_application.updated': { schema: z.object({ fields: z.array(z.string().max(40)).min(1), by: actorSide, warnings: z.array(warningCode) }) },
  'supplier_application.submitted': { schema: z.object({ number: z.string(), by: actorSide, warnings: z.array(warningCode) }) },
  'supplier_application.routed': { schema: z.object({ number: z.string(), routeId: z.uuid(), registryOutcome: z.enum(['FOUND', 'NOT_FOUND', 'UNAVAILABLE', 'SKIPPED']) }) },
  'supplier_application.returned': { schema: z.object({ number: z.string().nullable(), reasonCommentId: z.uuid().nullable(), by: z.enum(['PROCUREMENT', 'APPROVER']) }) },
  'supplier_application.approved': { schema: z.object({ number: z.string().nullable(), supplierId: z.uuid(), kind: z.enum(['NEW', 'EXISTING']), bankAccountChangeId: z.uuid().nullable() }) },
  'supplier_application.rejected': { schema: z.object({ number: z.string().nullable(), reasonCommentId: z.uuid().nullable() }) },
  'supplier_application.expired': { schema: z.object({ number: z.string().nullable() }) },
  // S7-07 (BR-SUP ข้อ 12): the reminder names what is still missing (field names and document type codes, never values)
  'supplier_application.reminded': { schema: z.object({ missing: z.array(z.string().max(60)), linkId: z.uuid().nullable() }) },
  'supplier_application.escalated': { schema: z.object({ notified: z.array(z.uuid()) }) },
  'supplier_application.cancelled': { schema: z.object({ number: z.string().nullable(), reasonCommentId: z.uuid().nullable() }) },
})
