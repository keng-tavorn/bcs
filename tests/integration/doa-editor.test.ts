import { randomUUID } from 'node:crypto'
import { beforeAll, describe, expect, it } from 'vitest'
import { amountToSatang } from '@/core/money/dto'
import { totp } from '@/lib/totp'
import { enableTotpWithSecret, upsertUserWithPassword } from '@/server/auth/provision'
import { grantStepUp } from '@/server/auth/step-up'
import { makeCtx } from '@/server/context'
import { prisma } from '@/server/db/client'
import { decideTask } from '@/server/services/approvals/decide'
import { submitDoaVersion } from '@/server/services/doa'
import { draftDoaCopy, getDoaEditor, type DoaEditorView, type DraftCopyInput } from '@/server/services/doa/editor'
import { getDoaOverviewForAdmin, getDoaVersionForAdmin } from '@/server/services/doa/view'
import { loadYaml } from '../golden/doa-fixtures'
import { createDoaOrg, type DoaOrg } from '../support/doa-org'

// S3-09 · the DOA editor and what a draft shows before it is sent, through the services the pages call: the editor
// starts from a copy of the latest version and saves the edited table as the next draft without touching the source
// (FR-DOA-001 AC1), recorded as drafted from that version; a draft is compared with the version in effect — bands,
// policies, and the positions that gain or lose authority (FR-DOA-009 AC1); the boundary table of both versions, which
// matches GC-DOA-22 for version 1, ticked by the drafter before sending and by the approver before approving, each tick
// on its event (FR-DOA-009 AC3; the approver's side in full in doa-editor-approve.test.ts). Real Postgres; the org is
// the §7.4 fixture (createDoaOrg).

const NOW = new Date('2026-10-05T03:00:00Z')
const key = () => ({ idempotencyKey: randomUUID(), sender: null })
const CEO_SECRET = 'K'.repeat(32)
const baht = (text: string) => amountToSatang(text).toString()

let org: DoaOrg
let v1: string
beforeAll(async () => {
  org = await createDoaOrg()
  await prisma.roleAssignment.create({ data: { organizationId: org.organizationId, memberId: org.member.admin!, role: 'ORG_ADMIN', grantedAt: NOW } })
  const ceo = await prisma.member.findUniqueOrThrow({ where: { id: org.member.ceo! } })
  const userId = await upsertUserWithPassword({ email: ceo.email, name: ceo.displayNameTh, password: 'ceo-password-123456' })
  await enableTotpWithSecret(userId, CEO_SECRET, [])
  await prisma.member.update({ where: { id: ceo.id }, data: { userId } })
  v1 = (await prisma.doaVersion.findFirstOrThrow({ where: { organizationId: org.organizationId, versionNo: 1 } })).id
})

const admin = () => org.ctxOf('admin', NOW)

async function editor(versionId: string): Promise<DoaEditorView> {
  const r = await getDoaEditor(admin(), versionId)
  if (!r.ok) throw new Error(`editor failed: ${JSON.stringify(r.error)}`)
  return r.data
}

/** What the page sends: the editor's table as it was loaded, after `edit` */
function inputOf(view: DoaEditorView, edit: (input: DraftCopyInput) => void = () => undefined): DraftCopyInput {
  const input: DraftCopyInput = {
    sourceVersionId: view.source.id,
    effectiveDate: view.defaultEffectiveDate,
    changeReason: 'ขยายวงเงิน DM เป็น 30,000 บาท',
    policy: { ...view.policy },
    rules: view.rules.map((r) => ({ code: r.code, documentType: r.documentType, band: r.band ? { ...r.band } : null, steps: r.steps.map((s) => ({ approver: { ...s.approver }, slaMinutes: s.slaMinutes })) })),
  }
  edit(input)
  return input
}

const rule = (input: DraftCopyInput, code: string) => input.rules.find((r) => r.code === code)!
/** The demo's change: the DM band ends at 30,000 and the VP band starts there */
const dmTo30k = (input: DraftCopyInput) => {
  rule(input, 'PR-01').band!.upper = baht('30000.00')
  rule(input, 'PR-02').band!.lower = baht('30000.00')
}

describe('[FR-DOA-001/AC1] a draft starts from a copy of the latest version and is edited as a table', () => {
  it('the versions page offers the latest published version as the start, and the editor holds it whole', async () => {
    const overview = await getDoaOverviewForAdmin(admin())
    if (!overview.ok) throw new Error('overview failed')
    expect(overview.data.copySources.map((s) => ({ id: s.id, inEffect: s.inEffect }))).toEqual([{ id: v1, inEffect: true }])

    const view = await editor(v1)
    expect(view.source).toMatchObject({ id: v1, code: 'DOA-DEMO', versionNo: 1, status: 'PUBLISHED' })
    expect(view.nextVersionNo).toBe(2)
    // The first day of next month, and never before tomorrow (Thai calendar)
    expect(view.defaultEffectiveDate).toBe('2026-11-01')
    expect(view.minEffectiveDate).toBe('2026-10-06')
    expect(view.policy).toEqual({ amountBasis: 'GROSS', selfApprovalPolicy: 'ESCALATE_NEXT_BAND', collapseDuplicateApprovers: true, stepUpThreshold: baht('100000.00'), approverMayReceive: false, requesterMayReceive: true })
    expect(view.rules.map((r) => r.code)).toEqual(['PR-01', 'PR-02', 'PR-03', 'PO-01', 'PO-02', 'GRV-01', 'DOA-CHG-01', 'ORG-CHG-01'])
    expect(view.rules[0]).toEqual({ code: 'PR-01', documentType: 'PURCHASE_REQUEST', band: { lowerKind: 'gt', lower: '0', upper: baht('20000.00') }, steps: [{ approver: { kind: 'POSITION_OF_DEPARTMENT', position: 'DM' }, slaMinutes: 480 }] })
    expect(view.rules.find((r) => r.code === 'GRV-01')!.band).toBeNull()
    // The dropdown of approvers: every position of the organization, with its scope
    expect(view.positions.map((p) => [p.code, p.scope]).sort()).toEqual([
      ['CEO', 'ORG'],
      ['COO', 'ORG'],
      ['DM', 'DEPARTMENT'],
      ['PROC_MGR', 'ORG'],
      ['VP', 'DEPARTMENT'],
    ])
  })

  it('saving the table creates the next draft with the edited bands, approver, time and policies; the source never changes', async () => {
    const before = await prisma.doaRule.findMany({ where: { doaVersionId: v1 }, orderBy: { id: 'asc' } })
    const sourceRow = await prisma.doaVersion.findUniqueOrThrow({ where: { id: v1 } })
    const view = await editor(v1)
    const input = inputOf(view, (i) => {
      dmTo30k(i)
      rule(i, 'PR-03').steps[0]!.slaMinutes = 24 * 60
      rule(i, 'PO-01').steps[0]!.approver = { kind: 'POSITION_OF_ORG', position: 'CEO' }
      i.policy.stepUpThreshold = baht('50000.00')
      i.policy.approverMayReceive = true
    })
    const saved = await draftDoaCopy(admin(), input, key())
    expect(saved).toMatchObject({ ok: true, data: { code: 'DOA-DEMO', versionNo: 2 } })
    if (!saved.ok) return
    const draft = await prisma.doaVersion.findUniqueOrThrow({ where: { id: saved.data.versionId }, include: { rules: { orderBy: { id: 'asc' } } } })
    expect(draft).toMatchObject({
      status: 'DRAFT',
      code: 'DOA-DEMO',
      versionNo: 2,
      effectiveFrom: new Date('2026-10-31T17:00:00Z'),
      amountBasis: 'GROSS',
      stepUpThresholdSatang: 5_000_000n,
      sodPolicy: { approverMayReceive: true, requesterMayReceive: true },
      escalationPolicy: sourceRow.escalationPolicy,
      changeReason: 'ขยายวงเงิน DM เป็น 30,000 บาท',
      diffSummary: { fromVersionId: v1, fromVersionNo: 1 },
    })
    expect(draft.rules.map((r) => r.code)).toEqual(['PR-01', 'PR-02', 'PR-03', 'PO-01', 'PO-02', 'GRV-01', 'DOA-CHG-01', 'ORG-CHG-01'])
    expect(draft.rules.find((r) => r.code === 'PR-01')).toMatchObject({ priority: 100, when: { amount: { gt: '0', lte: baht('30000.00') } } })
    expect(draft.rules.find((r) => r.code === 'PR-02')).toMatchObject({ when: { amount: { gt: baht('30000.00'), lte: baht('100000.00') } } })
    expect(draft.rules.find((r) => r.code === 'PR-03')!.steps).toEqual([{ approver: { kind: 'POSITION_OF_ORG', position: 'CEO' }, slaBusinessMinutes: 1440, mode: 'SEQUENTIAL' }])
    // Drafting is an event of the new version, by the admin, as a copy of version 1
    const events = await prisma.event.findMany({ where: { organizationId: org.organizationId, aggregateId: draft.id } })
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ type: 'doa_version.drafted', actorMemberId: org.member.admin, data: { code: 'DOA-DEMO', versionNo: 2, via: 'COPY', rules: 8, fromVersionId: v1, fromVersionNo: 1 } })
    // Version 1 keeps its rules and policies (FR-DOA-007 AC3)
    expect(await prisma.doaRule.findMany({ where: { doaVersionId: v1 }, orderBy: { id: 'asc' } })).toEqual(before)
    expect(await prisma.doaVersion.findUniqueOrThrow({ where: { id: v1 } })).toEqual(sourceRow)
  })

  it('a member without admin.doa.draft, and the BCS team, can neither open the editor nor save a draft (NG-12)', async () => {
    const count = await prisma.doaVersion.count({ where: { organizationId: org.organizationId } })
    const view = await editor(v1)
    expect(await getDoaEditor(org.ctxOf('dm_it', NOW), v1)).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    expect(await draftDoaCopy(org.ctxOf('dm_it', NOW), inputOf(view), key())).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    const platform = makeCtx({ organizationId: org.organizationId, actor: { type: 'PLATFORM_ADMIN', platformAdminId: randomUUID() }, channel: 'WEB', now: NOW })
    expect(await getDoaEditor(platform, v1)).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    expect(await draftDoaCopy(platform, inputOf(view), key())).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    expect(await prisma.doaVersion.count({ where: { organizationId: org.organizationId } })).toBe(count)
    expect(await getDoaEditor(admin(), randomUUID())).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } })
  })

  it('a table that could never be sent is not saved: gaps, wrong bands, unknown approvers, duplicate codes and past dates', async () => {
    const count = await prisma.doaVersion.count({ where: { organizationId: org.organizationId } })
    const view = await editor(v1)
    const refused = async (edit: (i: DraftCopyInput) => void) => draftDoaCopy(admin(), inputOf(view, edit), key())
    // A gap between two bands: the lint's error with its band (BR-DOA-08)
    expect(
      await refused((i) => {
        rule(i, 'PR-01').band!.upper = baht('30000.00')
        rule(i, 'PR-02').band!.lower = baht('40000.00')
      }),
    ).toMatchObject({ ok: false, error: { code: 'DOA_LINT_FAILED', details: { errors: [{ code: 'DOA_LINT_GAP', documentType: 'PURCHASE_REQUEST', gt: baht('30000.00'), lte: baht('40000.00') }] } } })
    expect(await refused((i) => (rule(i, 'PR-02').band!.upper = baht('20000.00')))).toMatchObject({ ok: false, error: { details: { reason: 'BAND_ORDER', field: 'rules.1.band', rule: 'PR-02' } } })
    expect(await refused((i) => (rule(i, 'DOA-CHG-01').band = { lowerKind: 'gt', lower: '0', upper: null }))).toMatchObject({ ok: false, error: { details: { reason: 'BAND_NOT_ALLOWED', field: 'rules.6.band' } } })
    expect(await refused((i) => (rule(i, 'PO-01').steps[0]!.approver = { kind: 'POSITION_OF_ORG', position: 'CFO' }))).toMatchObject({ ok: false, error: { details: { reason: 'POSITION', field: 'rules.3.steps.0.approver' } } })
    expect(await refused((i) => (rule(i, 'PO-01').steps[0]!.approver = { kind: 'MEMBER', memberId: randomUUID() }))).toMatchObject({ ok: false, error: { details: { reason: 'MEMBER', field: 'rules.3.steps.0.approver' } } })
    expect(await refused((i) => (i.rules[1]!.code = 'PR-01'))).toMatchObject({ ok: false, error: { details: { reason: 'DUPLICATE_RULE', field: 'rules.1.code' } } })
    expect(await refused((i) => i.rules.splice(6, 1))).toMatchObject({ ok: false, error: { code: 'DOA_LINT_FAILED', details: { errors: [{ code: 'DOA_LINT_MISSING_DOCTYPE', documentType: 'DOA_CHANGE' }] } } })
    // BR-DOA-12: today has started already; a date that does not exist is not a date
    expect(await refused((i) => (i.effectiveDate = '2026-10-05'))).toMatchObject({ ok: false, error: { details: { reason: 'EFFECTIVE_IN_PAST', field: 'effectiveDate' } } })
    expect(await refused((i) => (i.effectiveDate = '2026-02-30'))).toMatchObject({ ok: false, error: { details: { reason: 'DATE', field: 'effectiveDate' } } })
    // The shape is checked before anything is read
    expect(await refused((i) => (rule(i, 'PR-01').band!.upper = '30000.00'))).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED', details: { field: 'rules.0.band.upper' } } })
    expect(await refused((i) => (rule(i, 'PR-01').steps[0]!.slaMinutes = 0))).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED', details: { field: 'rules.0.steps.0.slaMinutes' } } })
    expect(await prisma.doaVersion.count({ where: { organizationId: org.organizationId } })).toBe(count)
  })

  it('a new rule takes the rank of its document type; a removed rule is gone from the draft only', async () => {
    const view = await editor(v1)
    const saved = await draftDoaCopy(
      admin(),
      inputOf(view, (i) => {
        // Split the VP band at 50,000: PR-02 up to 50,000, a new PR-04 above it up to 100,000 for the COO
        rule(i, 'PR-02').band!.upper = baht('50000.00')
        i.rules.splice(2, 0, { code: 'PR-04', documentType: 'PURCHASE_REQUEST', band: { lowerKind: 'gt', lower: baht('50000.00'), upper: baht('100000.00') }, steps: [{ approver: { kind: 'POSITION_OF_ORG', position: 'COO' }, slaMinutes: 480 }] })
        // GRV-01 is replaced by a banded pair
        i.rules.splice(
          i.rules.findIndex((r) => r.code === 'GRV-01'),
          1,
          { code: 'GRV-02', documentType: 'GR_VARIANCE', band: { lowerKind: 'gt', lower: '0', upper: baht('5000.00') }, steps: [{ approver: { kind: 'POSITION_OF_DEPARTMENT', position: 'DM' }, slaMinutes: 480 }] },
          { code: 'GRV-03', documentType: 'GR_VARIANCE', band: { lowerKind: 'gt', lower: baht('5000.00'), upper: null }, steps: [{ approver: { kind: 'POSITION_OF_DEPARTMENT', position: 'VP' }, slaMinutes: 480 }] },
        )
        i.effectiveDate = '2026-12-01'
      }),
      key(),
    )
    expect(saved).toMatchObject({ ok: true, data: { versionNo: 3 } })
    if (!saved.ok) return
    const rules = await prisma.doaRule.findMany({ where: { doaVersionId: saved.data.versionId }, orderBy: { id: 'asc' } })
    expect(rules.map((r) => [r.code, r.priority])).toEqual([
      ['PR-01', 100],
      ['PR-02', 100],
      ['PR-04', 100],
      ['PR-03', 100],
      ['PO-01', 100],
      ['PO-02', 100],
      ['GRV-02', 100],
      ['GRV-03', 100],
      ['DOA-CHG-01', 100],
      ['ORG-CHG-01', 100],
    ])
    const detail = await getDoaVersionForAdmin(admin(), saved.data.versionId)
    if (!detail.ok || !detail.data.compare) throw new Error('expected a comparison with the version in effect')
    expect(detail.data.compare.diff).toMatchObject({ added: ['PR-04', 'GRV-02', 'GRV-03'], removed: ['GRV-01'], changed: [{ code: 'PR-02', fields: ['band'] }] })
  })
})

describe('[FR-DOA-009/AC1] before it is sent, a draft is read beside the version in effect: bands, policies, authority', () => {
  it('names the bands and policies that changed and the positions that gain or lose authority', async () => {
    const view = await editor(v1)
    const saved = await draftDoaCopy(
      admin(),
      inputOf(view, (i) => {
        dmTo30k(i)
        i.policy.stepUpThreshold = baht('50000.00')
        i.effectiveDate = '2026-11-15'
      }),
      key(),
    )
    if (!saved.ok) throw new Error(JSON.stringify(saved.error))
    const detail = await getDoaVersionForAdmin(admin(), saved.data.versionId)
    if (!detail.ok) throw new Error('detail failed')
    const compare = detail.data.compare!
    expect(compare.baseline).toMatchObject({ id: v1, code: 'DOA-DEMO', versionNo: 1 })
    expect(compare.diff).toEqual({
      policy: [{ field: 'stepUpThreshold', before: baht('100000.00'), after: baht('50000.00') }],
      added: [],
      removed: [],
      changed: [
        { code: 'PR-01', fields: ['band'] },
        { code: 'PR-02', fields: ['band'] },
      ],
    })
    // The DM of the charged department gains requests above 20,000 up to 30,000; the VP loses them — nothing else moves
    expect(compare.authority).toEqual([
      { change: 'GAIN', approver: { kind: 'POSITION_OF_DEPARTMENT', position: 'DM', positionNameTh: 'DM', positionNameEn: null }, documentType: 'PURCHASE_REQUEST', band: { gt: baht('20000.00'), lte: baht('30000.00') } },
      { change: 'LOSE', approver: { kind: 'POSITION_OF_DEPARTMENT', position: 'VP', positionNameTh: 'VP', positionNameEn: null }, documentType: 'PURCHASE_REQUEST', band: { gt: baht('20000.00'), lte: baht('30000.00') } },
    ])
    // Version 1 itself, in effect, is history: no comparison, its diff is with the version before (none)
    expect(await getDoaVersionForAdmin(admin(), v1)).toMatchObject({ ok: true, data: { compare: null, previous: null } })
  })
})

describe('[FR-DOA-009/AC3] the boundary table of both versions, ticked by the drafter before sending and by the approver before approving', () => {
  it('[GC-DOA-22] version 1 has the boundary table of the golden case', async () => {
    const golden = loadYaml<{ cases: Array<{ id: string; expect: { rows: Array<{ amount: string; rule: string }> } }> }>('doa-lint.yaml').cases.find((c) => c.id === 'GC-DOA-22')!
    const expected = golden.expect.rows.map((r) => ({ amount: amountToSatang(r.amount).toString(), ruleCode: r.rule }))
    const detail = await getDoaVersionForAdmin(admin(), v1)
    if (!detail.ok) throw new Error('detail failed')
    expect(detail.data.boundaries.find((b) => b.documentType === 'PURCHASE_REQUEST')!.rows).toEqual(expected)
  })

  it('every band edge of either version, with the rule and approver of each, and which ones change', async () => {
    const view = await editor(v1)
    const saved = await draftDoaCopy(
      admin(),
      inputOf(view, (i) => {
        dmTo30k(i)
        i.effectiveDate = '2026-11-20'
      }),
      key(),
    )
    if (!saved.ok) throw new Error(JSON.stringify(saved.error))
    const detail = await getDoaVersionForAdmin(admin(), saved.data.versionId)
    if (!detail.ok || !detail.data.compare) throw new Error('expected a comparison')
    const pr = detail.data.compare.boundaries.find((b) => b.documentType === 'PURCHASE_REQUEST')!
    const at = (s: { ruleCode: string | null; approvers: ReadonlyArray<{ kind: string; position?: string }> } | null) => (s ? `${s.ruleCode} ${s.approvers.map((a) => a.position).join(',')}` : null)
    expect(pr.rows.map((r) => [r.amount, at(r.before), at(r.after), r.changed])).toEqual([
      [baht('20000.00'), 'PR-01 DM', 'PR-01 DM', false],
      [baht('20000.01'), 'PR-02 VP', 'PR-01 DM', true],
      [baht('30000.00'), 'PR-02 VP', 'PR-01 DM', true],
      [baht('30000.01'), 'PR-02 VP', 'PR-02 VP', false],
      [baht('100000.00'), 'PR-02 VP', 'PR-02 VP', false],
      [baht('100000.01'), 'PR-03 CEO', 'PR-03 CEO', false],
    ])
    const po = detail.data.compare.boundaries.find((b) => b.documentType === 'PURCHASE_ORDER')!
    expect(po.rows.map((r) => [r.amount, r.changed])).toEqual([
      [baht('1000000.00'), false],
      [baht('1000000.01'), false],
    ])
    // Types without amount bands have no table
    expect(detail.data.compare.boundaries.map((b) => b.documentType)).toEqual(['PURCHASE_REQUEST', 'PURCHASE_ORDER'])
  })

  it('a draft is not sent until the drafter ticks the boundary table; the approver then ticks it too and decides it with a step-up', async () => {
    const view = await editor(v1)
    const saved = await draftDoaCopy(admin(), inputOf(view, dmTo30k), key())
    if (!saved.ok) throw new Error(JSON.stringify(saved.error))
    const versionId = saved.data.versionId
    // The service asks for the tick itself (BR-AUTH-05): an unticked box and a send that leaves the tick out are refused
    for (const tick of [{ boundaryTableConfirmed: false }, {}]) {
      expect(await submitDoaVersion(admin(), { versionId, ...tick }, key())).toMatchObject({
        ok: false,
        error: { code: 'VALIDATION_FAILED', details: { reason: 'BOUNDARY_NOT_CONFIRMED', field: 'boundaryTableConfirmed' } },
      })
    }
    expect(await prisma.doaVersion.findUniqueOrThrow({ where: { id: versionId } })).toMatchObject({ status: 'DRAFT' })
    expect(await submitDoaVersion(admin(), { versionId, boundaryTableConfirmed: true }, key())).toMatchObject({ ok: true, data: { assigneeMemberId: org.member.ceo } })
    // The send records the drafter's tick
    const submitted = await prisma.event.findFirstOrThrow({ where: { organizationId: org.organizationId, aggregateId: versionId, type: 'doa_version.submitted' } })
    expect(submitted).toMatchObject({ actorMemberId: org.member.admin, data: { code: 'DOA-DEMO', versionNo: saved.data.versionNo, warningsAcknowledged: 0, boundaryTableConfirmed: true } })
    // Waiting for approval it is still read beside the version in effect
    expect(await getDoaVersionForAdmin(admin(), versionId)).toMatchObject({ ok: true, data: { version: { status: 'PENDING_APPROVAL' }, compare: { baseline: { id: v1 } }, submit: null } })

    // The CEO approves with a step-up and the tick: the draft is published for 1 November and version 1 stays in effect
    // until then; the decision records both
    const task = await prisma.approvalTask.findFirstOrThrow({ where: { status: 'OPEN', step: { route: { subjectId: versionId } } } })
    const grant = await grantStepUp({ organizationId: org.organizationId, memberId: org.member.ceo!, subjectType: 'DOA_VERSION', subjectId: versionId, code: totp(CEO_SECRET) }, new Date())
    if (!grant.ok) throw new Error(`step-up refused: ${grant.reason}`)
    expect(await decideTask(org.ctxOf('ceo', NOW), { taskId: task.id, decision: 'APPROVE' }, key())).toMatchObject({ ok: false, error: { details: { reason: 'BOUNDARY_NOT_CONFIRMED' } } })
    expect(await decideTask(org.ctxOf('ceo', NOW), { taskId: task.id, decision: 'APPROVE', boundaryTableConfirmed: true }, key())).toMatchObject({ ok: true, data: { documentStatus: 'PUBLISHED' } })
    const decided = await prisma.event.findFirstOrThrow({ where: { organizationId: org.organizationId, aggregateId: task.id, type: 'approval_task.decided' } })
    expect(decided).toMatchObject({ actorMemberId: org.member.ceo, data: { decision: 'APPROVE', subjectType: 'DOA_VERSION', subjectId: versionId, stepUpGrantId: grant.grantId, boundaryTableConfirmed: true } })

    // The editor now starts from the version approved for later, and its dates follow it (ADR-042 item 7)
    const overview = await getDoaOverviewForAdmin(admin())
    if (!overview.ok) throw new Error('overview failed')
    expect(overview.data.copySources.map((s) => s.id)).toEqual([versionId])
    const next = await editor(versionId)
    expect(next).toMatchObject({ defaultEffectiveDate: '2026-12-01', minEffectiveDate: '2026-11-02' })
    expect(await draftDoaCopy(admin(), inputOf(next, (i) => (i.effectiveDate = '2026-11-01')), key())).toMatchObject({
      ok: false,
      error: { code: 'VALIDATION_FAILED', details: { reason: 'LATER_VERSION_SCHEDULED', field: 'effectiveDate' } },
    })
  })
})
