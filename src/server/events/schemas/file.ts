import { z } from 'zod'
import { defineEvents } from '../registry'

// File events (spec §10.2). The file name is free text chosen by a person and stays out of the event (§4.5).
defineEvents('File', {
  'file.uploaded': { schema: z.object({ fileId: z.uuid(), mimeType: z.string().min(1), sizeBytes: z.number().int().positive() }) },
  // S7-06 (BR-SDOC ข้อ 05): who read a file through another step's right says so (S11's risk reviewer · RISK_REVIEW)
  'file.downloaded': { schema: z.object({ fileId: z.uuid(), grantedBy: z.enum(['RISK_REVIEW']).optional() }) },
  // S7-06 (BR-PORTAL ข้อ 07): the central scan of an uploaded file; each step listens for its own link kinds
  'file.scanned': { schema: z.object({ fileId: z.uuid(), result: z.enum(['CLEAN', 'INFECTED']), linkKinds: z.array(z.string()), scanner: z.enum(['stub', 'live']) }) },
})
