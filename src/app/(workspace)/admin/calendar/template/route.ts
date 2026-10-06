import { getTranslations } from 'next-intl/server'
import { systemClock } from '@/lib/clock'
import { ctxFromSession, resolveSession } from '@/server/auth/session'
import { holidayImportTemplate } from '@/server/services/calendar'

// GET the empty Excel template of the holiday import (FR-ADM-003 AC2). Read-only: it never changes state.
export async function GET(request: Request): Promise<Response> {
  const ctx = ctxFromSession(await resolveSession(request.headers), 'WEB', systemClock.now())
  if (!ctx) return new Response(null, { status: 401 })
  const t = await getTranslations('adminSettings.calendar.template')
  const result = await holidayImportTemplate(ctx, { date: t('dateColumn'), nameTh: t('nameColumn') }, { sheetName: t('guideSheet'), lines: [t('line1'), t('line2'), t('line3'), t('line4')] })
  if (!result.ok) return new Response(null, { status: 403 })
  return new Response(new Uint8Array(result.data), {
    headers: {
      'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'content-disposition': 'attachment; filename="bcs-holidays-template.xlsx"',
      'cache-control': 'no-store',
    },
  })
}
