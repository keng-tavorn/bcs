import { prisma } from '@/server/db/client'
import { E2E_DB } from '../support/e2e-env'

/** The demo organization the e2e seed makes: other scenes' test organizations reuse the same employee codes */
const DEMO_ORG = 'DEMO'

// Run by tests/e2e/request-form.spec.ts against the e2e database only: the code of the budget line the member sent
// their latest request of a type on (what BR-FORM-02 puts first in a new form), or null when they sent none. Other
// tests of the run send requests too, so the form test reads this instead of assuming a line. Prints JSON last.
if (new URL(process.env.DATABASE_URL ?? 'postgresql://x/none').pathname !== `/${E2E_DB}`) throw new Error('the form defaults scene runs in the e2e database only')

const [code, type] = process.argv.slice(2)
const member = await prisma.member.findFirstOrThrow({ where: { employeeCode: code, organization: { code: DEMO_ORG } }, select: { id: true } })
const latest = await prisma.request.findFirst({
  where: { requesterMemberId: member.id, requestType: { code: type }, submittedAt: { not: null }, budgetLineId: { not: null } },
  orderBy: { submittedAt: 'desc' },
  select: { budgetLine: { select: { code: true } } },
})
console.log(JSON.stringify({ code: latest?.budgetLine?.code ?? null }))
await prisma.$disconnect()
