'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { systemClock } from '@/lib/clock'
import { REASON_MAX_LENGTH } from '@/lib/constants'
import { ctxFromSession } from '@/server/auth/session'
import { assignHolder, createCostCenter, createDepartment, endHolder, updateCostCenter, updateDepartment } from '@/server/services/org-structure'
import type { OrgActionResult } from '@/ui/admin-org/department-forms'
import { toActionFailure } from '@/ui/admin-org/outcome'
import { getSession } from '../../../_lib/session'

// Browser-facing adapters for /admin/org (FR-ADM-002 AC1–AC2). Each checks the session; the service checks
// admin.orgStructure.editBasic, refuses positions with authority and department moves (USE_ORG_AUTHORITY_CHANGE) and
// records the event (BR-AUTH-05), so hiding a button is never the guard. The idempotencyKey comes from the form
// (spec §4.3), so the same submission sent twice runs once.

const NO_SESSION: OrgActionResult = { ok: false, code: 'UNAUTHENTICATED' }
const BAD_KEY: OrgActionResult = { ok: false, code: 'VALIDATION_FAILED', field: 'idempotencyKey' }
const BAD_INPUT: OrgActionResult = { ok: false, code: 'VALIDATION_FAILED', field: '(input)' }
const submissionKey = z.uuid()
// Server actions are public endpoints (BR-AUTH-05): the shape of what arrives is checked before it is read; the
// service checks the values themselves
const Text = z.string().max(REASON_MAX_LENGTH * 2)
const Shapes = {
  createDepartment: z.object({ code: Text, nameTh: Text, nameEn: Text, parentId: Text, kind: Text }),
  renameDepartment: z.object({ departmentId: Text, nameTh: Text, nameEn: Text }),
  createCostCenter: z.object({ code: Text, nameTh: Text, departmentId: Text }),
  updateCostCenter: z.object({ costCenterId: Text, nameTh: Text.optional(), active: z.boolean().optional() }),
  slot: z.object({ positionCode: Text, departmentId: Text }),
  assignHolder: z.object({ positionCode: Text, departmentId: Text, memberId: Text }),
}

async function currentCtx() {
  return ctxFromSession(await getSession(), 'WEB', systemClock.now())
}

function done(result: { ok: true } | { ok: false; error: { code: string; details?: Readonly<Record<string, unknown>> } }): OrgActionResult {
  if (!result.ok) return toActionFailure(result.error)
  revalidatePath('/admin/org', 'layout')
  return { ok: true }
}

/** An optional English name: empty means none */
const optional = (value: string) => (value.trim() ? value.trim() : null)

export async function createDepartmentAction(input: { code: string; nameTh: string; nameEn: string; parentId: string; kind: string }, idempotencyKey: string): Promise<OrgActionResult> {
  const ctx = await currentCtx()
  if (!ctx) return NO_SESSION
  if (!submissionKey.safeParse(idempotencyKey).success) return BAD_KEY
  const shape = Shapes.createDepartment.safeParse(input)
  if (!shape.success) return BAD_INPUT
  const value = shape.data
  // The kind arrives as a plain string; the service's schema refuses any that is not a department kind
  const kind = value.kind as 'DIVISION' | 'DEPARTMENT' | 'SECTION'
  return done(await createDepartment(ctx, { code: value.code, nameTh: value.nameTh, nameEn: optional(value.nameEn), parentId: value.parentId, kind }, { idempotencyKey }))
}

export async function renameDepartmentAction(input: { departmentId: string; nameTh: string; nameEn: string }, idempotencyKey: string): Promise<OrgActionResult> {
  const ctx = await currentCtx()
  if (!ctx) return NO_SESSION
  if (!submissionKey.safeParse(idempotencyKey).success) return BAD_KEY
  const shape = Shapes.renameDepartment.safeParse(input)
  if (!shape.success) return BAD_INPUT
  return done(await updateDepartment(ctx, { departmentId: shape.data.departmentId, nameTh: shape.data.nameTh, nameEn: optional(shape.data.nameEn) }, { idempotencyKey }))
}

export async function createCostCenterAction(input: { code: string; nameTh: string; departmentId: string }, idempotencyKey: string): Promise<OrgActionResult> {
  const ctx = await currentCtx()
  if (!ctx) return NO_SESSION
  if (!submissionKey.safeParse(idempotencyKey).success) return BAD_KEY
  const shape = Shapes.createCostCenter.safeParse(input)
  if (!shape.success) return BAD_INPUT
  return done(await createCostCenter(ctx, shape.data, { idempotencyKey }))
}

export async function updateCostCenterAction(input: { costCenterId: string; nameTh?: string; active?: boolean }, idempotencyKey: string): Promise<OrgActionResult> {
  const ctx = await currentCtx()
  if (!ctx) return NO_SESSION
  if (!submissionKey.safeParse(idempotencyKey).success) return BAD_KEY
  const shape = Shapes.updateCostCenter.safeParse(input)
  if (!shape.success) return BAD_INPUT
  return done(await updateCostCenter(ctx, shape.data, { idempotencyKey }))
}

export async function assignHolderAction(input: { positionCode: string; departmentId: string; memberId: string }, idempotencyKey: string): Promise<OrgActionResult> {
  const ctx = await currentCtx()
  if (!ctx) return NO_SESSION
  if (!submissionKey.safeParse(idempotencyKey).success) return BAD_KEY
  const shape = Shapes.assignHolder.safeParse(input)
  if (!shape.success) return BAD_INPUT
  return done(await assignHolder(ctx, shape.data, { idempotencyKey }))
}

export async function endHolderAction(input: { positionCode: string; departmentId: string }, idempotencyKey: string): Promise<OrgActionResult> {
  const ctx = await currentCtx()
  if (!ctx) return NO_SESSION
  if (!submissionKey.safeParse(idempotencyKey).success) return BAD_KEY
  const shape = Shapes.slot.safeParse(input)
  if (!shape.success) return BAD_INPUT
  return done(await endHolder(ctx, shape.data, { idempotencyKey }))
}
