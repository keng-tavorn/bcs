import { z } from 'zod'
import { authorize } from '@/server/authz'
import type { Ctx } from '@/server/context'
import { lockRowsForUpdate } from '@/server/db/sql/locks'
import type { TenantTx } from '@/server/db/tenant'
import { positionHasAuthority } from '@/server/doa/policy'
import type { EventDraft } from '@/server/events/append'
import { defineCommand, runCommand, type CommandOutcome, type RunOptions } from '../_pipeline'

// The organization structure an ORG_ADMIN changes at once (spec FR-ADM-002 AC1–AC2, §2.4 admin.orgStructure.editBasic):
// new departments and their names, cost centers, and the holders of positions that carry no authority. Moving a
// department to another parent, and the holders of a position a DOA in effect, to come or awaiting approval names —
// or that open approval tasks came from — change only through an ORG_AUTHORITY_CHANGE (BR-DOA-17, BR-AUTH-02).

type FailCode = 'VALIDATION_FAILED' | 'NOT_FOUND' | 'FORBIDDEN'
const fail = (code: FailCode, message: string, details?: Record<string, unknown>) => ({ ok: false, error: { code, message, ...(details ? { details } : {}) } }) as const
/** The refusal that sends the admin to propose an authority change of this kind instead */
const needsAuthorityChange = (kind: 'DEPARTMENT_REPARENT' | 'POSITION_ASSIGN' | 'POSITION_END') =>
  fail('FORBIDDEN', 'this change needs an approved authority change', { reason: 'USE_ORG_AUTHORITY_CHANGE', kind })

const Code = z.string().trim().regex(/^[A-Z0-9][A-Z0-9_-]{0,39}$/)
const PositionCode = z.string().regex(/^[A-Z][A-Z0-9_]{0,39}$/)
const NameTh = z.string().trim().min(1).max(200)
const NameEn = z.string().trim().min(1).max(200).nullable()

async function allowed(tx: TenantTx, ctx: Ctx) {
  return authorize(tx, ctx, 'admin.orgStructure.editBasic')
}

// ---------- departments (AC1) ----------

const CreateDepartmentInput = z.strictObject({
  code: Code,
  nameTh: NameTh,
  nameEn: NameEn.optional(),
  parentId: z.uuid(),
  kind: z.enum(['DIVISION', 'DEPARTMENT', 'SECTION']),
})

export const createDepartmentCommand = defineCommand({
  name: 'org_structure.create_department',
  capability: 'admin.orgStructure.editBasic',
  input: CreateDepartmentInput,
  async execute(tx, input, ctx): Promise<CommandOutcome<{ departmentId: string }>> {
    const ok = await allowed(tx, ctx)
    if (!ok.ok) return { ok: false, error: ok.error }
    if (!(await tx.department.findFirst({ where: { id: input.parentId }, select: { id: true } }))) return fail('VALIDATION_FAILED', 'unknown parent department', { field: 'parentId', reason: 'DEPARTMENT' })
    if (await tx.department.findFirst({ where: { code: input.code }, select: { id: true } })) return fail('VALIDATION_FAILED', 'the code is in use', { field: 'code', reason: 'CODE_EXISTS' })
    // A new department is a leaf under an existing one, so it cannot close a cycle (the database refuses one anyway)
    const row = await tx.department.create({
      data: { organizationId: ctx.organizationId, code: input.code, nameTh: input.nameTh, nameEn: input.nameEn ?? null, parentId: input.parentId, kind: input.kind },
      select: { id: true },
    })
    return {
      ok: true,
      result: { departmentId: row.id },
      events: [{ type: 'department.created', aggregateType: 'Department', aggregateId: row.id, data: { code: input.code, parentId: input.parentId, via: 'ADMIN' } }],
    }
  },
})

export function createDepartment(ctx: Ctx, input: z.input<typeof CreateDepartmentInput>, options: RunOptions) {
  return runCommand(ctx, createDepartmentCommand, input, options)
}

const UpdateDepartmentInput = z.strictObject({
  departmentId: z.uuid(),
  nameTh: NameTh.optional(),
  nameEn: NameEn.optional(),
  /** Accepted only to say why a move is refused: a department moves through DEPARTMENT_REPARENT */
  parentId: z.uuid().optional(),
})

export const updateDepartmentCommand = defineCommand({
  name: 'org_structure.update_department',
  capability: 'admin.orgStructure.editBasic',
  input: UpdateDepartmentInput,
  async execute(tx, input, ctx): Promise<CommandOutcome<{ departmentId: string }>> {
    const ok = await allowed(tx, ctx)
    if (!ok.ok) return { ok: false, error: ok.error }
    const department = await tx.department.findFirst({ where: { id: input.departmentId } })
    if (!department) return fail('NOT_FOUND', 'department not found')
    if (input.parentId !== undefined && input.parentId !== department.parentId) return needsAuthorityChange('DEPARTMENT_REPARENT')
    const changed: string[] = []
    if (input.nameTh !== undefined && input.nameTh !== department.nameTh) changed.push('nameTh')
    if (input.nameEn !== undefined && input.nameEn !== department.nameEn) changed.push('nameEn')
    if (changed.length === 0) return fail('VALIDATION_FAILED', 'nothing to change', { reason: 'NO_CHANGE' })
    await tx.department.update({ where: { id: department.id }, data: { ...(input.nameTh !== undefined ? { nameTh: input.nameTh } : {}), ...(input.nameEn !== undefined ? { nameEn: input.nameEn } : {}) } })
    return {
      ok: true,
      result: { departmentId: department.id },
      events: [{ type: 'department.updated', aggregateType: 'Department', aggregateId: department.id, data: { code: department.code, changed } }],
    }
  },
})

export function updateDepartment(ctx: Ctx, input: z.input<typeof UpdateDepartmentInput>, options: RunOptions) {
  return runCommand(ctx, updateDepartmentCommand, input, options)
}

// ---------- cost centers (AC1) ----------

const CreateCostCenterInput = z.strictObject({ code: Code, nameTh: NameTh, departmentId: z.uuid() })

export const createCostCenterCommand = defineCommand({
  name: 'org_structure.create_cost_center',
  capability: 'admin.orgStructure.editBasic',
  input: CreateCostCenterInput,
  async execute(tx, input, ctx): Promise<CommandOutcome<{ costCenterId: string }>> {
    const ok = await allowed(tx, ctx)
    if (!ok.ok) return { ok: false, error: ok.error }
    if (!(await tx.department.findFirst({ where: { id: input.departmentId }, select: { id: true } }))) return fail('VALIDATION_FAILED', 'unknown department', { field: 'departmentId', reason: 'DEPARTMENT' })
    if (await tx.costCenter.findFirst({ where: { code: input.code }, select: { id: true } })) return fail('VALIDATION_FAILED', 'the code is in use', { field: 'code', reason: 'CODE_EXISTS' })
    const row = await tx.costCenter.create({ data: { organizationId: ctx.organizationId, code: input.code, nameTh: input.nameTh, departmentId: input.departmentId }, select: { id: true } })
    return {
      ok: true,
      result: { costCenterId: row.id },
      events: [{ type: 'cost_center.created', aggregateType: 'CostCenter', aggregateId: row.id, data: { code: input.code, departmentId: input.departmentId } }],
    }
  },
})

export function createCostCenter(ctx: Ctx, input: z.input<typeof CreateCostCenterInput>, options: RunOptions) {
  return runCommand(ctx, createCostCenterCommand, input, options)
}

// A cost center keeps its department: which department a cost center belongs to may decide who approves its spending
// once budgets arrive (S3), so moving one is not a basic edit
const UpdateCostCenterInput = z.strictObject({ costCenterId: z.uuid(), nameTh: NameTh.optional(), active: z.boolean().optional() })

export const updateCostCenterCommand = defineCommand({
  name: 'org_structure.update_cost_center',
  capability: 'admin.orgStructure.editBasic',
  input: UpdateCostCenterInput,
  async execute(tx, input, ctx): Promise<CommandOutcome<{ costCenterId: string }>> {
    const ok = await allowed(tx, ctx)
    if (!ok.ok) return { ok: false, error: ok.error }
    const row = await tx.costCenter.findFirst({ where: { id: input.costCenterId } })
    if (!row) return fail('NOT_FOUND', 'cost center not found')
    const changed: string[] = []
    if (input.nameTh !== undefined && input.nameTh !== row.nameTh) changed.push('nameTh')
    if (input.active !== undefined && input.active !== row.active) changed.push('active')
    if (changed.length === 0) return fail('VALIDATION_FAILED', 'nothing to change', { reason: 'NO_CHANGE' })
    await tx.costCenter.update({ where: { id: row.id }, data: { ...(input.nameTh !== undefined ? { nameTh: input.nameTh } : {}), ...(input.active !== undefined ? { active: input.active } : {}) } })
    return {
      ok: true,
      result: { costCenterId: row.id },
      events: [{ type: 'cost_center.updated', aggregateType: 'CostCenter', aggregateId: row.id, data: { code: row.code, changed } }],
    }
  },
})

export function updateCostCenter(ctx: Ctx, input: z.input<typeof UpdateCostCenterInput>, options: RunOptions) {
  return runCommand(ctx, updateCostCenterCommand, input, options)
}

// ---------- holders of positions without authority (AC2) ----------

const SlotInput = { positionCode: PositionCode, departmentId: z.uuid() }
const AssignHolderInput = z.strictObject({ ...SlotInput, memberId: z.uuid() })
const EndHolderInput = z.strictObject(SlotInput)

/** The position and department of a slot, checked: an organization-wide position belongs to the root department (§6.2). */
async function slotOf(tx: TenantTx, input: { positionCode: string; departmentId: string }) {
  const position = await tx.position.findFirst({ where: { code: input.positionCode }, select: { id: true, scope: true } })
  if (!position) return fail('VALIDATION_FAILED', 'unknown position', { field: 'positionCode', reason: 'POSITION' })
  const department = await tx.department.findFirst({ where: { id: input.departmentId }, select: { id: true, parentId: true } })
  if (!department) return fail('VALIDATION_FAILED', 'unknown department', { field: 'departmentId', reason: 'DEPARTMENT' })
  if (position.scope === 'ORG' && department.parentId !== null) return fail('VALIDATION_FAILED', 'an organization-wide position belongs to the root department', { field: 'departmentId', reason: 'ORG_POSITION' })
  return { ok: true, position } as const
}

/** Ends the current holder of a slot (one current holder per position and department, §6.3) */
async function endCurrent(tx: TenantTx, ctx: Ctx, positionId: string, positionCode: string, departmentId: string): Promise<EventDraft[]> {
  const current = await tx.positionAssignment.findMany({ where: { positionId, departmentId, validTo: null }, select: { id: true, memberId: true } })
  const events: EventDraft[] = []
  for (const h of current) {
    await tx.positionAssignment.update({ where: { id: h.id }, data: { validTo: ctx.now } })
    events.push({ type: 'position.unassigned', aggregateType: 'PositionAssignment', aggregateId: h.id, data: { positionCode, departmentId, memberId: h.memberId, validTo: ctx.now.toISOString() } })
  }
  return events
}

export const assignHolderCommand = defineCommand({
  name: 'org_structure.assign_holder',
  capability: 'admin.orgStructure.editBasic',
  input: AssignHolderInput,
  async execute(tx, input, ctx): Promise<CommandOutcome<{ assignmentId: string }>> {
    const ok = await allowed(tx, ctx)
    if (!ok.ok) return { ok: false, error: ok.error }
    // Serialized with DOA submissions: a version submitted at the same moment sees this holder, or this sees the version
    await lockRowsForUpdate(tx, 'Organization', ctx.organizationId, [ctx.organizationId])
    const slot = await slotOf(tx, input)
    if (!slot.ok) return slot
    if (await positionHasAuthority(tx, input.positionCode, ctx.now)) return needsAuthorityChange('POSITION_ASSIGN')
    const member = await tx.member.findFirst({ where: { id: input.memberId, status: 'ACTIVE' }, select: { id: true } })
    if (!member) return fail('VALIDATION_FAILED', 'unknown or inactive member', { field: 'memberId', reason: 'MEMBER' })
    if (await tx.positionAssignment.findFirst({ where: { positionId: slot.position.id, departmentId: input.departmentId, memberId: member.id, validTo: null }, select: { id: true } })) {
      return fail('VALIDATION_FAILED', 'the member holds this position already', { reason: 'NO_CHANGE' })
    }
    const events = await endCurrent(tx, ctx, slot.position.id, input.positionCode, input.departmentId)
    const row = await tx.positionAssignment.create({
      data: { organizationId: ctx.organizationId, positionId: slot.position.id, departmentId: input.departmentId, memberId: member.id, validFrom: ctx.now },
      select: { id: true },
    })
    events.push({ type: 'position.assigned', aggregateType: 'PositionAssignment', aggregateId: row.id, data: { positionCode: input.positionCode, departmentId: input.departmentId, memberId: member.id, validFrom: ctx.now.toISOString(), via: 'ADMIN' } })
    return { ok: true, result: { assignmentId: row.id }, events }
  },
})

export function assignHolder(ctx: Ctx, input: z.input<typeof AssignHolderInput>, options: RunOptions) {
  return runCommand(ctx, assignHolderCommand, input, options)
}

export const endHolderCommand = defineCommand({
  name: 'org_structure.end_holder',
  capability: 'admin.orgStructure.editBasic',
  input: EndHolderInput,
  async execute(tx, input, ctx): Promise<CommandOutcome<{ ended: number }>> {
    const ok = await allowed(tx, ctx)
    if (!ok.ok) return { ok: false, error: ok.error }
    await lockRowsForUpdate(tx, 'Organization', ctx.organizationId, [ctx.organizationId])
    const slot = await slotOf(tx, input)
    if (!slot.ok) return slot
    if (await positionHasAuthority(tx, input.positionCode, ctx.now)) return needsAuthorityChange('POSITION_END')
    const events = await endCurrent(tx, ctx, slot.position.id, input.positionCode, input.departmentId)
    if (events.length === 0) return fail('VALIDATION_FAILED', 'nobody holds this position', { reason: 'VACANT' })
    return { ok: true, result: { ended: events.length }, events }
  },
})

export function endHolder(ctx: Ctx, input: z.input<typeof EndHolderInput>, options: RunOptions) {
  return runCommand(ctx, endHolderCommand, input, options)
}
