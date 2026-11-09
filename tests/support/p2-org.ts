import { prisma } from '@/server/db/client'
import { createDoaOrg, type DoaOrg } from './doa-org'

// createP2Org (S7-02 · ADR-069): createP1Org's organization with DOA-P2 version 1 of doa-versions-p2.yaml (DOA-P1's 22
// rules unchanged + SA-01 of SUPPLIER_APPROVAL · S10 S11 add theirs) as PUBLISHED, and the modules PAY AI BCS_GO
// SUPPLIER switched on (rows only, as a platform admin would leave them). It never touches the demo seed.

export const P2_FIXTURES = { org: 'fixtures/org-p1.yaml', versions: 'fixtures/doa-versions-p2.yaml' } as const
export const P2_MODULES = ['PAY', 'AI', 'BCS_GO', 'SUPPLIER'] as const

/**
 * In an e2e database the organization's code starts with Z, as every e2e scene's does: the pages of the BCS team list the
 * customers by code and the e2e tests expect DEMO first (uat-config.spec.ts) — a D-… code sorts before it (review S7-19)
 */
const inE2eDatabase = () => new URL(process.env.DATABASE_URL ?? 'postgresql://x/none').pathname.startsWith('/bcs_e2e')

export async function createP2Org(options: { modules?: readonly (typeof P2_MODULES)[number][] } = {}): Promise<DoaOrg> {
  const org = await createDoaOrg({ fixtures: P2_FIXTURES })
  if (inE2eDatabase()) {
    const { code } = await prisma.organization.findUniqueOrThrow({ where: { id: org.organizationId }, select: { code: true } })
    await prisma.organization.update({ where: { id: org.organizationId }, data: { code: `ZE2E-P2-${code}` } })
  }
  const enabledAt = new Date('2026-01-01T00:00:00+07:00')
  for (const key of options.modules ?? P2_MODULES) {
    await prisma.orgModule.create({ data: { organizationId: org.organizationId, module: key, enabled: true, enabledAt, contractRef: 'TEST-P2', reason: 'องค์กรทดสอบระยะ 2' } })
  }
  return org
}
