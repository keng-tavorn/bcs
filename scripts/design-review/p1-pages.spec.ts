import AxeBuilder from '@axe-core/playwright'
import { spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { devices, type Browser, type BrowserContext, type Page } from '@playwright/test'
import { totp, deriveSeedTotpSecret } from '../../src/lib/totp'
import { lineUserOf } from '../../tests/e2e/demo/support'
import { expect, test } from '../../tests/e2e/fixtures'
import { BARS_IN_PLACE, openAsLineUser, pointerAway } from '../../tests/e2e/liff-support'
import { askBcsAi } from '../../tests/e2e/p1demo/ai-steps'
import { day, expectedOf, p1Sheet, sceneOf, signInAs, type P1Sheet } from '../../tests/e2e/p1demo/support'
import { E2E_PLATFORM_ADMIN } from '../../tests/e2e/platform-admin'
import { settled } from '../../tests/e2e/settled'
import { E2E_BASE_URL, e2eEnv } from '../../tests/support/e2e-env'

// P1-09 (§9.9 step 4 · the S16-12 way): every page that phase 1 added or changed (git diff p1-start -- src/app/**/page.tsx,
// the list of docs/drafts/p1/P1-09-pages.md), opened by the member who uses it on the SIMEC database the @p1demo scenes
// played on, at 1440 × 900 and 375 × 812: a full-page picture, axe (serious and critical), sideways scroll, text below
// 14 px (16 px on a phone, §9.10) and, on the LIFF and BCS Go pages, touch targets below 44 px. The pictures go to
// docs/design-review/p1/pages/<name>-<width>.png and what was measured to docs/design-review/p1/pages/shots.json, which
// docs/design-review/p1.md reads. Run by scripts/design-review/p1.config.ts (after the scenes, or on their database again).

const OUT = path.resolve('docs/design-review/p1/pages')
const JOURNAL = path.join(OUT, 'checks.jsonl')
const WIDE = { width: 1440, height: 900 }
const PHONE = { width: 375, height: 812 }

type Kind = 'web' | 'liff' | 'go' | 'platform' | 'public'
interface Screen {
  /** The pictures' base name: <member>_<page> */
  readonly name: string
  readonly who: string | (() => string | null)
  readonly path: string | (() => string | null)
  /** A link on the page at `path` to follow first (a list's first row): the screen is the page it opens */
  readonly follow?: string
  readonly kind: Kind
  /** What to press on the page before the pictures (a dialog, a sheet, a tab) */
  readonly open?: (page: Page) => Promise<void>
}

function data<T>(...args: string[]): T {
  const r = spawnSync(`pnpm exec tsx scripts/design-review/p1-data.ts ${args.join(' ')}`, { shell: true, encoding: 'utf8', env: { ...process.env, ...e2eEnv(), E2E_P1DEMO: '1' }, maxBuffer: 64 * 1024 * 1024 })
  if (r.status !== 0) throw new Error(`p1-data ${args[0]} failed:\n${r.stderr}`)
  return JSON.parse(r.stdout.trim().split('\n').at(-1)!) as T
}

interface Targets {
  simec: string
  uat: string | null
  doa: { id: string; status: string; versionNo: number }[]
  workflows: { id: string; status: string; versionNo: number }[]
  transfer: { id: string; by: string | null } | null
  invoices: { exception: string | null; draft: string | null; ready: string | null }
  paymentRun: string | null
  poWithInvoices: string | null
  sentPo: string | null
  flaggedRequest: { id: string; by: string | null } | null
  supplierWithAccount: string | null
  verificationToken: string | null
  passkeyHolder: string | null
  chatRequest: { id: string; status: string; by: string | null } | null
  tasks: Record<string, { id: string; code: string | null }>
}

const t = data<Targets>('targets')
const made: { overRequest?: string; editRequest?: string; overrun?: string; bankChange?: string } = {}
/** The records again once the setup below made its own (the open tasks of the kinds it started) */
let late: Targets | null = null
const doaPublished = t.doa.find((d) => d.status === 'PUBLISHED') ?? t.doa[0]
const workflow = t.workflows.find((w) => w.status === 'DRAFT') ?? t.workflows[0]
/**
 * Opens a dialog or sheet: the button that opens it, after the buttons before it that are on the page (a draft to make
 * first — the second width finds it made). Short waits: a page without the button is recorded, not waited on.
 */
const button =
  (name: string | RegExp, ...before: ReadonlyArray<string | RegExp>) =>
  async (page: Page) => {
    for (const first of before) {
      const step = page.getByRole('button', { name: first }).or(page.getByRole('link', { name: first })).first()
      if (await step.isVisible({ timeout: 3_000 }).catch(() => false)) {
        await step.click({ timeout: 10_000 })
        await page.waitForLoadState('load')
      }
    }
    await page.getByRole('button', { name }).first().click({ timeout: 15_000 })
    await expect(page.getByRole('dialog').first()).toBeVisible({ timeout: 10_000 })
  }

const SCREENS: Screen[] = [
  // G1 the platform and the organization's admins
  { name: 'platform_tenants', who: 'platform', path: '/platform/tenants', kind: 'platform' },
  { name: 'platform_tenant', who: 'platform', path: `/platform/tenants/${t.simec}`, kind: 'platform' },
  { name: 'platform_tenant_modules', who: 'platform', path: `/platform/tenants/${t.simec}/modules`, kind: 'platform' },
  { name: 'platform_tenant_ai', who: 'platform', path: `/platform/tenants/${t.simec}/ai`, kind: 'platform' },
  { name: 'admin_ai', who: 'admin', path: '/admin/ai', kind: 'web' },
  { name: 'admin_config', who: 'admin', path: '/admin/config', kind: 'web' },
  { name: 'admin_doa', who: 'admin', path: '/admin/doa', kind: 'web' },
  { name: 'admin_doa_version', who: 'admin', path: `/admin/doa/${doaPublished?.id}`, kind: 'web' },
  { name: 'admin_doa_version_simulate', who: 'admin', path: `/admin/doa/${doaPublished?.id}/simulate`, kind: 'web' },
  { name: 'admin_doa_ai-draft', who: 'admin', path: '/admin/doa/ai-draft', kind: 'web' },
  { name: 'admin_request-types_BUY_GOODS', who: 'admin', path: '/admin/request-types/BUY_GOODS', kind: 'web' },
  { name: 'admin_request-types_BUY_GOODS_form', who: 'admin', path: '/admin/request-types/BUY_GOODS/form', kind: 'web' },
  { name: 'admin2_workflows', who: 'admin2', path: '/admin/workflows', kind: 'web' },
  { name: 'admin2_workflows_version', who: 'admin2', path: `/admin/workflows/${workflow?.id}`, kind: 'web' },
  // G2 requests, budgets, the catalogue and decisions
  { name: 'fm_p02_requests_new_BUY_GOODS', who: 'fm_p02', path: '/requests/new/BUY_GOODS', kind: 'web' },
  { name: 'fm_p02_requests_edit', who: 'fm_p02', path: () => (made.editRequest ? `/requests/${made.editRequest}/edit` : null), kind: 'web' },
  { name: 'requester_requests_flagged', who: t.flaggedRequest?.by ?? 'pm_p07', path: `/requests/${t.flaggedRequest?.id}`, kind: 'web' },
  { name: 'mkt_requests_over-budget', who: 'mkt_01', path: () => (made.overRequest ? `/requests/${made.overRequest}` : null), kind: 'web' },
  { name: 'mkt_budgets_overrun', who: 'mkt_01', path: () => (made.overrun ? `/budgets/overruns/${made.overrun}` : null), kind: 'web' },
  { name: 'fin_bud1_budgets', who: 'fin_bud1', path: '/budgets', kind: 'web' },
  { name: 'fin_bud1_budgets_transfers', who: 'fin_bud1', path: '/budgets/transfers', kind: 'web' },
  { name: 'fin_bud1_budgets_transfers_new', who: 'fin_bud1', path: '/budgets/transfers/new', kind: 'web' },
  { name: 'fin_bud1_budgets_transfer', who: t.transfer?.by ?? 'fin_bud1', path: `/budgets/transfers/${t.transfer?.id}`, kind: 'web' },
  { name: 'proc_officer_catalog_manage', who: 'proc_officer', path: '/catalog/manage', kind: 'web' },
  { name: 'se_p06a_catalog', who: 'se_p06a', path: '/catalog', kind: 'web' },
  // G3 finance, AP, payment runs and procurement
  { name: 'fin_tre1_bank-accounts', who: 'fin_tre1', path: '/finance/bank-accounts', kind: 'web' },
  { name: 'fin_tre1_bank-accounts_change', who: 'fin_tre1', path: () => (made.bankChange ? `/finance/bank-accounts/changes/${made.bankChange}` : null), kind: 'web' },
  { name: 'fin_ap1_invoices', who: 'fin_ap1', path: '/finance/invoices', kind: 'web' },
  { name: 'fin_ap1_invoices_inbox', who: 'fin_ap1', path: '/finance/invoices/inbox', kind: 'web' },
  { name: 'fin_ap1_invoices_new', who: 'fin_ap1', path: '/finance/invoices/new', kind: 'web' },
  { name: 'fin_ap1_invoice_exception', who: 'fin_ap1', path: `/finance/invoices/${t.invoices.exception}`, kind: 'web' },
  { name: 'fin_ap1_invoice_draft', who: 'fin_ap1', path: `/finance/invoices/${t.invoices.draft}`, kind: 'web' },
  { name: 'fin_ap1_invoice_ready', who: 'fin_ap1', path: `/finance/invoices/${t.invoices.ready}`, kind: 'web' },
  { name: 'fin_tre1_payments', who: 'fin_tre1', path: '/finance/payments', kind: 'web' },
  { name: 'fin_tre1_payments_new', who: 'fin_tre1', path: '/finance/payments/new', kind: 'web' },
  { name: 'fin_tre1_payment', who: 'fin_tre1', path: `/finance/payments/${t.paymentRun}`, kind: 'web' },
  { name: 'fin_ap1_retentions', who: 'fin_ap1', path: '/finance/retentions', kind: 'web' },
  { name: 'fin_ap1_wht', who: 'fin_ap1', path: '/finance/wht', kind: 'web' },
  { name: 'fin_ap1_wht_types', who: 'fin_ap1', path: '/finance/wht/types', kind: 'web' },
  { name: 'proc_officer_invoice-exceptions', who: 'proc_officer', path: '/procurement/invoice-exceptions', kind: 'web' },
  { name: 'proc_officer_pos', who: 'proc_officer', path: '/procurement/pos', kind: 'web' },
  { name: 'proc_officer_po', who: 'proc_officer', path: `/procurement/pos/${t.poWithInvoices}`, kind: 'web' },
  { name: 'proc_officer_po_change', who: 'proc_officer', path: `/procurement/pos/${t.sentPo}/change`, kind: 'web' },
  // G4 receiving, reports, one's own settings and suppliers
  { name: 'store_p07_receiving', who: 'store_p07', path: '/receiving', kind: 'web' },
  { name: 'ceo_insights', who: 'ceo', path: '/insights', kind: 'web' },
  { name: 'dm_fin_reports', who: 'dm_fin', path: '/reports', kind: 'web' },
  { name: 'dm_fin_reports_workflow', who: 'dm_fin', path: '/reports/workflow', kind: 'web' },
  { name: 'ceo_settings_notifications', who: 'ceo', path: '/settings/notifications', kind: 'web' },
  { name: 'passkey_settings_pin', who: t.passkeyHolder ?? 'ceo', path: '/settings/pin', kind: 'web' },
  { name: 'fin_ap1_supplier', who: 'fin_ap1', path: `/suppliers/${t.supplierWithAccount}`, kind: 'web' },
  { name: 'se_p06a_supplier', who: 'se_p06a', path: `/suppliers/${t.supplierWithAccount}`, kind: 'web' },
  { name: 'ceo_home', who: 'ceo', path: '/', kind: 'web' },
  { name: 'ceo_ask-ai', who: 'ceo', path: '/', kind: 'web', open: async (page) => void (await askBcsAi(page, expectedOf<string>(sceneOf(sheet, 14), 'questionTh'))) },
  // G5 LINE, the app and the public page
  { name: 'store_p07_go_receive', who: 'store_p07', path: '/go/receive', kind: 'go' },
  { name: 'store_p07_liff_gr', who: 'store_p07', path: '/liff/gr', kind: 'liff' },
  { name: 'ceo_liff_home', who: 'ceo', path: '/liff/home', kind: 'liff' },
  { name: 'se_p01a_liff_home', who: 'se_p01a', path: '/liff/home', kind: 'liff' },
  { name: 'proc_officer_liff_procurement', who: 'proc_officer', path: '/liff/procurement', kind: 'liff' },
  { name: 'requester_liff_request', who: t.flaggedRequest?.by ?? 'pm_p07', path: `/liff/requests/${t.flaggedRequest?.id}`, kind: 'liff' },
  { name: 'se_p01a_liff_requests_new', who: 'se_p01a', path: '/liff/requests/new', kind: 'liff' },
  { name: 'public_verify', who: 'nobody', path: `/verify/${t.verificationToken}`, kind: 'public' },
  { name: 'public_verify_unknown', who: 'nobody', path: '/verify/not-a-real-token-0000', kind: 'public' },
]
SCREENS.push(
  { name: 'admin_request-types_BUY_GOODS_form_dialog', who: 'admin', path: '/admin/request-types/BUY_GOODS/form', kind: 'web', open: button('เพิ่มคำถาม', 'สร้างร่างฉบับใหม่') },
  { name: 'admin2_workflows_version_dialog', who: 'admin2', path: '/admin/workflows', kind: 'web', open: button('เพิ่มข้อผู้ตรวจ', /^สร้างร่างจาก /, /^แก้ WF-/) },
  { name: 'proc_officer_catalog_manage_dialog', who: 'proc_officer', path: '/catalog/manage', kind: 'web', open: button('เพิ่มรายการ') },
  { name: 'proc_officer_po_sent', who: 'proc_officer', path: `/procurement/pos/${t.sentPo}`, kind: 'web' },
  { name: 'store_p07_receiving_po', who: 'store_p07', path: '/receiving', follow: 'main a[href^="/receiving/01"]', kind: 'web' },
  { name: 'fm_p02_settings_pin', who: 'fm_p02', path: '/settings/pin', kind: 'web' },
  { name: 'fm_p02_liff_requests_edit', who: 'fm_p02', path: () => (made.editRequest ? `/liff/requests/${made.editRequest}/edit` : null), kind: 'liff' },
)
if (t.chatRequest?.by && t.chatRequest.status === 'DRAFT') {
  SCREENS.push({ name: 'chat_liff_requests_edit', who: t.chatRequest.by, path: `/liff/requests/${t.chatRequest.id}/edit`, kind: 'liff' })
}
// One open task of every kind there is one of once the setup below made its records, on the web and in LINE, opened by
// the member who holds it (a kind without an open task is skipped, and the report says so)
const TASK_KINDS = ['REQUEST', 'REQUEST_REVIEW', 'BUDGET_TRANSFER', 'BUDGET_OVERRUN', 'PO_CHANGE', 'VARIANCE', 'INVOICE', 'PAYMENT_RUN', 'BANK_ACCOUNT_CHANGE', 'PURCHASE_ORDER', 'DOA_VERSION', 'WORKFLOW_VERSION', 'ORG_AUTHORITY_CHANGE']
for (const kind of TASK_KINDS) {
  const task = () => late?.tasks[kind] ?? null
  SCREENS.push({ name: `tasks_${kind}`, who: () => task()?.code ?? null, path: () => (task() ? `/tasks/${task()!.id}` : null), kind: 'web' })
  SCREENS.push({ name: `liff_tasks_${kind}`, who: () => task()?.code ?? null, path: () => (task() ? `/liff/tasks/${task()!.id}` : null), kind: 'liff' })
}

let sheet: P1Sheet
test.beforeAll(async () => {
  test.setTimeout(600_000)
  mkdirSync(OUT, { recursive: true })
  sheet = await p1Sheet()
  // The BCS team's account for the /platform pages (the scenes' database has none) and the LINE links of the LIFF members
  const r = spawnSync('pnpm exec tsx tests/e2e/seed-platform-admin.ts', { shell: true, encoding: 'utf8', env: { ...process.env, ...e2eEnv() } })
  if (r.status !== 0) throw new Error(`the platform admin: ${r.stderr}`)
  const phones = [...new Set(SCREENS.filter((s) => s.kind === 'liff' && typeof s.who === 'string').map((s) => s.who as string))]
  day('prepare', ...phones.map((code) => `${code}:${lineUserOf(code)}`))
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

async function phone(browser: Browser, ip: string): Promise<BrowserContext> {
  return browser.newContext({ ...devices['Pixel 7'], viewport: PHONE, baseURL: E2E_BASE_URL, locale: 'th-TH', timezoneId: 'Asia/Bangkok', extraHTTPHeaders: { 'x-forwarded-for': ip } })
}

/** What one width of a screen measures: axe (serious, critical), sideways scroll, small text and small touch targets */
async function measure(page: Page, screen: Screen, width: number) {
  await pointerAway(page)
  await settled(page)
  const axe = await new AxeBuilder({ page }).analyze()
  const blocking = axe.violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical')
    .map((v) => `${v.impact} ${v.id}: ${v.help} (${v.nodes.slice(0, 4).map((n) => n.target.join(' ')).join(', ')})`)
  const minimum = width < 768 ? 16 : 14
  const found = await page.evaluate(
    ({ minimum, touch }) => {
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
      const targets = touch
        ? [...document.querySelectorAll('header a, main a, main button, [role="dialog"] button')]
            .filter((el) => visible(el) && el.getBoundingClientRect().height < 44)
            .map((el) => `${el.tagName.toLowerCase()} "${(el.textContent ?? '').trim().slice(0, 40)}" ${Math.round(el.getBoundingClientRect().height)}px`)
        : []
      return { sideways: document.documentElement.scrollWidth - document.documentElement.clientWidth, small: [...new Set(small)], targets }
    },
    { minimum, touch: (screen.kind === 'liff' || screen.kind === 'go') && width < 768 },
  )
  const file = path.join(OUT, `${screen.name}-${width}.png`)
  await page.screenshot({ path: file, fullPage: true, style: screen.kind === 'liff' || screen.kind === 'go' ? BARS_IN_PLACE : undefined })
  return { picture: path.relative(process.cwd(), file).split(path.sep).join('/'), axe: blocking, sideways: found.sideways, smallText: found.small.slice(0, 20), smallTextCount: found.small.length, smallTargets: found.targets }
}

async function show(page: Page, screen: Screen, to: string) {
  const response = await page.goto(to)
  await page.locator('h1').first().waitFor({ timeout: 20_000 }).catch(() => undefined)
  if (screen.open) await screen.open(page)
  return response?.status() ?? null
}

/** The page a screen shows: its path, or the first link it follows from there */
async function address(page: Page, screen: Screen, to: string): Promise<string> {
  if (!screen.follow) return to
  await page.goto(to)
  const link = page.locator(screen.follow).first()
  await link.waitFor({ timeout: 20_000 })
  return (await link.getAttribute('href'))!
}

for (const screen of SCREENS) {
  test(`P1-09 ${screen.name}`, async ({ page, browser, clientIp }) => {
    test.setTimeout(240_000)
    let to = typeof screen.path === 'function' ? screen.path() : screen.path
    const who = typeof screen.who === 'function' ? screen.who() : screen.who
    test.skip(!to || !who || to.includes('undefined') || to.includes('null'), `no record for ${screen.name} on this database`)
    let target = page
    let context: BrowserContext | null = null
    if (screen.kind === 'liff') {
      day('prepare', `${who}:${lineUserOf(who!)}`)
      context = await phone(browser, clientIp)
      await openAsLineUser(context, lineUserOf(who!))
      target = await context.newPage()
    } else if (screen.kind === 'platform') await signInPlatform(page)
    else if (screen.kind !== 'public') await signInAs(page, sheet, who!)
    to = await address(target, screen, to!)
    const widths = screen.kind === 'liff' || screen.kind === 'go' ? [PHONE, WIDE] : [WIDE, PHONE]
    const record: Record<string, unknown> = { name: screen.name, who, kind: screen.kind, path: to }
    for (const size of widths) {
      await target.setViewportSize(size)
      const status = await show(target, screen, to).catch((error: unknown) => {
        record.openFailed = String(error).split('\n')[0]
        return null
      })
      record.status = status
      record.landed = new URL(target.url()).pathname
      record.h1 = ((await target.locator('h1').first().textContent({ timeout: 2_000 }).catch(() => null)) ?? '').trim()
      record[size.width] = await measure(target, screen, size.width)
    }
    appendFileSync(JOURNAL, `${JSON.stringify(record)}\n`)
    await context?.close()
    for (const size of widths) {
      const m = record[size.width] as { axe: string[]; sideways: number }
      expect.soft(m.axe, `${screen.name} ${size.width}: axe serious or critical`).toEqual([])
      expect.soft(m.sideways, `${screen.name} ${size.width}: sideways scroll`).toBeLessThanOrEqual(0)
    }
  })
}

// The records the scenes did not leave: made through the pages themselves, before the screens that show them
test.beforeAll(async ({ browser }) => {
  test.setTimeout(600_000)
  const drafts = data<{ over: { id: string }; edit: { id: string } }>('drafts', 'mkt_01', 'fm_p02')
  made.overRequest = drafts.over.id
  made.editRequest = drafts.edit.id
  const context = await browser.newContext({ viewport: WIDE, baseURL: E2E_BASE_URL, locale: 'th-TH', timezoneId: 'Asia/Bangkok', extraHTTPHeaders: { 'x-forwarded-for': '198.18.9.9' } })
  const page = await context.newPage()
  try {
    // The marketing requester asks for the shortfall (S6-16 · the over-budget panel of the request)
    await signInAs(page, sheet, 'mkt_01')
    await page.goto(`/requests/${made.overRequest}`)
    const section = page.getByRole('region', { name: 'ขออนุมัติเกินงบ', exact: true })
    await section.getByRole('button', { name: 'ขออนุมัติเกินงบ', exact: true }).click()
    const dialog = page.getByRole('dialog')
    await page.screenshot({ path: path.join(OUT, 'mkt_requests_over-budget_dialog-1440.png'), fullPage: true })
    await dialog.getByLabel('เหตุผลที่ต้องใช้เกินงบ').fill('งานแสดงสินค้าเลื่อนมาไตรมาสนี้ ต้องจองบูธก่อนสิ้นเดือน')
    await dialog.getByRole('button', { name: 'ส่งขออนุมัติเกินงบ', exact: true }).click()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    const link = section.locator('a[href*="/budgets/overruns/"]').first()
    await link.waitFor({ timeout: 15_000 })
    made.overrun = (await link.getAttribute('href'))!.split('/').at(-1)!
  } catch (error) {
    console.log(`[p1-09] the over-budget ask: ${String(error).slice(0, 400)}`)
  }
  await context.clearCookies()
  try {
    // FINANCE proposes a new receiving account for a supplier (S9-09 · BR-BANK)
    await signInAs(page, sheet, 'fin_tre1')
    await page.goto(`/suppliers/${t.supplierWithAccount}`)
    await page.getByRole('region', { name: 'บัญชีรับเงิน' }).getByRole('link', { name: 'เสนอเปลี่ยนบัญชี' }).click()
    await expect(page).toHaveURL(/\/finance\/bank-accounts\/changes\/new/)
    await page.screenshot({ path: path.join(OUT, 'fin_tre1_bank-accounts_changes_new-1440.png'), fullPage: true })
    await page.getByRole('radio', { name: /เปลี่ยนบัญชี/ }).check()
    await page.getByRole('button', { name: 'ถัดไป: ใส่บัญชีใหม่และหลักฐาน' }).click()
    await page.getByLabel('ธนาคาร', { exact: true }).selectOption('002')
    await page.getByLabel('เลขบัญชี', { exact: true }).fill('3030303031')
    await page.getByLabel('ชื่อบัญชี', { exact: true }).fill('บริษัท ผู้ขายตัวอย่าง จำกัด')
    await page.locator('input[type="file"]').setInputFiles({ name: 'bank-letter.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.7\n' + 'x'.repeat(200) + '\n%%EOF\n', 'latin1') })
    await expect(page.getByText('bank-letter.pdf').first()).toBeVisible({ timeout: 30_000 })
    await page.getByLabel('บันทึกการโทร').fill('โทรเบอร์ในทะเบียน คุยกับฝ่ายบัญชีของผู้ขาย ยืนยันการเปลี่ยนตามหนังสือ')
    await page.getByRole('checkbox', { name: 'ฉันโทรเบอร์ในทะเบียนผู้ขายแล้ว และผู้ขายยืนยันการเปลี่ยนนี้' }).check()
    await page.getByLabel('เหตุผลของคำขอ').fill('ผู้ขายแจ้งเปลี่ยนบัญชีรับเงินเป็นบัญชีใหม่')
    await page.screenshot({ path: path.join(OUT, 'fin_tre1_bank-accounts_changes_new_step2-1440.png'), fullPage: true })
    await page.getByRole('button', { name: 'บันทึกและส่งขออนุมัติ' }).click()
    await expect(page).toHaveURL(/\/finance\/bank-accounts\/changes\/[0-9a-f-]{36}(\?|$)/, { timeout: 30_000 })
    made.bankChange = new URL(page.url()).pathname.split('/').at(-1)!
  } catch (error) {
    console.log(`[p1-09] the bank account change: ${String(error).slice(0, 400)}`)
  }
  await context.clearCookies()
  try {
    // The budget admin moves 1,000.00 between two lines of the year (S6-15): a BUDGET_TRANSFER task
    await signInAs(page, sheet, 'fin_bud1')
    await page.goto('/budgets/transfers/new')
    await page.getByLabel('จากบรรทัด', { exact: true }).selectOption({ index: 1 })
    await page.getByLabel('ไปบรรทัด', { exact: true }).selectOption({ index: 2 })
    await page.getByLabel('จำนวนเงิน (บาท)').fill('1000')
    await page.getByLabel('เหตุผล').fill('ย้ายงบค่าวัสดุไปงานที่เริ่มก่อนกำหนด')
    await page.getByRole('button', { name: 'ส่งขออนุมัติ', exact: true }).click()
    await expect(page).toHaveURL(/\/budgets\/transfers\/[0-9a-f-]{36}/, { timeout: 30_000 })
  } catch (error) {
    console.log(`[p1-09] the budget transfer: ${String(error).slice(0, 400)}`)
  }
  await context.clearCookies()
  try {
    // Procurement changes a sent PO's price (S8-13): step 2 pictured, then the change sent for approval (a PO_CHANGE task)
    await signInAs(page, sheet, 'proc_officer')
    await page.goto(`/procurement/pos/${t.sentPo}/change`)
    await page.getByLabel('ราคาต่อหน่วยใหม่ (บาท)').first().fill('59000.00')
    await page.getByRole('button', { name: 'ดูยอดใหม่และไปขั้นถัดไป' }).click()
    await page.getByLabel('เหตุผลที่แก้ (ผู้อนุมัติจะเห็น)').fill('ผู้ขายปรับราคาเหล็กตามประกาศราคากลางเดือนนี้')
    await page.screenshot({ path: path.join(OUT, 'proc_officer_po_change_step2-1440.png'), fullPage: true })
    await page.getByRole('button', { name: 'บันทึกร่างใบแก้ไข' }).click()
    await page.getByRole('button', { name: 'ส่งใบแก้ไข', exact: true }).click()
    await expect(page.getByText('ส่งใบแก้ไขแล้ว').first()).toBeVisible({ timeout: 30_000 })
  } catch (error) {
    console.log(`[p1-09] the PO change: ${String(error).slice(0, 400)}`)
  }
  await context.close()
  late = data<Targets>('targets')
})
