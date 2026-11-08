import { cookies } from 'next/headers'
import { getLocale, getTranslations } from 'next-intl/server'
import { systemClock } from '@/lib/clock'
import { resolvePortalOrg, type PortalOrg } from '@/server/portal/org'
import { portalInvoicesShown } from '@/server/portal/queries-invoices'
import { PORTAL_CSRF_COOKIE, PORTAL_SESSION_COOKIE, readPortalSession, type PortalSessionState } from '@/server/portal/session'
import { PortalFrame, PortalNotice } from '@/ui/portal/frame'

// What every page of /portal/[org] reads (BR-PORTAL ข้อ 01 ข้อ 03): the organization of its path (unknown or without
// SUPPLIER → the same "not available" page), and the portal's own cookies — never a Workspace session.

export async function pageOrg(code: string): Promise<PortalOrg | null> {
  return resolvePortalOrg(code)
}

/**
 * The live session of this organization's portal and its CSRF token for the page's forms, or null; `invoices` says whether
 * the menu shows invoices and payments (S7-12: PAY on, supplier.portalInvoice, an ACTIVE supplier)
 */
export async function pageSession(org: PortalOrg): Promise<{ readonly state: PortalSessionState; readonly csrf: string; readonly invoices: boolean } | null> {
  const jar = await cookies()
  const state = await readPortalSession(org, jar.get(PORTAL_SESSION_COOKIE)?.value, systemClock.now())
  if (!state) return null
  const invoices = state.ctx.actor.type === 'SUPPLIER' && state.ctx.actor.supplierId ? await portalInvoicesShown(state.ctx) : false
  return { state, csrf: jar.get(PORTAL_CSRF_COOKIE)?.value ?? '', invoices }
}

export async function Unavailable() {
  const t = await getTranslations('portal')
  return (
    <PortalFrame organization={t('title')} title={t('unavailable.title')}>
      <PortalNotice tone="info">{t('unavailable.body')}</PortalNotice>
    </PortalFrame>
  )
}

const ERRORS = ['RATE_LIMITED', 'TOKEN_INVALID', 'TOKEN_USED', 'TOKEN_EXPIRED', 'OTP_INVALID', 'OTP_LOCKED', 'OTP_EXPIRED', 'VALIDATION_FAILED', 'PRIVACY_NOTICE_OUTDATED'] as const

/** The words of ?error= as the handlers send it back; an unknown code reads as a failure */
export async function ErrorNotice({ code, remaining, until }: { readonly code?: string; readonly remaining?: string; readonly until?: string }) {
  if (!code) return null
  const [t, locale] = await Promise.all([getTranslations('portal'), getLocale()])
  const known = (ERRORS as readonly string[]).includes(code) ? (code as (typeof ERRORS)[number]) : null
  const text =
    known === 'OTP_INVALID'
      ? t('errors.OTP_INVALID', { remaining: Number(remaining ?? 0) })
      : known === 'OTP_LOCKED'
        ? t('errors.OTP_LOCKED', { time: until ? new Date(until).toLocaleTimeString(locale === 'en' ? 'en-GB' : 'th-TH', { timeZone: 'Asia/Bangkok', hour: '2-digit', minute: '2-digit' }) : '-' })
        : known
          ? t(`errors.${known}`)
          : t('errors.FAILED')
  return <PortalNotice tone="danger">{text}</PortalNotice>
}

export type SearchParams = Promise<Record<string, string | string[] | undefined>>
export const one = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v[0] : v)

type PortalT = Awaited<ReturnType<typeof getTranslations<'portal'>>>
type Section = 'home' | 'apply' | 'pos' | 'invoices' | 'payments' | 'documents' | 'bank-account' | 'profile' | 'help'

/**
 * The portal's sections for who is signed in: an application's contact has the form; a supplier's, its home and
 * documents — and its invoices and payments when the organization takes invoices on the portal (S7-12)
 */
export function portalNav(orgCode: string, t: PortalT, current: Section, who: 'SUPPLIER' | 'APPLICATION', invoices = false) {
  const sections: Section[] = who === 'SUPPLIER' ? ['home', 'pos', ...(invoices ? (['invoices', 'payments'] as const) : []), 'documents', 'bank-account', 'profile', 'help'] : ['apply', 'profile', 'help']
  return sections.map((s) => ({ href: `/portal/${orgCode}/${s}`, label: t(`nav.${s === 'bank-account' ? 'bank' : s}`), current: s === current }))
}
