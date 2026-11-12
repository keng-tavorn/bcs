import { spawnSync } from 'node:child_process'
import type { BrowserContext } from '@playwright/test'
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

/** The Thai day N days from today, as a date input takes it */
export function dayFromToday(days: number, at: Date = new Date()): string {
  return new Date(at.getTime() + 7 * 3_600_000 + days * 86_400_000).toISOString().slice(0, 10)
}
