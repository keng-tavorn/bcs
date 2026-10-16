import { z } from 'zod'
import { DOA_DOCUMENT_TYPES, DOC_TYPE_TRAITS, NO_AMOUNT_DOCUMENT_TYPES, resolveRoute, versionAt, type DoaDocumentType, type RouteInput, type RouteResult } from '@/core/doa'
import { amountToSatang } from '@/core/money/dto'
import { err, ok, type AppError, type ErrorCode, type Result } from '@/core/result'
import { authorize } from '@/server/authz'
import type { Ctx } from '@/server/context'
import { forTenant } from '@/server/db/tenant'
import { loadRoutePolicy } from '@/server/doa/policy'
import { versionSnapshotFromRows } from '@/server/doa/snapshot'
import { getDoaVersionRow, listDoaVersions } from '@/server/queries/doa'
import { listDepartments, listMembers, listPositions } from '@/server/queries/org'
import { treeOrder } from '../org-structure/tree'
import { personOf, summaryOf, type DoaVersionSummaryView, type PersonView } from './view'

// The DOA try-out of ORG_ADMIN (FR-DOA-009 AC2, BR-DOA-14): a document type, an amount, the department that pays and
// the requester in, and the route of the version in effect and of this version out — rule, approvers, delegates, time
// under the SLA and the Thai explanation stored with a real route (BR-DOA-10). It is the engine of real routing:
// resolveRoute over loadRoutePolicy, as startRoute runs it when a document is sent, at this moment and with today's
// position holders and delegations; this version is routed as if it were in effect now, so the two results differ only
// by what the versions say. The requester is the conflicting member, as for a request (BR-DOA-06). Reading only
// (admin.doa.simulate): nothing is stored, so the page is a GET form that can be shared and reloaded.

export const SIMULATION_FIELDS = ['type', 'net', 'vat', 'department', 'requester'] as const
export type SimulationField = (typeof SIMULATION_FIELDS)[number]
export type SimulationQuery = Partial<Record<SimulationField, string>>

/** Why a field of the try-out cannot be used */
export type SimulationFieldError = 'REQUIRED' | 'INVALID' | 'AMOUNT_NOT_POSITIVE'

const MONEY = /^\d{1,13}(\.\d{1,2})?$/

export interface NameView {
  readonly code: string
  readonly nameTh: string
  readonly nameEn: string | null
}

export interface SimulatedStepView {
  readonly assignee: PersonView
  /** The member the assignee acts for (BR-DLG-04) */
  readonly principal: PersonView | null
  /** Where the approver was found: a position held in a department; null when the rule names a person */
  readonly position: NameView | null
  readonly department: NameView | null
  readonly slaMinutes: number
  /** A committee step (S6 · FR-WF-102): every member with the quorum; the fields above repeat the first member */
  readonly committee?: { readonly quorum: 'ALL' | 'ANY' | 'COUNT'; readonly quorumCount: number | null; readonly members: readonly SimulatedHolderView[] }
}

/** Who holds a slot and where the position came from */
export interface SimulatedHolderView {
  readonly assignee: PersonView
  readonly principal: PersonView | null
  readonly position: NameView | null
  readonly department: NameView | null
}

export type SimulatedRouteView =
  | {
      readonly ok: true
      readonly doaCode: string
      readonly versionNo: number
      readonly ruleCode: string
      readonly escalatedFromRuleCode: string | null
      readonly amountBasis: 'GROSS' | 'NET'
      /** satang text; null for a document without an amount */
      readonly basisAmount: string | null
      readonly steps: readonly SimulatedStepView[]
      readonly explanationTh: string
    }
  | {
      readonly ok: false
      readonly code: ErrorCode
      readonly reason: string | null
      readonly ruleCode: string | null
      readonly position: string | null
      readonly departments: readonly string[]
      readonly rules: readonly string[]
    }

export interface DoaSimulationView {
  readonly version: DoaVersionSummaryView
  /** The version in effect now; null when none is */
  readonly inEffect: DoaVersionSummaryView | null
  readonly departments: ReadonlyArray<NameView & { readonly id: string; readonly depth: number }>
  readonly members: ReadonlyArray<PersonView & { readonly employeeCode: string | null }>
  /** What the form shows: the values as typed */
  readonly input: Readonly<Record<SimulationField, string>>
  readonly errors: Partial<Record<SimulationField, SimulationFieldError>>
  /** null until the form is filled in; inEffect is null when no version is in effect */
  readonly result: { readonly inEffect: SimulatedRouteView | null; readonly version: SimulatedRouteView; readonly sameApprovers: boolean } | null
}

async function allow(ctx: Ctx) {
  return forTenant(ctx.organizationId).$transaction((tx) => authorize(tx, ctx, 'admin.doa.simulate'))
}

/** "25,000" or "25000.5" → satang; null when empty; undefined when it is not an amount */
function moneyOf(text: string): bigint | null | undefined {
  const plain = text.replace(/[\s,]/g, '')
  if (plain === '') return null
  return MONEY.test(plain) ? amountToSatang(plain) : undefined
}

const text = (v: unknown) => (typeof v === 'string' ? v : null)
const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])

function errorView(error: AppError): SimulatedRouteView {
  const d = error.details ?? {}
  return { ok: false, code: error.code, reason: text(d.reason), ruleCode: text(d.ruleCode), position: text(d.position), departments: strings(d.departments), rules: strings(d.rules) }
}

/** /admin/doa/[versionId]/simulate: the try-out form and, once filled in, the route of both versions. */
export async function getDoaSimulation(ctx: Ctx, versionId: string, query: SimulationQuery): Promise<Result<DoaSimulationView>> {
  const allowed = await allow(ctx)
  if (!allowed.ok) return allowed
  if (!z.uuid().safeParse(versionId).success) return err('NOT_FOUND', 'DOA version not found')
  const row = await getDoaVersionRow(ctx, versionId)
  if (!row) return err('NOT_FOUND', 'DOA version not found')
  const [members, departmentRows, positionRows, versions] = await Promise.all([listMembers(ctx), listDepartments(ctx), listPositions(ctx), listDoaVersions(ctx)])
  const person = personOf(members)
  const summaries = versions.map((v) => summaryOf(v, person, ctx.now))
  const departments = treeOrder(departmentRows).map((d) => ({ id: d.id, code: d.code, nameTh: d.nameTh, nameEn: d.nameEn, depth: d.depth }))
  const active = members.filter((m) => m.active)

  const input = Object.fromEntries(SIMULATION_FIELDS.map((f) => [f, (query[f] ?? '').trim()])) as Record<SimulationField, string>
  const typed = SIMULATION_FIELDS.some((f) => input[f] !== '')
  if (!input.type) input.type = 'PURCHASE_REQUEST'
  const errors: Partial<Record<SimulationField, SimulationFieldError>> = {}
  const documentType = (DOA_DOCUMENT_TYPES as readonly string[]).includes(input.type) ? (input.type as DoaDocumentType) : null
  if (!documentType) errors.type = 'INVALID'
  const noAmount = documentType !== null && NO_AMOUNT_DOCUMENT_TYPES.includes(documentType)
  // A policy change or a type without an amount takes none (BR-DOA-22); a type that needs one needs it above zero
  // (BR-DOA-02, BR-DOA-21)
  const net = noAmount ? null : moneyOf(input.net)
  const vat = noAmount ? null : moneyOf(input.vat)
  if (net === undefined) errors.net = 'INVALID'
  if (vat === undefined) errors.vat = 'INVALID'
  const required = documentType !== null && DOC_TYPE_TRAITS[documentType].amount === 'REQUIRED'
  if (required && net === null) errors.net = 'REQUIRED'
  else if (required && typeof net === 'bigint' && net + (vat ?? 0n) <= 0n) errors.net = 'AMOUNT_NOT_POSITIVE'
  if (!input.department) errors.department = 'REQUIRED'
  else if (!departmentRows.some((d) => d.id === input.department)) errors.department = 'INVALID'
  if (!input.requester) errors.requester = 'REQUIRED'
  else if (!active.some((m) => m.id === input.requester)) errors.requester = 'INVALID'

  const inEffectSummary = summaries.find((v) => v.inEffect) ?? null
  const base = {
    version: summaryOf(row, person, ctx.now),
    inEffect: inEffectSummary,
    departments,
    members: active.map((m) => ({ id: m.id, nameTh: m.displayNameTh, nameEn: m.displayNameEn, employeeCode: m.employeeCode })),
    input,
  }
  // A page opened without a document shows the form only, and no errors yet
  if (!typed) return ok({ ...base, errors: {}, result: null })
  if (Object.keys(errors).length || !documentType) return ok({ ...base, errors, result: null })

  const amount = typeof net === 'bigint' ? { netSatang: net, vatSatang: vat ?? 0n } : undefined
  const routeInput: RouteInput = {
    documentType,
    ...(amount ? { amount } : {}),
    requesterMemberId: input.requester,
    chargedDepartmentId: input.department,
    conflictMemberIds: [input.requester],
    at: ctx.now,
  }
  const departmentByCode = new Map(departmentRows.map((d) => [d.code, { code: d.code, nameTh: d.nameTh, nameEn: d.nameEn }]))
  const positionByCode = new Map(positionRows.map((p) => [p.code, { code: p.code, nameTh: p.nameTh, nameEn: p.nameEn }]))
  const holder = (h: { readonly assigneeMemberId: string; readonly principalMemberId: string | null; readonly resolvedFrom: string }): SimulatedHolderView => {
    const slot = /^POSITION:([^@]+)@(.+)$/.exec(h.resolvedFrom)
    return {
      assignee: person(h.assigneeMemberId)!,
      principal: person(h.principalMemberId),
      position: slot ? (positionByCode.get(slot[1]!) ?? { code: slot[1]!, nameTh: slot[1]!, nameEn: null }) : null,
      department: slot ? (departmentByCode.get(slot[2]!) ?? { code: slot[2]!, nameTh: slot[2]!, nameEn: null }) : null,
    }
  }
  const view = (route: Result<RouteResult>): SimulatedRouteView => {
    if (!route.ok) return errorView(route.error)
    const r = route.data
    return {
      ok: true,
      doaCode: r.doaCode,
      versionNo: r.versionNo,
      ruleCode: r.ruleCode,
      escalatedFromRuleCode: r.escalatedFromRuleCode,
      amountBasis: r.amountBasis,
      basisAmount: r.basisAmountSatang === null ? null : r.basisAmountSatang.toString(),
      steps: r.steps.map((s) => ({
        ...holder(s),
        slaMinutes: s.slaBusinessMinutes,
        ...(s.committee ? { committee: { quorum: s.committee.quorum, quorumCount: s.committee.quorumCount, members: s.committee.slots.map(holder) } } : {}),
      })),
      explanationTh: r.explanationTh,
    }
  }

  const result = await forTenant(ctx.organizationId).$transaction(async (tx) => {
    const policy = await loadRoutePolicy(tx)
    const current = versionAt(policy.versions, ctx.now)
    // This version as if it were the one in effect now: same holders, delegations and time as the version in effect
    const asInEffect = { ...versionSnapshotFromRows(row, row.ruleRows), status: 'PUBLISHED' as const, effectiveFrom: ctx.now, effectiveTo: null }
    return {
      inEffect: current ? view(resolveRoute(routeInput, policy)) : null,
      version: view(resolveRoute(routeInput, { ...policy, versions: [asInEffect] })),
    }
  })
  const assignees = (r: SimulatedRouteView | null) => (r?.ok ? r.steps.map((s) => (s.committee ? s.committee.members.map((m) => m.assignee.id).join('+') : s.assignee.id)).join('|') : null)
  return ok({ ...base, errors: {}, result: { ...result, sameApprovers: result.inEffect !== null && assignees(result.inEffect) !== null && assignees(result.inEffect) === assignees(result.version) } })
}
