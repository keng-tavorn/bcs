import { isAllowed } from '@/server/authz'
import { registerFileSubjectPolicy } from '../files/policies'

// Who may download an exported file (FR-PLT-004 AC2): whoever may make that kind of export — the Express AP file is
// FINANCE's (§2.4 export.express), an audit export the AUDITOR's (audit.export).
registerFileSubjectPolicy('ExportJob', async (tx, _ctx, principal, subjectId) => {
  const job = await tx.exportJob.findFirst({ where: { id: subjectId }, select: { kind: true } })
  if (!job) return false
  return isAllowed(principal, job.kind === 'AUDIT' ? 'audit.export' : job.kind === 'EXPRESS_AP' ? 'export.express' : 'report.view')
})

// The invoice file of a confirmation (BR-IVC-05): FINANCE who records invoices, and the AUDITOR
registerFileSubjectPolicy('InvoiceConfirmation', async (_tx, _ctx, principal) => isAllowed(principal, 'invoiceConfirmation.record') || isAllowed(principal, 'audit.view'))
