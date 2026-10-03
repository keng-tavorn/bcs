import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type { ApproverSpec, DoaRuleSnapshot, DoaWhen } from '@/core/doa'
import { amountToSatang } from '@/core/money/dto'
import { totp } from '@/lib/totp'
import { enableTotpWithSecret, upsertUserWithPassword } from '@/server/auth/provision'
import { grantStepUp } from '@/server/auth/step-up'
import { prisma } from '@/server/db/client'
import { ruleJson } from '@/server/doa/snapshot'
import { decideTask } from '@/server/services/approvals/decide'
import { submitDoaVersion } from '@/server/services/doa'
import { draftDoaCopy, getDoaEditor, type DoaEditorView, type DraftCopyInput } from '@/server/services/doa/editor'
import { submitInitialPackage } from '@/server/services/doa/initial-package'
import { getDoaVersionForAdmin } from '@/server/services/doa/view'
import { loadYaml, versionSnapshots } from '../golden/doa-fixtures'
import { createDoaOrg, type DoaOrg } from '../support/doa-org'

// S3-09 · what a draft is compared with and when its boundary table must be ticked, through the services the pages call:
// the drafter ticks the boundary table whenever the version — beside the version it replaces — has one, and the send
// asks for that tick itself (FR-DOA-009 AC3, drafter side; BR-AUTH-05); a version whose bands have no upper end has no
// table and is sent without one, on a normal send and on the initial package; the version a draft is compared with is
// the one in effect just before it starts — one approved for later included (FR-DOA-009 AC1); a change of amount basis
// is said beside the comparison; a rule's description travels only with a rule whose band and steps did not change.
// Real Postgres; organizations of the §7.4 fixture (createDoaOrg), with versions stored as the seed stores them.

const NOW = new Date('2026-10-05T03:00:00Z')
const key = () => ({ idempotencyKey: randomUUID(), sender: null })
const baht = (text: string) => amountToSatang(text)
const CEO_SECRET = 'B'.repeat(32)

const DM: ApproverSpec = { kind: 'POSITION_OF_DEPARTMENT', position: 'DM' }
const VP: ApproverSpec = { kind: 'POSITION_OF_DEPARTMENT', position: 'VP' }
const COO: ApproverSpec = { kind: 'POSITION_OF_ORG', position: 'COO' }
const CEO: ApproverSpec = { kind: 'POSITION_OF_ORG', position: 'CEO' }
const rule = (code: string, documentType: DoaRuleSnapshot['documentType'], when: DoaWhen, approver: ApproverSpec, minutes = 480): DoaRuleSnapshot => ({
  code,
  documentType,
  priority: 100,
  when,
  steps: [{ approver, slaBusinessMinutes: minutes, mode: 'SEQUENTIAL' }],
})

/** A version whose bands have no upper end: every purchase request goes to the DM, every order to the COO */
const FLAT: DoaRuleSnapshot[] = [
  rule('PR-01', 'PURCHASE_REQUEST', { amount: { gt: 0n } }, DM),
  rule('PO-01', 'PURCHASE_ORDER', { amount: { gt: 0n } }, COO),
  rule('GRV-01', 'GR_VARIANCE', {}, DM),
  rule('DOA-CHG-01', 'DOA_CHANGE', {}, CEO, 960),
  rule('ORG-CHG-01', 'ORG_AUTHORITY_CHANGE', {}, CEO, 960),
]

/** A version stored as the seed stores one (local test data), with each rule's description when it has one */
async function storeVersion(org: DoaOrg, versionNo: number, status: 'PUBLISHED' | 'DRAFT', effectiveFrom: Date, rules: ReadonlyArray<DoaRuleSnapshot>): Promise<string> {
  const version = await prisma.doaVersion.create({
    data: {
      organizationId: org.organizationId,
      code: 'DOA-DEMO',
      versionNo,
      status,
      effectiveFrom,
      amountBasis: 'GROSS',
      selfApprovalPolicy: 'ESCALATE_NEXT_BAND',
      collapseDuplicateApprovers: true,
      stepUpThresholdSatang: 10_000_000n,
      escalationPolicy: { remindPct: 0.5, escalateAfterBusinessHours: 8 },
      sodPolicy: { approverMayReceive: false, requesterMayReceive: true },
      ...(status === 'PUBLISHED' ? { publishedAt: effectiveFrom } : {}),
    },
  })
  for (const r of rules) {
    const json = ruleJson(r)
    await prisma.doaRule.create({
      data: { organizationId: org.organizationId, doaVersionId: version.id, code: r.code, documentType: json.documentType, priority: r.priority, when: json.when, steps: json.steps, descriptionTh: r.descriptionTh ?? null },
    })
  }
  return version.id
}

async function withAdmin(org: DoaOrg) {
  await prisma.roleAssignment.create({ data: { organizationId: org.organizationId, memberId: org.member.admin!, role: 'ORG_ADMIN', grantedAt: NOW } })
}

async function editor(org: DoaOrg, versionId: string): Promise<DoaEditorView> {
  const r = await getDoaEditor(org.ctxOf('admin', NOW), versionId)
  if (!r.ok) throw new Error(`editor failed: ${JSON.stringify(r.error)}`)
  return r.data
}

/** What the editor page sends: the table as it was loaded, after `edit` */
function inputOf(view: DoaEditorView, edit: (input: DraftCopyInput) => void = () => undefined): DraftCopyInput {
  const input: DraftCopyInput = {
    sourceVersionId: view.source.id,
    effectiveDate: view.defaultEffectiveDate,
    changeReason: 'ปรับผู้อนุมัติ',
    policy: { ...view.policy },
    rules: view.rules.map((r) => ({ code: r.code, documentType: r.documentType, band: r.band ? { ...r.band } : null, steps: r.steps.map((s) => ({ approver: { ...s.approver }, slaMinutes: s.slaMinutes })) })),
  }
  edit(input)
  return input
}

async function saved(org: DoaOrg, input: DraftCopyInput): Promise<string> {
  const r = await draftDoaCopy(org.ctxOf('admin', NOW), input, key())
  if (!r.ok) throw new Error(`draft failed: ${JSON.stringify(r.error)}`)
  return r.data.versionId
}

const ruleOf = (input: DraftCopyInput, code: string) => input.rules.find((r) => r.code === code)!

describe('a version without a band edge has no boundary table, and is sent without a tick (FR-DOA-009 AC3, drafter side)', () => {
  it('a normal send: no table on either side, the authority change is still named, and the send goes through', async () => {
    const org = await createDoaOrg({ doa: false })
    await withAdmin(org)
    const v1 = await storeVersion(org, 1, 'PUBLISHED', new Date('2026-01-01T00:00:00+07:00'), FLAT)
    const draftId = await saved(org, inputOf(await editor(org, v1), (i) => (ruleOf(i, 'PR-01').steps[0]!.approver = VP)))

    const detail = await getDoaVersionForAdmin(org.ctxOf('admin', NOW), draftId)
    if (!detail.ok || !detail.data.compare) throw new Error('expected a comparison with version 1')
    expect(detail.data.compare.boundaries).toEqual([])
    expect(detail.data.ownBoundaries).toEqual([])
    expect(detail.data.boundaries).toEqual([])
    // Nothing to tick, but who gains and loses authority is said all the same (FR-DOA-009 AC1)
    expect(detail.data.compare.authority.map((c) => [c.change, c.approver.kind === 'MEMBER' ? c.approver.member.id : c.approver.position, c.documentType, c.band])).toEqual([
      ['GAIN', 'VP', 'PURCHASE_REQUEST', { gt: '0', lte: null }],
      ['LOSE', 'DM', 'PURCHASE_REQUEST', { gt: '0', lte: null }],
    ])
    expect(await submitDoaVersion(org.ctxOf('admin', NOW), { versionId: draftId }, key())).toMatchObject({ ok: true, data: { assigneeMemberId: org.member.ceo } })
  })

  it('the initial package: a first version with band edges is refused without the tick, one without edges goes', async () => {
    const org = await createDoaOrg({ doa: false })
    await withAdmin(org)
    await prisma.organization.update({ where: { id: org.organizationId }, data: { contractSignatoryMemberId: org.member.ceo!, contractSignatoryVerifiedAt: NOW } })
    const effective = new Date('2026-10-10T00:00:00+07:00')
    const fixture = loadYaml<{ positions: Array<{ position: string; department: string; member: string }> }>('fixtures/org-demo.yaml')
    const holders = (named: ReadonlySet<string>) =>
      fixture.positions.filter((p) => named.has(p.position)).map((p) => ({ positionCode: p.position, departmentId: org.department[p.department]!, memberId: org.member[p.member]! }))
    const send = (versionId: string, named: ReadonlySet<string>, tick: { boundaryTableConfirmed?: boolean } = {}) =>
      submitInitialPackage(org.ctxOf('admin', NOW), { versionId, holders: holders(named), reason: 'ชุดตั้งต้นตามสัญญา', ...tick }, key())

    // Version 1 of the fixture has the band edges of GC-DOA-22: its table must be ticked
    const banded = await storeVersion(org, 1, 'DRAFT', effective, versionSnapshots()[0]!.rules)
    const all = new Set(['DM', 'VP', 'COO', 'CEO'])
    expect(await send(banded, all)).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED', details: { reason: 'BOUNDARY_NOT_CONFIRMED', field: 'boundaryTableConfirmed' } } })
    expect(await prisma.doaVersion.findUniqueOrThrow({ where: { id: banded } })).toMatchObject({ status: 'DRAFT' })
    const detail = await getDoaVersionForAdmin(org.ctxOf('admin', NOW), banded)
    if (!detail.ok) throw new Error('detail failed')
    // Nothing to compare with: the table the drafter ticks is the version's own, with the approver at each edge
    expect(detail.data.compare).toBeNull()
    const pr = detail.data.ownBoundaries.find((t) => t.documentType === 'PURCHASE_REQUEST')!
    expect(pr.rows.map((r) => [r.amount, r.before, r.after.ruleCode, r.after.approvers.map((a) => (a.kind === 'MEMBER' ? a.member.id : a.position))])).toEqual([
      [baht('20000.00').toString(), null, 'PR-01', ['DM']],
      [baht('20000.01').toString(), null, 'PR-02', ['VP']],
      [baht('100000.00').toString(), null, 'PR-02', ['VP']],
      [baht('100000.01').toString(), null, 'PR-03', ['CEO']],
    ])

    // A first version without band edges has no table: it goes without a tick
    const flat = await storeVersion(org, 2, 'DRAFT', effective, FLAT)
    expect(await send(flat, new Set(['DM', 'COO', 'CEO']))).toMatchObject({ ok: true, data: { assigneeMemberId: org.member.ceo } })
  })
})

describe('[FR-DOA-009/AC1] a draft is compared with the version it replaces: the one in effect just before it starts', () => {
  it('with version 2 approved for 1 November, a draft for 1 December is read beside version 2, not version 1', async () => {
    const org = await createDoaOrg()
    await withAdmin(org)
    const ceo = await prisma.member.findUniqueOrThrow({ where: { id: org.member.ceo! } })
    const userId = await upsertUserWithPassword({ email: ceo.email, name: ceo.displayNameTh, password: 'ceo-password-123456' })
    await enableTotpWithSecret(userId, CEO_SECRET, [])
    await prisma.member.update({ where: { id: ceo.id }, data: { userId } })
    const v1 = (await prisma.doaVersion.findFirstOrThrow({ where: { organizationId: org.organizationId, versionNo: 1 } })).id

    // Version 2: the DM band up to 30,000 from 1 November, sent and approved with a step-up
    const v2 = await saved(
      org,
      inputOf(await editor(org, v1), (i) => {
        ruleOf(i, 'PR-01').band!.upper = baht('30000.00').toString()
        ruleOf(i, 'PR-02').band!.lower = baht('30000.00').toString()
      }),
    )
    expect(await submitDoaVersion(org.ctxOf('admin', NOW), { versionId: v2, boundaryTableConfirmed: true }, key())).toMatchObject({ ok: true })
    const task = await prisma.approvalTask.findFirstOrThrow({ where: { status: 'OPEN', step: { route: { subjectId: v2 } } } })
    await grantStepUp({ organizationId: org.organizationId, memberId: org.member.ceo!, subjectType: 'DOA_VERSION', subjectId: v2, code: totp(CEO_SECRET) }, new Date())
    expect(await decideTask(org.ctxOf('ceo', NOW), { taskId: task.id, decision: 'APPROVE' }, key())).toMatchObject({ ok: true, data: { documentStatus: 'PUBLISHED' } })

    // Version 3 from version 2 for 1 December: the COO's orders go to the CEO; nothing else changes
    const view = await editor(org, v2)
    expect(view.defaultEffectiveDate).toBe('2026-12-01')
    const v3 = await saved(org, inputOf(view, (i) => (ruleOf(i, 'PO-01').steps[0]!.approver = CEO)))
    const detail = await getDoaVersionForAdmin(org.ctxOf('admin', NOW), v3)
    if (!detail.ok || !detail.data.compare) throw new Error('expected a comparison')
    const compare = detail.data.compare
    expect(compare.baseline).toMatchObject({ id: v2, versionNo: 2, inEffectNow: false, effectiveFrom: '2026-10-31T17:00:00.000Z' })
    // Only what version 3 changes: version 2's own band move is not repeated as a change of version 3
    expect(compare.diff).toEqual({ policy: [], added: [], removed: [], changed: [{ code: 'PO-01', fields: ['approver'] }] })
    expect(compare.authority.map((c) => [c.change, c.approver.kind === 'MEMBER' ? c.approver.member.id : c.approver.position, c.documentType])).toEqual([
      ['GAIN', 'CEO', 'PURCHASE_ORDER'],
      ['LOSE', 'COO', 'PURCHASE_ORDER'],
    ])
    const pr = compare.boundaries.find((t) => t.documentType === 'PURCHASE_REQUEST')!
    expect(pr.rows.map((r) => [r.amount, r.before?.ruleCode, r.after.ruleCode, r.changed])).toEqual([
      [baht('30000.00').toString(), 'PR-01', 'PR-01', false],
      [baht('30000.01').toString(), 'PR-02', 'PR-02', false],
      [baht('100000.00').toString(), 'PR-02', 'PR-02', false],
      [baht('100000.01').toString(), 'PR-03', 'PR-03', false],
    ])
    expect(compare.basis).toBeNull()
    // The send asks for the tick of this table too
    expect(await submitDoaVersion(org.ctxOf('admin', NOW), { versionId: v3 }, key())).toMatchObject({ ok: false, error: { details: { reason: 'BOUNDARY_NOT_CONFIRMED' } } })
    expect(await submitDoaVersion(org.ctxOf('admin', NOW), { versionId: v3, boundaryTableConfirmed: true }, key())).toMatchObject({ ok: true })
    // Waiting for approval, it is still read beside version 2
    expect(await getDoaVersionForAdmin(org.ctxOf('admin', NOW), v3)).toMatchObject({ ok: true, data: { version: { status: 'PENDING_APPROVAL' }, compare: { baseline: { id: v2, inEffectNow: false } } } })
  })

  it('a draft that reads amounts on another basis says so beside the comparison', async () => {
    const org = await createDoaOrg()
    await withAdmin(org)
    const v1 = (await prisma.doaVersion.findFirstOrThrow({ where: { organizationId: org.organizationId, versionNo: 1 } })).id
    const draftId = await saved(org, inputOf(await editor(org, v1), (i) => (i.policy.amountBasis = 'NET')))
    const detail = await getDoaVersionForAdmin(org.ctxOf('admin', NOW), draftId)
    if (!detail.ok || !detail.data.compare) throw new Error('expected a comparison')
    expect(detail.data.compare.baseline).toMatchObject({ id: v1, inEffectNow: true })
    expect(detail.data.compare.basis).toEqual({ before: 'GROSS', after: 'NET' })
    expect(detail.data.compare.diff.policy).toEqual([{ field: 'amountBasis', before: 'GROSS', after: 'NET' }])
    // The same numbers name the same approvers, yet they are different documents: the screen says so (sections.tsx)
    expect(detail.data.compare.authority).toEqual([])
  })
})

describe('[FR-DOA-001/AC1] a rule keeps its description only while its band and steps stay as they were', () => {
  it('moving the DM band drops the descriptions that would contradict the new bands; the others travel with the copy', async () => {
    const org = await createDoaOrg({ doa: false })
    await withAdmin(org)
    const described: Record<string, string> = {
      'PR-01': 'ขอซื้อไม่เกิน 20,000 บาท → ผู้จัดการฝ่าย',
      'PR-02': 'ขอซื้อเกิน 20,000 ถึง 100,000 บาท → รองประธานสายงาน',
      'PR-03': 'ขอซื้อเกิน 100,000 บาท → ประธานเจ้าหน้าที่บริหาร',
      'PO-01': 'สั่งซื้อไม่เกิน 1,000,000 บาท → COO',
    }
    const v1 = await storeVersion(
      org,
      1,
      'PUBLISHED',
      new Date('2026-01-01T00:00:00+07:00'),
      versionSnapshots()[0]!.rules.map((r) => (described[r.code] ? { ...r, descriptionTh: described[r.code] } : r)),
    )
    const draftId = await saved(
      org,
      inputOf(await editor(org, v1), (i) => {
        ruleOf(i, 'PR-01').band!.upper = baht('30000.00').toString()
        ruleOf(i, 'PR-02').band!.lower = baht('30000.00').toString()
        ruleOf(i, 'PO-01').steps[0]!.slaMinutes = 960
      }),
    )
    const rules = await prisma.doaRule.findMany({ where: { doaVersionId: draftId }, orderBy: { id: 'asc' }, select: { code: true, descriptionTh: true } })
    expect(Object.fromEntries(rules.map((r) => [r.code, r.descriptionTh]))).toEqual({
      'PR-01': null,
      'PR-02': null,
      'PR-03': described['PR-03'],
      'PO-01': null,
      'PO-02': null,
      'GRV-01': null,
      'DOA-CHG-01': null,
      'ORG-CHG-01': null,
    })
    // The source keeps every description it had
    expect((await prisma.doaRule.findMany({ where: { doaVersionId: v1, descriptionTh: { not: null } } })).length).toBe(4)
  })
})

describe('[FR-DOA-001/AC1] an admin of another organization never reaches this one’s versions', () => {
  it('the editor and the copy answer NOT_FOUND for another organization’s version, and nothing is written', async () => {
    const mine = await createDoaOrg()
    const theirs = await createDoaOrg()
    await withAdmin(mine)
    await withAdmin(theirs)
    const theirV1 = (await prisma.doaVersion.findFirstOrThrow({ where: { organizationId: theirs.organizationId, versionNo: 1 } })).id
    const myV1 = (await prisma.doaVersion.findFirstOrThrow({ where: { organizationId: mine.organizationId, versionNo: 1 } })).id
    const before = await prisma.doaVersion.count({ where: { organizationId: { in: [mine.organizationId, theirs.organizationId] } } })

    expect(await getDoaEditor(mine.ctxOf('admin', NOW), theirV1)).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } })
    // The admin's own table, pointed at the other organization's version as its source
    const input = { ...inputOf(await editor(mine, myV1)), sourceVersionId: theirV1 }
    expect(await draftDoaCopy(mine.ctxOf('admin', NOW), input, key())).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } })
    expect(await getDoaVersionForAdmin(mine.ctxOf('admin', NOW), theirV1)).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } })
    expect(await prisma.doaVersion.count({ where: { organizationId: { in: [mine.organizationId, theirs.organizationId] } } })).toBe(before)
    expect(await prisma.event.count({ where: { organizationId: { in: [mine.organizationId, theirs.organizationId] }, type: 'doa_version.drafted' } })).toBe(0)
  })
})
