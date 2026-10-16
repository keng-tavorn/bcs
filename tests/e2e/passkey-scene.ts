import { prisma } from '@/server/db/client'
import { E2E_DB } from '../support/e2e-env'

// Run by tests/e2e/passkey.spec.ts against the e2e database only (S17-15, FR-PLT-301 AC3 AC4, FR-AUTH-005 AC6): reads
// back what the passkey pages recorded and leaves the member as the other specs expect them. Prints JSON on the last line.
//   grants <memberCode>  the member's step-up grants, newest first: how each was earned and whether it was used
//   off <memberCode>     every passkey of the member stops counting (test clean-up: the other specs of the run expect
//                        a decision page without the passkey button)
if (new URL(process.env.DATABASE_URL ?? 'postgresql://x/none').pathname !== `/${E2E_DB}`) throw new Error('the passkey scene runs in the e2e database only')

const [command, code = ''] = process.argv.slice(2)
if (!/^[a-z0-9_-]{2,60}$/.test(code)) throw new Error('a member code')
const member = await prisma.member.findFirstOrThrow({ where: { employeeCode: code, organization: { code: 'DEMO' } }, select: { id: true } })

switch (command) {
  case 'grants': {
    const grants = await prisma.stepUpGrant.findMany({ where: { memberId: member.id }, orderBy: { grantedAt: 'desc' }, take: 5, select: { method: true, usedAt: true, subjectType: true } })
    console.log(JSON.stringify({ grants: grants.map((g) => ({ method: g.method, used: g.usedAt !== null, subjectType: g.subjectType })) }))
    break
  }
  case 'off': {
    const now = new Date()
    const revoked = await prisma.memberPasskey.updateMany({ where: { memberId: member.id, revokedAt: null }, data: { revokedAt: now, revokeReason: 'USER' } })
    console.log(JSON.stringify({ revoked: revoked.count }))
    break
  }
  default:
    throw new Error('grants <member> · off <member>')
}
await prisma.$disconnect()
