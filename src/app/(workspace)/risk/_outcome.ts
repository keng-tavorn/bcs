import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import type { AppError } from '@/core/result'
import { systemClock } from '@/lib/clock'
import { ctxFromSession } from '@/server/auth/session'
import type { RiskAdminOutcome } from '@/ui/risk-admin/model'
import { getSession } from '../../_lib/session'

// What the server actions of the risk pages share (S11-04 · S11-05): the session's context, the submission key (§4.3),
// and a refusal turned into its code and screen-safe details only — never the service's message (§14.2).

const submissionKey = z.uuid()
const NO_SESSION: RiskAdminOutcome = { ok: false, code: 'UNAUTHENTICATED' }
export const BAD_KEY: RiskAdminOutcome = { ok: false, code: 'VALIDATION_FAILED' }

export async function currentCtx() {
  return ctxFromSession(await getSession(), 'WEB', systemClock.now())
}

export function refused(error: AppError): Extract<RiskAdminOutcome, { ok: false }> {
  const details = error.details ?? {}
  const reason = typeof details.reason === 'string' ? details.reason : undefined
  const lint = Array.isArray(details.errors) ? (details.errors as { code: string; question?: string; documentType?: string; reason: string }[]) : undefined
  const missing = Array.isArray(details.missing) ? (details.missing as string[]) : undefined
  return { ok: false, code: error.code, ...(reason ? { reason } : {}), ...(lint ? { lint } : {}), ...(missing ? { missing } : {}) }
}

/** One command of a page: the session, the key, the service; the page's path refreshed on success */
export async function runRiskCommand<T>(
  key: string,
  call: (ctx: NonNullable<Awaited<ReturnType<typeof currentCtx>>>) => Promise<{ ok: true; data: T } | { ok: false; error: AppError }>,
  path: string,
  id?: (data: T) => string,
): Promise<RiskAdminOutcome> {
  const ctx = await currentCtx()
  if (!ctx) return NO_SESSION
  if (!submissionKey.safeParse(key).success) return BAD_KEY
  const r = await call(ctx)
  if (!r.ok) return refused(r.error)
  revalidatePath(path)
  return { ok: true, ...(id ? { id: id(r.data) } : {}) }
}

/** A file opened through a service that checks the right each time and returns a link of a few minutes (a POST) */
export async function openRiskFile(key: string, call: (ctx: NonNullable<Awaited<ReturnType<typeof currentCtx>>>) => Promise<{ ok: true; data: { url: string } } | { ok: false; error: AppError }>): Promise<RiskAdminOutcome> {
  const ctx = await currentCtx()
  if (!ctx) return NO_SESSION
  if (!submissionKey.safeParse(key).success) return BAD_KEY
  const r = await call(ctx)
  return r.ok ? { ok: true, url: r.data.url } : refused(r.error)
}
