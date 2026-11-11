import { randomUUID } from 'node:crypto'
import { localeCookieName } from '@/i18n/locales'
import { LOCALE_COOKIE_MAX_AGE_SECONDS } from '@/lib/constants'
import { portalAuthorize } from '@/server/portal/authz'
import { portalRequest, postSession } from '@/server/portal/http'
import { PORTAL_CSRF_COOKIE, PORTAL_SESSION_COOKIE, portalCookieOptions } from '@/server/portal/session'
import { closeOwnContact, setOwnContactLocale } from '@/server/services/suppliers/contacts'
import { field, forbiddenCsrf, formOf, notFound, seeOther } from '../../_lib/respond'

// POST /portal/<org>/api/profile (S7-08 · docs/sub-specs/S7.md "/portal/profile"): what a contact changes of their own
// account — the language of the portal and of the e-mails (SupplierContact.locale, and the locale cookie of this
// browser), or closing the account (confirmed with a tick, then signed out). Where to go next is one of a fixed list,
// never a URL from the form.

const NEXT = { profile: '/profile', 'apply-bank': '/apply?step=bank' } as const

export async function POST(request: Request, { params }: { params: Promise<{ org: string }> }) {
  const req = await portalRequest(request, (await params).org)
  if (!req) return notFound()
  const form = await formOf(request)
  const state = await postSession(request, req, field(form, 'csrf'), 'profile')
  if (state === 'NONE') return notFound()
  if (state === 'CSRF') return forbiddenCsrf()
  if (!portalAuthorize(state.ctx, 'portal.contact.self').ok) return seeOther(req.org, '/profile', { error: 'FORBIDDEN' })
  const key = { idempotencyKey: field(form, 'key') || randomUUID() }
  if (field(form, 'action') === 'locale') {
    const locale = field(form, 'locale')
    const next = field(form, 'next') === 'apply-bank' ? NEXT['apply-bank'] : NEXT.profile
    if (locale !== 'th' && locale !== 'en') return seeOther(req.org, '/profile', { error: 'VALIDATION_FAILED' })
    const r = await setOwnContactLocale(state.ctx, { locale }, key)
    if (!r.ok) return seeOther(req.org, '/profile', { error: r.error.code })
    const [page, query] = next.split('?')
    const res = seeOther(req.org, page!, query ? Object.fromEntries(new URLSearchParams(query)) : { saved: 1 })
    res.cookies.set(localeCookieName, locale, { path: '/', sameSite: 'lax', maxAge: LOCALE_COOKIE_MAX_AGE_SECONDS })
    return res
  }
  if (field(form, 'action') === 'close') {
    if (field(form, 'confirm') !== '1') return seeOther(req.org, '/profile', { error: 'CONFIRM' })
    const r = await closeOwnContact(state.ctx, key)
    if (!r.ok) return seeOther(req.org, '/profile', { error: r.error.details?.reason === 'PRIMARY_CONTACT' ? 'PRIMARY_CONTACT' : r.error.code })
    const res = seeOther(req.org, '/login', { closed: 1 })
    res.cookies.set(PORTAL_SESSION_COOKIE, '', portalCookieOptions(req.org, { maxAgeMs: 0 }))
    res.cookies.set(PORTAL_CSRF_COOKIE, '', portalCookieOptions(req.org, { maxAgeMs: 0, httpOnly: false }))
    return res
  }
  return seeOther(req.org, '/profile', { error: 'VALIDATION_FAILED' })
}
