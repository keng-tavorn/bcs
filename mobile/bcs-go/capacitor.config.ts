import type { CapacitorConfig } from '@capacitor/cli'

// BCS Go (ADR-163, BR-APP-01): the app holds no business code. Capacitor opens the BCS web of one environment with
// server.url (nothing of the web is bundled), the WebView stays on that origin (allowNavigation; any other link opens
// the phone's browser), and the user agent carries the app's mark so the web records the APP channel (BR-APP-02).
// The CLI (cap sync) reads BCS_GO_SERVER_URL; the APK workflow (.github/workflows/bcs-go-apk.yml) sets it per build.

/** Same text as APP_USER_AGENT_MARKER of src/lib/app-client.ts (this folder may not import src; tests compare them) */
export const APP_USER_AGENT_MARKER = 'BCSGo'
/** Same as "version" of package.json (tests compare them) */
export const APP_VERSION = '0.1.0'

// Plain http only for a web on this computer seen from the Android emulator (10.0.2.2) or a USB-forwarded port
const LOCAL_HTTP_HOSTS = new Set(['localhost', '127.0.0.1', '10.0.2.2'])

export function serverOrigin(raw: string | undefined): URL {
  const value = raw?.trim()
  if (!value) throw new Error('BCS_GO_SERVER_URL is not set: give the web of the environment, e.g. https://bcs-staging-demo.vercel.app')
  const url = new URL(value)
  const local = url.protocol === 'http:' && LOCAL_HTTP_HOSTS.has(url.hostname)
  if (url.protocol !== 'https:' && !local) throw new Error(`BCS_GO_SERVER_URL must be https (http only for ${[...LOCAL_HTTP_HOSTS].join(', ')})`)
  if (url.pathname !== '/' || url.search || url.hash || url.username || url.password) throw new Error('BCS_GO_SERVER_URL is an origin only, e.g. https://bcs.example.com')
  return url
}

export function bcsGoConfig(env: Readonly<Record<string, string | undefined>>): CapacitorConfig {
  const origin = serverOrigin(env.BCS_GO_SERVER_URL)
  return {
    // The demo's id; the store id is settled with the store release (S17-20, OQ-166)
    appId: 'th.bcs.go',
    appName: 'BCS Go',
    // Required by the CLI; only shown if the web cannot be opened at all
    webDir: 'www',
    appendUserAgent: `${APP_USER_AGENT_MARKER}/${APP_VERSION}`,
    server: {
      url: origin.origin,
      allowNavigation: [origin.hostname],
      ...(origin.protocol === 'http:' ? { cleartext: true } : {}),
    },
    android: {
      allowMixedContent: false,
      // Chrome's remote inspector, for a debug build on the developer's own phone only
      webContentsDebuggingEnabled: env.BCS_GO_WEBVIEW_DEBUG === '1',
    },
  }
}

export default bcsGoConfig(process.env)
