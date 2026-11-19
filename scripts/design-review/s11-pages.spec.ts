import AxeBuilder from '@axe-core/playwright'
import { spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { devices, type Browser, type BrowserContext, type Page } from '@playwright/test'
import { totp, deriveSeedTotpSecret } from '../../src/lib/totp'
import { lineUserOf, th } from '../../tests/e2e/demo/support'
import { expect, test } from '../../tests/e2e/fixtures'
import { BARS_IN_PLACE, FIRST_LOAD_JS_BUDGET_BYTES, openAsLineUser, pointerAway, weighFirstLoad } from '../../tests/e2e/liff-support'
import { day, p1Sheet, signInAs, type P1Sheet } from '../../tests/e2e/p1demo/support'
import { s11, s7 } from '../../tests/e2e/p2demo/support'
import { E2E_PLATFORM_ADMIN } from '../../tests/e2e/platform-admin'
import { settled } from '../../tests/e2e/settled'
import { E2E_BASE_URL, e2eEnv } from '../../tests/support/e2e-env'

// S11-16 (§9.9 step 4 · the S7-18 way): every page of S11's screen table (docs/sub-specs/S11.md "หน้าจอ") — the
// questionnaire in the supplier portal (with the AI's proposals to confirm, and once sent), the overview /risk, the
// assessment's file with the on-behalf dialog and its AI ticks, the reviewers' inbox and task on the web and in LINE (with
// the AI's summary), the overrides (list, form, request, the approver's task on the web and in LINE), the PO's risk band,
// the board's filter, the supplier's risk tab and file, the tiers, the questionnaire's versions and editor, the workflow's
// reviewers tab, report G-9 and the module switch — opened by the person who uses it on the SIMEC database the @p2demo
// scenes played on, at 1440 × 900 and 375 × 812: a full-page picture, axe (serious and critical), sideways scroll and text
// below 14 px (16 px on a phone); the portal pages also weigh their first JavaScript (at most 200 KB gzip · §9.4 ·
// ADR-184). The pictures go to docs/design-review/s11/<name>-<width>.png and what was measured to
// docs/design-review/s11/shots.json, which docs/design-review/s11.md reads. Run by scripts/design-review/s11.config.ts
// (after the scenes, or on their database again).

const OUT = path.resolve('docs/design-review/s11')
const JOURNAL = path.join(OUT, 'checks.jsonl')
const MAX_PICTURE_HEIGHT = 6000
const WIDE = { width: 1440, height: 900 }
const PHONE = { width: 375, height: 812 }

type Kind = 'web' | 'liff' | 'portal' | 'platform'
interface Screen {
  /** The pictures' base name */
  readonly name: string
  /** A member's code (web, liff), the contact's e-mail (portal) — of the records found after the scenes */
  readonly who: (f: Found) => string | null
  readonly path: (f: Found) => string | null
  readonly kind: Kind
  /** What the person does before the picture (a tab or a dialog opened) */
  readonly act?: (page: Page) => Promise<void>
}

interface Targets {
  org: string
  organizationId: string
  sentAssessment: string | null
  sentSupplier: string | null
  sentContact: string | null
  reviewTasks: Array<{ id: string; code: string | null }>
  workflowVersion: string | null
  override: string | null
  overrideTask: { id: string; code: string | null } | null
  heldPo: string | null
  questionnaire: string | null
  completedSupplier: string | null
}
interface AiBox {
  assessment: string | null
  supplierId: string | null
  contact: string | null
  result: string
}

function data<T>(...args: string[]): T {
  const r = spawnSync(`pnpm exec tsx scripts/design-review/s11-data.ts ${args.join(' ')}`, { shell: true, encoding: 'utf8', env: { ...process.env, ...e2eEnv(), E2E_P2DEMO: '1' }, maxBuffer: 64 * 1024 * 1024 })
  if (r.status !== 0) throw new Error(`s11-data ${args[0]} failed:\n${r.stderr}`)
  return JSON.parse(r.stdout.trim().split('\n').at(-1)!) as T
}

interface Found {
  readonly t: Targets
  readonly ai: AiBox
}
/**
 * The records are read in beforeAll, after the scenes played: Playwright loads this file before the run too (to list
 * its tests), and the AI's proposals written then would land on the assessment scenes 19 and 22 still have to answer
 */
let found: Found
const portal = (f: Found) => `/portal/${f.t.org}`
const at = (id: string | null | undefined, to: (id: string) => string) => (id ? to(id) : null)
const reviewer = (f: Found) => f.t.reviewTasks[0] ?? null
const openTab = (name: string) => async (page: Page) => {
  await page.getByRole('tab', { name }).click()
  await expect(page.getByRole('tab', { name })).toHaveAttribute('aria-selected', 'true')
}
const openDialog = (button: string) => async (page: Page) => {
  await page.getByRole('button', { name: button }).first().click()
  await expect(page.getByRole('dialog')).toBeVisible()
}

const SCREENS: Screen[] = [
  // the supplier portal: the list, the questionnaire with the AI's proposals still to confirm, the one scene 22 sent
  { name: 'portal_risk', who: (f) => f.t.sentContact, path: (f) => `${portal(f)}/risk`, kind: 'portal' },
  { name: 'portal_risk_ai', who: (f) => f.ai.contact, path: (f) => at(f.ai.assessment, (id) => `${portal(f)}/risk/${id}`), kind: 'portal' },
  { name: 'portal_risk_sent', who: (f) => f.t.sentContact, path: (f) => at(f.t.sentAssessment, (id) => `${portal(f)}/risk/${id}`), kind: 'portal' },
  // the workspace
  { name: 'proc_officer_risk', who: () => 'proc_officer', path: () => '/risk', kind: 'web' },
  { name: 'proc_officer_assessment_sent', who: () => 'proc_officer', path: (f) => at(f.t.sentAssessment, (id) => `/risk/assessments/${id}`), kind: 'web' },
  { name: 'proc_officer_assessment_fill_ai', who: () => 'proc_officer', path: (f) => at(f.ai.assessment, (id) => `/risk/assessments/${id}`), kind: 'web', act: openDialog(th('risk.assessment.fill')) },
  { name: 'reviewer_reviews', who: (f) => reviewer(f)?.code ?? null, path: () => '/risk/reviews', kind: 'web' },
  { name: 'reviewer_review', who: (f) => reviewer(f)?.code ?? null, path: (f) => at(reviewer(f)?.id ?? null, (id) => `/risk/reviews/${id}`), kind: 'web' },
  { name: 'liff_reviewer_review', who: (f) => reviewer(f)?.code ?? null, path: (f) => at(reviewer(f)?.id ?? null, (id) => `/liff/risk/reviews/${id}`), kind: 'liff' },
  { name: 'proc_officer_overrides', who: () => 'proc_officer', path: () => '/risk/overrides?tab=all', kind: 'web' },
  { name: 'proc_officer_override', who: () => 'proc_officer', path: (f) => at(f.t.override, (id) => `/risk/overrides/${id}`), kind: 'web' },
  { name: 'proc_officer_override_new', who: () => 'proc_officer', path: (f) => at(f.t.sentSupplier, (id) => `/risk/overrides/new?supplierId=${id}`), kind: 'web' },
  { name: 'task_override', who: (f) => f.t.overrideTask?.code ?? null, path: (f) => at(f.t.overrideTask?.id ?? null, (id) => `/tasks/${id}`), kind: 'web' },
  { name: 'liff_task_override', who: (f) => f.t.overrideTask?.code ?? null, path: (f) => at(f.t.overrideTask?.id ?? null, (id) => `/liff/tasks/${id}`), kind: 'liff' },
  { name: 'proc_officer_po_held', who: () => 'proc_officer', path: (f) => at(f.t.heldPo, (id) => `/procurement/pos/${id}`), kind: 'web' },
  { name: 'proc_officer_board_risk', who: () => 'proc_officer', path: () => '/board/pending?risk=gated', kind: 'web' },
  { name: 'proc_officer_suppliers', who: () => 'proc_officer', path: () => '/suppliers', kind: 'web' },
  { name: 'proc_officer_supplier_risk', who: () => 'proc_officer', path: (f) => at(f.t.completedSupplier, (id) => `/suppliers/${id}?tab=risk`), kind: 'web' },
  { name: 'proc_officer_risk_file', who: () => 'proc_officer', path: (f) => at(f.t.completedSupplier, (id) => `/risk/suppliers/${id}`), kind: 'web' },
  { name: 'admin_risk_tiers', who: () => 'admin', path: () => '/admin/risk/tiers', kind: 'web' },
  { name: 'admin_risk_questionnaire', who: () => 'admin', path: () => '/admin/risk/questionnaire', kind: 'web' },
  { name: 'admin_risk_questionnaire_version', who: () => 'admin', path: (f) => at(f.t.questionnaire, (id) => `/admin/risk/questionnaire/${id}`), kind: 'web' },
  { name: 'admin_workflow_risk', who: () => 'admin', path: (f) => at(f.t.workflowVersion, (id) => `/admin/workflows/${id}`), kind: 'web', act: openTab(th('adminWorkflow.tabs.risk')) },
  { name: 'dm_proc_reports_risk', who: () => 'dm_proc', path: () => '/reports/risk', kind: 'web' },
  { name: 'platform_tenant_modules', who: () => 'platform', path: (f) => `/platform/tenants/${f.t.organizationId}/modules`, kind: 'platform' },
]

let sheet: P1Sheet
test.beforeAll(async () => {
  test.setTimeout(600_000)
  mkdirSync(OUT, { recursive: true })
  sheet = await p1Sheet()
  const t = data<Targets>('targets')
  // the AI's proposals on another open assessment (scene 22 confirmed all of its own): the portal's box, the dialog's ticks
  found = { t, ai: s11<AiBox>('ai-propose', t.sentAssessment ?? '-') }
  // the BCS team's account for the /platform page (the scenes' database has none)
  const r = spawnSync('pnpm exec tsx tests/e2e/seed-platform-admin.ts', { shell: true, encoding: 'utf8', env: { ...process.env, ...e2eEnv() } })
  if (r.status !== 0) throw new Error(`the platform admin: ${r.stderr}`)
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
    { name: 'bcs_portal', value: sid, url: `${E2E_BASE_URL}${portal(found)}` },
    { name: 'bcs_portal_csrf', value: csrf, url: `${E2E_BASE_URL}${portal(found)}` },
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
  // a page taller than 6000 px (/suppliers lists every supplier) is taken down to there, as in S7-18
  const height = await page.evaluate(() => document.documentElement.scrollHeight)
  const clip = height > MAX_PICTURE_HEIGHT ? { x: 0, y: 0, width, height: MAX_PICTURE_HEIGHT } : undefined
  await page.screenshot({ path: file, fullPage: true, ...(clip ? { clip } : {}), style: screen.kind === 'liff' ? BARS_IN_PLACE : undefined })
  return { picture: path.relative(process.cwd(), file).split(path.sep).join('/'), axe: blocking, sideways: found.sideways, smallText: found.small.slice(0, 20), smallTextCount: found.small.length }
}

for (const screen of SCREENS) {
  test(`S11-16 ${screen.name}`, async ({ browser, clientIp }) => {
    test.setTimeout(240_000)
    const who = screen.who(found)
    const where = screen.path(found)
    test.skip(!where || !who, `no record for ${screen.name} on this database`)
    const record: Record<string, unknown> = { name: screen.name, who, kind: screen.kind, path: where }
    const widths = screen.kind === 'liff' || screen.kind === 'portal' ? [PHONE, WIDE] : [WIDE, PHONE]
    for (const size of widths) {
      const ctx = await context(browser, size, clientIp)
      if (screen.kind === 'liff') {
        day('prepare', `${who}:${lineUserOf(who!)}`)
        await openAsLineUser(ctx, lineUserOf(who!))
      } else if (screen.kind === 'portal') await portalSignIn(ctx, who!)
      const page = await ctx.newPage()
      if (screen.kind === 'platform') await signInPlatform(page)
      else if (screen.kind === 'web') await signInAs(page, sheet, who!)
      // the portal's first JavaScript, weighed once on the phone with nothing cached (§9.4 · ADR-184)
      if (screen.kind === 'portal' && size.width < 768) {
        const load = await weighFirstLoad(page, where!, () => page.locator('h1').first().waitFor({ timeout: 20_000 }))
        record.firstLoadJs = { total: load.total, note: load.note, merge: load.loads.filter((l) => l.merge).length }
      } else {
        const response = await page.goto(where!)
        record.status = response?.status() ?? null
        await page.locator('h1').first().waitFor({ timeout: 20_000 }).catch(() => undefined)
      }
      if (screen.act) await screen.act(page)
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
