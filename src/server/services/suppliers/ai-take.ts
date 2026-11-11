import { z } from 'zod'
import { err, type Result } from '@/core/result'
import type { Ctx } from '@/server/context'
import { forTenant } from '@/server/db/tenant'
import type { RunOptions } from '../_pipeline'
import { SUPPLIER_ASSIST_PATHS } from './ai-assist'
import { updateApplication } from './applications'

// S7-14 (FR-AI-304 AC3 · BR-AI-30 · ADR-189): a person takes values the Supplier Onboarding Agent read into the
// application — the supplier's contact on the portal, or procurement filling it in — by ticking each one (the fields
// that wait one by one: taxId branchCode nameTh isVatRegistered bankCode accountName and those below the floor) or with
// "ยืนยันค่าที่เหลือทั้งหมด" for the others. What is taken is written by supplierApplication.update with aiAssist naming the
// paths confirmed; a value not taken stays as the person typed it. Never an account number (BR-AI-18).

const Input = z.strictObject({
  applicationId: z.uuid(),
  expectedVersion: z.int().min(0),
  agentActionId: z.uuid(),
  /** The paths the person ticked */
  paths: z.array(z.enum(SUPPLIER_ASSIST_PATHS)).max(SUPPLIER_ASSIST_PATHS.length),
  /** The button "ยืนยันค่าที่เหลือทั้งหมด": every value that need not be confirmed one by one, besides the ticked ones */
  rest: z.boolean().default(false),
})

export async function takeAiReading(ctx: Ctx, raw: z.input<typeof Input>, options: RunOptions): Promise<Result<{ applicationId: string; version: number; taken: string[] }>> {
  const parsed = Input.safeParse(raw)
  if (!parsed.success) return err('VALIDATION_FAILED', 'invalid input', { field: parsed.error.issues[0]?.path.join('.') || 'paths' })
  const input = parsed.data
  // the reading of this application only (another one, or another organization's, is not found · INV-SUP-01)
  const action = await forTenant(ctx.organizationId).agentAction.findFirst({
    where: { id: input.agentActionId, purpose: 'SUPPLIER_DOC_READ', subjectType: 'SUPPLIER_APPLICATION', subjectId: input.applicationId, status: 'DRAFT' },
    select: { review: true },
  })
  if (!action) return err('NOT_FOUND', 'no such AI reading', { field: 'agentActionId' })
  const review = (action.review ?? {}) as { proposed?: Record<string, string>; requiredPaths?: string[] }
  const proposed = review.proposed ?? {}
  const required = new Set(review.requiredPaths ?? [])
  const taken = [...new Set([...input.paths, ...(input.rest ? Object.keys(proposed).filter((p) => !required.has(p)) : [])])].filter((p) => Object.hasOwn(proposed, p)).sort()
  if (taken.length === 0) return err('VALIDATION_FAILED', 'tick at least one value to take', { field: 'paths', reason: 'NOTHING_TAKEN' })
  const fields: Record<string, string | boolean> = {}
  for (const path of taken) fields[path] = path === 'isVatRegistered' ? proposed[path] === 'true' : proposed[path]!
  const r = await updateApplication(ctx, { applicationId: input.applicationId, expectedVersion: input.expectedVersion, fields, aiAssist: { agentActionId: input.agentActionId, confirmedPaths: taken } }, options)
  return r.ok ? { ok: true, data: { ...r.data, taken } } : r
}
