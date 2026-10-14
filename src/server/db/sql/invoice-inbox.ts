import { systemDb } from '../system'

// The job invoice-inbox-poll reads across organizations (ADR-123): those with PAY on and an inbox address in
// settings.ap.inboxAddress. Only ids leave here; each inbox is then read through its organization's scoped client.

export async function organizationsWithInvoiceInbox(): Promise<string[]> {
  const rows = await systemDb.organization.findMany({
    where: { status: 'ACTIVE', modules: { some: { module: 'PAY', enabled: true } }, settings: { path: ['ap', 'inboxAddress'], not: 'null' } },
    select: { id: true },
    orderBy: { id: 'asc' },
  })
  return rows.map((r) => r.id)
}
