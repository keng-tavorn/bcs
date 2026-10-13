import { z } from 'zod'
import { lintDoaVersion, stepApprovers, type OrgSnapshot, type RouteResult } from '@/core/doa'
import { checkSod, type SodPolicy } from '@/core/sod'
import { DOA_VERSION_MACHINE, transition, type DoaVersionState } from '@/core/state-machines'
import { REASON_MAX_LENGTH } from '@/lib/constants'
import { newId } from '@/lib/ids'
import { authorize } from '@/server/authz'
import type { Ctx } from '@/server/context'
import { lockRowsForUpdate } from '@/server/db/sql/locks'
import { loadOrgSnapshot } from '@/server/doa/policy'
import { versionSnapshotFromRows } from '@/server/doa/snapshot'
import type { EventDraft } from '@/server/events/append'
import { defineCommand, runCommand, type CommandOutcome, type RunOptions } from '../_pipeline'
import { enabledModules } from '../modules'
import { storeRoute } from '../approvals/route'
import { boundaryTableRequired } from './boundary'
import { issueView, warningKey } from './lint-view'

// The organization's initial package (spec BR-DOA-19, FR-DOA-002 AC3, OQ-31 default): the holders of the positions the
// first DOA version names, and that version, go together from ORG_ADMIN to the contract signatory the BCS team verified
// (Organization.contractSignatoryMemberId), who approves with a step-up. No DOA is in effect yet, so no rule can route
// the package: its route names the signatory and cites the version itself under BR-DOA-19. The submitter is never the
// signatory. The holders travel as POSITION_ASSIGN authority changes on the same route and apply when it is approved.
// PLATFORM_ADMIN only verifies who the signatory is and never sees the content.

/** The rule an initial package's route cites: the spec's own, since the version it approves is not in effect yet */
export const INITIAL_PACKAGE_RULE = 'BR-DOA-19'

const fail = (code: 'VALIDATION_FAILED' | 'NOT_FOUND' | 'INVALID_STATE_TRANSITION', message: string, details?: Record<string, unknown>) =>
  ({ ok: false, error: { code, message, ...(details ? { details } : {}) } }) as const

/** The signatory approves policy, never a document they receive, and the package's submitter never approves it */
const PACKAGE_SOD: SodPolicy = { approverMayReceive: false, requesterMayReceive: true }

const Holder = z.strictObject({ positionCode: z.string().regex(/^[A-Z][A-Z0-9_]{0,39}$/), departmentId: z.uuid(), memberId: z.uuid() })
type Holder = z.output<typeof Holder>

const SubmitInitialInput = z.strictObject({
  versionId: z.uuid(),
  holders: z.array(Holder).min(1).max(500),
  reason: z.string().trim().min(3).max(REASON_MAX_LENGTH),
  acknowledgedWarnings: z.array(z.string()).default([]),
  /** FR-DOA-009 AC3: the drafter ticked the boundary table; required (true) whenever the version has one (boundary.ts) */
  boundaryTableConfirmed: z.boolean().optional(),
})

const slotKey = (h: { positionCode: string; departmentId: string }) => `${h.positionCode}@${h.departmentId}`

/** The organization once the package's holders start: each listed slot changes to its new holder at that time. */
function withHolders(org: OrgSnapshot, holders: readonly Holder[], at: Date): OrgSnapshot {
  const listed = new Set(holders.map(slotKey))
  return {
    ...org,
    holders: [
      ...org.holders.map((h) => (listed.has(slotKey(h)) && (h.validTo === null || h.validTo > at) ? { ...h, validTo: at } : h)),
      ...holders.map((h) => ({ positionCode: h.positionCode, departmentId: h.departmentId, memberId: h.memberId, validFrom: at, validTo: null })),
    ],
  }
}

export const submitInitialPackageCommand = defineCommand({
  name: 'doa.submit_initial_package',
  capability: 'admin.doa.submitForPublish',
  input: SubmitInitialInput,
  async execute(tx, input, ctx): Promise<CommandOutcome<{ versionId: string; routeId: string; assigneeMemberId: string; changeIds: string[] }>> {
    const allowed = await authorize(tx, ctx, 'admin.doa.submitForPublish')
    if (!allowed.ok) return { ok: false, error: allowed.error }
    const submitter = ctx.actor.type === 'USER' ? ctx.actor.memberId : null
    if (!submitter) return { ok: false, error: { code: 'FORBIDDEN', message: 'only a member submits' } }
    // One package at a time, and no holder edit in between (org-structure takes the same lock)
    await lockRowsForUpdate(tx, 'Organization', ctx.organizationId, [ctx.organizationId])
    const [locked] = await lockRowsForUpdate(tx, 'DoaVersion', ctx.organizationId, [input.versionId])
    if (!locked) return fail('NOT_FOUND', 'DOA version not found')
    const row = await tx.doaVersion.findUniqueOrThrow({ where: { id: input.versionId }, include: { rules: true } })
    const moved = transition(DOA_VERSION_MACHINE, row.status as DoaVersionState, 'doa.submit')
    if (!moved.ok) return fail('INVALID_STATE_TRANSITION', `doa.submit is not allowed from ${row.status}`, { from: row.status, command: 'doa.submit' })
    // Only the first version: once a DOA is in effect, to come or awaiting approval, versions follow its DOA_CHANGE rule
    if (await tx.doaVersion.count({ where: { status: { in: ['PENDING_APPROVAL', 'PUBLISHED', 'SUPERSEDED'] } } })) {
      return fail('VALIDATION_FAILED', 'the organization has a DOA already: submit the version for its DOA_CHANGE approval', { reason: 'NOT_INITIAL' })
    }
    if (row.effectiveFrom.getTime() < ctx.now.getTime()) return fail('VALIDATION_FAILED', 'the effective time is in the past', { field: 'effectiveFrom', reason: 'EFFECTIVE_IN_PAST' })

    // The contract signatory the BCS team verified, and never the submitter (OQ-31)
    const org = await tx.organization.findUniqueOrThrow({ where: { id: ctx.organizationId }, select: { contractSignatoryMemberId: true, contractSignatoryVerifiedAt: true } })
    const signatory =
      org.contractSignatoryMemberId && org.contractSignatoryVerifiedAt ? await tx.member.findFirst({ where: { id: org.contractSignatoryMemberId, status: 'ACTIVE' }, select: { id: true } }) : null
    if (!signatory) return fail('VALIDATION_FAILED', 'the organization has no verified contract signatory', { reason: 'SIGNATORY_NOT_VERIFIED' })
    const own = checkSod({ kind: 'DECIDE_APPROVAL', subject: 'DOA_VERSION', actorMemberId: signatory.id, requesterMemberIds: [submitter] }, PACKAGE_SOD)
    if (!own.ok) {
      return {
        ok: false,
        error: { code: 'SOD_VIOLATION', message: 'the contract signatory cannot submit the package they approve', details: { rule: own.rule } },
        auditEvents: [{ type: 'security.sod_blocked', aggregateType: 'Security', aggregateId: row.id, data: { rule: own.rule, action: 'doa.submit_initial_package', subjectType: 'DOA_VERSION', subjectId: row.id, actorMemberId: submitter } }],
      }
    }

    // The holders: positions this version names, one per position and department, active members, never the submitter
    const version = versionSnapshotFromRows(row, row.rules)
    const named = new Set(version.rules.flatMap((r) => r.steps.flatMap(stepApprovers).flatMap((a) => (a.kind === 'MEMBER' ? [] : [a.position]))))
    const structure = await loadOrgSnapshot(tx)
    const root = structure.departments.find((d) => d.parentId === null)
    const seen = new Set<string>()
    for (const [i, h] of input.holders.entries()) {
      const field = `holders.${i}`
      if (seen.has(slotKey(h))) return fail('VALIDATION_FAILED', 'one holder per position and department', { field, reason: 'DUPLICATE_SLOT' })
      seen.add(slotKey(h))
      if (!named.has(h.positionCode)) return fail('VALIDATION_FAILED', 'the version does not name this position', { field, reason: 'POSITION_NOT_IN_DOA' })
      const position = await tx.position.findFirst({ where: { code: h.positionCode }, select: { scope: true } })
      if (!position) return fail('VALIDATION_FAILED', 'unknown position', { field, reason: 'POSITION' })
      if (!structure.departments.some((d) => d.id === h.departmentId)) return fail('VALIDATION_FAILED', 'unknown department', { field, reason: 'DEPARTMENT' })
      if (position.scope === 'ORG' && h.departmentId !== root?.id) return fail('VALIDATION_FAILED', 'an organization-wide position belongs to the root department', { field, reason: 'ORG_POSITION' })
      if (!structure.members.some((m) => m.id === h.memberId && m.active)) return fail('VALIDATION_FAILED', 'unknown or inactive member', { field, reason: 'MEMBER' })
      // BR-SOD-08: the submitter never puts themselves into a position the DOA names
      const gain = checkSod({ kind: 'PROPOSE_ORG_AUTHORITY_CHANGE', changeKind: 'POSITION_ASSIGN', actorMemberId: submitter, beneficiaryMemberId: h.memberId }, PACKAGE_SOD)
      if (!gain.ok) {
        return {
          ok: false,
          error: { code: 'SOD_VIOLATION', message: 'separation of duties', details: { rule: gain.rule, field } },
          auditEvents: [{ type: 'security.sod_blocked', aggregateType: 'Security', aggregateId: row.id, data: { rule: gain.rule, action: 'doa.submit_initial_package', subjectType: 'DOA_VERSION', subjectId: row.id, actorMemberId: submitter } }],
        }
      }
    }
    // Nobody may hold authority under the version that the signatory did not approve: every slot of a named position
    // that has a holder now is in the package (with the same or a new holder)
    const unlisted = structure.holders.filter((h) => h.validTo === null && named.has(h.positionCode) && !seen.has(slotKey(h))).map((h) => ({ positionCode: h.positionCode, departmentId: h.departmentId }))
    if (unlisted.length) return fail('VALIDATION_FAILED', 'every current holder of a position the version names must be in the package', { reason: 'UNLISTED_HOLDER', slots: unlisted })

    // BR-DOA-08: the full lint against the organization as it will be with the package's holders
    const lint = lintDoaVersion(version, withHolders(structure, input.holders, row.effectiveFrom), row.effectiveFrom, { modules: await enabledModules(tx) })
    if (lint.errors.length) return { ok: false, error: { code: 'DOA_LINT_FAILED', message: 'the DOA version does not pass the lint', details: { errors: lint.errors.map(issueView) } } }
    const unacknowledged = lint.warnings.map(warningKey).filter((k) => !input.acknowledgedWarnings.includes(k))
    if (unacknowledged.length) return fail('VALIDATION_FAILED', 'every warning must be acknowledged', { reason: 'WARNINGS_NOT_ACKNOWLEDGED', warnings: unacknowledged })
    // FR-DOA-009 AC3: the boundary table of the first version (nothing is in effect to compare it with), when it has one
    if (input.boundaryTableConfirmed !== true && (await boundaryTableRequired(tx, row, ctx.now))) {
      return fail('VALIDATION_FAILED', 'the boundary table must be confirmed', { field: 'boundaryTableConfirmed', reason: 'BOUNDARY_NOT_CONFIRMED' })
    }

    // The route: the signatory alone, within the time the version itself gives its DOA_CHANGE approver (lint ensures one)
    const governance = version.rules.find((r) => r.documentType === 'DOA_CHANGE')!
    const route: RouteResult = {
      doaVersionId: row.id,
      doaCode: row.code,
      versionNo: row.versionNo,
      ruleCode: INITIAL_PACKAGE_RULE,
      escalatedFromRuleCode: null,
      amountBasis: version.amountBasis,
      basisAmountSatang: null,
      steps: [{ stepNo: 1, assigneeMemberId: signatory.id, principalMemberId: null, resolvedFrom: `CONTRACT_SIGNATORY:${signatory.id}`, slaBusinessMinutes: governance.steps[0]!.slaBusinessMinutes, notifyOrgAdmin: false }],
      explanationTh: `ชุดตั้งต้นขององค์กร (${row.code} ฉบับ ${row.versionNo} และผู้ดำรงตำแหน่ง ${input.holders.length} ตำแหน่ง) อนุมัติโดยผู้มีอำนาจลงนามตามสัญญา (BR-DOA-19)`,
    }
    const stored = await storeRoute(tx, ctx, { type: 'DOA_VERSION', id: row.id, label: `${row.code} ฉบับ ${row.versionNo}` }, route)
    if (!stored.ok) return { ok: false, error: stored.error }
    const routeId = stored.data.routeId

    const events: EventDraft[] = []
    const changeIds: string[] = []
    for (const h of input.holders) {
      const id = newId()
      const current = structure.holders.filter((x) => x.validTo === null && slotKey(x) === slotKey(h)).map((x) => x.memberId)
      await tx.orgAuthorityChange.create({
        data: {
          id,
          organizationId: ctx.organizationId,
          kind: 'POSITION_ASSIGN',
          payload: { positionCode: h.positionCode, departmentId: h.departmentId, memberId: h.memberId },
          reason: input.reason,
          effectiveFrom: row.effectiveFrom,
          submittedById: submitter,
          routeId,
          status: 'PENDING_APPROVAL',
          impactSummary: { gains: [h.memberId], loses: current.filter((m) => m !== h.memberId), openTasks: 0 },
          submittedAt: ctx.now,
        },
      })
      changeIds.push(id)
      events.push({ type: 'org_authority_change.submitted', aggregateType: 'OrgAuthorityChange', aggregateId: id, data: { kind: 'POSITION_ASSIGN', effectiveFrom: row.effectiveFrom.toISOString(), routeId } })
    }
    await tx.doaVersion.update({ where: { id: row.id }, data: { status: moved.to, submittedById: submitter, submittedAt: ctx.now, version: { increment: 1 } } })
    return {
      ok: true,
      result: { versionId: row.id, routeId, assigneeMemberId: signatory.id, changeIds },
      events: [
        {
          type: 'doa_version.submitted',
          aggregateType: 'DoaVersion',
          aggregateId: row.id,
          data: {
            code: row.code,
            versionNo: row.versionNo,
            warningsAcknowledged: lint.warnings.length,
            routeId,
            initialPackageHolders: input.holders.length,
            ...(input.boundaryTableConfirmed ? { boundaryTableConfirmed: true } : {}),
          },
        },
        ...events,
        ...stored.data.events,
      ],
      notifications: stored.data.notifications,
    }
  },
})

export function submitInitialPackage(ctx: Ctx, input: z.input<typeof SubmitInitialInput>, options: RunOptions) {
  return runCommand(ctx, submitInitialPackageCommand, input, options)
}

/** Whether a DOA_VERSION route is an initial package's: only a package cites the version it approves. */
export const isInitialPackageRoute = (route: { readonly subjectType: string; readonly subjectId: string; readonly doaVersionId: string }) =>
  route.subjectType === 'DOA_VERSION' && route.doaVersionId === route.subjectId
