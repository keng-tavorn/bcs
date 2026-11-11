import { z } from 'zod'
import { systemClock } from '@/lib/clock'
import { inngest } from '@/server/inngest'
import { runAllDocumentExpiry, scanFile, supplierDocumentScanned } from '@/server/services/suppliers/documents'
import { resetPoAck } from '@/server/services/suppliers/po-ack'

// The jobs of S7-06 (BR-PORTAL ข้อ 07 · BR-SDOC ข้อ 04 · docs/sub-specs/S7.md "job Inngest ใหม่"):
// - file-scan: the central scan of every uploaded file still PENDING, whatever it is linked to; it says what it found in
//   file.scanned and nothing else
// - supplier-document-scanned: S7's listener of file.scanned for SUPPLIER_DOC (S10 S11 listen for their own kinds)
// - supplier-document-expiry: 07:00 Bangkok, every organization with SUPPLIER: reminders and expiries of the day

const FileEvent = z.object({ organizationId: z.uuid(), aggregateId: z.uuid() })
const ScannedEvent = FileEvent.extend({ data: z.object({ result: z.enum(['CLEAN', 'INFECTED']), linkKinds: z.array(z.string()) }).loose() })

export const fileScan = inngest.createFunction({ id: 'file-scan', triggers: [{ event: 'bcs/file.uploaded' }] }, async ({ event, step }) => {
  const payload = FileEvent.safeParse(event.data)
  if (!payload.success) return 'IGNORED'
  return step.run('scan', () => scanFile(payload.data.organizationId, payload.data.aggregateId, systemClock.now()))
})

export const supplierDocumentScannedJob = inngest.createFunction({ id: 'supplier-document-scanned', triggers: [{ event: 'bcs/file.scanned' }] }, async ({ event, step }) => {
  const payload = ScannedEvent.safeParse(event.data)
  if (!payload.success || !payload.data.data.linkKinds.includes('SUPPLIER_DOC')) return 'IGNORED'
  return step.run('mark', () => supplierDocumentScanned(payload.data.organizationId, payload.data.aggregateId, payload.data.data.result, systemClock.now()))
})

export const SUPPLIER_DOCUMENT_EXPIRY_CRON = 'TZ=Asia/Bangkok 0 7 * * *'

export const supplierDocumentExpiry = inngest.createFunction({ id: 'supplier-document-expiry', retries: 1, triggers: [{ cron: SUPPLIER_DOCUMENT_EXPIRY_CRON }] }, async ({ step }) =>
  step.run('expiry', () => runAllDocumentExpiry(systemClock.now())),
)

// S7-11 (FR-SUP-105 AC4 · BR-SUP ข้อ 14): a new revision sent to the supplier (S8's po.revision_sent) waits for its
// acknowledgement again — S8's code untouched
const RevisionEvent = FileEvent.extend({ data: z.object({ revisionNo: z.number().int().min(1) }).loose() })

export const poAckReset = inngest.createFunction({ id: 'po-ack-reset', triggers: [{ event: 'bcs/po.revision_sent' }] }, async ({ event, step }) => {
  const payload = RevisionEvent.safeParse(event.data)
  if (!payload.success) return 'IGNORED'
  return step.run('reset', () => resetPoAck(payload.data.organizationId, payload.data.aggregateId, payload.data.data.revisionNo, systemClock.now()))
})
