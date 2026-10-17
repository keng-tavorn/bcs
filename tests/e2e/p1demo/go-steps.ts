import { randomBytes } from 'node:crypto'
import { devices, type Browser, type BrowserContext, type CDPSession, type Locator, type Page } from '@playwright/test'
import { E2E_BASE_URL, E2E_FAKE_LINE_URL } from '../../support/e2e-env'

// The phone with BCS Go of the scenes of phase 1 (P1-08 scenes 2 and 7), as tests/e2e/s17.spec.ts holds them for the
// twin of S17-16 (a spec file cannot import another, so they are copied here): the mobile browser with the app's mark in
// its user agent — the app's WebView sends it, and the server reads the channel APP from it — Chromium's virtual
// authenticator as the fingerprint, a camera-sized photo, the queue's counts of /go/receive, and the fake FCM of the run.
// The native halves (FCM's token, the tap on the notification, the camera, the fingerprint itself) are tried on a phone
// (docs/runbooks/bcs-go-demo.md).

/** What the WebView of BCS Go adds to the phone's user agent (mobile/bcs-go/capacitor.config.ts) */
export const APP_MARK = 'BCSGo/0.1.0'

/** The fake FCM of the run, for the delivery job a scene plays (PUSH_PROVIDER=fake is local only; env.ts reads it once) */
export const FAKE_PUSH_ENV: Readonly<Record<string, string>> = {
  PUSH_PROVIDER: 'fake',
  FCM_PROJECT_ID: 'bcs-go-e2e',
  FCM_API_BASE_URL: `${E2E_FAKE_LINE_URL}/fcm`,
  FCM_TOKEN_URL: `${E2E_FAKE_LINE_URL}/fcm/token`,
}

/** A push the fake FCM of the run accepted */
export interface FakePush {
  readonly token: string
  readonly title: string
  readonly body: string | null
  readonly data: Readonly<Record<string, string>>
}

/** Every push the fake FCM accepted in this run */
export async function fakePushes(): Promise<FakePush[]> {
  const response = await fetch(`${E2E_FAKE_LINE_URL}/__fake/pushes`)
  if (!response.ok) throw new Error(`fake FCM /__fake/pushes: ${response.status}`)
  return ((await response.json()) as { pushes: FakePush[] }).pushes
}

/**
 * The phone with the app: a Pixel 7 at 375 px, BCS Go's mark in its user agent, Thai and Bangkok time, and an address of
 * its own (sign-in limits counted per address never meet another test's). `serviceWorkers: 'block'` lets a page's route
 * see the requests the worker would otherwise send.
 */
export async function appPhone(browser: Browser, options: { serviceWorkers?: 'allow' | 'block' } = {}): Promise<BrowserContext> {
  const [a, b] = randomBytes(2)
  const phone = devices['Pixel 7']
  return browser.newContext({
    ...phone,
    viewport: { width: 375, height: 812 },
    userAgent: `${phone.userAgent} ${APP_MARK}`,
    baseURL: E2E_BASE_URL,
    locale: 'th-TH',
    timezoneId: 'Asia/Bangkok',
    serviceWorkers: options.serviceWorkers ?? 'allow',
    extraHTTPHeaders: { 'x-forwarded-for': `198.18.${a!}.${(b! % 254) + 1}` },
  })
}

/** Chromium's virtual authenticator on the page: a platform one with user verification, as a phone's fingerprint is */
export async function fingerprint(page: Page): Promise<CDPSession> {
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('WebAuthn.enable')
  await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
  })
  return cdp
}

/** The count of one kind of the queue on /go/receive (รอส่ง, อาจบันทึกแล้ว, …) */
export const pending = (page: Page, label: string): Locator =>
  page
    .locator('dl > div')
    .filter({ has: page.locator('dt', { hasText: new RegExp(`^${label}$`) }) })
    .locator('dd')

/** A camera-sized photo made by the browser itself (a real JPEG, so the page can shrink it before keeping it) */
export async function photo(page: Page): Promise<Buffer> {
  const base64 = await page.evaluate(async () => {
    const canvas = document.createElement('canvas')
    canvas.width = 3000
    canvas.height = 2000
    const ctx = canvas.getContext('2d')!
    ctx.fillStyle = '#6b6b6b'
    ctx.fillRect(0, 0, 3000, 2000)
    const blob = await new Promise<Blob>((resolve) => canvas.toBlob((b) => resolve(b!), 'image/jpeg', 0.9))
    const bytes = new Uint8Array(await blob.arrayBuffer())
    let text = ''
    for (const b of bytes) text += String.fromCharCode(b)
    return btoa(text)
  })
  return Buffer.from(base64, 'base64')
}
