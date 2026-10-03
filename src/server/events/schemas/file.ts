import { z } from 'zod'
import { defineEvents } from '../registry'

// File events (spec §10.2). The file name is free text chosen by a person and stays out of the event (§4.5).
defineEvents('File', {
  'file.uploaded': { schema: z.object({ fileId: z.uuid(), mimeType: z.string().min(1), sizeBytes: z.number().int().positive() }) },
  'file.downloaded': { schema: z.object({ fileId: z.uuid() }) },
})
