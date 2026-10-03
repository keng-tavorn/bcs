'use server'

import { revalidatePath } from 'next/cache'
import { getLocale, getTranslations } from 'next-intl/server'
import { z } from 'zod'
import { systemClock } from '@/lib/clock'
import { MEMBER_IMPORT_MAX_BYTES } from '@/lib/constants'
import { ctxFromSession } from '@/server/auth/session'
import { STORED_ROLES, type StoredRole } from '@/server/authz/permissions'
import { deactivateMember, inviteMember, resetMemberTwoFactor } from '@/server/services/members'
import { importMembers, type ImportRoleNames } from '@/server/services/members/import'
import { grantRole, revokeRole } from '@/server/services/members/roles'
import { toFailure, type AdminOutcome } from '@/ui/admin/outcome'
import { getSession } from '../../../_lib/session'

// Browser-facing adapters for /admin/members (FR-ADM-001). Each one checks the session; the service checks
// admin.members, self-grant, the last ORG_ADMIN and the rest (BR-AUTH-05), so hiding a button is never the guard.
// The idempotencyKey comes from the form (spec §4.3: a UUID the client creates when the form opens), so sending the
// same submission twice runs the command once (INV-PLT-01).

const NO_SESSION: AdminOutcome = { ok: false, code: 'UNAUTHENTICATED' }
const BAD_KEY: AdminOutcome = { ok: false, code: 'VALIDATION_FAILED', field: 'idempotencyKey' }
const submissionKey = z.uuid()

async function currentCtx() {
  return ctxFromSession(await getSession(), 'WEB', systemClock.now())
}

async function locale(): Promise<'th' | 'en'> {
  return (await getLocale()) === 'en' ? 'en' : 'th'
}

function done(result: { ok: true } | { ok: false; error: { code: string; details?: Record<string, unknown> } }, extra: Omit<Extract<AdminOutcome, { ok: true }>, 'ok'> = {}): AdminOutcome {
  if (!result.ok) return toFailure(result.error)
  revalidatePath('/admin/members', 'layout')
  return { ok: true, ...extra }
}

// Role names come from the browser as plain strings; the service's schema refuses any that is not a stored role.
const asRoles = (roles: readonly string[]) => roles as StoredRole[]

/** The role names of the screen in both languages, so a file may say จัดซื้อ or Procurement instead of PROCUREMENT. */
async function roleNames(): Promise<ImportRoleNames[]> {
  const lookups = await Promise.all((['th', 'en'] as const).map((l) => Promise.all([getTranslations({ locale: l, namespace: 'admin.roles' }), getTranslations({ locale: l, namespace: 'admin.members' })])))
  return [
    ...STORED_ROLES.map((code) => ({ code, names: lookups.map(([roles]) => roles(code)) })),
    { code: 'REQUESTER' as const, names: lookups.map(([, members]) => members('noRoles')) },
  ]
}

export async function inviteMemberAction(input: { email: string; displayNameTh: string; roles: string[] }, idempotencyKey: string): Promise<AdminOutcome> {
  const ctx = await currentCtx()
  if (!ctx) return NO_SESSION
  if (!submissionKey.safeParse(idempotencyKey).success) return BAD_KEY
  const result = await inviteMember(ctx, { ...input, roles: asRoles(input.roles), locale: await locale() }, { idempotencyKey })
  return result.ok ? done(result, { emailSent: result.data.emailSent }) : done(result)
}

export async function importMembersAction(formData: FormData): Promise<AdminOutcome> {
  const ctx = await currentCtx()
  if (!ctx) return NO_SESSION
  const file = formData.get('file')
  if (!(file instanceof File) || file.size === 0) return { ok: false, code: 'VALIDATION_FAILED', field: 'file', reason: 'FILE_MISSING' }
  if (file.size > MEMBER_IMPORT_MAX_BYTES) return { ok: false, code: 'VALIDATION_FAILED', field: 'file', reason: 'FILE_TOO_LARGE' }
  // The import's key is the file's own hash (importMembers): the same file twice is one import
  const result = await importMembers(ctx, await file.arrayBuffer(), { locale: await locale(), roleNames: await roleNames() })
  return result.ok ? done(result, { count: result.data.invited, emailsSent: result.data.emailsSent, notSent: result.data.notSent }) : done(result)
}

export async function grantRoleAction(memberId: string, role: string, idempotencyKey: string): Promise<AdminOutcome> {
  const ctx = await currentCtx()
  if (!ctx) return NO_SESSION
  if (!submissionKey.safeParse(idempotencyKey).success) return BAD_KEY
  return done(await grantRole(ctx, { memberId, role: asRoles([role])[0]! }, { idempotencyKey }))
}

export async function revokeRoleAction(memberId: string, role: string, idempotencyKey: string): Promise<AdminOutcome> {
  const ctx = await currentCtx()
  if (!ctx) return NO_SESSION
  if (!submissionKey.safeParse(idempotencyKey).success) return BAD_KEY
  return done(await revokeRole(ctx, { memberId, role: asRoles([role])[0]! }, { idempotencyKey }))
}

export async function deactivateMemberAction(memberId: string, reason: string, idempotencyKey: string): Promise<AdminOutcome> {
  const ctx = await currentCtx()
  if (!ctx) return NO_SESSION
  if (!submissionKey.safeParse(idempotencyKey).success) return BAD_KEY
  return done(await deactivateMember(ctx, { memberId, reason }, { idempotencyKey }))
}

export async function resetTwoFactorAction(memberId: string, reason: string, idempotencyKey: string): Promise<AdminOutcome> {
  const ctx = await currentCtx()
  if (!ctx) return NO_SESSION
  if (!submissionKey.safeParse(idempotencyKey).success) return BAD_KEY
  return done(await resetMemberTwoFactor(ctx, { memberId, reason }, { idempotencyKey }))
}
