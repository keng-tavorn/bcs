import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type { DoaRuleSnapshot } from '@/core/doa'
import { prisma } from '@/server/db/client'
import { ruleJson } from '@/server/doa/snapshot'
import { migratorUrl } from '../../scripts/lib/db-urls'
import { lintSeededAndPublishedDoa } from '../../scripts/lib/doa-lint-gate'
import { createMember, createOrg } from '../support/factory'

// Canary of the db gate's DOA lint (spec §15.5 item 5, BR-DOA-08): a published version with a gap in its amount bands
// must be reported, a complete one must not, and a draft is not linted at all.

const B = (baht: number) => BigInt(baht) * 100n
const ceo = { kind: 'POSITION_OF_ORG', position: 'CEO' } as const
const step = { approver: ceo, slaBusinessMinutes: 480, mode: 'SEQUENTIAL' } as const
const rule = (code: string, documentType: DoaRuleSnapshot['documentType'], amount?: { gt?: bigint; lte?: bigint }): DoaRuleSnapshot => ({
  code,
  documentType,
  priority: 100,
  when: amount ? { amount } : {},
  steps: [step],
})
const governance = [rule('DOA-CHG-01', 'DOA_CHANGE'), rule('ORG-CHG-01', 'ORG_AUTHORITY_CHANGE')]

async function orgWithDoa(rules: DoaRuleSnapshot[], status: 'PUBLISHED' | 'DRAFT') {
  const org = await createOrg()
  const root = await prisma.department.create({ data: { organizationId: org.id, code: 'HQ', nameTh: 'สำนักงานใหญ่', kind: 'COMPANY' } })
  const position = await prisma.position.create({ data: { organizationId: org.id, code: 'CEO', nameTh: 'ประธานเจ้าหน้าที่บริหาร', scope: 'ORG' } })
  const member = await createMember(org.id, 'ประธาน บริษัท')
  await prisma.positionAssignment.create({
    data: { organizationId: org.id, positionId: position.id, departmentId: root.id, memberId: member.id, validFrom: new Date('2026-01-01T00:00:00Z') },
  })
  const version = await prisma.doaVersion.create({
    data: {
      organizationId: org.id,
      code: `DOA-${randomUUID().slice(0, 6)}`,
      versionNo: 1,
      status,
      effectiveFrom: new Date('2026-01-01T00:00:00Z'),
      amountBasis: 'GROSS',
      selfApprovalPolicy: 'ESCALATE_NEXT_BAND',
      sodPolicy: { approverMayReceive: false, requesterMayReceive: true },
    },
  })
  for (const r of rules) {
    const json = ruleJson(r)
    await prisma.doaRule.create({
      data: { organizationId: org.id, doaVersionId: version.id, code: r.code, documentType: json.documentType, priority: r.priority, when: json.when, steps: json.steps },
    })
  }
  const orgRow = await prisma.organization.findUniqueOrThrow({ where: { id: org.id }, select: { code: true } })
  return { orgCode: orgRow.code, version }
}

describe('[FR-DOA-002/AC1] pnpm verify lints every seeded or published DOA version with the full BR-DOA-08 rules', () => {
  it('reports a gap in a published version, passes a complete one, and leaves drafts alone', async () => {
    const gap = await orgWithDoa([rule('PR-01', 'PURCHASE_REQUEST', { lte: B(20_000) }), rule('PR-03', 'PURCHASE_REQUEST', { gt: B(30_000) }), ...governance], 'PUBLISHED')
    const complete = await orgWithDoa([rule('PR-01', 'PURCHASE_REQUEST', { lte: B(20_000) }), rule('PR-02', 'PURCHASE_REQUEST', { gt: B(20_000) }), ...governance], 'PUBLISHED')
    const draft = await orgWithDoa([rule('PR-01', 'PURCHASE_REQUEST', { lte: B(20_000) })], 'DRAFT')

    const result = await lintSeededAndPublishedDoa({ verifyDatabaseUrl: migratorUrl(process.env.BCS_TEST_DB ?? 'bcs_test') })
    const about = (code: string) => result.problems.filter((p) => p.includes(`องค์กร ${code}`))
    expect(about(gap.orgCode)).toEqual([`DOA ${gap.version.code} ฉบับ 1 ขององค์กร ${gap.orgCode}: DOA_LINT_GAP PURCHASE_REQUEST ช่วง (20000.00, 30000.00]`])
    expect(about(complete.orgCode)).toEqual([])
    // The draft has no governance rules and only one band, yet it is not linted: only seeded or published versions are
    expect(about(draft.orgCode)).toEqual([])
    expect(result.checked).toBeGreaterThanOrEqual(2)
  })
})
