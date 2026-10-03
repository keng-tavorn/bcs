import { randomUUID } from 'node:crypto'
import { prisma } from '@/server/db/client'

// Test data built directly through the base client (bcs_app role). Every test creates its own organization,
// so tests can run in parallel and never need to delete rows (Event cannot be deleted anyway).

export async function createOrg(overrides: { legalNameTh?: string } = {}) {
  return prisma.organization.create({
    data: {
      code: `T-${randomUUID().slice(0, 8)}`,
      legalNameTh: overrides.legalNameTh ?? 'องค์กรทดสอบ',
      taxId: '0999999000055',
      settings: {},
    },
  })
}

export async function createMember(organizationId: string, name = 'สมาชิกทดสอบ') {
  return prisma.member.create({
    data: {
      organizationId,
      displayNameTh: name,
      email: `${randomUUID()}@test.bcs.local`,
      status: 'ACTIVE',
    },
  })
}
