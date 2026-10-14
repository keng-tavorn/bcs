import { isAllowed } from '@/server/authz'
import { auditFileReadable } from '../audit/masking'
import { registerFileSubjectPolicy } from '../files/policies'
import { whtReturnFileReadable } from '../ap/wht-files'
import { reportFileReadable } from '../reports/access'

// Who may download an exported file (FR-PLT-004 AC2): whoever may make that kind of export — the Express AP file is
// FINANCE's (§2.4 export.express), an audit export the AUDITOR's (audit.export) — and a report's file only a reader whose
// report.view covers the scope it was made for (FR-VIS-002 AC3, ExportJob.params.scope): an organization-wide file only
// readers of the whole organization, a department's file readers of those departments, so a department head who learns
// the id of the organization's file cannot take it. An audit file that holds a national id number whole goes only to a
// reader who sees them whole (BR-AUTH-04, NEW-33), as an individual's registry proof does. ../reports/access.ts and
// ../audit/masking.ts import neither the report framework nor the audit service, so no import cycle runs back through
// them. A job that does not exist, or a kind with no rule, gives no access (deny by default, BR-AUTH-01).
registerFileSubjectPolicy('ExportJob', async (tx, ctx, principal, subjectId) => {
  const job = await tx.exportJob.findFirst({ where: { id: subjectId }, select: { kind: true, params: true } })
  if (!job) return false
  switch (job.kind) {
    case 'AUDIT':
      return isAllowed(principal, 'audit.export') && auditFileReadable(principal, job.params)
    case 'EXPRESS_AP':
      return isAllowed(principal, 'export.express')
    case 'REPORT':
      return reportFileReadable(principal, job.params)
    // S8-08: a monthly withholding summary (BR-WHT-08, BR-WHT-09)
    case 'WHT_RETURN':
      return whtReturnFileReadable(tx, ctx, principal, subjectId, job.params)
    default:
      return false
  }
})

// The invoice file of a confirmation (BR-IVC-05): FINANCE who records invoices, and the AUDITOR
registerFileSubjectPolicy('InvoiceConfirmation', async (_tx, _ctx, principal) => isAllowed(principal, 'invoiceConfirmation.record') || isAllowed(principal, 'audit.view'))
