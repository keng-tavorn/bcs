import { prisma } from '@/server/db/client'
import { createDoaOrg, type DoaOrg } from './doa-org'

// createP1Org (ADR-070, P1-07): an organization of the §7.4 phase-1 fixtures for the lanes' tests and e2e. The
// departments and holders of org-p1.yaml (org-demo.yaml + CFO@HQ), DOA-P1 version 1 of doa-versions-p1.yaml as
// PUBLISHED (the tier-1 rules + 14 rules of the six phase-1 types), the rest as createDoaOrg, and the modules PAY AI
// BCS_GO switched on (rows only, as a platform admin would leave them). It never touches the demo seed.

export const P1_FIXTURES = { org: 'fixtures/org-p1.yaml', versions: 'fixtures/doa-versions-p1.yaml' } as const
export const P1_MODULES = ['PAY', 'AI', 'BCS_GO'] as const

export async function createP1Org(options: { modules?: readonly (typeof P1_MODULES)[number][] } = {}): Promise<DoaOrg> {
  const org = await createDoaOrg({ fixtures: P1_FIXTURES })
  const enabledAt = new Date('2026-01-01T00:00:00+07:00')
  for (const key of options.modules ?? P1_MODULES) {
    await prisma.orgModule.create({ data: { organizationId: org.organizationId, module: key, enabled: true, enabledAt, contractRef: 'TEST-P1', reason: 'องค์กรทดสอบระยะ 1' } })
  }
  return org
}
