import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { devices, type Browser, type BrowserContext, type Page } from '@playwright/test'
import { expect } from '../fixtures'
import { INPUT_WORKBOOKS, loadInputWorkbook, type SheetRow } from '../../../src/server/seed/workbook'
import { E2E_BASE_URL, e2eEnv } from '../../support/e2e-env'

// Shared steps of the scenes of phase 2 (S7-17 · ADR-191 · docs/drafts/p2/S7-demo-runbook.md). A scene reads who does
// what and what should follow from the phase-1 workbook itself (docs/inputs/BCS_inputs_p1.xlsx): sheet Demo_Script_P2
// (one row per scene · scripts/inputs_p1/p1_suppliers_portal.py demo_p2_rows for S7) and the sheets its rows name (Users
// through ../p1demo/support, Supplier_Contacts, Supplier_Applications, Request_History). `pnpm inputs:check` checks every
// row against those sheets. The scenes run in p2demo mode (tests/support/e2e-env.ts) on one database seeded with SIMEC
// and its histories — of requests, payments and supplier applications — in file order, on the real clock, without the
// scenes of phase 1 before them: what a scene needs of the past is in the seed (ADR-191). A scene finds what an earlier
// one made by the values of the rows (./scripts/s7.ts), never by an id or a number typed here. Members sign in with
// ../p1demo/support (signInAs); a supplier's contact signs in on the portal by the code e-mailed to it (scene 1), or
// with a session the scene script opens (the other scenes: the portal's sign-in is scene 1's).

// ---------- the workbook ----------

/** One row of sheet Demo_Script_P2 */
export interface P2Scene {
  readonly row: number
  readonly scene: number
  readonly core: boolean
  /** The step that owns the scene: S7 S10 S11 */
  readonly stage: string
  readonly titleTh: string
  /** Code of the member who acts (sheet Users) */
  readonly actor: string
  readonly others: readonly string[]
  /** The e-mail of the supplier's contact who acts on the portal (sheet Supplier_Contacts or Supplier_Applications) */
  readonly portalActor: string | null
  /** A supplier code (sheet Suppliers) or an application ref (sheet Supplier_Applications) */
  readonly supplier: string | null
  readonly module: string | null
  readonly expect: Readonly<Record<string, unknown>>
  readonly stepsTh: string
}

/** One row of sheet Supplier_Applications */
export interface P2Application {
  readonly ref: string
  readonly nameTh: string
  readonly taxId: string | null
  readonly status: string
  readonly contactEmail: string
  readonly invitedBy: string
  readonly missingDocs: readonly string[]
}

export interface P2Sheet {
  readonly orgCode: string
  readonly scenes: readonly P2Scene[]
  readonly applications: ReadonlyMap<string, P2Application>
}

const text = (r: SheetRow, key: string): string | null => {
  const v = r.values[key]
  if (v === null || v === undefined) return null
  const s = String(v).trim()
  return s === '' ? null : s
}
const must = (r: SheetRow, sheet: string, key: string): string => {
  const v = text(r, key)
  if (v === null) throw new Error(`${sheet} row ${r.row}: ${key} is empty`)
  return v
}
const list = (v: string | null, sep: string) => (v ? v.split(sep).map((x) => x.trim()).filter(Boolean) : [])

async function load(): Promise<P2Sheet> {
  const workbook = await loadInputWorkbook(INPUT_WORKBOOKS.p1)
  const orgCode = workbook.keyValues('Org').get('code')?.value
  if (!orgCode) throw new Error('Org: code is empty')
  const S = 'Demo_Script_P2'
  const scenes = workbook.table(S).map((r) => ({
    row: r.row,
    scene: Number(must(r, S, 'scene')),
    core: must(r, S, 'core') === 'Y',
    stage: must(r, S, 'stage'),
    titleTh: must(r, S, 'titleTh'),
    actor: must(r, S, 'actor'),
    others: list(text(r, 'others'), '·'),
    portalActor: text(r, 'portalActor')?.toLowerCase() ?? null,
    supplier: text(r, 'supplier'),
    module: text(r, 'module'),
    expect: JSON.parse(must(r, S, 'expectJson')) as Record<string, unknown>,
    stepsTh: must(r, S, 'stepsTh'),
  }))
  const A = 'Supplier_Applications'
  const applications = new Map(
    workbook.table(A).map((r) => {
      const ref = must(r, A, 'ref')
      return [ref, { ref, nameTh: must(r, A, 'nameTh'), taxId: text(r, 'taxId'), status: must(r, A, 'status'), contactEmail: must(r, A, 'contactEmail').toLowerCase(), invitedBy: must(r, A, 'invitedBy'), missingDocs: list(text(r, 'missingDocs'), ',') }] as const
    }),
  )
  return { orgCode: orgCode.toLowerCase(), scenes, applications }
}

let loaded: Promise<P2Sheet> | null = null
/** The phase-1 workbook's phase-2 rows, read once per worker */
export function p2Sheet(): Promise<P2Sheet> {
  loaded ??= load()
  return loaded
}

export function p2SceneOf(sheet: P2Sheet, scene: number): P2Scene {
  const s = sheet.scenes.find((x) => x.scene === scene)
  if (!s) throw new Error(`Demo_Script_P2 has no scene ${scene}`)
  return s
}

export function p2Expected<T>(scene: P2Scene, key: string): T {
  if (!(key in scene.expect)) throw new Error(`scene ${scene.scene}: expectJson has no ${key}`)
  return scene.expect[key] as T
}

export function applicationOf(sheet: P2Sheet, ref: string): P2Application {
  const a = sheet.applications.get(ref)
  if (!a) throw new Error(`Supplier_Applications has no ${ref}`)
  return a
}

// ---------- the scene script ----------

const SAFE_ARG = /^[A-Za-z0-9_.:@/+-]+$/

/** Runs ./scripts/s7.ts against the run's database (it checks it is the p2demo one) and returns the JSON of its last line */
export function s7<T>(...args: string[]): T {
  for (const arg of args) if (!SAFE_ARG.test(arg)) throw new Error(`not an argument for a scene script: ${arg}`)
  const r = spawnSync(`pnpm exec tsx tests/e2e/p2demo/scripts/s7.ts ${args.join(' ')}`, { shell: true, encoding: 'utf8', env: { ...process.env, ...e2eEnv(), E2E_P2DEMO: '1' }, maxBuffer: 64 * 1024 * 1024 })
  // the script may print a sign-in code or a session (secrets of this test database): on failure only stderr is shown
  if (r.status !== 0) throw new Error(`scene script s7 ${args[0] ?? ''} failed:\n${r.stderr}`)
  return JSON.parse(r.stdout.trim().split('\n').at(-1)!) as T
}

/** Runs ./scripts/s10.ts (the scenes of S10) against the run's database, as s7 does */
export function s10<T>(...args: string[]): T {
  for (const arg of args) if (!SAFE_ARG.test(arg)) throw new Error(`not an argument for a scene script: ${arg}`)
  const r = spawnSync(`pnpm exec tsx tests/e2e/p2demo/scripts/s10.ts ${args.join(' ')}`, { shell: true, encoding: 'utf8', env: { ...process.env, ...e2eEnv(), E2E_P2DEMO: '1' }, maxBuffer: 64 * 1024 * 1024 })
  if (r.status !== 0) throw new Error(`scene script s10 ${args[0] ?? ''} failed:\n${r.stderr}`)
  return JSON.parse(r.stdout.trim().split('\n').at(-1)!) as T
}

/** A session of the portal the scene script opened for a contact, set on the browser as the sign-in would set it */
export async function portalSessionOn(context: BrowserContext, org: string, email: string): Promise<void> {
  const { sid, csrf } = s7<{ sid: string; csrf: string }>('session', email)
  await context.addCookies([
    { name: 'bcs_portal', value: sid, url: `${E2E_BASE_URL}/portal/${org}` },
    { name: 'bcs_portal_csrf', value: csrf, url: `${E2E_BASE_URL}/portal/${org}` },
  ])
}

// ---------- the RFx of S10 (S10-18) ----------

/** One row of RFx_Bids: what a supplier types for a line of an RFx of RFx_Scenarios */
export interface RfxBidRow {
  readonly supplier: string
  readonly lineNo: number
  readonly unitPrice: string
  readonly includesVat: boolean
  readonly deliveryDays: number
}
/** One row of RFx_Scores: an evaluator's score of a supplier on a criterion that is not PRICE */
export interface RfxScoreRow {
  readonly evaluator: string
  readonly supplier: string
  readonly criterion: string
  readonly score: number
}
export interface RfxRows {
  readonly bids: readonly RfxBidRow[]
  readonly scores: readonly RfxScoreRow[]
  /** The scorecard's criteria of the row (weightsJson): code and Thai name, as the score page names them */
  readonly criteria: ReadonlyArray<{ readonly code: string; readonly nameTh: string }>
  /** The questions the seed asked and answered while the RFx was open (questionsJson) */
  readonly questions: ReadonlyArray<{ readonly supplier: string; readonly question: string; readonly answer: string }>
  /** The award's reason the seed gave (awardReason) */
  readonly awardReason: string | null
  /** Procurement's conclusion of an RFI (conclusionNote) */
  readonly conclusionNote: string | null
}

/** The bids, scores and criteria of an RFx of sheet RFx_Scenarios, from the phase-1 workbook */
export async function rfxRowsOf(ref: string): Promise<RfxRows> {
  const workbook = await loadInputWorkbook(INPUT_WORKBOOKS.p1)
  const row = workbook.table('RFx_Scenarios').find((r) => text(r, 'ref') === ref)
  if (!row) throw new Error(`RFx_Scenarios has no ${ref}`)
  const B = 'RFx_Bids'
  const bids = workbook
    .table(B)
    .filter((r) => text(r, 'rfxRef') === ref)
    .map((r) => ({ supplier: must(r, B, 'supplier'), lineNo: Number(must(r, B, 'lineNo')), unitPrice: must(r, B, 'unitPrice'), includesVat: must(r, B, 'includesVat') === 'Y', deliveryDays: Number(must(r, B, 'deliveryDays')) }))
  const S = 'RFx_Scores'
  const scores = workbook
    .table(S)
    .filter((r) => text(r, 'rfxRef') === ref)
    .map((r) => ({ evaluator: must(r, S, 'evaluator'), supplier: must(r, S, 'supplier'), criterion: must(r, S, 'criterion'), score: Number(must(r, S, 'score')) }))
  const weights = text(row, 'weightsJson')
  const criteria = weights ? (JSON.parse(weights) as Array<{ code: string; nameTh: string }>).map((c) => ({ code: c.code, nameTh: c.nameTh })) : []
  const asked = text(row, 'questionsJson')
  const questions = asked ? (JSON.parse(asked) as Array<{ supplier: string; question: string; answer: string }>).map((q) => ({ supplier: q.supplier, question: q.question, answer: q.answer })) : []
  return { bids, scores, criteria, questions, awardReason: text(row, 'awardReason'), conclusionNote: text(row, 'conclusionNote') }
}

/** What scripts/s10.ts rfx prints of an RFx the seed made */
export interface RfxFacts {
  readonly id: string
  readonly number: string | null
  readonly status: string
  readonly closesAt: string | null
  readonly lines: ReadonlyArray<{ readonly lineNo: number; readonly description: string; readonly quantity: string; readonly uom: string }>
  readonly invites: ReadonlyArray<{
    readonly supplierCode: string | null
    readonly supplierName: string | null
    readonly applicationId: string | null
    readonly status: string
    readonly contacts: ReadonlyArray<{ readonly email: string; readonly locale: string; readonly isPrimary: boolean }>
  }>
}

/** What scripts/s10.ts award prints of an RFx's award */
export interface AwardFacts {
  readonly number: string | null
  readonly status: string
  readonly net: string
  readonly vat: string
  readonly gross: string
  readonly reason: string | null
  readonly reasonCodes: readonly string[]
  readonly route: { readonly rule: string; readonly approvers: readonly string[]; readonly openTaskId: string | null } | null
  readonly pos: ReadonlyArray<{ readonly id: string; readonly number: string | null; readonly status: string; readonly net: string; readonly site: string | null }>
  readonly agreements: ReadonlyArray<{ readonly item: string; readonly supplier: string; readonly unitPrice: string }>
  readonly preferred: ReadonlyArray<{ readonly category: string; readonly supplier: string; readonly validFrom: string; readonly validTo: string }>
  readonly notices: ReadonlyArray<{ readonly template: string; readonly supplier: string | null }>
}

/** The words of the portal's RFx pages in a contact's language (messages/src/<locale>/portal.json, namespace rfx) */
export interface PortalRfxWords {
  readonly detail: { readonly bid: string; readonly applicationWaits: string }
  readonly bid: { readonly unitPrice: string; readonly vatIncluded: string; readonly deliveryDays: string; readonly next: string; readonly submit: string }
  readonly notices: { readonly sent: string; readonly asked: string }
  readonly questions: { readonly question: string; readonly send: string }
  readonly errors: Readonly<Record<string, string>>
}
export function portalRfxWords(locale: string): PortalRfxWords {
  const file = path.join(process.cwd(), 'messages', 'src', locale === 'en' ? 'en' : 'th', 'portal.json')
  return (JSON.parse(readFileSync(file, 'utf8')) as { rfx: PortalRfxWords }).rfx
}

/** A phone of a supplier's contact at 375 px with a session of the portal, in the contact's language */
export async function portalPhone(browser: Browser, org: string, email: string, locale: string): Promise<BrowserContext> {
  const phone = await browser.newContext({ ...devices['Pixel 7'], viewport: { width: 375, height: 812 }, baseURL: E2E_BASE_URL, locale: locale === 'en' ? 'en-US' : 'th-TH', timezoneId: 'Asia/Bangkok' })
  await portalSessionOn(phone, org, email)
  return phone
}

/**
 * A bid typed on the portal's form, step by step as a phone shows it (S10-07): from the RFx's page, the unit prices of
 * each line (with VAT when the row says so, before VAT otherwise), the delivery days on the terms step, then sent
 */
export async function bidOnPhone(page: Page, w: PortalRfxWords, bid: { readonly prices: readonly string[]; readonly includesVat: boolean; readonly deliveryDays: number }) {
  await page.getByRole('link', { name: w.detail.bid, exact: true }).click()
  const prices = page.getByLabel(w.bid.unitPrice)
  const next = page.getByRole('button', { name: w.bid.next, exact: true })
  await expect(prices.first()).toBeVisible()
  if (bid.includesVat) await page.getByLabel(w.bid.vatIncluded).filter({ visible: true }).first().check()
  for (const [i, price] of bid.prices.entries()) {
    if (!(await prices.nth(i).isVisible())) await next.click()
    await prices.nth(i).fill(price)
  }
  while (await next.isVisible()) {
    await next.click()
    const days = page.getByLabel(w.bid.deliveryDays)
    if (await days.isVisible()) await days.fill(String(bid.deliveryDays))
  }
  await page.getByRole('button', { name: w.bid.submit, exact: true }).click()
  await expect(page.getByRole('status').filter({ hasText: w.notices.sent })).toBeVisible()
}

/** The G-8 figures of sheet Demo_Script_P2 scene 15 (afterSeed · afterScene9) */
export interface G8Figures {
  readonly awards: number
  readonly baseline: string
  readonly savings: string
  readonly savingsBp: number
  readonly medianDays: string
}

/**
 * /reports/sourcing over the awards approved in the last 120 days up to today (every RFx of the seed opened within
 * six weeks of it · BR-RFX-15): the savings with their share of the baseline, the baseline, the lower median of the
 * business days from opening to the award's approval, and how many awards it counts (figures from code, not AI)
 */
export async function expectG8(page: Page, g: G8Figures) {
  const percent = `${g.savingsBp > 0 ? '+' : g.savingsBp < 0 ? '-' : ''}${Math.trunc(Math.abs(g.savingsBp) / 100)}.${String(Math.abs(g.savingsBp) % 100).padStart(2, '0')}%`
  await page.goto(`/reports/sourcing?${new URLSearchParams({ from: dayFromToday(-120), to: dayFromToday(0) }).toString()}`)
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('รายงานการจัดหา')
  const main = page.locator('main')
  await expect(main.getByText(`${bahtText(g.savings)} บาท (${percent})`).first()).toBeVisible()
  await expect(main.getByText(`${bahtText(g.baseline)} บาท`, { exact: true }).first()).toBeVisible()
  await expect(main.getByText(`${g.medianDays} วันทำการ`, { exact: true }).first()).toBeVisible()
  await expect(page.getByRole('heading', { name: `ผลมอบงานที่อนุมัติในช่วงนี้ (${g.awards})` })).toBeVisible()
}

/** Money as the pages write it: "300950.00" → "300,950.00" */
export const bahtText = (amount: string) => {
  const [whole = '0', cents = '00'] = amount.split('.')
  return `${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${cents.padEnd(2, '0')}`
}

/** The Thai day N days from today, as a date input takes it */
export function dayFromToday(days: number, at: Date = new Date()): string {
  return new Date(at.getTime() + 7 * 3_600_000 + days * 86_400_000).toISOString().slice(0, 10)
}
