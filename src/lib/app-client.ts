// The BCS Go app (ADR-163) is the web in a Capacitor WebView that adds "BCSGo/<version>" to its user agent
// (mobile/bcs-go/capacitor.config.ts appendUserAgent). The web reads the mark to record the APP channel of a request:
// for audit and KPI only, never to grant anything (BR-APP-02) — a user agent is whatever the sender says.

/** Same text as mobile/bcs-go/capacitor.config.ts (tests/unit/bcs-go-shell.test.ts compares them) */
export const APP_USER_AGENT_MARKER = 'BCSGo'

// A token of its own in the user agent: "… Chrome/140.0 Mobile Safari/537.36 BCSGo/0.1.0"
const APP_MARK = new RegExp(`(?:^|\\s)${APP_USER_AGENT_MARKER}/\\d+\\.\\d+\\.\\d+(?:\\s|$)`)

export function isAppUserAgent(userAgent: string | null | undefined): boolean {
  return typeof userAgent === 'string' && APP_MARK.test(userAgent)
}

/** One statement of /.well-known/assetlinks.json (Digital Asset Links) */
export interface AssetLinkStatement {
  readonly relation: readonly string[]
  readonly target: { readonly namespace: 'android_app'; readonly package_name: string; readonly sha256_cert_fingerprints: readonly string[] }
}

/**
 * /.well-known/assetlinks.json (ADR-166): the BCS Go app of this package, signed with one of these certificates, is
 * this domain's app, so its WebView may use the domain's passkeys (get_login_creds) and open its links. The values come
 * from BCS_GO_ANDROID_PACKAGE and BCS_GO_ANDROID_CERT_SHA256 (src/lib/env.ts checks their form); null when either is
 * unset, and the route answers 404.
 */
export function assetLinksOf(androidPackage: string | undefined, certSha256: string | undefined): readonly AssetLinkStatement[] | null {
  if (!androidPackage || !certSha256) return null
  return [
    {
      relation: ['delegate_permission/common.handle_all_urls', 'delegate_permission/common.get_login_creds'],
      target: { namespace: 'android_app', package_name: androidPackage, sha256_cert_fingerprints: certSha256.split(',') },
    },
  ]
}
