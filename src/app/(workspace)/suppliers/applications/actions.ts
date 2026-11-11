'use server'

import { revalidatePath } from 'next/cache'
import type { AppError } from '@/core/result'
import { systemClock } from '@/lib/clock'
import { ctxFromSession } from '@/server/auth/session'
import { cancelApplication, inviteSupplier, reinviteSupplier, returnApplication, submitApplication, updateApplication, verifyAndRoute } from '@/server/services/suppliers/applications'
import { getSession } from '../../../_lib/session'

// Browser-facing adapters of the application screens (S7-09 · ADR-181): each builds ctx from the session and hands the
// browser's values to a command of services/suppliers/applications.ts, which parses them and checks the capability and
// every rule again (BR-AUTH-05). The idempotency key comes from the form, so a double click runs the command once.

export type ApplicationActionResult = { readonly ok: true; readonly applicationId: string } | { readonly ok: false; readonly code: string; readonly reason: string | null; readonly details: Readonly<Record<string, unknown>> }

const failOf = (error: AppError): ApplicationActionResult => ({ ok: false, code: error.code, reason: typeof error.details?.reason === 'string' ? error.details.reason : null, details: (error.details ?? {}) as Record<string, unknown> })
const NO_SESSION: ApplicationActionResult = { ok: false, code: 'UNAUTHENTICATED', reason: null, details: {} }

async function currentCtx() {
  return ctxFromSession(await getSession(), 'WEB', systemClock.now())
}

function done(applicationId: string): ApplicationActionResult {
  revalidatePath('/suppliers/applications')
  revalidatePath(`/suppliers/applications/${applicationId}`)
  return { ok: true, applicationId }
}

/** /suppliers/invite: a new supplier, or a registered one to the portal (BR-SUP ข้อ 08 ข้อ 09) */
export async function inviteSupplierAction(input: unknown, idempotencyKey: string): Promise<ApplicationActionResult> {
  const ctx = await currentCtx()
  if (!ctx) return NO_SESSION
  const r = await inviteSupplier(ctx, input as Parameters<typeof inviteSupplier>[1], { idempotencyKey })
  return r.ok ? done(r.data.applicationId) : failOf(r.error)
}

export async function routeApplicationAction(applicationId: string, expectedVersion: number, registryProofFileId: string | null, idempotencyKey: string): Promise<ApplicationActionResult> {
  const ctx = await currentCtx()
  if (!ctx) return NO_SESSION
  const r = await verifyAndRoute(ctx, { applicationId, expectedVersion, ...(registryProofFileId ? { registryProofFileId } : {}) }, { idempotencyKey })
  return r.ok ? done(r.data.applicationId) : failOf(r.error)
}

export async function returnApplicationAction(applicationId: string, expectedVersion: number, reason: string, idempotencyKey: string): Promise<ApplicationActionResult> {
  const ctx = await currentCtx()
  if (!ctx) return NO_SESSION
  const r = await returnApplication(ctx, { applicationId, expectedVersion, reason }, { idempotencyKey })
  return r.ok ? done(r.data.applicationId) : failOf(r.error)
}

export async function cancelApplicationAction(applicationId: string, expectedVersion: number, reason: string, idempotencyKey: string): Promise<ApplicationActionResult> {
  const ctx = await currentCtx()
  if (!ctx) return NO_SESSION
  const r = await cancelApplication(ctx, { applicationId, expectedVersion, reason }, { idempotencyKey })
  return r.ok ? done(r.data.applicationId) : failOf(r.error)
}

export async function reinviteApplicationAction(applicationId: string, expectedVersion: number, idempotencyKey: string): Promise<ApplicationActionResult> {
  const ctx = await currentCtx()
  if (!ctx) return NO_SESSION
  const r = await reinviteSupplier(ctx, { applicationId, expectedVersion }, { idempotencyKey })
  return r.ok ? done(r.data.applicationId) : failOf(r.error)
}

/** PROCUREMENT fills in a step for the supplier (BR-SUP ข้อ 10: every field marked ON_BEHALF) */
export async function updateOnBehalfAction(applicationId: string, expectedVersion: number, fields: unknown, idempotencyKey: string): Promise<ApplicationActionResult> {
  const ctx = await currentCtx()
  if (!ctx) return NO_SESSION
  const r = await updateApplication(ctx, { applicationId, expectedVersion, fields: fields as Parameters<typeof updateApplication>[1]['fields'] }, { idempotencyKey })
  return r.ok ? done(r.data.applicationId) : failOf(r.error)
}

export async function submitOnBehalfAction(applicationId: string, expectedVersion: number, duplicateReasons: Record<string, string>, idempotencyKey: string): Promise<ApplicationActionResult> {
  const ctx = await currentCtx()
  if (!ctx) return NO_SESSION
  const r = await submitApplication(ctx, { applicationId, expectedVersion, duplicateReasons }, { idempotencyKey })
  return r.ok ? done(r.data.applicationId) : failOf(r.error)
}
