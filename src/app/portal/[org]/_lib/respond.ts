import { NextResponse } from 'next/server'
import { appUrl } from '@/server/portal/http'
import type { PortalOrg } from '@/server/portal/org'

// Answers of the portal's route handlers (ADR-184): a form posted by the browser is answered with a 303 to the page that
// shows the result (the page reads ?error= and words it), never a page built by the handler. Unknown organization or no
// session: 404, the same answer for both (BR-PORTAL ข้อ 01 ข้อ 03).

export const notFound = (): NextResponse => NextResponse.json({ code: 'NOT_FOUND' }, { status: 404 })

export const forbiddenCsrf = (): NextResponse => NextResponse.json({ code: 'FORBIDDEN', reason: 'CSRF' }, { status: 403 })

/** 303 to a page of the organization's portal, with its query */
export function seeOther(org: PortalOrg, page: string, query: Record<string, string | number | undefined> = {}): NextResponse {
  const url = appUrl(`/portal/${org.code}${page}`)
  for (const [k, v] of Object.entries(query)) if (v !== undefined) url.searchParams.set(k, String(v))
  return NextResponse.redirect(url, 303)
}

export async function formOf(request: Request): Promise<FormData> {
  try {
    return await request.formData()
  } catch {
    return new FormData()
  }
}

export const field = (form: FormData, name: string): string => {
  const v = form.get(name)
  return typeof v === 'string' ? v : ''
}
