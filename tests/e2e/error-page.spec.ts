import { readFileSync } from 'node:fs'
import path from 'node:path'
import { localeCookieName } from '../../src/i18n/locales'
import { E2E_BASE_URL } from '../support/e2e-env'
import { expect, test } from './fixtures'
import { expectNoBlockingAxe, expectTouchTargets } from './liff-support'

// §14.2 INTERNAL · §9.9 · NFR-A11Y-02: the error page of the app (src/app/error.tsx), drawn with plain elements in the look
// of the danger notice and the main button so that it adds little to every page's first JavaScript (§9.4). A page that
// fails on purpose on this machine (src/app/(auth)/dev/error/page.tsx, 404 elsewhere) shows it, at 1440 px in the desktop
// project and at 375 px in the mobile one: what happened, that saved work is safe, the reference to tell the BCS team and
// never the error's own text, the way to try again and the way home, in Thai and in English, with axe and 44 px targets.

const catalogue = (locale: 'th' | 'en') =>
  (JSON.parse(readFileSync(path.resolve(import.meta.dirname, `../../messages/${locale}.json`), 'utf8')) as { app: { error: Record<'title' | 'body' | 'reference' | 'retry' | 'home', string> } }).app.error

for (const locale of ['th', 'en'] as const) {
  test(`[§14.2] [§9.9] [NFR-A11Y-02] an unexpected error shows what happened, its reference and the ways on, in ${locale === 'th' ? 'Thai' : 'English'}`, async ({ page, context }, testInfo) => {
    const words = catalogue(locale)
    await context.addCookies([{ name: localeCookieName, value: locale, url: E2E_BASE_URL }])
    await page.goto('/dev/error')
    await expect(page.getByRole('heading', { level: 1, name: words.title })).toBeVisible()
    await expect(page.locator('html')).toHaveAttribute('lang', locale)
    const notice = page.getByRole('alert').filter({ hasText: words.body })
    await expect(notice).toBeVisible()
    // The reference is Next.js's digest of the error, never its text
    const [before] = words.reference.split('{reference}')
    await expect(notice.getByText(new RegExp(`^${before!}\\S+$`))).toBeVisible()
    await expect(page.getByText('the error page on purpose')).toHaveCount(0)
    await expect(page.getByRole('button', { name: words.retry })).toBeVisible()
    await expect(page.getByRole('link', { name: words.home })).toHaveAttribute('href', '/')
    await expectNoBlockingAxe(page)
    await expectTouchTargets(page)
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0)
    await page.screenshot({ path: testInfo.outputPath(`error-page-${locale}.png`), fullPage: true })
    // The way home loads the home page afresh; signed out, that is the sign-in
    await page.getByRole('link', { name: words.home }).click()
    await expect(page).toHaveURL(/\/login/)
  })
}
