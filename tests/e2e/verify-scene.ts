import { prisma } from '@/server/db/client'
import { verificationToken } from '@/server/verification/token'
import { E2E_DB } from '../support/e2e-env'

// Run by tests/e2e/verify.spec.ts against the e2e database only (S6-19 · FR-DOA-102): the token a printed document's QR
// carries, computed from the latest verification row of a sent purchase order of the demo (the seed sends its
// requests and POs through the services, which issue the rows), with the number and the amounts the page must not show.
// Reads only. Prints one JSON line last.
if (new URL(process.env.DATABASE_URL ?? 'postgresql://x/none').pathname !== `/${E2E_DB}`) throw new Error('the verify scene runs in the e2e database only')

async function main() {
  const row = await prisma.documentVerification.findFirstOrThrow({ where: { subjectType: 'PURCHASE_ORDER', supersededAt: null }, orderBy: { issuedAt: 'asc' } })
  const po = await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: row.subjectId }, select: { number: true, grossSatang: true } })
  const gross = po.grossSatang.toString()
  console.log(JSON.stringify({ token: verificationToken(row.id), number: po.number, gross: `${gross.slice(0, -2)}.${gross.slice(-2)}` }))
}

main()
  .catch((e: unknown) => {
    console.error(e)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
