import { InvoiceVarianceBody, type InvoiceTaskView } from '@/ui/tasks/subjects/invoice'

// The LIFF summary of an invoice's price variance task (S8-06, ADR-052): the invoice and PO numbers and the variance in
// total, nothing per line (BR-AP-09). The LIFF task page of S6 renders it with the view it read.

export async function LiffInvoiceSummary({ invoice }: { invoice: InvoiceTaskView | null }) {
  return invoice ? <InvoiceVarianceBody invoice={invoice} brief /> : null
}
