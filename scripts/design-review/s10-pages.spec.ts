import AxeBuilder from '@axe-core/playwright'
import { spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { devices, type Browser, type BrowserContext, type Page } from '@playwright/test'
import { lineUserOf } from '../../tests/e2e/demo/support'
import { expect, test } from '../../tests/e2e/fixtures'
import { BARS_IN_PLACE, FIRST_LOAD_JS_BUDGET_BYTES, openAsLineUser, pointerAway, weighFirstLoad } from '../../tests/e2e/liff-support'
import { day, p1Sheet, signInAs, type P1Sheet } from '../../tests/e2e/p1demo/support'
import { p2SceneOf, p2Sheet, portalSessionOn } from '../../tests/e2e/p2demo/support'
import { settled } from '../../tests/e2e/settled'
import { E2E_BASE_URL, e2eEnv } from '../../tests/support/e2e-env'

// S10-20 (§9.9 step 4 · the S7-18 way): every page of S10's screen table (docs/sub-specs/S10.md "หน้าจอ") — the RFx
// pages of the portal, /sourcing and its pages (detail tabs, setup steps, scoring, award, print), the pool, the award's
// approval task on the web and in LINE, the preferred suppliers, the request form that takes them, the PO of an award,
// the G-8 report and the form builder's English — opened by the person who uses it on the SIMEC database the @p2demo
// scenes played on, at 1440 × 900 and 375 × 812: a full-page picture, axe (serious and critical), sideways scroll and
// text below 14 px (16 px on a phone); the portal pages also weigh their first JavaScript (at most 200 KB gzip with the
// page data · ADR-184). The pictures go to docs/design-review/s10/<name>-<width>.png and what was measured to
// docs/design-review/s10/shots.json, which docs/design-review/s10.md reads. Run by scripts/design-review/s10.config.ts.

const OUT = path.resolve('docs/design-review/s10')
const JOURNAL = path.join(OUT, 'checks.jsonl')
const MAX_PICTURE_HEIGHT = 6000
const WIDE = { width: 1440, height: 900 }
const PHONE = { width: 375, height: 812 }

type Kind = 'web' | 'liff' | 'portal'
interface Screen {
  /** The pictures' base name */
  readonly name: string
  /** A member's code (web, liff), the contact's e-mail (portal) */
  readonly who: string | null
  readonly path: string | null
  readonly kind: Kind
  /** The portal contact's language (the foreign supplier reads in English) */
  readonly locale?: 'th' | 'en'
}

interface Rfx {
  id: string
  by: string | null
  evaluator?: string | null
}
interface Targets {
  org: string
  rfq: Rfx | null
  rfp: Rfx | null
  rfi: Rfx | null
  open: Rfx | null
  draft: Rfx | null
  awardTask: { id: string; code: string | null } | null
  awardPo: string | null
  winnerContact: string | null
  loserContact: string | null
  openThaiContact: string | null
  openForeignContact: string | null
}

function data<T>(...args: string[]): T {
  const r = spawnSync(`pnpm exec tsx scripts/design-review/s10-data.ts ${args.join(' ')}`, { shell: true, encoding: 'utf8', env: { ...process.env, ...e2eEnv(), E2E_P2DEMO: '1' }, maxBuffer: 64 * 1024 * 1024 })
  if (r.status !== 0) throw new Error(`s10-data ${args[0]} failed:\n${r.stderr}`)
  return JSON.parse(r.stdout.trim().split('\n').at(-1)!) as T
}

const t = data<Targets>('targets')
const P = `/portal/${t.org}`
const PROC = t.rfq?.by ?? 'proc_mat1'
const at = (id: string | null | undefined, to: (id: string) => string) => (id ? to(id) : null)
const rfq = (to: (id: string) => string) => at(t.rfq?.id, to)
const openContact = t.openThaiContact ?? t.openForeignContact
/** The requester of scene 10 (an IT member), who sees the preferred supplier on the request form */
const requester = p2SceneOf(await p2Sheet(), 10).others.find((c) => c.startsWith('it_')) ?? null

const SCREENS: Screen[] = [
  // the portal: the RFx of the winner of scene 9 and of a supplier who lost, the open RFx of scene 13 and its bid form
  { name: 'portal_home', who: t.winnerContact, path: `${P}/home`, kind: 'portal' },
  { name: 'portal_rfx', who: t.winnerContact, path: `${P}/rfx`, kind: 'portal' },
  { name: 'portal_rfx_open', who: openContact, path: at(t.open?.id, (id) => `${P}/rfx/${id}`), kind: 'portal' },
  { name: 'portal_rfx_open_bid', who: openContact, path: at(t.open?.id, (id) => `${P}/rfx/${id}/bid`), kind: 'portal' },
  { name: 'portal_rfx_open_en', who: t.openThaiContact ? t.openForeignContact : null, path: at(t.open?.id, (id) => `${P}/rfx/${id}`), kind: 'portal', locale: 'en' },
  { name: 'portal_rfx_open_bid_en', who: t.openThaiContact ? t.openForeignContact : null, path: at(t.open?.id, (id) => `${P}/rfx/${id}/bid`), kind: 'portal', locale: 'en' },
  { name: 'portal_rfx_awarded', who: t.winnerContact, path: rfq((id) => `${P}/rfx/${id}`), kind: 'portal' },
  { name: 'portal_rfx_result_won', who: t.winnerContact, path: rfq((id) => `${P}/rfx/${id}/result`), kind: 'portal' },
  { name: 'portal_rfx_result_lost', who: t.loserContact, path: rfq((id) => `${P}/rfx/${id}/result`), kind: 'portal' },
  // the workspace: the list, the pool, a new RFx and the steps of a draft
  { name: 'proc_sourcing', who: PROC, path: '/sourcing', kind: 'web' },
  { name: 'proc_sourcing_rfi', who: PROC, path: '/sourcing?kind=RFI', kind: 'web' },
  { name: 'proc_pool', who: PROC, path: '/procurement/pool', kind: 'web' },
  { name: 'proc_sourcing_new', who: PROC, path: '/sourcing/new', kind: 'web' },
  ...(['general', 'lines', 'suppliers', 'scorecard', 'schedule', 'review'] as const).map((step) => ({
    name: `proc_sourcing_draft_${step}`,
    who: t.draft?.by ?? PROC,
    path: at(t.draft?.id, (id) => `/sourcing/${id}/edit?step=${step}`),
    kind: 'web' as const,
  })),
  // the RFQ of scene 9 (awarded), each tab, the scoring, the award and the print
  ...(['overview', 'lines', 'suppliers', 'questions', 'revisions', 'bids', 'scores', 'awards'] as const).map((tab) => ({
    name: `proc_rfq_${tab}`,
    who: PROC,
    path: rfq((id) => `/sourcing/${id}?tab=${tab}`),
    kind: 'web' as const,
  })),
  { name: 'evaluator_rfq_score', who: t.rfq?.evaluator ?? null, path: rfq((id) => `/sourcing/${id}/score`), kind: 'web' },
  { name: 'proc_rfq_award', who: PROC, path: rfq((id) => `/sourcing/${id}/award`), kind: 'web' },
  { name: 'proc_rfp_award', who: t.rfp?.by ?? PROC, path: at(t.rfp?.id, (id) => `/sourcing/${id}/award`), kind: 'web' },
  { name: 'proc_rfi', who: t.rfi?.by ?? PROC, path: at(t.rfi?.id, (id) => `/sourcing/${id}`), kind: 'web' },
  { name: 'proc_open', who: t.open?.by ?? PROC, path: at(t.open?.id, (id) => `/sourcing/${id}`), kind: 'web' },
  { name: 'proc_open_print', who: t.open?.by ?? PROC, path: at(t.open?.id, (id) => `/sourcing/${id}/print`), kind: 'web' },
  // the award's approval task, the PO it drafted, the preferred suppliers, the request form, the report, the form's English
  { name: 'task_award', who: t.awardTask?.code ?? null, path: at(t.awardTask?.id, (id) => `/tasks/${id}`), kind: 'web' },
  { name: 'liff_task_award', who: t.awardTask?.code ?? null, path: at(t.awardTask?.id, (id) => `/liff/tasks/${id}`), kind: 'liff' },
  { name: 'proc_po_from_award', who: PROC, path: at(t.awardPo, (id) => `/procurement/pos/${id}`), kind: 'web' },
  { name: 'proc_preferred', who: PROC, path: '/suppliers/preferred', kind: 'web' },
  { name: 'requester_request_new', who: requester, path: '/requests/new/BUY_GOODS', kind: 'web' },
  { name: 'dm_proc_reports_sourcing', who: 'dm_proc', path: '/reports/sourcing', kind: 'web' },
  { name: 'admin_request-type_form', who: 'admin', path: '/admin/request-types/BUY_GOODS/form', kind: 'web' },
]

let sheet: P1Sheet
test.beforeAll(async () => {
  test.setTimeout(600_000)
  mkdirSync(OUT, { recursive: true })
  sheet = await p1Sheet()
  if (t.awardTask?.code) day('prepare', `${t.awardTask.code}:${lineUserOf(t.awardTask.code)}`)
})

test.afterAll(() => {
  if (!existsSync(JOURNAL)) return
  const byName = new Map<string, unknown>()
  for (const line of readFileSync(JOURNAL, 'utf8').split('\n').filter(Boolean)) byName.set((JSON.parse(line) as { name: string }).name, JSON.parse(line))
  writeFileSync(path.join(OUT, 'shots.json'), `${JSON.stringify([...byName.values()], null, 2)}\n`)
})

async function context(browser: Browser, size: { width: number; height: number }, ip: string, locale: 'th' | 'en'): Promise<BrowserContext> {
  const device = size.width < 768 ? devices['Pixel 7'] : devices['Desktop Chrome']
  return browser.newContext({ ...device, viewport: size, baseURL: E2E_BASE_URL, locale: locale === 'en' ? 'en-US' : 'th-TH', timezoneId: 'Asia/Bangkok', extraHTTPHeaders: { 'x-forwarded-for': ip } })
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
  const height = await page.evaluate(() => document.documentElement.scrollHeight)
  const clip = height > MAX_PICTURE_HEIGHT ? { x: 0, y: 0, width, height: MAX_PICTURE_HEIGHT } : undefined
  await page.screenshot({ path: file, fullPage: true, ...(clip ? { clip } : {}), style: screen.kind === 'liff' ? BARS_IN_PLACE : undefined })
  return { picture: path.relative(process.cwd(), file).split(path.sep).join('/'), axe: blocking, sideways: found.sideways, smallText: found.small.slice(0, 20), smallTextCount: found.small.length }
}

for (const screen of SCREENS) {
  test(`S10-20 ${screen.name}`, async ({ browser, clientIp }) => {
    test.setTimeout(240_000)
    test.skip(!screen.path || !screen.who, `no record for ${screen.name} on this database`)
    const record: Record<string, unknown> = { name: screen.name, who: screen.who, kind: screen.kind, path: screen.path }
    const widths = screen.kind === 'web' ? [WIDE, PHONE] : [PHONE, WIDE]
    for (const size of widths) {
      const ctx = await context(browser, size, clientIp, screen.locale ?? 'th')
      if (screen.kind === 'liff') {
        day('prepare', `${screen.who}:${lineUserOf(screen.who!)}`)
        await openAsLineUser(ctx, lineUserOf(screen.who!))
      } else if (screen.kind === 'portal') await portalSessionOn(ctx, t.org, screen.who!)
      const page = await ctx.newPage()
      if (screen.kind === 'web') await signInAs(page, sheet, screen.who!)
      // the portal's first JavaScript, weighed once on the phone with nothing cached (§9.4 · ADR-184)
      if (screen.kind === 'portal' && size.width < 768) {
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
