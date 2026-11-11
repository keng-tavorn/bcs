import { localeCookieName } from '@/i18n/locales'
import { LOCALE_COOKIE_MAX_AGE_SECONDS, MS_PER_HOUR } from '@/lib/constants'
import { supplierSettingsOf } from '@/lib/org-settings'
import { verifyPortalOtp } from '@/server/portal/commands'
import { portalRequest, sameOrigin } from '@/server/portal/http'
import { organizationSettings } from '@/server/portal/org'
import { portalRiskLanding } from '@/server/portal/queries-risk'
import { PORTAL_CSRF_COOKIE, PORTAL_PENDING_COOKIE, PORTAL_SESSION_COOKIE, portalCookieOptions, readPortalSession } from '@/server/portal/session'
import { field, forbiddenCsrf, formOf, notFound, seeOther } from '../../_lib/respond'

// POST /portal/<org>/api/otp (BR-PORTAL ข้อ 02 ข้อ 03): the code typed. Right → a new session: bcs_portal (HttpOnly) and
// the CSRF token the pages send back (bcs_portal_csrf), both under /portal/<org> only, and the pending cookie dropped;
// the locale cookie set to the contact's language.

export async function POST(request: Request, { params }: { params: Promise<{ org: string }> }) {
  const req = await portalRequest(request, (await params).org)
  if (!req) return notFound()
  if (!sameOrigin(request)) return forbiddenCsrf()
  const pending = req.cookies.get(PORTAL_PENDING_COOKIE) ?? ''
  const dot = pending.indexOf('.')
  if (dot <= 0) return seeOther(req.org, '/login', { error: 'OTP_EXPIRED' })
  const r = await verifyPortalOtp(
    req.org,
    { challengeId: pending.slice(0, dot), token: pending.slice(dot + 1), code: field(await formOf(request), 'code').trim(), priorSessionId: req.cookies.get(PORTAL_SESSION_COOKIE) ?? null },
    req.meta,
  )
  if (!r.ok) {
    const again = r.error.code === 'OTP_INVALID' || r.error.code === 'OTP_LOCKED' || r.error.code === 'VALIDATION_FAILED'
    const details = r.error.details ?? {}
    return seeOther(req.org, again ? '/otp' : '/login', {
      error: r.error.code,
      remaining: typeof details.remaining === 'number' ? details.remaining : undefined,
      until: typeof details.lockedUntil === 'string' ? details.lockedUntil : undefined,
    })
  }
  const maxAgeMs = supplierSettingsOf(await organizationSettings(req.org)).sessionMaxHours * MS_PER_HOUR
  // S11-05 (BR-RSK-17): a contact who came by a questionnaire's link lands on that questionnaire
  const session = await readPortalSession(req.org, r.data.sessionId, req.meta.now)
  const res = seeOther(req.org, session ? await portalRiskLanding(session.ctx) : '')
  res.cookies.set(PORTAL_SESSION_COOKIE, r.data.sessionId, portalCookieOptions(req.org, { maxAgeMs }))
  res.cookies.set(PORTAL_CSRF_COOKIE, r.data.csrfToken, portalCookieOptions(req.org, { maxAgeMs, httpOnly: false }))
  res.cookies.set(PORTAL_PENDING_COOKIE, '', portalCookieOptions(req.org, { maxAgeMs: 0 }))
  // the pages speak the contact's language (S7-08 · SupplierContact.locale, changed on /portal/<org>/profile)
  res.cookies.set(localeCookieName, r.data.locale, { path: '/', sameSite: 'lax', maxAge: LOCALE_COOKIE_MAX_AGE_SECONDS })
  return res
}
