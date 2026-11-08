import AxeBuilder from '@axe-core/playwright'
import { spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { devices, type Browser, type BrowserContext, type Page } from '@playwright/test'
import { totp, deriveSeedTotpSecret } from '../../src/lib/totp'
import { lineUserOf } from '../../tests/e2e/demo/support'
import { expect, test } from '../../tests/e2e/fixtures'
import { BARS_IN_PLACE, FIRST_LOAD_JS_BUDGET_BYTES, openAsLineUser, pointerAway, weighFirstLoad } from '../../tests/e2e/liff-support'
import { day, p1Sheet, signInAs, type P1Sheet } from '../../tests/e2e/p1demo/support'
import { s7 } from '../../tests/e2e/p2demo/support'
import { E2E_PLATFORM_ADMIN } from '../../tests/e2e/platform-admin'
import { settled } from '../../tests/e2e/settled'
import { E2E_BASE_URL, e2eEnv } from '../../tests/support/e2e-env'

// S7-18 (§9.9 step 4 · the P1-09 way): every page of S7's screen table (docs/sub-specs/S7.md "หน้าจอ") — the supplier
// portal, the applications, the invitation, the supplier's page, the task of an application on the web and in LINE, the
// PO's acknowledgement, finance's portal filters, the supplier report, the document types and the module switch — opened
// by the person who uses it on the SIMEC database the @p2demo scenes played on, at 1440 × 900 and 375 × 812: a full-page
// picture, axe (serious and critical), sideways scroll and text below 14 px (16 px on a phone); the portal pages also
// weigh their first JavaScript (at most 200 KB gzip with the page data · §9.4 · ADR-184). The pictures go to
// docs/design-review/s7/<name>-<width>.png and what was measured to docs/design-review/s7/shots.json, which
// docs/design-review/s7.md reads. Run by scripts/design-review/s7.config.ts (after the scenes, or on their database again).

const OUT = path.resolve('docs/design-review/s7')
const JOURNAL = path.join(OUT, 'checks.jsonl')
const WIDE = { width: 1440, height: 900 }
const PHONE = { width: 375, height: 812 }

type Kind = 'web' | 'liff' | 'portal' | 'portal-out' | 'platform'
interface Screen {
  /** The pictures' base name */
  readonly name: string
  /** A member's code (web, liff), the contact's e-mail (portal) */
  readonly who: string | null
  readonly path: string | null
  readonly kind: Kind
}

interface Targets {
  org: string
  organizationId: string
  supplierId: string
  supplierContact: string
  sentPo: string | null
  portalInvoice: string | null
  stuckApplication: string | null
  appliedApplication: string | null
  bankChange: string | null
  supplierTask: { id: string; code: string | null } | null
  ackedPo: string | null
}

function data<T>(...args: string[]): T {
  const r = spawnSync(`pnpm exec tsx scripts/design-review/s7-data.ts ${args.join(' ')}`, { shell: true, encoding: 'utf8', env: { ...process.env, ...e2eEnv(), E2E_P2DEMO: '1' }, maxBuffer: 64 * 1024 * 1024 })
  if (r.status !== 0) throw new Error(`s7-data ${args[0]} failed:\n${r.stderr}`)
  return JSON.parse(r.stdout.trim().split('\n').at(-1)!) as T
}

const t = data<Targets>('targets')
const P = `/portal/${t.org}`
const STUCK_CONTACT = 'bpk@supplier.simec.local'
const at = (id: string | null, to: (id: string) => string) => (id ? to(id) : null)

const SCREENS: Screen[] = [
  // the portal of an ACTIVE supplier's primary contact (SP0029, the contact of scene 6)
  { name: 'portal_login', who: null, path: `${P}/login`, kind: 'portal-out' },
  { name: 'portal_home', who: t.supplierContact, path: `${P}/home`, kind: 'portal' },
  { name: 'portal_pos', who: t.supplierContact, path: `${P}/pos`, kind: 'portal' },
  { name: 'portal_po', who: t.supplierContact, path: at(t.sentPo, (id) => `${P}/pos/${id}`), kind: 'portal' },
  { name: 'portal_documents', who: t.supplierContact, path: `${P}/documents`, kind: 'portal' },
  { name: 'portal_bank-account', who: t.supplierContact, path: `${P}/bank-account`, kind: 'portal' },
  { name: 'portal_invoices', who: t.supplierContact, path: `${P}/invoices`, kind: 'portal' },
  { name: 'portal_invoices_new', who: t.supplierContact, path: `${P}/invoices/new`, kind: 'portal' },
  { name: 'portal_invoice', who: t.supplierContact, path: at(t.portalInvoice, (id) => `${P}/invoices/${id}`), kind: 'portal' },
  { name: 'portal_payments', who: t.supplierContact, path: `${P}/payments`, kind: 'portal' },
  { name: 'portal_profile', who: t.supplierContact, path: `${P}/profile`, kind: 'portal' },
  { name: 'portal_help', who: t.supplierContact, path: `${P}/help`, kind: 'portal' },
  // the application of the stuck supplier (scene 2), each step of the form
  ...(['company', 'tax', 'contact', 'bank', 'documents', 'review'] as const).map((step) => ({ name: `portal_apply_${step}`, who: STUCK_CONTACT, path: `${P}/apply?step=${step}`, kind: 'portal' as const })),
  // the workspace
  { name: 'proc_mat1_applications', who: 'proc_mat1', path: '/suppliers/applications', kind: 'web' },
  { name: 'proc_mat1_application_stuck', who: 'proc_mat1', path: at(t.stuckApplication, (id) => `/suppliers/applications/${id}`), kind: 'web' },
  { name: 'proc_sub1_application_approved', who: 'proc_sub1', path: at(t.appliedApplication, (id) => `/suppliers/applications/${id}`), kind: 'web' },
  { name: 'proc_sub1_invite', who: 'proc_sub1', path: '/suppliers/invite', kind: 'web' },
  { name: 'proc_sub1_invite_existing', who: 'proc_sub1', path: '/suppliers/invite?kind=existing', kind: 'web' },
  { name: 'proc_mat1_supplier', who: 'proc_mat1', path: `/suppliers/${t.supplierId}`, kind: 'web' },
  { name: 'proc_officer_po_acked', who: 'proc_officer', path: at(t.ackedPo, (id) => `/procurement/pos/${id}`), kind: 'web' },
  { name: 'task_supplier_application', who: t.supplierTask?.code ?? null, path: at(t.supplierTask?.id ?? null, (id) => `/tasks/${id}`), kind: 'web' },
  { name: 'liff_task_supplier_application', who: t.supplierTask?.code ?? null, path: at(t.supplierTask?.id ?? null, (id) => `/liff/tasks/${id}`), kind: 'liff' },
  { name: 'fin_ap1_invoices_portal', who: 'fin_ap1', path: '/finance/invoices?channel=PORTAL', kind: 'web' },
  { name: 'fin_ap1_bank-changes', who: 'fin_ap1', path: '/finance/bank-accounts/changes', kind: 'web' },
  { name: 'fin_ap1_bank-change_portal', who: 'fin_ap1', path: at(t.bankChange, (id) => `/finance/bank-accounts/changes/${id}`), kind: 'web' },
  { name: 'dm_proc_reports_suppliers', who: 'dm_proc', path: '/reports/suppliers', kind: 'web' },
  { name: 'admin_supplier-document-types', who: 'admin', path: '/admin/supplier-document-types', kind: 'web' },
  { name: 'platform_tenant_modules', who: 'platform', path: `/platform/tenants/${t.organizationId}/modules`, kind: 'platform' },
]

let sheet: P1Sheet
test.beforeAll(async () => {
  test.setTimeout(600_000)
  mkdirSync(OUT, { recursive: true })
  sheet = await p1Sheet()
  // the BCS team's account for the /platform page (the scenes' database has none) and the LINE link of the task's holder
  const r = spawnSync('pnpm exec tsx tests/e2e/seed-platform-admin.ts', { shell: true, encoding: 'utf8', env: { ...process.env, ...e2eEnv() } })
  if (r.status !== 0) throw new Error(`the platform admin: ${r.stderr}`)
  if (t.supplierTask?.code) day('prepare', `${t.supplierTask.code}:${lineUserOf(t.supplierTask.code)}`)
})

test.afterAll(() => {
  if (!existsSync(JOURNAL)) return
  const byName = new Map<string, unknown>()
  for (const line of readFileSync(JOURNAL, 'utf8').split('\n').filter(Boolean)) byName.set((JSON.parse(line) as { name: string }).name, JSON.parse(line))
  writeFileSync(path.join(OUT, 'shots.json'), `${JSON.stringify([...byName.values()], null, 2)}\n`)
})

async function signInPlatform(page: Page) {
  await page.goto('/login')
  await page.getByLabel('อีเมลบริษัท').fill(E2E_PLATFORM_ADMIN.email)
  await page.getByLabel('รหัสผ่าน').fill(process.env.SEED_DEV_PASSWORD!)
  await page.getByRole('button', { name: 'เข้าสู่ระบบ' }).click()
  await page.getByLabel('รหัส 6 หลักจากแอป').fill(totp(deriveSeedTotpSecret(process.env.SEED_TOTP_KEY!, E2E_PLATFORM_ADMIN.code)))
  await page.getByRole('button', { name: 'ยืนยันและเข้าสู่ระบบ' }).click()
  await expect(page).toHaveURL(/\/platform\/tenants$/)
}

async function context(browser: Browser, size: { width: number; height: number }, ip: string): Promise<BrowserContext> {
  const device = size.width < 768 ? devices['Pixel 7'] : devices['Desktop Chrome']
  return browser.newContext({ ...device, viewport: size, baseURL: E2E_BASE_URL, locale: 'th-TH', timezoneId: 'Asia/Bangkok', extraHTTPHeaders: { 'x-forwarded-for': ip } })
}

/** A session of the portal for the contact, as its sign-in sets it (tests/e2e/p2demo/scripts/s7.ts session) */
async function portalSignIn(ctx: BrowserContext, email: string) {
  const { sid, csrf } = s7<{ sid: string; csrf: string }>('session', email)
  await ctx.addCookies([
    { name: 'bcs_portal', value: sid, url: `${E2E_BASE_URL}${P}` },
    { name: 'bcs_portal_csrf', value: csrf, url: `${E2E_BASE_URL}${P}` },
  ])
}

/** What one width of a screen measures: axe (serious, critical), sideways scroll, small text */
async function measure(page: Page, screen: Screen, width: number) {
  await pointerAway(page)
  await settled(page)
  const axe = await new AxeBuilder({ page }).analyze()
  const blocking = axe.violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical')
    .map((v) => `${v.impact} ${v.id}: ${v.help} (${v.nodes.slice(0, 4).map((n) => n.target.join(' ')).join(', ')})`)
  const minimum = width < 768 ? 16 : 14
  const found = await page.evaluate((minimum) => {
    const visible = (el: Element) => {
      const r = el.getBoundingClientRect()
      const s = getComputedStyle(el)
      return r.width > 1 && r.height > 1 && s.visibility !== 'hidden' && s.display !== 'none' && !el.closest('[aria-hidden="true"], .sr-only, nextjs-portal')
    }
    const small: string[] = []
    for (const el of document.querySelectorAll('body *')) {
      const own = [...el.childNodes].some((n) => n.nodeType === Node.TEXT_NODE && (n.textContent ?? '').trim() !== '')
      if (!own || !visible(el)) continue
      const size = parseFloat(getComputedStyle(el).fontSize)
      if (size < minimum) small.push(`${el.tagName.toLowerCase()} "${(el.textContent ?? '').trim().slice(0, 40)}" ${size}px`)
    }
    return { sideways: document.documentElement.scrollWidth - document.documentElement.clientWidth, small: [...new Set(small)] }
  }, minimum)
  const file = path.join(OUT, `${screen.name}-${width}.png`)
  await page.screenshot({ path: file, fullPage: true, style: screen.kind === 'liff' ? BARS_IN_PLACE : undefined })
  return { picture: path.relative(process.cwd(), file).split(path.sep).join('/'), axe: blocking, sideways: found.sideways, smallText: found.small.slice(0, 20), smallTextCount: found.small.length }
}

for (const screen of SCREENS) {
  test(`S7-18 ${screen.name}`, async ({ browser, clientIp }) => {
    test.setTimeout(240_000)
    test.skip(!screen.path || (screen.kind !== 'portal-out' && !screen.who), `no record for ${screen.name} on this database`)
    const record: Record<string, unknown> = { name: screen.name, who: screen.who, kind: screen.kind, path: screen.path }
    const widths = screen.kind === 'liff' || screen.kind.startsWith('portal') ? [PHONE, WIDE] : [WIDE, PHONE]
    for (const size of widths) {
      const ctx = await context(browser, size, clientIp)
      if (screen.kind === 'liff') {
        day('prepare', `${screen.who}:${lineUserOf(screen.who!)}`)
        await openAsLineUser(ctx, lineUserOf(screen.who!))
      } else if (screen.kind === 'portal') await portalSignIn(ctx, screen.who!)
      const page = await ctx.newPage()
      if (screen.kind === 'platform') await signInPlatform(page)
      else if (screen.kind === 'web') await signInAs(page, sheet, screen.who!)
      // the portal's first JavaScript, weighed once on the phone with nothing cached (§9.4 · ADR-184)
      if (screen.kind.startsWith('portal') && size.width < 768) {
        const load = await weighFirstLoad(page, screen.path!, () => page.locator('h1').first().waitFor({ timeout: 20_000 }))
        record.firstLoadJs = { total: load.total, note: load.note, merge: load.loads.filter((l) => l.merge).length }
      } else {
        const response = await page.goto(screen.path!)
        record.status = response?.status() ?? null
        await page.locator('h1').first().waitFor({ timeout: 20_000 }).catch(() => undefined)
      }
      record.landed = new URL(page.url()).pathname
      record.h1 = ((await page.locator('h1').first().textContent({ timeout: 2_000 }).catch(() => null)) ?? '').trim()
      record[size.width] = await measure(page, screen, size.width)
      await ctx.close()
    }
    appendFileSync(JOURNAL, `${JSON.stringify(record)}\n`)
    for (const size of widths) {
      const m = record[size.width] as { axe: string[]; sideways: number }
      expect.soft(m.axe, `${screen.name} ${size.width}: axe serious or critical`).toEqual([])
      expect.soft(m.sideways, `${screen.name} ${size.width}: sideways scroll`).toBeLessThanOrEqual(0)
    }
    const js = record.firstLoadJs as { total: number; note: string; merge: number } | undefined
    if (js) {
      expect.soft(js.merge, `${screen.name}: no tailwind-merge in the portal's first load`).toBe(0)
      expect.soft(js.total, `${screen.name}: ${js.note}`).toBeLessThanOrEqual(FIRST_LOAD_JS_BUDGET_BYTES)
    }
  })
}
