import { z } from 'zod'
import { defineEvents } from '../registry'

// The supplier portal's identity, kept on the contact's own aggregate (S7-04 · BR-PORTAL ข้อ 01 ถึง ข้อ 04 · docs/sub-specs/S7.md "event"): contacts and
// their sessions. Ids and codes only: never a one-time code, a token, an e-mail address or an IP in clear (NFR-SEC-09).

const linkPurpose = z.enum(['INVITATION', 'LOGIN', 'DOCUMENT_REQUEST', 'RISK_QUESTIONNAIRE'])

defineEvents('SupplierContact', {
  'portal_session.link_requested': { schema: z.object({ contactId: z.uuid(), linkId: z.uuid(), purpose: linkPurpose }) },
  'portal_session.otp_requested': { schema: z.object({ contactId: z.uuid(), challengeId: z.uuid(), linkId: z.uuid(), purpose: linkPurpose }) },
  'portal_session.otp_failed': { schema: z.object({ contactId: z.uuid(), challengeId: z.uuid(), attempts: z.int().min(1), remaining: z.int().min(0) }) },
  'portal_session.otp_locked': { schema: z.object({ contactId: z.uuid(), challengeId: z.uuid(), attempts: z.int().min(1), lockedUntil: z.string() }) },
  'portal_session.signed_in': { schema: z.object({ contactId: z.uuid(), sessionId: z.uuid(), challengeId: z.uuid(), newDevice: z.boolean(), firstSignIn: z.boolean() }) },
  'portal_session.signed_out': { schema: z.object({ contactId: z.uuid(), sessionId: z.uuid() }) },
  'portal_session.revoked': {
    schema: z.object({ contactId: z.uuid(), sessionId: z.uuid(), reason: z.enum(['LOGOUT', 'IDLE', 'ABSOLUTE', 'CONTACT_DEACTIVATED', 'SUPPLIER_INACTIVE', 'APPLICATION_CLOSED', 'ADMIN']) }),
  },
  'portal_session.csrf_rejected': { schema: z.object({ contactId: z.uuid(), sessionId: z.uuid(), route: z.string().max(200) }) },
})

const changedField = z.enum(['nameTh', 'nameEn', 'email', 'phone', 'roleLabel', 'isPrimary', 'locale', 'portalEnabled'])

defineEvents('SupplierContact', {
  'supplier_contact.created': {
    schema: z.object({ supplierId: z.uuid().nullable(), applicationId: z.uuid().nullable(), isPrimary: z.boolean(), portalEnabled: z.boolean() }),
  },
  'supplier_contact.updated': { schema: z.object({ supplierId: z.uuid().nullable(), changed: z.array(changedField).min(1) }) },
  'supplier_contact.deactivated': { schema: z.object({ supplierId: z.uuid().nullable(), sessionsRevoked: z.int().min(0) }) },
  'supplier_contact.privacy_notice_accepted': { schema: z.object({ privacyNoticeVersion: z.string().min(1).max(40) }) },
})
