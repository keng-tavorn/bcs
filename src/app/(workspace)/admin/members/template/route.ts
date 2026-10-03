import { getTranslations } from 'next-intl/server'
import { systemClock } from '@/lib/clock'
import { ctxFromSession, resolveSession } from '@/server/auth/session'
import { STORED_ROLES } from '@/server/authz/permissions'
import { IMPORT_COLUMNS } from '@/server/services/members/import'
import { memberImportTemplate } from '@/server/services/members/admin-view'

// GET the empty Excel template of the member import (FR-ADM-001 AC3). Read-only: it never changes state.
export async function GET(request: Request): Promise<Response> {
  const ctx = ctxFromSession(await resolveSession(request.headers), 'WEB', systemClock.now())
  if (!ctx) return new Response(null, { status: 401 })
  const t = await getTranslations('admin.members')
  const roleName = await getTranslations('admin.roles')
  const labels = Object.fromEntries(IMPORT_COLUMNS.map((c) => [c, c === 'roles' ? t('template.rolesColumn') : t(`fields.${c}`)])) as Record<
    (typeof IMPORT_COLUMNS)[number],
    string
  >
  const guide = {
    sheetName: t('template.guideSheet'),
    lines: [t('template.line1'), t('template.line2'), t('template.line3'), t('template.line4')],
    roleHeaders: [t('template.roleCode'), t('template.roleName')] as const,
    roles: [...STORED_ROLES.map((code) => ({ code, name: roleName(code) })), { code: 'REQUESTER', name: t('noRoles') }],
  }
  const result = await memberImportTemplate(ctx, labels, guide)
  if (!result.ok) return new Response(null, { status: 403 })
  return new Response(new Uint8Array(result.data), {
    headers: {
      'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'content-disposition': 'attachment; filename="bcs-members-template.xlsx"',
      'cache-control': 'no-store',
    },
  })
}
