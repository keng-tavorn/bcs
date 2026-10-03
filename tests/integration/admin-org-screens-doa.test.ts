import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { totp } from '@/lib/totp'
import { enableTotpWithSecret, upsertUserWithPassword } from '@/server/auth/provision'
import { grantStepUp } from '@/server/auth/step-up'
import { HTTP_STATUS } from '@/core/result'
import { prisma } from '@/server/db/client'
import { parseDoaYaml } from '@/server/doa/yaml'
import { decideTask } from '@/server/services/approvals/decide'
import { importDoaDraft, submitDoaVersion } from '@/server/services/doa'
import { exportDoaVersionYaml, getDoaOverviewForAdmin, getDoaVersionForAdmin } from '@/server/services/doa/view'
import { createDraft, submitRequest } from '@/server/services/requests'
import { versionSnapshots } from '../golden/doa-fixtures'
import { createDoaOrg, type DoaOrg } from '../support/doa-org'

// S2-13 DOA screens, read through the services the pages call: import and export YAML in the fixture's shape with a
// round trip (FR-DOA-001 AC2); every version with its period, reason, people and diff with the version before, and a
// published version that never changes (AC3); the lint a draft shows before it is sent, by code and band, with each
// warning to tick (FR-DOA-002 AC1); the initial package form when no DOA exists yet (FR-DOA-002 AC3, BR-DOA-19).

const NOW = new Date('2026-10-05T03:00:00Z')
const key = () => ({ idempotencyKey: randomUUID(), sender: null })
const CEO_SECRET = 'D'.repeat(32)
const FIXTURE = readFileSync(path.resolve(import.meta.dirname, '../golden/fixtures/doa-versions.yaml'), 'utf8')
/** Version 2 of the fixture (DM band up to 30,000 from 1 Nov) under its own number, edited */
const version2 = (versionNo: number, edit: (text: string) => string = (t) => t) =>
  edit(`versions:\n${FIXTURE.slice(FIXTURE.indexOf('  - code: DOA-DEMO\n    version: 2')).replace('version: 2', `version: ${versionNo}`)}`)
const noMembers = new Map<string, string>()
/** Drafts sent after version 20 (approved for 1 Nov) must start later than it (ADR-042 item 7) */
const inDecember = (t: string) => t.replace('"2026-11-01T00:00:00+07:00"', '"2026-12-01T00:00:00+07:00"')

let org: DoaOrg
beforeAll(async () => {
  org = await createDoaOrg()
  await prisma.roleAssignment.create({ data: { organizationId: org.organizationId, memberId: org.member.admin!, role: 'ORG_ADMIN', grantedAt: NOW } })
  const ceo = await prisma.member.findUniqueOrThrow({ where: { id: org.member.ceo! } })
  const userId = await upsertUserWithPassword({ email: ceo.email, name: ceo.displayNameTh, password: 'ceo-password-123456' })
  await enableTotpWithSecret(userId, CEO_SECRET, [])
  await prisma.member.update({ where: { id: ceo.id }, data: { userId } })
})

const admin = () => org.ctxOf('admin', NOW)

async function imported(yaml: string, changeReason = 'ปรับวงเงินตามมติคณะกรรมการ'): Promise<string> {
  const r = await importDoaDraft(admin(), { yaml, changeReason }, key())
  if (!r.ok) throw new Error(`import failed: ${JSON.stringify(r.error)}`)
  return r.data.versionIds[0]!
}

async function exported(versionId: string): Promise<string> {
  const r = await exportDoaVersionYaml(admin(), versionId)
  if (!r.ok) throw new Error(`export failed: ${JSON.stringify(r.error)}`)
  return r.data.yaml
}

describe('[FR-DOA-001/AC2] a version is imported from YAML and exported in the same shape; export then import gives the same data', () => {
  it('round trip through the services: import, export, import again under a new number, export again', async () => {
    const original = version2(2)
    const first = await imported(original)
    const text = await exported(first)
    expect(text).toContain('code: DOA-DEMO')
    expect(text).toContain('effectiveFrom: 2026-11-01T00:00:00+07:00')
    expect(text).toContain('lte: "30000.00"')
    const again = await imported(text.replace('version: 2', 'version: 3'))
    const text2 = await exported(again)
    expect(text2).toBe(text.replace('version: 2', 'version: 3'))
    // The exported data is the imported data: rules in order, policy, effective time
    const a = parseDoaYaml(original, noMembers)
    const b = parseDoaYaml(text, noMembers)
    expect(b).toEqual(a)
  })

  it('exports the version in effect as the fixture it was built from, with its file name', async () => {
    const v1 = await prisma.doaVersion.findFirstOrThrow({ where: { organizationId: org.organizationId, versionNo: 1 } })
    const r = await exportDoaVersionYaml(admin(), v1.id)
    expect(r).toMatchObject({ ok: true, data: { fileName: 'DOA-DEMO-v1.yaml' } })
    if (!r.ok) return
    const parsed = parseDoaYaml(r.data.yaml, noMembers)
    if (!parsed.ok) throw new Error('the export does not parse')
    const golden = versionSnapshots()[0]!
    expect(parsed.data[0]!.rules).toEqual(golden.rules)
    expect(parsed.data[0]).toMatchObject({ code: 'DOA-DEMO', versionNo: 1, effectiveFrom: golden.effectiveFrom, stepUpThresholdSatang: 10_000_000n })
  })

  it('a rule naming a person is exported with the member code and read back to the same member', async () => {
    const yaml = version2(4, (t) => t.replace('approver: { kind: POSITION_OF_ORG, position: COO }', 'approver: { kind: MEMBER, member: coo }'))
    const id = await imported(yaml)
    const text = await exported(id)
    expect(text).toContain('member: coo')
    const rule = await prisma.doaRule.findFirstOrThrow({ where: { doaVersionId: id, code: 'PO-01' } })
    expect(rule.steps).toMatchObject([{ approver: { kind: 'MEMBER', memberId: org.member.coo } }])
  })

  it('only an organization admin exports; an unknown version is not found', async () => {
    const v1 = await prisma.doaVersion.findFirstOrThrow({ where: { organizationId: org.organizationId, versionNo: 1 } })
    expect(await exportDoaVersionYaml(org.ctxOf('dm_it', NOW), v1.id)).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    expect(await exportDoaVersionYaml(admin(), randomUUID())).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } })
    expect(await exportDoaVersionYaml(admin(), 'not-an-id')).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } })
  })

  it('a file with problems imports nothing and says where each problem is and what kind it is', async () => {
    const before = await prisma.doaVersion.count({ where: { organizationId: org.organizationId } })
    const r = await importDoaDraft(admin(), { yaml: version2(5, (t) => t.replace('lte: "30000.00"', 'lte: "30000"').replace('collapseDuplicateApprovers: true', 'collapseDuplicateApprovers: true\n    extra: 1')), changeReason: 'ทดสอบ' }, key())
    expect(r).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED' } })
    const problems = r.ok ? [] : (r.error.details!.problems as Array<{ path: string; issue: string; keys?: string[] }>)
    expect(problems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'versions.0.rules.0.when.amount.lte', issue: 'invalid_format' }),
        expect.objectContaining({ path: 'versions.0', issue: 'unrecognized_keys', keys: ['extra'] }),
      ]),
    )
    expect(await importDoaDraft(admin(), { yaml: 'versions: [', changeReason: 'ทดสอบ' }, key())).toMatchObject({ ok: false, error: { details: { problems: [{ issue: 'NOT_YAML' }] } } })
    expect(await prisma.doaVersion.count({ where: { organizationId: org.organizationId } })).toBe(before)
  })
})

describe('[FR-DOA-001/AC3] every version shows with its period, reason, people and diff; a published version never changes', () => {
  let v2: string
  it('a published version keeps its period, the approver and the diff with the version before', async () => {
    v2 = await imported(version2(20), 'ขยายวงเงิน DM เป็น 30,000 บาท')
    expect(await submitDoaVersion(admin(), { versionId: v2 }, key())).toMatchObject({ ok: true, data: { assigneeMemberId: org.member.ceo } })
    const task = await prisma.approvalTask.findFirstOrThrow({ where: { status: 'OPEN', step: { route: { subjectId: v2 } } } })
    await grantStepUp({ organizationId: org.organizationId, memberId: org.member.ceo!, subjectType: 'DOA_VERSION', subjectId: v2, code: totp(CEO_SECRET) }, new Date())
    expect(await decideTask(org.ctxOf('ceo', NOW), { taskId: task.id, decision: 'APPROVE' }, key())).toMatchObject({ ok: true, data: { documentStatus: 'PUBLISHED' } })

    const overview = await getDoaOverviewForAdmin(admin())
    if (!overview.ok) throw new Error('overview failed')
    expect(overview.data.initial).toBe(false)
    const v1 = overview.data.versions.find((v) => v.versionNo === 1)!
    const v20 = overview.data.versions.find((v) => v.id === v2)!
    // Version 1 is in effect until version 20 starts on 1 Nov (Thai time); version 20 waits for its start
    expect(v1).toMatchObject({ status: 'PUBLISHED', inEffect: true, effectiveFrom: '2026-09-30T17:00:00.000Z', effectiveTo: '2026-10-31T17:00:00.000Z', changeReason: null })
    expect(v20).toMatchObject({
      status: 'PUBLISHED',
      inEffect: false,
      upcoming: true,
      effectiveFrom: '2026-10-31T17:00:00.000Z',
      effectiveTo: null,
      changeReason: 'ขยายวงเงิน DM เป็น 30,000 บาท',
      submittedBy: { id: org.member.admin },
      approvedBy: { id: org.member.ceo },
      rules: 8,
    })
    // Every version of the code is listed, newest edition first
    expect(overview.data.versions.map((v) => v.versionNo)).toEqual([...overview.data.versions.map((v) => v.versionNo)].sort((a, b) => b - a))

    const detail = await getDoaVersionForAdmin(admin(), v2)
    if (!detail.ok) throw new Error('detail failed')
    expect(detail.data).toMatchObject({
      importedBy: { id: org.member.admin },
      previous: { versionNo: 1 },
      diff: {
        policy: [],
        added: [],
        removed: [],
        changed: [
          { code: 'PR-01', fields: ['band'] },
          { code: 'PR-02', fields: ['band'] },
        ],
      },
      route: { ruleCode: 'DOA-CHG-01', doaCode: 'DOA-DEMO', versionNo: 1, tasks: [{ status: 'APPROVED', decidedBy: { id: org.member.ceo } }] },
      submit: null,
    })
    expect(detail.data.rules.find((r) => r.code === 'PR-01')).toMatchObject({ band: { gt: '0', lte: '3000000' }, steps: [{ approver: { kind: 'POSITION_OF_DEPARTMENT', position: 'DM' }, slaMinutes: 480 }] })
    expect(detail.data.previous!.rules.find((r) => r.code === 'PR-01')).toMatchObject({ band: { gt: '0', lte: '2000000' } })
    expect(detail.data.boundaries.find((b) => b.documentType === 'PURCHASE_REQUEST')!.rows).toEqual([
      { amount: '3000000', ruleCode: 'PR-01' },
      { amount: '3000001', ruleCode: 'PR-02' },
      { amount: '10000000', ruleCode: 'PR-02' },
      { amount: '10000001', ruleCode: 'PR-03' },
    ])
  })

  it('a published version cannot be changed: the same edition cannot be imported again or sent again, and its page has no send', async () => {
    const rulesBefore = await prisma.doaRule.findMany({ where: { doaVersionId: v2 }, orderBy: { id: 'asc' } })
    expect(await importDoaDraft(admin(), { yaml: version2(20, (t) => t.replace('lte: "30000.00"', 'lte: "35000.00"')), changeReason: 'แก้ฉบับเดิม' }, key())).toMatchObject({
      ok: false,
      error: { code: 'VALIDATION_FAILED', details: { reason: 'VERSION_EXISTS', doaCode: 'DOA-DEMO', versionNo: 20 } },
    })
    expect(await submitDoaVersion(admin(), { versionId: v2 }, key())).toMatchObject({ ok: false, error: { code: 'INVALID_STATE_TRANSITION' } })
    const v1 = await prisma.doaVersion.findFirstOrThrow({ where: { organizationId: org.organizationId, versionNo: 1 } })
    expect(await submitDoaVersion(admin(), { versionId: v1.id }, key())).toMatchObject({ ok: false, error: { code: 'INVALID_STATE_TRANSITION' } })
    expect(await prisma.doaRule.findMany({ where: { doaVersionId: v2 }, orderBy: { id: 'asc' } })).toEqual(rulesBefore)
    const detail = await getDoaVersionForAdmin(admin(), v1.id)
    expect(detail).toMatchObject({ ok: true, data: { submit: null, previous: null, diff: null, version: { versionNo: 1, inEffect: true } } })
  })

  it('only an organization admin reads the versions', async () => {
    expect(await getDoaOverviewForAdmin(org.ctxOf('dm_it', NOW))).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    expect(await getDoaVersionForAdmin(org.ctxOf('dm_it', NOW), v2)).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    expect(await getDoaVersionForAdmin(admin(), randomUUID())).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } })
  })
})

describe('[FR-DOA-002/AC1] a draft shows the lint before it is sent: errors by code and band, warnings to tick one by one', () => {
  it('a gap is an error with its band; the draft cannot be sent', async () => {
    const id = await imported(version2(30, (t) => inDecember(t).replace('when: { amount: { gt: "30000.00", lte: "100000.00" } }', 'when: { amount: { gt: "40000.00", lte: "100000.00" } }')))
    const detail = await getDoaVersionForAdmin(admin(), id)
    expect(detail).toMatchObject({
      ok: true,
      data: {
        submit: { mode: 'NORMAL', allowed: true, effectiveInPast: false, laterVersionScheduled: null, errors: [{ code: 'DOA_LINT_GAP', documentType: 'PURCHASE_REQUEST', gt: '3000000', lte: '4000000' }], warnings: [] },
      },
    })
    expect(await submitDoaVersion(admin(), { versionId: id }, key())).toMatchObject({ ok: false, error: { code: 'DOA_LINT_FAILED' } })
  })

  it('a vacant position is a warning by its key, with who approves and the tasks that stay on the version in effect', async () => {
    const draft = await createDraft(org.ctxOf('req_con', NOW), { requestTypeCode: 'BUY_GOODS', title: 'ไม้แบบ', priceIncludesVat: true, lines: [{ description: 'ไม้แบบ', quantity: '1', uom: 'ชุด', unitPrice: '25000.00' }] }, key())
    if (!draft.ok) throw new Error('draft failed')
    await submitRequest(org.ctxOf('req_con', NOW), { requestId: draft.data.requestId }, key())
    const id = await imported(version2(31, (t) => inDecember(t).replace('approver: { kind: POSITION_OF_ORG, position: COO }', 'approver: { kind: POSITION_OF_ORG, position: CFO }')))
    const detail = await getDoaVersionForAdmin(admin(), id)
    if (!detail.ok || detail.data.submit?.mode !== 'NORMAL') throw new Error('expected a normal draft')
    expect(detail.data.submit).toMatchObject({
      errors: [],
      warnings: ['DOA_LINT_VACANT_POSITION:PO-01'],
      approver: { doaCode: 'DOA-DEMO', versionNo: 1, ruleCode: 'DOA-CHG-01', approvers: [{ id: org.member.ceo }] },
      current: { code: 'DOA-DEMO', versionNo: 1 },
    })
    expect(detail.data.submit.openTasksUnderCurrent).toBeGreaterThanOrEqual(1)
    // The service asks for the same key the page shows
    expect(await submitDoaVersion(admin(), { versionId: id }, key())).toMatchObject({ ok: false, error: { details: { reason: 'WARNINGS_NOT_ACKNOWLEDGED', warnings: detail.data.submit.warnings } } })
    expect(await submitDoaVersion(admin(), { versionId: id, acknowledgedWarnings: [...detail.data.submit.warnings] }, key())).toMatchObject({ ok: true })
  })

  it('a draft starting with or before a version approved for later says which one must be withdrawn first', async () => {
    const id = await imported(version2(33))
    expect(await getDoaVersionForAdmin(admin(), id)).toMatchObject({ ok: true, data: { submit: { mode: 'NORMAL', laterVersionScheduled: 20 } } })
    expect(await submitDoaVersion(admin(), { versionId: id }, key())).toMatchObject({ ok: false, error: { details: { reason: 'LATER_VERSION_SCHEDULED', versionNo: 20 } } })
  })

  it('a draft whose effective time has passed says so before sending', async () => {
    const id = await imported(version2(32, (t) => t.replace('"2026-11-01T00:00:00+07:00"', '"2026-10-02T00:00:00+07:00"')))
    expect(await getDoaVersionForAdmin(admin(), id)).toMatchObject({ ok: true, data: { submit: { mode: 'NORMAL', effectiveInPast: true } } })
  })
})

describe('[FR-DOA-002/AC3] with no DOA yet, a draft offers the initial package for the contract signatory', () => {
  it('lists the positions the version names, their current holders and the signatory; the signatory cannot send it', async () => {
    const fresh = await createDoaOrg({ doa: false })
    for (const code of ['admin', 'ceo']) await prisma.roleAssignment.create({ data: { organizationId: fresh.organizationId, memberId: fresh.member[code]!, role: 'ORG_ADMIN', grantedAt: NOW } })
    const draft = await importDoaDraft(fresh.ctxOf('admin', NOW), { yaml: version2(1), changeReason: 'ฉบับแรกขององค์กร' }, key())
    if (!draft.ok) throw new Error(JSON.stringify(draft.error))
    const id = draft.data.versionIds[0]!
    expect(await getDoaOverviewForAdmin(fresh.ctxOf('admin', NOW))).toMatchObject({ ok: true, data: { initial: true } })

    const before = await getDoaVersionForAdmin(fresh.ctxOf('admin', NOW), id)
    if (!before.ok || before.data.submit?.mode !== 'INITIAL') throw new Error('expected the initial package')
    expect(before.data.submit.signatory).toBeNull()
    expect(before.data.submit.positions.map((p) => p.code).sort()).toEqual(['CEO', 'COO', 'DM', 'VP'])
    // Every current holder of a named position is offered (PROC_MGR is not named)
    expect(before.data.submit.holders).toHaveLength(8)
    expect(before.data.submit.holders.some((h) => h.positionCode === 'PROC_MGR')).toBe(false)
    expect(before.data.submit.departments.find((d) => d.root)).toMatchObject({ code: 'HQ', depth: 0 })

    await prisma.organization.update({ where: { id: fresh.organizationId }, data: { contractSignatoryMemberId: fresh.member.ceo!, contractSignatoryVerifiedAt: NOW } })
    expect(await getDoaVersionForAdmin(fresh.ctxOf('admin', NOW), id)).toMatchObject({ ok: true, data: { submit: { mode: 'INITIAL', signatory: { id: fresh.member.ceo }, submitterIsSignatory: false } } })
    expect(await getDoaVersionForAdmin(fresh.ctxOf('ceo', NOW), id)).toMatchObject({ ok: true, data: { submit: { mode: 'INITIAL', submitterIsSignatory: true } } })
  })
})

describe('[FR-DOA-001/AC2] a version the YAML shape cannot hold is refused by the export, never written half', () => {
  it('a rule with two approver steps is named in the refusal; the page answers it with its own status, not as forbidden', async () => {
    const version = await prisma.doaVersion.create({
      data: {
        organizationId: org.organizationId,
        code: 'DOA-STEPS',
        versionNo: 1,
        status: 'DRAFT',
        effectiveFrom: new Date('2027-01-01T00:00:00+07:00'),
        amountBasis: 'GROSS',
        selfApprovalPolicy: 'ESCALATE_NEXT_BAND',
        collapseDuplicateApprovers: true,
        sodPolicy: { approverMayReceive: false, requesterMayReceive: true },
      },
    })
    const step = (position: string) => ({ approver: { kind: 'POSITION_OF_ORG', position }, slaBusinessMinutes: 480, mode: 'SEQUENTIAL' })
    await prisma.doaRule.create({ data: { organizationId: org.organizationId, doaVersionId: version.id, code: 'PO-09', documentType: 'PURCHASE_ORDER', priority: 100, when: {}, steps: [step('COO'), step('CEO')] } })
    expect(await exportDoaVersionYaml(admin(), version.id)).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED', details: { reason: 'MULTI_STEP_RULE', rule: 'PO-09' } } })
    expect(HTTP_STATUS.VALIDATION_FAILED).toBe(400)
    expect(HTTP_STATUS.INTERNAL).toBe(500)
  })
})

