import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { makeCtx } from '@/server/context'
import { prisma } from '@/server/db/client'
import { forTenant } from '@/server/db/tenant'
import { importDoaDraft, publishApprovedDoaVersion, submitDoaVersion } from '@/server/services/doa'
import { createDoaOrg, type DoaOrg } from '../support/doa-org'

// FR-DOA-002 AC1 and AC4 (BR-DOA-08, BR-DOA-12): an imported DOA version is submitted only when the full lint passes and
// every warning is acknowledged, with an effective time that is not in the past; it goes to the DOA_CHANGE approver of
// the version in effect; publishing supersedes the version before it.

const NOW = new Date('2026-10-05T03:00:00Z')
const key = () => ({ idempotencyKey: randomUUID(), sender: null })
const FIXTURE = readFileSync(path.resolve(import.meta.dirname, '../golden/fixtures/doa-versions.yaml'), 'utf8')
/** Version 2 of the fixture only, renumbered so each test imports its own version */
const version2 = (versionNo: number, edit: (text: string) => string = (t) => t) => {
  const v2 = FIXTURE.slice(FIXTURE.indexOf('  - code: DOA-DEMO\n    version: 2'))
  return edit(`versions:\n${v2.replace('version: 2', `version: ${versionNo}`)}`)
}

let org: DoaOrg
beforeAll(async () => {
  org = await createDoaOrg()
  await prisma.roleAssignment.create({ data: { organizationId: org.organizationId, memberId: org.member.admin!, role: 'ORG_ADMIN', grantedAt: NOW } })
})

async function imported(yaml: string): Promise<string> {
  const r = await importDoaDraft(org.ctxOf('admin', NOW), { yaml }, key())
  if (!r.ok) throw new Error(`import failed: ${JSON.stringify(r.error)}`)
  return r.data.versionIds[0]!
}

describe('[FR-DOA-002/AC1] a version is submitted only when the lint passes and every warning is acknowledged', () => {
  it('refuses a version with a gap with DOA_LINT_FAILED, the code and the band', async () => {
    const id = await imported(version2(10, (t) => t.replace('when: { amount: { gt: "30000.00", lte: "100000.00" } }', 'when: { amount: { gt: "40000.00", lte: "100000.00" } }')))
    const r = await submitDoaVersion(org.ctxOf('admin', NOW), { versionId: id }, key())
    expect(r).toMatchObject({ ok: false, error: { code: 'DOA_LINT_FAILED', details: { errors: [{ code: 'DOA_LINT_GAP', documentType: 'PURCHASE_REQUEST', gt: '3000000', lte: '4000000' }] } } })
    expect(await prisma.doaVersion.findUniqueOrThrow({ where: { id } })).toMatchObject({ status: 'DRAFT' })
  })

  it('needs each warning acknowledged, then routes the version to the DOA_CHANGE approver (CEO)', async () => {
    // Nobody holds COO on the effective date: a vacant-position warning for PO-01
    const id = await imported(version2(11, (t) => t.replace('approver: { kind: POSITION_OF_ORG, position: COO }', 'approver: { kind: POSITION_OF_ORG, position: CFO }')))
    const silent = await submitDoaVersion(org.ctxOf('admin', NOW), { versionId: id }, key())
    expect(silent).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED', details: { reason: 'WARNINGS_NOT_ACKNOWLEDGED', warnings: ['DOA_LINT_VACANT_POSITION:PO-01'] } } })
    const submitted = await submitDoaVersion(org.ctxOf('admin', NOW), { versionId: id, acknowledgedWarnings: ['DOA_LINT_VACANT_POSITION:PO-01'] }, key())
    expect(submitted).toMatchObject({ ok: true, data: { assigneeMemberId: org.member.ceo } })
    expect(await prisma.doaVersion.findUniqueOrThrow({ where: { id } })).toMatchObject({ status: 'PENDING_APPROVAL', submittedById: org.member.admin })
    expect(await prisma.approvalRoute.findFirstOrThrow({ where: { subjectType: 'DOA_VERSION', subjectId: id } })).toMatchObject({ ruleCode: 'DOA-CHG-01' })
  })

  it('only an organization admin imports or submits', async () => {
    expect(await importDoaDraft(org.ctxOf('dm_con', NOW), { yaml: version2(12) }, key())).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
  })
})

describe('[FR-DOA-002/AC4] the effective time is never in the past, and the new version supersedes the old one', () => {
  it('refuses a past effective time at submit', async () => {
    const id = await imported(version2(13, (t) => t.replace('"2026-11-01T00:00:00+07:00"', '"2026-10-01T00:00:00+07:00"')))
    expect(await submitDoaVersion(org.ctxOf('admin', NOW), { versionId: id }, key())).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED', details: { reason: 'EFFECTIVE_IN_PAST' } } })
  })

  it('publishing after the planned time starts it at the approval and supersedes version 1', async () => {
    const id = await imported(version2(14))
    expect(await submitDoaVersion(org.ctxOf('admin', NOW), { versionId: id }, key())).toMatchObject({ ok: true })
    // The CEO approves on 2 Nov, after the planned 1 Nov start (the approval flow with step-up is S2-16)
    const approvedAt = new Date('2026-11-02T03:00:00Z')
    const ctx = makeCtx({ organizationId: org.organizationId, actor: { type: 'USER', memberId: org.member.ceo! }, channel: 'WEB', now: approvedAt })
    const events = await forTenant(org.organizationId).$transaction((tx) => publishApprovedDoaVersion(tx, ctx, id, org.member.ceo!))
    expect(events.map((e) => e.type)).toEqual(['doa_version.superseded', 'doa_version.published'])
    const versions = await prisma.doaVersion.findMany({ where: { organizationId: org.organizationId, code: 'DOA-DEMO', status: { in: ['PUBLISHED', 'SUPERSEDED'] } }, orderBy: { versionNo: 'asc' } })
    expect(versions.map((v) => [v.versionNo, v.status, v.effectiveFrom.toISOString(), v.effectiveTo?.toISOString() ?? null])).toEqual([
      [1, 'SUPERSEDED', '2026-09-30T17:00:00.000Z', approvedAt.toISOString()],
      [14, 'PUBLISHED', approvedAt.toISOString(), null],
    ])
  })
})
