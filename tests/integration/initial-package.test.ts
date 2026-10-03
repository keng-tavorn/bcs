import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { totp } from '@/lib/totp'
import { authorize } from '@/server/authz'
import { makeCtx } from '@/server/context'
import { prisma } from '@/server/db/client'
import { forTenant } from '@/server/db/tenant'
import { enableTotpWithSecret, upsertUserWithPassword } from '@/server/auth/provision'
import { grantStepUp } from '@/server/auth/step-up'
import { decideTask } from '@/server/services/approvals/decide'
import { importDoaDraft } from '@/server/services/doa'
import { INITIAL_PACKAGE_RULE, submitInitialPackage } from '@/server/services/doa/initial-package'
import { applyScheduledChange } from '@/server/services/org-authority'
import { getTenant } from '@/server/services/platform/tenants'
import { loadYaml } from '../golden/doa-fixtures'
import { createDoaOrg, type DoaOrg } from '../support/doa-org'

// FR-DOA-002 AC3 (BR-DOA-19, OQ-31 default): the first DOA version and the holders of the positions it names go together
// to the contract signatory, who approves with a step-up; the submitter is never the signatory; PLATFORM_ADMIN never
// sees the content.

const NOW = new Date('2026-10-05T03:00:00Z')
const EFFECTIVE = '2026-10-10T00:00:00+07:00'
const key = () => ({ idempotencyKey: randomUUID(), sender: null })
const SIGNATORY_SECRET = 'P'.repeat(32)
const FIXTURE = readFileSync(path.resolve(import.meta.dirname, '../golden/fixtures/doa-versions.yaml'), 'utf8')
/** Version 1 of the fixture, starting on 10 Oct so it is not in the past */
const VERSION1 = FIXTURE.slice(0, FIXTURE.indexOf('  - code: DOA-DEMO\n    version: 2')).replace('"2026-10-01T00:00:00+07:00"', `"${EFFECTIVE}"`)
const NAMED = new Set(['DM', 'VP', 'COO', 'CEO'])

interface OrgFixture {
  positions: Array<{ position: string; department: string; member: string }>
}

let org: DoaOrg
beforeAll(async () => {
  org = await createDoaOrg({ doa: false })
  await prisma.roleAssignment.create({ data: { organizationId: org.organizationId, memberId: org.member.admin!, role: 'ORG_ADMIN', grantedAt: NOW } })
  // The BCS team verified the CEO as the contract signatory; the CEO signs in with an authenticator
  await prisma.organization.update({ where: { id: org.organizationId }, data: { contractSignatoryMemberId: org.member.ceo!, contractSignatoryVerifiedAt: NOW } })
  const ceo = await prisma.member.findUniqueOrThrow({ where: { id: org.member.ceo! } })
  const userId = await upsertUserWithPassword({ email: ceo.email, name: ceo.displayNameTh, password: 'ceo-password-123456' })
  await enableTotpWithSecret(userId, SIGNATORY_SECRET, [])
  await prisma.member.update({ where: { id: ceo.id }, data: { userId } })
})

/** Every slot of a position version 1 names, with the holder of the fixture */
function holders(edit: (h: Array<{ positionCode: string; departmentId: string; memberId: string }>) => typeof h = (h) => h) {
  const fixture = loadYaml<OrgFixture>('fixtures/org-demo.yaml')
  return edit(fixture.positions.filter((p) => NAMED.has(p.position)).map((p) => ({ positionCode: p.position, departmentId: org.department[p.department]!, memberId: org.member[p.member]! })))
}

let drafts = 0
/** A draft of version 1's rules under its own number (the numbers of one code never repeat) */
async function draft(): Promise<string> {
  drafts += 1
  const r = await importDoaDraft(org.ctxOf('admin', NOW), { yaml: VERSION1.replace('version: 1\n', `version: ${drafts}\n`) }, key())
  if (!r.ok) throw new Error(`import failed: ${JSON.stringify(r.error)}`)
  return r.data.versionIds[0]!
}

describe('[FR-DOA-002/AC3] the initial package goes to the contract signatory, who approves it with a step-up', () => {
  it('refuses a package with a position the version does not name, an unlisted holder, or the submitter in it', async () => {
    const versionId = await draft()
    const submit = (list: ReturnType<typeof holders>) => submitInitialPackage(org.ctxOf('admin', NOW), { versionId, holders: list, reason: 'ชุดตั้งต้นตามสัญญา' }, key())
    expect(await submit(holders((h) => [...h, { positionCode: 'PROC_MGR', departmentId: org.department.HQ!, memberId: org.member.dm_proc! }]))).toMatchObject({
      ok: false,
      error: { code: 'VALIDATION_FAILED', details: { reason: 'POSITION_NOT_IN_DOA' } },
    })
    expect(await submit(holders((h) => h.filter((x) => x.positionCode !== 'COO')))).toMatchObject({ ok: false, error: { details: { reason: 'UNLISTED_HOLDER', slots: [{ positionCode: 'COO' }] } } })
    expect(await submit(holders((h) => h.map((x) => (x.positionCode === 'COO' ? { ...x, memberId: org.member.admin! } : x))))).toMatchObject({ ok: false, error: { code: 'SOD_VIOLATION', details: { rule: 'BR-SOD-08' } } })
    expect(await prisma.doaVersion.findUniqueOrThrow({ where: { id: versionId } })).toMatchObject({ status: 'DRAFT' })
  })

  it('refuses when the submitter is the signatory, or no signatory is verified', async () => {
    const versionId = await draft()
    await prisma.roleAssignment.create({ data: { organizationId: org.organizationId, memberId: org.member.ceo!, role: 'ORG_ADMIN', grantedAt: NOW } })
    expect(await submitInitialPackage(org.ctxOf('ceo', NOW), { versionId, holders: holders(), reason: 'ส่งเอง' }, key())).toMatchObject({ ok: false, error: { code: 'SOD_VIOLATION', details: { rule: 'BR-SOD-06' } } })
    await prisma.roleAssignment.updateMany({ where: { organizationId: org.organizationId, memberId: org.member.ceo!, role: 'ORG_ADMIN' }, data: { revokedAt: NOW } })
    await prisma.organization.update({ where: { id: org.organizationId }, data: { contractSignatoryVerifiedAt: null } })
    expect(await submitInitialPackage(org.ctxOf('admin', NOW), { versionId, holders: holders(), reason: 'ชุดตั้งต้น' }, key())).toMatchObject({ ok: false, error: { details: { reason: 'SIGNATORY_NOT_VERIFIED' } } })
    await prisma.organization.update({ where: { id: org.organizationId }, data: { contractSignatoryVerifiedAt: NOW } })
  })

  it('the signatory approves with a step-up: version 1 is published and the holders start on its effective date', async () => {
    const versionId = await draft()
    const submitted = await submitInitialPackage(org.ctxOf('admin', NOW), { versionId, holders: holders(), reason: 'ชุดตั้งต้นตามสัญญา' }, key())
    expect(submitted).toMatchObject({ ok: true, data: { assigneeMemberId: org.member.ceo } })
    if (!submitted.ok) return
    const route = await prisma.approvalRoute.findUniqueOrThrow({ where: { id: submitted.data.routeId } })
    // The route cites the version it approves under BR-DOA-19; nothing could resolve it from a DOA in effect
    expect(route).toMatchObject({ subjectType: 'DOA_VERSION', subjectId: versionId, doaVersionId: versionId, ruleCode: INITIAL_PACKAGE_RULE })
    expect(await prisma.orgAuthorityChange.count({ where: { routeId: route.id, status: 'PENDING_APPROVAL', kind: 'POSITION_ASSIGN' } })).toBe(holders().length)
    // While it waits, the positions it names change only through it
    const second = await draft()
    expect(await submitInitialPackage(org.ctxOf('admin', NOW), { versionId: second, holders: holders(), reason: 'ซ้ำ' }, key())).toMatchObject({ ok: false, error: { details: { reason: 'NOT_INITIAL' } } })

    const task = await prisma.approvalTask.findFirstOrThrow({ where: { status: 'OPEN', step: { routeId: route.id } } })
    const approve = () => decideTask(org.ctxOf('ceo', NOW), { taskId: task.id, decision: 'APPROVE' }, key())
    expect(await approve()).toMatchObject({ ok: false, error: { code: 'STEP_UP_REQUIRED' } })
    await grantStepUp({ organizationId: org.organizationId, memberId: org.member.ceo!, subjectType: 'DOA_VERSION', subjectId: versionId, code: totp(SIGNATORY_SECRET) }, new Date())
    expect(await approve()).toMatchObject({ ok: true, data: { documentStatus: 'PUBLISHED' } })
    expect(await prisma.doaVersion.findUniqueOrThrow({ where: { id: versionId } })).toMatchObject({ status: 'PUBLISHED', approvedById: org.member.ceo, effectiveFrom: new Date(EFFECTIVE) })
    const decided = await prisma.event.findFirstOrThrow({ where: { aggregateId: task.id, type: 'approval_task.decided' } })
    expect(decided.data).toMatchObject({ doaVersionId: versionId, doaRuleCode: INITIAL_PACKAGE_RULE, stepUpGrantId: expect.any(String) })

    // The holders start with the version: the job applies each change on the effective date
    const changes = await prisma.orgAuthorityChange.findMany({ where: { routeId: route.id } })
    expect(changes.every((c) => c.status === 'SCHEDULED')).toBe(true)
    for (const c of changes) expect(await applyScheduledChange(org.organizationId, c.id, new Date(EFFECTIVE))).toMatchObject({ ok: true })
    const current = await prisma.positionAssignment.findMany({ where: { organizationId: org.organizationId, validTo: null, position: { code: { in: [...NAMED] } } } })
    expect(current).toHaveLength(holders().length)
    expect(current.every((h) => h.validFrom.getTime() === new Date(EFFECTIVE).getTime())).toBe(true)
  })

  it('PLATFORM_ADMIN sees the tenant name and status only, and can neither read nor decide the package', async () => {
    const platformAdmin = await prisma.platformAdmin.create({ data: { displayName: 'ทีม BCS', active: true } })
    const tenant = await getTenant(platformAdmin.id, org.organizationId)
    expect(tenant.ok && Object.keys(tenant.data).sort()).toEqual(['code', 'id', 'name', 'status'])
    const platform = makeCtx({ organizationId: org.organizationId, actor: { type: 'PLATFORM_ADMIN', platformAdminId: platformAdmin.id }, channel: 'WEB', now: NOW })
    for (const capability of ['admin.doa.draft', 'admin.doa.simulate', 'admin.doa.submitForPublish', 'admin.orgAuthority.propose'] as const) {
      expect(await forTenant(org.organizationId).$transaction((tx) => authorize(tx, platform, capability)), capability).toMatchObject({ ok: false })
    }
    const task = await prisma.approvalTask.findFirstOrThrow({ where: { organizationId: org.organizationId, step: { route: { ruleCode: INITIAL_PACKAGE_RULE } } } })
    expect(await decideTask(platform, { taskId: task.id, decision: 'REJECT', reason: 'ทดสอบ' }, key())).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
  })
})
