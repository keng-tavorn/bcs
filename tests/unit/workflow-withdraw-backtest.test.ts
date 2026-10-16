import { describe, expect, it } from 'vitest'
import type { CommitteeStepSpec, DoaVersionSnapshot, RouteInput } from '@/core/doa'
import { backtestPolicy, backtestWorkflow, summarizeBacktest, withdrawVersion, type BacktestRow } from '@/core/workflow'
import { orgSnapshot, versionSnapshots } from '../golden/doa-fixtures'
import { workflowFixture } from '../golden/workflow-fixtures'

// S6-07 · the edges of withdrawing a version and of the backtest that the golden cases GC-WF-39 to GC-WF-42 leave out
// (FR-DOA-103, FR-DOA-104, BR-WF-13): a version not found or not approved, a withdrawal with nothing after it, a
// committee and a refusal on either side of a backtest, and the workflow backtest with its reviewers.

const ORG = 'fixtures/org-s6.yaml'
const d = (iso: string) => new Date(iso)
const v = (versionNo: number, status: string, from: string, to: string | null) => ({ versionNo, status, effectiveFrom: d(from), effectiveTo: to ? d(to) : null })

describe('[FR-DOA-104/AC2] withdrawVersion: only an approved version that still waits', () => {
  const versions = [v(1, 'SUPERSEDED', '2026-01-01T00:00:00Z', '2026-10-01T00:00:00Z'), v(2, 'PUBLISHED', '2026-10-01T00:00:00Z', '2026-11-01T00:00:00Z'), v(3, 'PUBLISHED', '2026-11-01T00:00:00Z', null), v(4, 'DRAFT', '2026-12-01T00:00:00Z', null)]
  const at = d('2026-10-15T00:00:00Z')

  it('refuses a version that does not exist, one not approved, and one in effect', () => {
    expect(withdrawVersion(versions, 9, at)).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } })
    expect(withdrawVersion(versions, 4, at)).toMatchObject({ ok: false, error: { code: 'INVALID_STATE_TRANSITION', details: { reason: 'NOT_PUBLISHED', from: 'DRAFT' } } })
    expect(withdrawVersion(versions, 2, at)).toMatchObject({ ok: false, error: { details: { reason: 'ALREADY_EFFECTIVE' } } })
  })

  it('withdraws a version with two after it: the one before it runs until the nearer of them', () => {
    const later = [...versions.slice(0, 3), v(5, 'PUBLISHED', '2027-01-01T00:00:00Z', null)]
    const r = withdrawVersion(later, 2, d('2026-09-15T00:00:00Z'))
    if (!r.ok) throw new Error('refused')
    expect(r.data.versions[0]!.effectiveTo?.toISOString()).toBe('2026-11-01T00:00:00.000Z')
  })

  it('withdraws the last version: the one before it runs with no end, the others are left alone', () => {
    const r = withdrawVersion(versions, 3, at)
    if (!r.ok) throw new Error('refused')
    expect(r.data.versions.map((x) => [x.versionNo, x.status, x.effectiveTo?.toISOString() ?? null])).toEqual([
      [1, 'SUPERSEDED', '2026-10-01T00:00:00.000Z'],
      [2, 'PUBLISHED', null],
      [3, 'WITHDRAWN', null],
      [4, 'DRAFT', null],
    ])
  })
})

describe('[FR-DOA-103/AC1] backtestPolicy and backtestWorkflow on the S6 fixture', () => {
  const org = orgSnapshot([], ORG)
  const [v1, v2] = versionSnapshots('fixtures/doa-versions.yaml')
  const sent = d('2026-10-06T03:00:00Z')
  const input = (net: bigint, requester = 'req_con', department = 'CON'): RouteInput => ({ documentType: 'PURCHASE_REQUEST', amount: { netSatang: net, vatSatang: 0n }, requesterMemberId: requester, chargedDepartmentId: department, conflictMemberIds: [requester], at: sent })
  const policy = { versions: [{ ...v1!, effectiveTo: null }], org, delegations: [] }

  it('counts a committee\'s slot holders and an engine\'s refusal on either side', () => {
    const committee: CommitteeStepSpec = { approvers: [{ kind: 'POSITION_OF_ORG', position: 'CEO' }, { kind: 'POSITION_OF_ORG', position: 'COO' }], slaBusinessMinutes: 960, mode: 'PARALLEL', quorum: 'ALL' }
    const draft: DoaVersionSnapshot = { ...v2!, status: 'DRAFT', rules: v2!.rules.map((r) => (r.code === 'PR-03' ? { ...r, steps: [committee] } : r)) }
    const r = backtestPolicy([{ ref: 'BIG', route: input(15_000_000n) }, { ref: 'CEO', route: input(15_000_000n, 'ceo', 'HQ') }], policy, draft)
    expect(r.rows[0]).toMatchObject({ current: { rule: 'PR-03', approvers: ['ceo'], error: null }, draft: { rule: 'PR-03', approvers: ['ceo', 'coo'] }, changed: true })
    // The CEO asks: nobody above them on either side
    expect(r.rows[1]).toMatchObject({ current: { rule: null, error: 'NO_HIGHER_AUTHORITY' }, draft: { rule: null, error: 'NO_HIGHER_AUTHORITY' }, changed: false })
    expect(r.summary).toEqual({ total: 2, changed: 1, load: { coo: 1 } })
  })

  it('a workflow draft adds or drops reviewers; the DOA steps are those of the version that was in effect', () => {
    const fx = workflowFixture(['fixtures/workflow-versions.yaml'])
    const current = fx.versions[0]!
    const draft = { ...current, versionNo: 2, status: 'DRAFT' as const, rules: current.rules.filter((rule) => rule.code !== 'RV-04') }
    const contract = { requestType: 'CONTRACT_WORK', amountGross: 150_000_000n, amountNet: 150_000_000n, lineCategories: [], budgetAccountCodes: [], fields: {} }
    const goods = { ...contract, requestType: 'BUY_GOODS', amountGross: 500_000n, amountNet: 500_000n }
    const r = backtestWorkflow(
      [
        { ref: 'CW', route: input(150_000_000n), review: contract },
        { ref: 'BG', route: input(500_000n), review: goods },
        { ref: 'X', route: input(150_000_000n, 'ceo', 'HQ'), review: contract },
      ],
      { ...policy, workflows: [current] },
      draft,
    )
    expect(r.rows[0]).toMatchObject({ current: { reviewers: ['dm_leg', 'dm_qse', 'dm_fin'], approvers: ['ceo'] }, draft: { reviewers: ['dm_leg', 'dm_fin'], approvers: ['ceo'] }, changed: true })
    expect(r.rows[1]).toMatchObject({ current: { reviewers: [] }, changed: false })
    expect(r.rows[2]!.current.error).not.toBeNull()
    expect(r.summary.load).toEqual({ dm_qse: -1 })
  })

  it('a change that moves nobody leaves the load empty', () => {
    const same = { rule: 'PR-01', approvers: ['a'], reviewers: [], error: null }
    const rows: BacktestRow[] = [{ ref: 'R', current: same, draft: { ...same, rule: 'PR-09' }, changed: true }]
    expect(summarizeBacktest(rows)).toEqual({ total: 1, changed: 1, load: {} })
  })
})
