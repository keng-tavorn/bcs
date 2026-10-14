import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { makeCtx } from '@/server/context'
import { prisma } from '@/server/db/client'
import { forTenant } from '@/server/db/tenant'
import { openTasksUnderVersion } from '@/server/doa/policy'
import { decideTask } from '@/server/services/approvals/decide'
import { activateDoaVersion, importDoaDraft, publishApprovedDoaVersion, submitDoaVersion } from '@/server/services/doa'
import { createDraft, resubmitRequest, submitRequest } from '../support/requests'
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
    const submitted = await submitDoaVersion(org.ctxOf('admin', NOW), { versionId: id, acknowledgedWarnings: ['DOA_LINT_VACANT_POSITION:PO-01'], boundaryTableConfirmed: true }, key())
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
    expect(await submitDoaVersion(org.ctxOf('admin', NOW), { versionId: id, boundaryTableConfirmed: true }, key())).toMatchObject({ ok: true })
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

describe('[NEW-13] a version approved for a later date supersedes its predecessor when it takes effect', () => {
  it('keeps version 1 PUBLISHED until then; the job sets it SUPERSEDED at the effective time and tells the admins', async () => {
    const solo = await createDoaOrg()
    await prisma.roleAssignment.create({ data: { organizationId: solo.organizationId, memberId: solo.member.admin!, role: 'ORG_ADMIN', grantedAt: NOW } })
    const draft = await importDoaDraft(solo.ctxOf('admin', NOW), { yaml: version2(30) }, key())
    if (!draft.ok) throw new Error('import failed')
    const id = draft.data.versionIds[0]!
    await submitDoaVersion(solo.ctxOf('admin', NOW), { versionId: id, boundaryTableConfirmed: true }, key())
    // Approved on 6 Oct for 1 Nov
    const approver = makeCtx({ organizationId: solo.organizationId, actor: { type: 'USER', memberId: solo.member.ceo! }, channel: 'WEB', now: new Date('2026-10-06T03:00:00Z') })
    const published = await forTenant(solo.organizationId).$transaction((tx) => publishApprovedDoaVersion(tx, approver, id, solo.member.ceo!))
    expect(published.map((e) => e.type)).toEqual(['doa_version.published'])
    const v1 = await prisma.doaVersion.findFirstOrThrow({ where: { organizationId: solo.organizationId, versionNo: 1 } })
    expect(v1).toMatchObject({ status: 'PUBLISHED', effectiveTo: new Date('2026-10-31T17:00:00Z') })
    expect(await activateDoaVersion(solo.organizationId, id, new Date('2026-10-31T16:59:00Z'))).toMatchObject({ ok: false, error: { details: { reason: 'NOT_DUE' } } })
    expect(await activateDoaVersion(solo.organizationId, id, new Date('2026-10-31T17:00:00Z'))).toMatchObject({ ok: true, data: { superseded: 1 } })
    expect(await prisma.doaVersion.findUniqueOrThrow({ where: { id: v1.id } })).toMatchObject({ status: 'SUPERSEDED' })
    expect(await prisma.event.count({ where: { aggregateId: v1.id, type: 'doa_version.superseded' } })).toBe(1)
    expect(await prisma.notification.count({ where: { recipientMemberId: solo.member.admin, templateKey: 'doa.authority_changed' } })).toBe(1)
  })
})

describe('[FR-DOA-002/AC4] a submitted document keeps the route of the version it was submitted under (BR-DOA-13)', () => {
  it('a new version does not move the open task; resubmitting after a return uses the new version (BR-DOA-09)', async () => {
    const solo = await createDoaOrg()
    await prisma.roleAssignment.create({ data: { organizationId: solo.organizationId, memberId: solo.member.admin!, role: 'ORG_ADMIN', grantedAt: NOW } })
    // 25,000 baht: version 1 sends it to the VP (PR-02); version 2 raises the DM band to 30,000 (PR-01)
    const draft = await createDraft(solo.ctxOf('req_con', NOW), { requestTypeCode: 'BUY_GOODS', title: 'เครื่องมือ', priceIncludesVat: true, lines: [{ description: 'สว่าน', quantity: '1', uom: 'ชุด', unitPrice: '25000.00' }] }, key())
    if (!draft.ok) throw new Error('draft failed')
    await submitRequest(solo.ctxOf('req_con', NOW), { requestId: draft.data.requestId }, key())
    const v1 = await prisma.doaVersion.findFirstOrThrow({ where: { organizationId: solo.organizationId, versionNo: 1 } })
    expect(await forTenant(solo.organizationId).$transaction((tx) => openTasksUnderVersion(tx, v1.id))).toBe(1)

    const imported = await importDoaDraft(solo.ctxOf('admin', NOW), { yaml: version2(40) }, key())
    if (!imported.ok) throw new Error('import failed')
    const v2 = imported.data.versionIds[0]!
    await submitDoaVersion(solo.ctxOf('admin', NOW), { versionId: v2, boundaryTableConfirmed: true }, key())
    const later = new Date('2026-11-02T03:00:00Z')
    const approver = makeCtx({ organizationId: solo.organizationId, actor: { type: 'USER', memberId: solo.member.ceo! }, channel: 'WEB', now: later })
    await forTenant(solo.organizationId).$transaction((tx) => publishApprovedDoaVersion(tx, approver, v2, solo.member.ceo!))

    // Still with the VP under version 1, rule PR-02
    const task = await prisma.approvalTask.findFirstOrThrow({ where: { status: 'OPEN', step: { route: { subjectId: draft.data.requestId } } }, include: { step: { include: { route: true } } } })
    expect(task).toMatchObject({ assigneeMemberId: solo.member.vp_ops, step: { route: { doaVersionId: v1.id, ruleCode: 'PR-02' } } })
    expect(await forTenant(solo.organizationId).$transaction((tx) => openTasksUnderVersion(tx, v1.id))).toBe(1)

    // Returned and sent again: the new route follows version 2
    await decideTask(solo.ctxOf('vp_ops', later), { taskId: task.id, decision: 'RETURN', reason: 'แนบใบเสนอราคา' }, key())
    expect(await resubmitRequest(solo.ctxOf('req_con', later), { requestId: draft.data.requestId }, key())).toMatchObject({ ok: true, data: { assigneeMemberId: solo.member.dm_con } })
    const routes = await prisma.approvalRoute.findMany({ where: { subjectId: draft.data.requestId }, orderBy: { routeNo: 'asc' } })
    expect(routes.map((r) => [r.routeNo, r.doaVersionId, r.ruleCode, r.status])).toEqual([
      [1, v1.id, 'PR-02', 'CANCELLED'],
      [2, v2, 'PR-01', 'ACTIVE'],
    ])
    expect(await forTenant(solo.organizationId).$transaction((tx) => openTasksUnderVersion(tx, v1.id))).toBe(0)
  })
})
