import { z } from 'zod'
import { defineEvents } from '../registry'

// Supplier documents and their types (S7-06 · ADR-185 · BR-SDOC ข้อ 01 ถึง ข้อ 04): ids, codes and dates only — never a
// document number of an individual's id card or anything read off a file (NFR-SEC-09).

const owner = { supplierId: z.uuid().nullable(), applicationId: z.uuid().nullable() }

defineEvents('SupplierDocument', {
  'supplier_document.uploaded': { schema: z.object({ ...owner, documentTypeCode: z.string(), fileId: z.uuid(), by: z.enum(['CONTACT', 'MEMBER']) }) },
  'supplier_document.scanned': { schema: z.object({ ...owner, fileId: z.uuid() }) },
  'supplier_document.verified': { schema: z.object({ ...owner, documentTypeCode: z.string(), expiresOn: z.string(), supersedes: z.array(z.uuid()) }) },
  'supplier_document.superseded': { schema: z.object({ ...owner, documentTypeCode: z.string(), supersededById: z.uuid() }) },
  'supplier_document.rejected': { schema: z.object({ ...owner, documentTypeCode: z.string(), reason: z.enum(['PERSON', 'INFECTED']) }) },
  'supplier_document.expired': { schema: z.object({ ...owner, documentTypeCode: z.string(), expiresOn: z.string() }) },
  'supplier_document.reminder_sent': { schema: z.object({ ...owner, documentTypeCode: z.string(), remindOn: z.string(), expiresOn: z.string() }) },
})

defineEvents('SupplierDocumentType', {
  'supplier_document_type.updated': { schema: z.object({ code: z.string(), created: z.boolean(), active: z.boolean(), changed: z.array(z.string()) }) },
})
