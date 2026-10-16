import { z } from 'zod'
import { defineEvents } from '../registry'

// The QR of a printed PR or PO (S6-19 · BR-QR-01): a row issued by a command that changed what the document prints,
// superseding the one before it. The token itself is never in an event (only its hash is kept, on the row).
defineEvents('DocumentVerification', {
  'document_verification.issued': { schema: z.object({ subjectType: z.enum(['REQUEST', 'PURCHASE_ORDER']), subjectId: z.uuid(), supersededId: z.uuid().nullable() }) },
})
