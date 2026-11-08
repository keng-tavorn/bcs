import { err, ok, type Result } from '@/core/result'
import { PORTAL_PRIVACY_NOTICE_VERSION } from '@/lib/portal-limits'

// The privacy notice of the portal (BR-PORTAL ข้อ 08 · NFR-PRIV-02 · OQ-188): a notice, not consent. Its words for each
// version are in messages portal.json (privacy.<version>); a contact who accepted an older version sees the current one
// before any other page and uploads nothing until they accept it (PRIVACY_NOTICE_OUTDATED).

export { PORTAL_PRIVACY_NOTICE_VERSION }

export const privacyNoticeCurrent = (contact: { readonly privacyNoticeVersion: string | null }): boolean => contact.privacyNoticeVersion === PORTAL_PRIVACY_NOTICE_VERSION

/** Refuses what needs the current notice accepted (uploads, an application's submit) */
export function requireCurrentPrivacyNotice(contact: { readonly privacyNoticeVersion: string | null }): Result<true> {
  return privacyNoticeCurrent(contact) ? ok(true) : err('PRIVACY_NOTICE_OUTDATED', 'the current privacy notice is not accepted yet', { version: PORTAL_PRIVACY_NOTICE_VERSION })
}
