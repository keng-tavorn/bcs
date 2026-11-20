import { prisma } from '@/server/db/client'
import { sendSupplierNotice } from '@/server/notifications/supplier-notices'

/**
 * The e2e scenes' stand-in for the job supplier-notice-send, which the e2e app does not run: sends the PENDING e-mails to
 * the addresses a spec reads, oldest first, through the job's own sendSupplierNotice. Not the sweep: it takes the 50
 * oldest PENDING notices of the whole database, and in the full suite (desktop, then mobile, in one e2e database) every
 * spec that does not read its supplier's mail leaves its notices PENDING, so by the mobile project a spec's own notice
 * was past the 50 and never sent (main CI 2026-11-12 to 2026-11-18: exception-helper [mobile] read 0 e-mails).
 */
export async function sendNoticesTo(emails: readonly string[]): Promise<number> {
  if (emails.length === 0) throw new Error('notices: name the supplier addresses the spec reads')
  const due = await prisma.supplierNotice.findMany({
    where: { status: 'PENDING', toEmail: { in: [...emails] } },
    orderBy: { createdAt: 'asc' },
    select: { id: true, organizationId: true },
  })
  let sent = 0
  for (const n of due) if ((await sendSupplierNotice(n.organizationId, n.id, new Date())) === 'SENT') sent++
  return sent
}
