import { spawnSync } from 'node:child_process'
import type { Page } from '@playwright/test'
import { INPUT_WORKBOOKS, loadInputWorkbook, type SheetRow } from '../../../src/server/seed/workbook'
import { e2eEnv } from '../../support/e2e-env'
import { signIn } from '../insight-support'

// Shared steps of the scenes of phase 1 (P1-08, spec §16.13, docs/drafts/p1/P1-08-demo-script.md). The scenes read who
// does what, with which amounts and what should follow from the phase-1 workbook itself (docs/inputs/BCS_inputs_p1.xlsx,
// made by scripts/inputs_p1/make.py): sheet Demo_Script_P1 (one row per scene, scripts/inputs_p1/p1_demo.py) and the
// sheets its rows name (Users, Request_History, Items, Suppliers, SupplierPayment, Budget, DOA, Workflow_Reviewers,
// DocSamples, Settings). `pnpm inputs:check` checks every row against those sheets and the rules (validate_inputs.py
// --profile p1), so a scene trusts the row and types no member, amount or document number of its own.
// They run in p1demo mode (tests/support/e2e-env.ts) on one database seeded with SIMEC and its Request_History
// (tests/e2e/prepare-db.ts), in file order, each scene building on the ones before it as on the day, on the real clock.
// A later scene finds what an earlier one made in the database by the values of the rows (./scripts/*.ts), never by an
// id or a number typed here. Axe and screenshots are not part of the scenes (P1-09 reviews the screens).
// A scene file imports this module at the top: to the p1demo project of playwright.config.ts only the *.spec.ts files of
// this folder are test files. The generic helpers of the old demo scenes (money and words as the screens show them, the
// LINE fake, LIFF) are imported from ../demo/support, which reads no workbook until it is asked to.

// ---------- the workbook ----------

/** Where a scene happens: a workspace page, a LIFF page, the LINE chat, the BCS Go app (online or not), an e-mail */
export type P1Channel = 'WEB' | 'LIFF' | 'LINE_CHAT' | 'APP' | 'APP_OFFLINE' | 'EMAIL'
const CHANNELS: readonly P1Channel[] = ['WEB', 'LIFF', 'LINE_CHAT', 'APP', 'APP_OFFLINE', 'EMAIL']

export type P1Outcome = 'ROUTED' | 'BLOCKED' | 'MATCHED' | 'EXCEPTION' | 'READY' | 'APPROVED' | 'RECEIVED' | 'PAID' | 'PUBLISHED' | 'ANSWERED' | 'NA'
const OUTCOMES: readonly P1Outcome[] = ['ROUTED', 'BLOCKED', 'MATCHED', 'EXCEPTION', 'READY', 'APPROVED', 'RECEIVED', 'PAID', 'PUBLISHED', 'ANSWERED', 'NA']

/** One row of sheet Demo_Script_P1: a scene of the day of phase 1 */
export interface P1Scene {
  /** Row in the sheet, for messages */
  readonly row: number
  readonly scene: number
  /** core = Y: the scene must pass before finish line A3 */
  readonly core: boolean
  /** The step that owns the scene: S6 S8 S9 S13 S17 */
  readonly stage: string
  /** The topic of P1-08 the scene shows (PARALLEL_REVIEW, INVOICE_EMAIL, …): the key of its expectJson */
  readonly area: string
  readonly titleTh: string
  /** Code of the member who acts (sheet Users) */
  readonly actor: string
  /** Codes of the other members who act in the scene, in order */
  readonly others: readonly string[]
  readonly channel: P1Channel
  readonly requestType: string | null
  readonly chargedDept: string | null
  /** A budget key without its year (sheet Budget): the line of the fiscal year of the day the scene runs */
  readonly budgetKey: string | null
  readonly site: string | null
  readonly supplier: string | null
  readonly itemCode: string | null
  /** The quantity as the sheet writes it ("8000", "2.5") */
  readonly qty: string | null
  /** Satang before VAT; null when the scene asks for no amount */
  readonly unitPrice: bigint | null
  readonly net: bigint | null
  readonly vat: bigint | null
  readonly gross: bigint | null
  /** A row of sheet Request_History the scene works on (an invoice, a receipt) */
  readonly historyRef: string | null
  /** A row of sheet DocSamples (the AI scenes) */
  readonly docSample: string | null
  /** The supplier's number and unit price (satang, before VAT) on the invoice of the scene */
  readonly invoiceNo: string | null
  readonly invoiceUnitPrice: bigint | null
  readonly expectedOutcome: P1Outcome
  /** The DOA rule and the member of its approval step */
  readonly expectedRule: string | null
  readonly expectedApprover: string | null
  /** The parallel reviewers the workflow in effect gives the scene's request: rule → member */
  readonly expectedReviewers: ReadonlyArray<{ readonly rule: string; readonly member: string }>
  readonly escalated: boolean | null
  readonly delegation: string | null
  /** expectJson: what the scene's area expects besides the columns (docs/drafts/p1/P1-08-demo-script.md §3.2) */
  readonly expect: Readonly<Record<string, unknown>>
  readonly minutes: number
  readonly stepsTh: string
}

/** A member of sheet Users */
export interface P1User {
  readonly code: string
  readonly nameTh: string
  readonly email: string
  readonly department: string
  readonly roles: readonly string[]
  readonly positions: readonly string[]
  /** A role or a position: the seed enrols them in TOTP, so the web sign-in asks for the code (FR-AUTH-002 AC1) */
  readonly twoFactor: boolean
}

/** A row of sheet Request_History: a request of the past the seed made through the services */
export interface P1HistoryRow {
  readonly row: number
  readonly ref: string
  readonly daysAgo: number
  readonly requester: string
  readonly chargedDept: string
  readonly requestType: string
  readonly title: string
  readonly site: string | null
  readonly supplier: string | null
  readonly budgetKey: string
  readonly itemCode: string
  readonly qty: string
  readonly unit: string | null
  readonly unitPrice: bigint
  readonly net: bigint
  readonly vat: bigint
  readonly gross: bigint
  readonly status: string
  readonly expectedRule: string | null
  readonly expectedApprover: string | null
  readonly invoiceScenario: string | null
  readonly invoiceNo: string | null
  readonly whtIncomeType: string | null
  readonly paymentStatus: string | null
}

/** A rule of sheet DOA (version of DOA_Policy): its band in satang (null: no bound) and whom it names */
export interface P1DoaRule {
  readonly ruleCode: string
  readonly documentType: string
  readonly gt: bigint | null
  readonly lte: bigint | null
  readonly approverKind: string
  readonly approverPosition: string | null
  readonly approverMember: string | null
}

export interface P1Sheet {
  /** Sheet Org: the organization's code (SIMEC) */
  readonly orgCode: string
  readonly scenes: readonly P1Scene[]
  readonly users: ReadonlyMap<string, P1User>
  readonly history: ReadonlyMap<string, P1HistoryRow>
  /** Code → Thai name, of sheets Departments, Sites, RequestTypes, Items and Suppliers */
  readonly departments: ReadonlyMap<string, string>
  /** Sheet Departments: each department's parent (null: the organization's root) */
  readonly departmentParents: ReadonlyMap<string, string | null>
  /** Sheet Positions: each position's Thai name and whether it is one per department or one for the organization */
  readonly positions: ReadonlyMap<string, { readonly nameTh: string; readonly scope: 'DEPARTMENT' | 'ORG' }>
  readonly sites: ReadonlyMap<string, string>
  readonly requestTypes: ReadonlyMap<string, string>
  readonly items: ReadonlyMap<string, { readonly nameTh: string; readonly unit: string; readonly isService: boolean; readonly whtIncomeType: string | null }>
  readonly suppliers: ReadonlyMap<string, { readonly nameTh: string; readonly email: string; readonly taxId: string; readonly vatRegistered: boolean }>
  /** Sheet SupplierPayment by supplier code */
  readonly supplierPayment: ReadonlyMap<string, { readonly payeeType: string; readonly whtIncomeType: string | null; readonly paymentTermDays: number; readonly eTaxIssuer: string }>
  /** Sheet Budget: budget key → fiscal year code (FY2569) → line code and planned amount (satang) */
  readonly budget: ReadonlyMap<string, ReadonlyMap<string, { readonly code: string; readonly nameTh: string; readonly department: string; readonly planned: bigint }>>
  /** Sheet DOA_Policy: the code, number and amount basis of the DOA version the seed publishes, its stepUpThreshold (satang) */
  readonly doa: { readonly code: string; readonly version: number; readonly amountBasis: 'GROSS' | 'NET'; readonly stepUpThreshold: bigint }
  readonly doaRules: readonly P1DoaRule[]
  /** Sheet DocSamples by sampleId: the document number, supplier and amounts (satang) */
  readonly docSamples: ReadonlyMap<string, { readonly docType: string; readonly historyRef: string; readonly supplierCode: string; readonly docNo: string; readonly net: bigint | null; readonly vat: bigint | null; readonly gross: bigint | null }>
  /** Sheet Settings: each key's value as the sheet writes it */
  readonly settings: ReadonlyMap<string, string>
}

/** Whole baht or baht with satang as the sheet writes them ("42000", "1309.5") in satang; null for anything else */
export function satangOf(value: string | null | undefined): bigint | null {
  const m = /^(\d{1,13})(?:\.(\d{1,2}))?$/.exec(value ?? '')
  return m ? BigInt(m[1]!) * 100n + BigInt((m[2] ?? '').padEnd(2, '0')) : null
}

const text = (r: SheetRow, key: string): string | null => r.values[key] ?? null
function must(r: SheetRow, sheet: string, key: string): string {
  const value = text(r, key)
  if (value === null) throw new Error(`${sheet} row ${r.row}: ${key} is empty`)
  return value
}
function money(r: SheetRow, sheet: string, key: string): bigint {
  const value = satangOf(must(r, sheet, key))
  if (value === null) throw new Error(`${sheet} row ${r.row}: ${key} is not an amount in baht`)
  return value
}
function moneyOrNull(r: SheetRow, sheet: string, key: string): bigint | null {
  const value = text(r, key)
  if (value === null) return null
  const satang = satangOf(value)
  if (satang === null) throw new Error(`${sheet} row ${r.row}: ${key} ${value} is not an amount in baht`)
  return satang
}
const yesNo = (value: string | null): boolean | null => (value === 'Y' ? true : value === 'N' ? false : null)
const list = (value: string | null, separator: string) => (value ?? '').split(separator).map((s) => s.trim()).filter(Boolean)

function sceneOfRow(r: SheetRow): P1Scene {
  const S = 'Demo_Script_P1'
  const channel = must(r, S, 'channel') as P1Channel
  if (!CHANNELS.includes(channel)) throw new Error(`${S} row ${r.row}: channel ${channel} is not one of ${CHANNELS.join(' ')}`)
  const outcome = must(r, S, 'expectedOutcome') as P1Outcome
  if (!OUTCOMES.includes(outcome)) throw new Error(`${S} row ${r.row}: expectedOutcome ${outcome} is not one of ${OUTCOMES.join(' ')}`)
  let expectations: unknown
  try {
    expectations = JSON.parse(text(r, 'expectJson') ?? '{}')
  } catch (error) {
    throw new Error(`${S} row ${r.row}: expectJson is not JSON (${(error as Error).message})`)
  }
  if (typeof expectations !== 'object' || expectations === null || Array.isArray(expectations)) throw new Error(`${S} row ${r.row}: expectJson is not a JSON object`)
  return {
    row: r.row,
    scene: Number(must(r, S, 'scene')),
    core: yesNo(text(r, 'core')) === true,
    stage: must(r, S, 'stage'),
    area: must(r, S, 'area'),
    titleTh: must(r, S, 'titleTh'),
    actor: must(r, S, 'actor'),
    others: list(text(r, 'others'), '·'),
    channel,
    requestType: text(r, 'requestType'),
    chargedDept: text(r, 'chargedDept'),
    budgetKey: text(r, 'budgetKey'),
    site: text(r, 'site'),
    supplier: text(r, 'supplier'),
    itemCode: text(r, 'itemCode'),
    qty: text(r, 'qty'),
    unitPrice: moneyOrNull(r, S, 'unitPrice'),
    net: moneyOrNull(r, S, 'net'),
    vat: moneyOrNull(r, S, 'vat'),
    gross: moneyOrNull(r, S, 'gross'),
    historyRef: text(r, 'historyRef'),
    docSample: text(r, 'docSample'),
    invoiceNo: text(r, 'invoiceNo'),
    invoiceUnitPrice: moneyOrNull(r, S, 'invoiceUnitPrice'),
    expectedOutcome: outcome,
    expectedRule: text(r, 'expectedRule'),
    expectedApprover: text(r, 'expectedApprover'),
    expectedReviewers: list(text(r, 'expectedReviewers'), '·').map((pair) => {
      const [rule, member] = pair.split('=').map((s) => s.trim())
      if (!rule || !member) throw new Error(`${S} row ${r.row}: expectedReviewers "${pair}" is not RULE=member`)
      return { rule, member }
    }),
    escalated: yesNo(text(r, 'escalated')),
    delegation: text(r, 'delegation'),
    expect: expectations as Record<string, unknown>,
    minutes: Number(text(r, 'minutes') ?? '0'),
    stepsTh: must(r, S, 'stepsTh'),
  }
}

async function load(): Promise<P1Sheet> {
  const workbook = await loadInputWorkbook(INPUT_WORKBOOKS.p1)
  const orgCode = workbook.keyValues('Org').get('code')?.value
  if (!orgCode) throw new Error('Org: code is empty')
  const users = new Map<string, P1User>()
  for (const r of workbook.table('Users')) {
    const roles = list(text(r, 'roles'), ',')
    const positions = list(text(r, 'positions'), ';')
    const code = must(r, 'Users', 'code')
    users.set(code, {
      code,
      nameTh: must(r, 'Users', 'displayNameTh'),
      email: must(r, 'Users', 'email').toLowerCase(),
      department: must(r, 'Users', 'department'),
      roles,
      positions,
      twoFactor: roles.some((role) => role !== 'REQUESTER') || positions.length > 0,
    })
  }
  const H = 'Request_History'
  const history = new Map(
    workbook.table(H).map((r) => {
      const ref = must(r, H, 'ref')
      const row: P1HistoryRow = {
        row: r.row,
        ref,
        daysAgo: Number(must(r, H, 'daysAgo')),
        requester: must(r, H, 'requester'),
        chargedDept: must(r, H, 'chargedDept'),
        requestType: must(r, H, 'requestType'),
        title: must(r, H, 'title'),
        site: text(r, 'site'),
        supplier: text(r, 'supplier'),
        budgetKey: must(r, H, 'budgetKey'),
        itemCode: must(r, H, 'itemCode'),
        qty: must(r, H, 'qty'),
        unit: text(r, 'unit'),
        unitPrice: money(r, H, 'unitPrice'),
        net: money(r, H, 'net'),
        vat: money(r, H, 'vat'),
        gross: money(r, H, 'gross'),
        status: must(r, H, 'status'),
        expectedRule: text(r, 'expectedRule'),
        expectedApprover: text(r, 'expectedApprover'),
        invoiceScenario: text(r, 'invoiceScenario'),
        invoiceNo: text(r, 'invoiceNo'),
        whtIncomeType: text(r, 'whtIncomeType'),
        paymentStatus: text(r, 'paymentStatus'),
      }
      return [ref, row] as const
    }),
  )
  const names = (sheet: string) => new Map(workbook.table(sheet).map((r) => [must(r, sheet, 'code'), must(r, sheet, 'nameTh')] as const))
  const budget = new Map<string, Map<string, { code: string; nameTh: string; department: string; planned: bigint }>>()
  for (const r of workbook.table('Budget')) {
    const key = text(r, 'budgetKey')
    if (key === null) continue
    const years = budget.get(key) ?? new Map()
    years.set(must(r, 'Budget', 'fiscalYear'), { code: must(r, 'Budget', 'code'), nameTh: must(r, 'Budget', 'nameTh'), department: must(r, 'Budget', 'department'), planned: money(r, 'Budget', 'planned') })
    budget.set(key, years)
  }
  const policy = workbook.keyValues('DOA_Policy')
  const basis = policy.get('amountBasis')?.value
  if (basis !== 'GROSS' && basis !== 'NET') throw new Error(`DOA_Policy: amountBasis ${basis ?? '(empty)'}`)
  const version = Number(policy.get('version')?.value)
  const stepUpThreshold = satangOf(policy.get('stepUpThreshold')?.value)
  if (stepUpThreshold === null) throw new Error(`DOA_Policy: stepUpThreshold ${policy.get('stepUpThreshold')?.value ?? '(empty)'} is not an amount in baht`)
  return {
    orgCode,
    scenes: workbook.table('Demo_Script_P1').map(sceneOfRow),
    users,
    history,
    departments: names('Departments'),
    departmentParents: new Map(workbook.table('Departments').map((r) => [must(r, 'Departments', 'code'), text(r, 'parent')] as const)),
    positions: new Map(
      workbook.table('Positions').map((r) => {
        const scope = must(r, 'Positions', 'scope')
        if (scope !== 'DEPARTMENT' && scope !== 'ORG') throw new Error(`Positions row ${r.row}: scope ${scope}`)
        return [must(r, 'Positions', 'code'), { nameTh: must(r, 'Positions', 'nameTh'), scope }] as const
      }),
    ),
    sites: names('Sites'),
    requestTypes: names('RequestTypes'),
    items: new Map(
      workbook.table('Items').map(
        (r) =>
          [
            must(r, 'Items', 'code'),
            { nameTh: must(r, 'Items', 'nameTh'), unit: must(r, 'Items', 'unit'), isService: text(r, 'isService') === 'Y', whtIncomeType: text(r, 'whtIncomeType') },
          ] as const,
      ),
    ),
    suppliers: new Map(
      workbook
        .table('Suppliers')
        .map(
          (r) =>
            [
              must(r, 'Suppliers', 'code'),
              { nameTh: must(r, 'Suppliers', 'nameTh'), email: must(r, 'Suppliers', 'email').toLowerCase(), taxId: must(r, 'Suppliers', 'taxId'), vatRegistered: text(r, 'vatRegistered') === 'Y' },
            ] as const,
        ),
    ),
    supplierPayment: new Map(
      workbook.table('SupplierPayment').map(
        (r) =>
          [
            must(r, 'SupplierPayment', 'supplierCode'),
            {
              payeeType: must(r, 'SupplierPayment', 'payeeType'),
              whtIncomeType: text(r, 'whtIncomeType'),
              paymentTermDays: Number(must(r, 'SupplierPayment', 'paymentTermDays')),
              eTaxIssuer: must(r, 'SupplierPayment', 'eTaxIssuer'),
            },
          ] as const,
      ),
    ),
    budget,
    doa: { code: policy.get('code')?.value ?? '', version, amountBasis: basis, stepUpThreshold },
    doaRules: workbook
      .table('DOA')
      .filter((r) => Number(text(r, 'version')) === version)
      .map((r) => ({
        ruleCode: must(r, 'DOA', 'ruleCode'),
        documentType: must(r, 'DOA', 'documentType'),
        gt: satangOf(text(r, 'gt')),
        lte: satangOf(text(r, 'lte')),
        approverKind: must(r, 'DOA', 'approverKind'),
        approverPosition: text(r, 'approverPosition'),
        approverMember: text(r, 'approverMember'),
      })),
    docSamples: new Map(
      workbook.table('DocSamples').map(
        (r) =>
          [
            must(r, 'DocSamples', 'sampleId'),
            {
              docType: must(r, 'DocSamples', 'docType'),
              historyRef: must(r, 'DocSamples', 'historyRef'),
              supplierCode: must(r, 'DocSamples', 'supplierCode'),
              docNo: must(r, 'DocSamples', 'docNo'),
              net: moneyOrNull(r, 'DocSamples', 'net'),
              vat: moneyOrNull(r, 'DocSamples', 'vat'),
              gross: moneyOrNull(r, 'DocSamples', 'gross'),
            },
          ] as const,
      ),
    ),
    settings: new Map([...workbook.keyValues('Settings')].flatMap(([key, entry]) => (entry.value === null ? [] : [[key, entry.value] as const]))),
  }
}

let loaded: Promise<P1Sheet> | null = null

/** The phase-1 workbook's sheets the scenes read, once per worker */
export function p1Sheet(): Promise<P1Sheet> {
  loaded ??= load()
  return loaded
}

/** The core scenes (core = Y), in the sheet's order */
export const coreScenes = (sheet: P1Sheet): P1Scene[] => sheet.scenes.filter((s) => s.core)

export function sceneOf(sheet: P1Sheet, scene: number): P1Scene {
  const found = sheet.scenes.find((s) => s.scene === scene)
  if (!found) throw new Error(`Demo_Script_P1 has no scene ${scene}`)
  return found
}

export function userOf(sheet: P1Sheet, code: string | null): P1User {
  const user = code === null ? undefined : sheet.users.get(code)
  if (!user) throw new Error(`sheet Users has no member ${code ?? '(empty)'}`)
  return user
}

export function historyOf(sheet: P1Sheet, ref: string | null): P1HistoryRow {
  const row = ref === null ? undefined : sheet.history.get(ref)
  if (!row) throw new Error(`sheet Request_History has no row ${ref ?? '(empty)'}`)
  return row
}

/** A column a scene needs: an error that names the row when it is empty */
export function columnOf<K extends keyof P1Scene>(scene: P1Scene, key: K): NonNullable<P1Scene[K]> {
  const value = scene[key]
  if (value === null || value === undefined) throw new Error(`Demo_Script_P1 row ${scene.row} (scene ${scene.scene}): ${String(key)} is empty`)
  return value as NonNullable<P1Scene[K]>
}

/** A key of the scene's expectJson: an error that names the row when it is missing */
export function expectedOf<T>(scene: P1Scene, key: string): T {
  if (!Object.hasOwn(scene.expect, key)) throw new Error(`Demo_Script_P1 row ${scene.row} (scene ${scene.scene}): expectJson has no "${key}"`)
  return scene.expect[key] as T
}

/** An amount of expectJson written as the sheet writes baht ("1800.00"), in satang */
export function expectedSatang(scene: P1Scene, key: string): bigint {
  const value = expectedOf<unknown>(scene, key)
  const satang = typeof value === 'string' ? satangOf(value) : null
  if (satang === null) throw new Error(`Demo_Script_P1 row ${scene.row} (scene ${scene.scene}): expectJson "${key}" is not an amount in baht ("1800.00")`)
  return satang
}

// ---------- the day and its fiscal year ----------

/** Today in Thai time, YYYY-MM-DD: the day the scenes run (the app's real clock) */
export const todayInBangkok = (at: Date = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bangkok' }).format(at)

/**
 * The fiscal year code of a day: SIMEC's year runs January to December (sheet Org fiscalYearStartMonth = 1, OQ-11
 * default), named by its Buddhist year — 2026-10-17 → FY2569, as src/server/seed/budget.ts fiscalYearDates reads it
 */
export function fiscalYearOf(day: string): string {
  return `FY${Number(day.slice(0, 4)) + 543}`
}

/** The line of a budget key in the fiscal year of the day (today by default), as the seed and the form pick it */
export function budgetLineOf(sheet: P1Sheet, key: string | null, day: string = todayInBangkok()) {
  const fiscalYear = fiscalYearOf(day)
  const line = key === null ? undefined : sheet.budget.get(key)?.get(fiscalYear)
  if (!line) throw new Error(`sheet Budget has no line of key ${key ?? '(empty)'} in ${fiscalYear}`)
  return line
}

/** The member who holds a position in a department by sheet Users ("DM@MEP"), or null */
export function holderOf(sheet: P1Sheet, position: string, department: string): P1User | null {
  return [...sheet.users.values()].find((u) => u.positions.includes(`${position}@${department}`)) ?? null
}

/**
 * Whom a rule of the DOA names for a department, by the sheets: the holder of its position in that department or the
 * nearest one above it (POSITION_OF_DEPARTMENT), the organization's holder (POSITION_OF_ORG), or the member it names
 */
export function approverByRule(sheet: P1Sheet, ruleCode: string, department: string): P1User {
  const rule = ruleOf(sheet, ruleCode)
  if (rule.approverKind === 'MEMBER') return userOf(sheet, rule.approverMember)
  const position = rule.approverPosition
  if (position === null) throw new Error(`DOA rule ${ruleCode} names no position`)
  if (rule.approverKind === 'POSITION_OF_ORG') {
    const root = [...sheet.departmentParents].find(([, parent]) => parent === null)?.[0]
    const holder = root === undefined ? null : holderOf(sheet, position, root)
    if (!holder) throw new Error(`nobody holds ${position} of the organization (rule ${ruleCode})`)
    return holder
  }
  for (let d: string | null | undefined = department; d; d = sheet.departmentParents.get(d)) {
    const holder = holderOf(sheet, position, d)
    if (holder) return holder
  }
  throw new Error(`nobody holds ${position} at ${department} or above it (rule ${ruleCode})`)
}

/** The rule of the sheet's DOA by its code */
export function ruleOf(sheet: P1Sheet, ruleCode: string | null): P1DoaRule {
  const rule = sheet.doaRules.find((r) => r.ruleCode === ruleCode)
  if (!rule) throw new Error(`sheet DOA version ${sheet.doa.version} has no rule ${ruleCode ?? '(empty)'}`)
  return rule
}

/** The amount the DOA counts for a scene's row: with VAT or before it, as sheet DOA_Policy says (amountBasis) */
export function countedOf(sheet: P1Sheet, scene: P1Scene): bigint {
  return columnOf(scene, sheet.doa.amountBasis === 'GROSS' ? 'gross' : 'net')
}

// ---------- the web ----------

/** Signs the member in on the web: the seeded password, and the authenticator code when the sheet says they need it */
export async function signInAs(page: Page, sheet: P1Sheet, code: string): Promise<P1User> {
  const user = userOf(sheet, code)
  await signIn(page, user.email, user.twoFactor ? user.code : null)
  return user
}

// ---------- scene scripts: what the database says and what happens outside the screens ----------

const SAFE_ARG = /^[A-Za-z0-9_.:@-]+$/

/**
 * Runs a scene script with tsx against the run's database (the p1demo e2e database: the script checks) and returns the
 * JSON of its last line. `tests/e2e/demo/scripts/day.ts` reads the phase-1 workbook in p1demo mode, so the scenes of
 * phase 1 use its commands too (day(…)); a step's own script lives in ./scripts/ (script('scripts/s8.ts', …)).
 */
export function script<T>(file: string, ...args: string[]): T {
  return scriptWith<T>({}, file, ...args)
}

/** script(…) with more environment for the script's process (FAKE_PUSH_ENV, PUSH_PROVIDER=fake …: env.ts reads them once) */
export function scriptWith<T>(env: Readonly<Record<string, string>>, file: string, ...args: string[]): T {
  for (const arg of [file, ...args]) if (!SAFE_ARG.test(arg.replaceAll('/', '_'))) throw new Error(`not an argument for a scene script: ${arg}`)
  const target = file.startsWith('tests/') ? file : `tests/e2e/p1demo/${file}`
  const r = spawnSync(`pnpm exec tsx ${target} ${args.join(' ')}`, { shell: true, encoding: 'utf8', env: { ...process.env, ...e2eEnv(), E2E_P1DEMO: '1', ...env }, maxBuffer: 64 * 1024 * 1024 })
  // A script may spend link codes or tokens (secrets of this test database): on failure only what went wrong is shown
  if (r.status !== 0) throw new Error(`scene script ${target} ${args[0] ?? ''} failed:\n${r.stderr}`)
  return JSON.parse(r.stdout.trim().split('\n').at(-1)!) as T
}

/** The commands of the old demo's day script (prepare deliver request latest budget doa counts channel history po …) on SIMEC */
export const day = <T>(...args: string[]): T => script<T>('tests/e2e/demo/scripts/day.ts', ...args)
