import { z } from 'zod'
import { defineEvents } from '../registry'

// Files made for download (spec §10.2 "ใบกำกับและการส่งออก", BR-EXP-02, BR-EXP-03, FR-VIS-004 AC3): what went in,
// how many rows, the total and the sha256 shown to the user.

const satang = z.string().regex(/^\d+$/)

defineEvents('ExportJob', {
  'export.generated': {
    schema: z.object({
      kind: z.enum(['EXPRESS_AP', 'REPORT', 'AUDIT']),
      rowCount: z.number().int().min(0),
      totalSatang: satang,
      checksum: z.string().regex(/^[0-9a-f]{64}$/),
      fileId: z.uuid(),
      invoiceIds: z.array(z.uuid()),
      /** BR-EXP-04: kept out because the supplier has no Express vendor code */
      excludedInvoiceIds: z.array(z.uuid()),
      /** BR-EXP-02: the same invoices again, with a reason */
      again: z.boolean(),
    }),
  },
  // FR-VIS-004 AC3: who exported which events (the filter) and the file's sha256
  'audit.exported': {
    schema: z.object({
      rowCount: z.number().int().min(0),
      checksum: z.string().regex(/^[0-9a-f]{64}$/),
      fileId: z.uuid(),
      format: z.enum(['xlsx', 'csv']),
      filter: z.record(z.string(), z.unknown()),
    }),
  },
})
