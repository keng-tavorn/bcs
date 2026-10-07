import AxeBuilder from '@axe-core/playwright'
import { spawnSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { devices, type Browser, type BrowserContext, type Locator, type Page, type Route, type TestInfo } from '@playwright/test'
import { cardLabel, confirmationLabel, type CardLabel, type ConfirmationLabel } from '../../../src/channels/line/flex/labels'
import { liffPathFor } from '../../../src/channels/line/links'
import { formatThaiDate, formatThaiDateTime } from '../../../src/core/thai/date'
import { deriveSeedTotpSecret, totp } from '../../../src/lib/totp'
import { loadInputWorkbook, type SheetRow } from '../../../src/server/seed/workbook'
import { E2E_BASE_URL, E2E_FAKE_LINE_URL, E2E_LINE, e2eEnv } from '../../support/e2e-env'
import { attachmentOf, type MailpitMessage } from '../../support/mailpit'
import { expect } from '../fixtures'
import { checkScreen as checkWorkspaceScreen, exportedFile, percent, sha256, sheetRows, shownChecksum, signIn } from '../insight-support'
import { anotherPhone, BARS_IN_PLACE, checkScreen as checkPhoneScreen, openAsLineUser, pointerAway } from '../liff-support'
import { actions, budgetRegion, chooseSupplier, consolidateNow, expectPdfLink, header, poMails, poNumberOf, poolGroup, poTimeline, requestsRegion } from '../procurement-support'
import { rowWith } from '../tasks-support'

// Shared steps of the demo scenes (D-04, spec §16.10, docs/DEMO_RUNBOOK.md, docs/sub-specs/D.md). The scenes read who
// does what, with which amounts and what should follow from the workbook itself — sheet Demo_Script (one row per scene),
// Demo_History (the requests of the past the seed made) and the sheets those rows name (Users, Departments, Positions,
// Sites, RequestTypes, Budget, DOA_Policy, DOA) — except the steps §16.10 "ฉากที่ปรับ" adjusts. They run in demo mode on
// one database seeded with the demo organization and its history, in file order, each scene building on the ones before
// it as on the day; a later scene finds what it needs in the database or on the page (./scripts/day.ts), never by a
// number typed here. The app runs on the real clock (the business clock of the e2e, docs/sub-specs/D.md, is not built):
// no assertion reads the time of day, and a due time is read from the database.
//  - the web: a member signs in with the seeded password, and with the authenticator code when the sheet gives them a
//    role or a position (the seed enrols those in TOTP from SEED_TOTP_KEY);
//  - LINE: before the day every phone is linked (runbook §1 items 3 and 4: the rich menus made, each member linked to
//    their own LINE account through the link service, lineUserOf); the notification job is played by delivering a
//    member's pending notices with its own handler (deliverNotification), since the e2e app sends no outbox to Inngest,
//    so cards reach the fake LINE server of the run; what the fake received is read back; a button of a card is tapped by
//    sending the signed postback with `pnpm exec tsx scripts/line-simulate.ts postback`, as LINE would;
//  - LIFF: a page opens as a member's LINE user through LIFF_MOCK (the mock cookie; the ID token comes from the fake and
//    the sign-in is the real one), at 375 px; a LIFF deep link of a card or a rich menu becomes the page's path here.
// How a scene file uses this module: to the demo project of playwright.config.ts (testMatch '**/demo/**') every file of
// this folder is a test file, and Playwright refuses a test file that imports another one when it collects the tests.
// So a scene imports what it needs from here inside its test, `const { … } = await import('./support')` (types with
// `import type`, which leaves nothing behind), and this module imports nothing of this folder; ./scripts/day.ts does
// its work only when tsx runs it. A LIFF scene file sets its phone itself, at the top: a Pixel 7 at 375 px without the
// device's defaultBrowserType — `const { defaultBrowserType, ...pixel7 } = devices['Pixel 7']` then
// `test.use({ ...pixel7, viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true })` — because that one is
// a worker option: a file that sets it gets a worker of its own, Playwright runs each worker's files together, and the
// scenes would no longer run in the files' name order.

// ---------- the workbook ----------

export type Channel = 'LIFF' | 'LINE_CHAT' | 'WEB'

/** One row of sheet Demo_Script: a scene of the day */
export interface DemoScene {
  /** Row in the sheet, for messages */
  readonly row: number
  readonly scene: number
  /** core = Y: the scenes the demo cannot do without (§16.10) */
  readonly core: boolean
  readonly titleTh: string
  /** Code of the member who acts (Users sheet) */
  readonly actor: string
  readonly channel: Channel
  readonly requestType: string | null
  readonly chargedDept: string | null
  readonly budgetLine: string | null
  readonly site: string | null
  /** Satang; null when the scene asks for no amount */
  readonly net: bigint | null
  readonly vat: bigint | null
  readonly gross: bigint | null
  readonly expectedOutcome: 'ROUTED' | 'BLOCKED' | 'NA'
  readonly expectedRule: string | null
  readonly expectedApprover: string | null
  readonly escalated: boolean | null
  readonly delegation: string | null
  readonly stepsTh: string
}

/** One row of sheet Demo_History: a request of the past the seed made through the services (D-01) */
export interface DemoHistoryRow {
  readonly row: number
  readonly ref: string
  readonly daysAgo: number
  readonly requester: string
  readonly chargedDept: string
  readonly requestType: string
  readonly title: string
  readonly site: string | null
  readonly supplier: string | null
  readonly budgetLine: string
  readonly net: bigint
  readonly vat: bigint | null
  readonly gross: bigint | null
  readonly status: string
  readonly expectedRule: string | null
  readonly expectedApprover: string | null
  readonly escalated: boolean
  readonly hours: number
  readonly channel: Channel | null
  readonly note: string | null
}

/** A member of sheet Users */
export interface DemoUser {
  readonly code: string
  readonly nameTh: string
  readonly email: string
  readonly department: string
  readonly roles: readonly string[]
  readonly positions: readonly string[]
  /** A role or a position: the seed enrols them in TOTP, so the web sign-in asks for the code (FR-AUTH-002 AC1) */
  readonly twoFactor: boolean
}

export interface DemoSheet {
  readonly scenes: readonly DemoScene[]
  readonly history: readonly DemoHistoryRow[]
  readonly users: ReadonlyMap<string, DemoUser>
  /** Code → Thai name, of sheets Departments, Sites, RequestTypes and Budget */
  readonly departments: ReadonlyMap<string, string>
  /** Sheet Departments: each department's parent (null: the organization's root) */
  readonly departmentParents: ReadonlyMap<string, string | null>
  readonly sites: ReadonlyMap<string, string>
  readonly requestTypes: ReadonlyMap<string, string>
  readonly budgetLines: ReadonlyMap<string, string>
  /** Sheet Budget: each line's planned amount, what the demo history uses of it and what it leaves (satang) */
  readonly budget: ReadonlyMap<string, BudgetSheetLine>
  /** Sheet Positions: each position's Thai name and whether it is one per department or one for the organization */
  readonly positions: ReadonlyMap<string, { readonly nameTh: string; readonly scope: 'DEPARTMENT' | 'ORG' }>
  /** Sheet RequestTypes: the attachment rules each type names ("ATT-QUOTES · ATT-DPA") */
  readonly attachmentRules: ReadonlyMap<string, readonly string[]>
  /**
   * Sheet DOA_Policy: the code, number and amount basis of the DOA version the seed publishes, and its stepUpThreshold
   * (satang): a decision at or above it needs the PIN, below it the card approves in the chat (BR-TOK-05)
   */
  readonly doa: { readonly code: string; readonly version: number; readonly amountBasis: 'GROSS' | 'NET'; readonly stepUpThreshold: bigint }
  /** Sheet DOA: the rules of that version, with their bands in satang (null: no bound) and whom each names */
  readonly doaRules: readonly DoaSheetRule[]
  /** Sheet Suppliers: each supplier's Thai name and the address its purchase orders go to */
  readonly suppliers: ReadonlyMap<string, { readonly nameTh: string; readonly email: string }>
  /** Sheet Settings: each key's value as the sheet writes it ("0.07", "0.1") */
  readonly settings: ReadonlyMap<string, string>
}

/** A rule of sheet DOA: its band in satang (null: no bound) and the position that approves under it */
export interface DoaSheetRule {
  readonly ruleCode: string
  readonly documentType: string
  readonly gt: bigint | null
  readonly lte: bigint | null
  /** POSITION_OF_DEPARTMENT: the nearest holder up from the department that pays · POSITION_OF_ORG: the organization's */
  readonly approverKind: string
  readonly approverPosition: string | null
  /** The business hours the approver has to decide (the step's SLA); null when the sheet gives none */
  readonly slaBusinessHours: number | null
}

/** A line of sheet Budget (satang): remaining = planned − usedDemo, what the line has left once the history is seeded */
export interface BudgetSheetLine {
  readonly department: string
  /** The line's cost center (code) */
  readonly costCenter: string
  readonly planned: bigint
  readonly used: bigint
  readonly remaining: bigint
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
const yesNo = (value: string | null): boolean | null => (value === 'Y' ? true : value === 'N' ? false : null)
const list = (value: string | null, separator: string) => (value ?? '').split(separator).map((s) => s.trim()).filter(Boolean)

async function load(): Promise<DemoSheet> {
  const workbook = await loadInputWorkbook()
  const scenes = workbook.table('Demo_Script').map((r): DemoScene => {
    const outcome = must(r, 'Demo_Script', 'expectedOutcome')
    if (outcome !== 'ROUTED' && outcome !== 'BLOCKED' && outcome !== 'NA') throw new Error(`Demo_Script row ${r.row}: expectedOutcome ${outcome}`)
    const channel = must(r, 'Demo_Script', 'channel')
    if (channel !== 'LIFF' && channel !== 'LINE_CHAT' && channel !== 'WEB') throw new Error(`Demo_Script row ${r.row}: channel ${channel}`)
    return {
      row: r.row,
      scene: Number(must(r, 'Demo_Script', 'scene')),
      core: yesNo(text(r, 'core')) === true,
      titleTh: must(r, 'Demo_Script', 'titleTh'),
      actor: must(r, 'Demo_Script', 'actor'),
      channel,
      requestType: text(r, 'requestType'),
      chargedDept: text(r, 'chargedDept'),
      budgetLine: text(r, 'budgetLine'),
      site: text(r, 'site'),
      net: satangOf(text(r, 'net')),
      vat: satangOf(text(r, 'vat')),
      gross: satangOf(text(r, 'gross')),
      expectedOutcome: outcome,
      expectedRule: text(r, 'expectedRule'),
      expectedApprover: text(r, 'expectedApprover'),
      escalated: yesNo(text(r, 'escalated')),
      delegation: text(r, 'delegation'),
      stepsTh: must(r, 'Demo_Script', 'stepsTh'),
    }
  })
  const history = workbook.table('Demo_History').map(
    (r): DemoHistoryRow => ({
      row: r.row,
      ref: must(r, 'Demo_History', 'ref'),
      daysAgo: Number(must(r, 'Demo_History', 'daysAgo')),
      requester: must(r, 'Demo_History', 'requester'),
      chargedDept: must(r, 'Demo_History', 'chargedDept'),
      requestType: must(r, 'Demo_History', 'requestType'),
      title: must(r, 'Demo_History', 'title'),
      site: text(r, 'site'),
      supplier: text(r, 'supplier'),
      budgetLine: must(r, 'Demo_History', 'budgetLine'),
      net: satangOf(must(r, 'Demo_History', 'net')) ?? 0n,
      vat: satangOf(text(r, 'vat')),
      gross: satangOf(text(r, 'gross')),
      status: must(r, 'Demo_History', 'status'),
      expectedRule: text(r, 'expectedRule'),
      expectedApprover: text(r, 'expectedApprover'),
      escalated: yesNo(text(r, 'escalated')) === true,
      hours: Number(must(r, 'Demo_History', 'hours')),
      channel: (text(r, 'channel') as Channel | null) ?? null,
      note: text(r, 'note'),
    }),
  )
  const users = new Map<string, DemoUser>()
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
  const names = (sheet: string) => new Map(workbook.table(sheet).map((r) => [must(r, sheet, 'code'), must(r, sheet, 'nameTh')] as const))
  const policy = workbook.keyValues('DOA_Policy')
  const basis = policy.get('amountBasis')?.value
  if (basis !== 'GROSS' && basis !== 'NET') throw new Error(`DOA_Policy: amountBasis ${basis ?? '(empty)'}`)
  const version = Number(policy.get('version')?.value)
  const stepUpThreshold = satangOf(policy.get('stepUpThreshold')?.value)
  if (stepUpThreshold === null) throw new Error(`DOA_Policy: stepUpThreshold ${policy.get('stepUpThreshold')?.value ?? '(empty)'} is not an amount in baht`)
  return {
    scenes,
    history,
    users,
    departments: names('Departments'),
    departmentParents: new Map(workbook.table('Departments').map((r) => [must(r, 'Departments', 'code'), text(r, 'parent')] as const)),
    sites: names('Sites'),
    requestTypes: names('RequestTypes'),
    budgetLines: names('Budget'),
    budget: new Map(
      workbook.table('Budget').map(
        (r) =>
          [
            must(r, 'Budget', 'code'),
            {
              department: must(r, 'Budget', 'department'),
              costCenter: must(r, 'Budget', 'costCenter'),
              planned: money(r, 'Budget', 'planned'),
              used: money(r, 'Budget', 'usedDemo'),
              remaining: money(r, 'Budget', 'remaining'),
            },
          ] as const,
      ),
    ),
    positions: new Map(
      workbook.table('Positions').map((r) => {
        const scope = must(r, 'Positions', 'scope')
        if (scope !== 'DEPARTMENT' && scope !== 'ORG') throw new Error(`Positions row ${r.row}: scope ${scope}`)
        return [must(r, 'Positions', 'code'), { nameTh: must(r, 'Positions', 'nameTh'), scope }] as const
      }),
    ),
    attachmentRules: new Map(
      workbook.table('RequestTypes').map((r) => [must(r, 'RequestTypes', 'code'), list(text(r, 'attachmentRule'), '·').filter((rule) => /^[A-Z][A-Z0-9-]+$/.test(rule))] as const),
    ),
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
        slaBusinessHours: text(r, 'slaBusinessHours') === null ? null : Number(text(r, 'slaBusinessHours')),
      })),
    suppliers: new Map(
      workbook.table('Suppliers').map((r) => [must(r, 'Suppliers', 'code'), { nameTh: must(r, 'Suppliers', 'nameTh'), email: must(r, 'Suppliers', 'email').toLowerCase() }] as const),
    ),
    settings: new Map([...workbook.keyValues('Settings')].flatMap(([key, entry]) => (entry.value === null ? [] : [[key, entry.value] as const]))),
  }
}

let loaded: Promise<DemoSheet> | null = null

/** The workbook's demo sheets, read once per worker */
export function demoSheet(): Promise<DemoSheet> {
  loaded ??= load()
  return loaded
}

/** The core scenes (core = Y), in the sheet's order */
export const coreScenes = (sheet: DemoSheet): DemoScene[] => sheet.scenes.filter((s) => s.core)

export function sceneOf(sheet: DemoSheet, scene: number): DemoScene {
  const found = sheet.scenes.find((s) => s.scene === scene)
  if (!found) throw new Error(`Demo_Script has no scene ${scene}`)
  return found
}

export function userOf(sheet: DemoSheet, code: string | null): DemoUser {
  const user = code ? sheet.users.get(code) : undefined
  if (!user) throw new Error(`the Users sheet has no member ${code ?? '(none)'}`)
  return user
}

/** The Thai name of a code in one of the name maps of the sheet */
export function nameIn(names: ReadonlyMap<string, string>, code: string | null, what: string): string {
  const name = code ? names.get(code) : undefined
  if (!name) throw new Error(`no ${what} ${code ?? '(none)'} in the workbook`)
  return name
}

/** The amount a scene's row asks for: an error that names the row when it has none */
export function amountOf(scene: DemoScene, key: 'net' | 'vat' | 'gross'): bigint {
  const value = scene[key]
  if (value === null) throw new Error(`Demo_Script row ${scene.row} (scene ${scene.scene}) has no ${key}`)
  return value
}

/** The rule of the sheet's DOA whose band holds this amount, for a purchase request (or another document type) */
export function doaRuleFor(sheet: DemoSheet, amount: bigint, documentType = 'PURCHASE_REQUEST'): string {
  const rule = sheet.doaRules.find((r) => r.documentType === documentType && (r.gt !== null || r.lte !== null) && (r.gt === null || amount > r.gt) && (r.lte === null || amount <= r.lte))
  if (!rule) throw new Error(`no band of the DOA sheet holds ${amount} satang`)
  return rule.ruleCode
}

/** The amount the DOA counts for a scene's row: with VAT or before it, as sheet DOA_Policy says (amountBasis) */
export const countedOf = (sheet: DemoSheet, scene: DemoScene): bigint => amountOf(scene, sheet.doa.amountBasis === 'GROSS' ? 'gross' : 'net')

/** A rule of the sheet's DOA version by its code */
export function ruleOf(sheet: DemoSheet, ruleCode: string | null): DoaSheetRule {
  const rule = ruleCode ? sheet.doaRules.find((r) => r.ruleCode === ruleCode) : undefined
  if (!rule) throw new Error(`no rule ${ruleCode ?? '(none)'} in version ${sheet.doa.version} of the DOA sheet`)
  return rule
}

/** Whom a rule of the DOA names, by the sheets: the position, the department it is held in, and the member who holds it */
export interface SheetApprover {
  /** Member code (sheet Users) */
  readonly member: string
  /** Position code (the rule's approverPosition) */
  readonly position: string
  /** The department the position is held in */
  readonly department: string
  readonly positionName: string
  readonly departmentName: string
  /** One for the whole organization (Positions scope ORG, or held at the root): named without its department */
  readonly orgWide: boolean
  /** As the approval task records it: "POSITION:VP@OPS" */
  readonly resolvedFrom: string
}

/**
 * The approver a rule of the sheet's DOA names for a request the department pays, read from the sheets as the DOA
 * reads the organization: the holder of the rule's position in the nearest department up from that one
 * (POSITION_OF_DEPARTMENT), or in the organization's root (POSITION_OF_ORG); sheet Users says who holds what ("VP@OPS")
 */
export function approverByRule(sheet: DemoSheet, ruleCode: string | null, department: string | null): SheetApprover {
  const rule = ruleOf(sheet, ruleCode)
  const position = rule.approverPosition
  if (!position) throw new Error(`DOA rule ${rule.ruleCode} names no position`)
  const chain: string[] = []
  if (rule.approverKind === 'POSITION_OF_ORG') {
    const root = [...sheet.departmentParents].find(([, parent]) => parent === null)?.[0]
    if (root) chain.push(root)
  } else if (rule.approverKind === 'POSITION_OF_DEPARTMENT') {
    for (let at: string | null | undefined = department; at && !chain.includes(at); at = sheet.departmentParents.get(at)) chain.push(at)
  } else throw new Error(`DOA rule ${rule.ruleCode}: approverKind ${rule.approverKind} names no position`)
  const held = sheet.positions.get(position)
  if (!held) throw new Error(`sheet Positions has no ${position}`)
  for (const at of chain) {
    const holder = [...sheet.users.values()].find((u) => u.positions.includes(`${position}@${at}`))
    if (holder) {
      return {
        member: holder.code,
        position,
        department: at,
        positionName: held.nameTh,
        departmentName: nameIn(sheet.departments, at, 'department'),
        orgWide: held.scope === 'ORG' || sheet.departmentParents.get(at) === null,
        resolvedFrom: `POSITION:${position}@${at}`,
      }
    }
  }
  throw new Error(`nobody in sheet Users holds ${position} in ${chain.join(' → ') || '(no department)'}`)
}

/** The words of the button a scene's steps tap: กด "อนุมัติ" */
export function tappedIn(scene: DemoScene): string {
  const label = /กด "([^"]+)"/.exec(scene.stepsTh)?.[1]
  if (!label) throw new Error(`Demo_Script row ${scene.row}: the steps tap no button`)
  return label
}

/**
 * What is left on a scene's budget line when the scene starts, by the workbook alone: the line's remaining in sheet
 * Budget (planned less what the demo history uses), less the amounts before VAT of the day's earlier core scenes that
 * sent a request on that line — a sent request reserves its amount before VAT (BR-BUD-03, §7.7)
 */
export function budgetLeftAt(sheet: DemoSheet, scene: DemoScene): bigint {
  const line = scene.budgetLine ? sheet.budget.get(scene.budgetLine) : undefined
  if (!line) throw new Error(`Demo_Script row ${scene.row}: budget line ${scene.budgetLine ?? '(none)'} is not in sheet Budget`)
  const earlier = coreScenes(sheet).filter((s) => s.scene < scene.scene && s.budgetLine === scene.budgetLine && s.expectedOutcome === 'ROUTED')
  return earlier.reduce((left, s) => left - amountOf(s, 'net'), line.remaining)
}

/** The words of the rich menu button a scene starts from, as its steps quote them: rich menu "ขอซื้อ" */
export function richMenuButtonOf(scene: DemoScene): string {
  const label = /rich menu "([^"]+)"/.exec(scene.stepsTh)?.[1]
  if (!label) throw new Error(`Demo_Script row ${scene.row}: the steps name no rich menu button`)
  return label
}

// ---------- words and money as the screens show them ----------

const CATALOGUE = JSON.parse(readFileSync(path.resolve(import.meta.dirname, '../../../messages/th.json'), 'utf8')) as Record<string, unknown>

/** A Thai message of the app's catalogue with its arguments filled in (messages/th.json) */
export function th(key: string, values: Readonly<Record<string, string | number>> = {}): string {
  const words = key.split('.').reduce<unknown>((node, name) => (node && typeof node === 'object' ? (node as Record<string, unknown>)[name] : undefined), CATALOGUE)
  if (typeof words !== 'string') throw new Error(`${key} is not a message of messages/th.json`)
  return words.replace(/\{(\w+)\}/g, (all, name: string) => (values[name] === undefined ? all : String(values[name])))
}

/** A text of the sheet inside a regular expression, as it is */
export const literally = (value: string) => value.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')

/** Satang as a person types baht in a form: no separators, two decimals ("1500.00") */
export const typed = (satang: bigint) => `${satang / 100n}.${String(satang % 100n).padStart(2, '0')}`

/** Satang as the screens write baht: thousands separators and two decimals ("42,000.00") */
export function baht(satang: bigint): string {
  const sign = satang < 0n ? '-' : ''
  const whole = satang < 0n ? -satang : satang
  return `${sign}${(whole / 100n).toLocaleString('en-US')}.${String(whole % 100n).padStart(2, '0')}`
}

/** Satang as a person says whole baht in the sheet's steps ("25,000"); the satang, when there are any, as on screen */
export const spokenBaht = (satang: bigint) => (satang % 100n === 0n ? (satang / 100n).toLocaleString('en-US') : baht(satang))

/** An instant as the cards and the pages write it in Thai time: "6 ต.ค. 2569 15:30 น." (BR-DATE-01) */
export const thaiDateTime = (at: string | Date) => formatThaiDateTime(at)

/** A row of a LINE card as wordsOf reads it: the row's label in Thai (src/channels/line/flex/labels), its value below */
export const cardRow = (label: CardLabel, value: string) => `${cardLabel(label, 'th')}\n${value}`

/** A fixed word of the LINE cards in Thai (src/channels/line/flex/labels): "จองแล้ว" */
export const cardWord = (label: CardLabel) => cardLabel(label, 'th')

/** A fixed word of the confirmation card of a decision made in the chat, in Thai (src/channels/line/flex/labels): "อนุมัติแล้ว" */
export const confirmationWord = (label: ConfirmationLabel) => confirmationLabel(label, 'th')

/** "DOA-DEMO ฉบับ 1 ข้อ PR-02": the DOA reference of a decision as the timeline writes it (FR-DOA-005 AC2) */
export const doaRefOf = (doa: { readonly code: string; readonly versionNo: number }, rule: string) => th('timeline.doaRef', { code: doa.code, version: doa.versionNo, rule })

/**
 * The DOA reference of a rule of the sheet's DOA as the screens and the cards write it ("DOA-DEMO ฉบับ 1 ข้อ PR-02"),
 * its code and version those of sheet DOA_Policy — never the database's, which sheetDoa holds to the sheet
 */
export const sheetDoaRef = (sheet: DemoSheet, rule: string | null) => doaRefOf({ code: sheet.doa.code, versionNo: sheet.doa.version }, ruleOf(sheet, rule).ruleCode)

/** The channel of an event as the timeline names it (LINE_CHAT → "แชท LINE", LIFF → "หน้าจอใน LINE") */
export const channelLabel = (channel: Channel) => th(`timeline.channel.${channel}`)

/** The approver's position as the route before sending names it: "รองประธานสายงาน ของสายปฏิบัติการ" */
export const routeRoleOf = (approver: SheetApprover) => th('requestForm.route.positionOf', { position: approver.positionName, department: approver.departmentName })

/** The approver's position as a stamp of the timeline names it: "รองประธานสายงาน สายปฏิบัติการ"; the organization's alone */
export const stampRoleOf = (approver: SheetApprover) =>
  approver.orgWide ? approver.positionName : th('requestView.role.positionIn', { position: approver.positionName, department: approver.departmentName })

// ---------- the web ----------

/** Signs the member in on the web: the seeded password, and the authenticator code when the sheet says they need it */
export async function signInAs(page: Page, sheet: DemoSheet, code: string): Promise<DemoUser> {
  const user = userOf(sheet, code)
  await signIn(page, user.email, user.twoFactor ? user.code : null)
  return user
}

/** §9.9 step 4: the two widths every screen of the day is checked and photographed at — the scene's desk and a phone */
const DESK = { width: 1440, height: 900 } as const
const PHONE = { width: 375, height: 812 } as const

/**
 * D-05: one line {name, path, kind} in the test's design-review.jsonl for every screen a scene checks — the base name of
 * its screenshots, the path of its page and whether it is a workspace ("web") or a LIFF page — which
 * scripts/design-review-shots.mjs reads to put each picture beside its page. Written before the checks, so a screen
 * whose checks stopped the scene is listed too, without the pictures it did not get.
 */
function noteScreen(page: Page, testInfo: TestInfo, name: string, kind: 'web' | 'liff') {
  const journal = testInfo.outputPath('design-review.jsonl')
  mkdirSync(path.dirname(journal), { recursive: true })
  appendFileSync(journal, `${JSON.stringify({ name, path: new URL(page.url()).pathname, kind })}\n`, 'utf8')
}

/** The page after a change of width: its document loaded (no navigation under way), its fonts ready, laid out again */
async function settled(page: Page) {
  await page.waitForLoadState('load')
  await page.evaluate(async () => {
    await document.fonts.ready
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
  })
}

/**
 * The focus away from the control the last step typed in or pressed, as pointerAway moves the mouse away: a field still
 * being edited shows what was typed, not what the person reads once they move on — a money field its raw digits
 * ("60000.00") until it is left, then "60,000.00" (src/ui/request-form/money-input.tsx) — and draws its focus ring. A
 * screen is checked and photographed at rest, as the person sees it after the step; the page is laid out again first.
 */
async function focusAway(page: Page) {
  await page.evaluate(async () => {
    const active = document.activeElement
    if (active instanceof HTMLElement && active !== document.body) active.blur()
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
  })
}

/** What axe finds serious or critical on the page: each rule, its help and the elements it names */
async function blockingAxe(page: Page): Promise<string[]> {
  // Next streams the <title> after the first HTML: let it arrive before axe reads the page (a page without one still fails)
  await page.waitForFunction(() => document.title !== '', undefined, { timeout: 5_000 }).catch(() => undefined)
  const results = await new AxeBuilder({ page }).analyze()
  return results.violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical')
    .map((v) => `${v.id}: ${v.help} (${v.nodes.map((n) => n.target.join(' ')).join(', ')})`)
}

/**
 * The §9.9 checks of a workspace page: at the scene's width (1440 px) axe, no sideways scroll and a full-page screenshot
 * `<name>.png`; then the same page at a phone's 375 × 812 — axe with nothing serious or critical, no sideways scroll, a
 * full-page screenshot `<name>-375.png`, a bar fixed to the bottom of a phone's screen drawn in its place (BARS_IN_PLACE)
 * — and back to 1440 × 900. A failure at 375 px is recorded with expect.soft: the test fails, but the scene goes on, so
 * the screens after it are still checked and photographed. The pointer and the focus are moved away first: the screen at
 * rest (pointerAway, focusAway).
 */
export async function checkWebScreen(page: Page, testInfo: TestInfo, name: string) {
  noteScreen(page, testInfo, name, 'web')
  // Every control at rest in the pictures, not under the pointer the last click left, nor still being edited
  await pointerAway(page)
  await focusAway(page)
  await checkWorkspaceScreen(page, testInfo, name)
  const at = `${name} at ${PHONE.width} px`
  try {
    await page.setViewportSize(PHONE)
    await settled(page)
    expect.soft(await blockingAxe(page), `${at}: axe finds nothing serious or critical`).toEqual([])
    const sideways = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
    expect.soft(sideways, `${at}: the page scrolls sideways by this many px`).toBeLessThanOrEqual(0)
    await page.screenshot({ path: testInfo.outputPath(`${name}-375.png`), fullPage: true, style: BARS_IN_PLACE })
  } catch (error) {
    expect.soft(error instanceof Error ? error.message : String(error), `${at}: the checks could not run`).toBe('')
  } finally {
    await page.setViewportSize(DESK)
    await settled(page)
  }
}

/** What the LIFF gate says while it signs in with LINE or moves on (src/ui/liff/liff-gate.tsx, messages liff.gate) */
const GATE_UNDER_WAY = ['signingIn', 'opening', 'toLink', 'toWebSignIn'] as const

/**
 * The §9.9 checks of a LIFF page at the phone's 375 px (axe, no sideways scroll, 44 px targets, a full-page screenshot
 * `<name>.png`), then the same at 1440 px (`<name>-1440.png`) and back to the phone. A page opened in a new browser
 * shows its title while its gate still signs in with LINE, so the checks wait for the gate to be done: what axe reads
 * and the pictures show is the page itself, at rest — no field still being edited (focusAway), no control under the
 * pointer.
 */
export async function checkLiffScreen(page: Page, testInfo: TestInfo, name: string) {
  noteScreen(page, testInfo, name, 'liff')
  const gate = page.getByRole('status').filter({ hasText: new RegExp(GATE_UNDER_WAY.map((key) => literally(th(`liff.gate.${key}`))).join('|')) })
  await expect(gate, `${name}: the LIFF page has signed in with LINE before it is checked`).toHaveCount(0, { timeout: 30_000 })
  await settled(page)
  // No field still being edited: a price shows "60,000.00" as the person reads it once they move on (checkPhoneScreen
  // moves the pointer away)
  await focusAway(page)
  await checkPhoneScreen(page, testInfo, name)
}

// ---------- the scene script: what the database says ----------

const SAFE_ARG = /^[A-Za-z0-9_.:-]+$/

/** Runs ./scripts/day.ts against the run's database and returns the JSON of its last line */
export function day<T>(...args: string[]): T {
  for (const arg of args) if (!SAFE_ARG.test(arg)) throw new Error(`not an argument for the day scene: ${arg}`)
  const r = spawnSync(`pnpm exec tsx tests/e2e/demo/scripts/day.ts ${args.join(' ')}`, { shell: true, encoding: 'utf8', env: { ...process.env, ...e2eEnv() } })
  // Its work spends link codes (secrets of this test database): on failure only what went wrong is shown
  if (r.status !== 0) throw new Error(`demo day ${args[0] ?? ''} failed:\n${r.stderr}`)
  return JSON.parse(r.stdout.trim().split('\n').at(-1)!) as T
}

export interface TaskFacts {
  readonly id: string
  readonly stepNo: number
  readonly status: string
  /** Member code */
  readonly assignee: string
  /** The member a delegate holds the task for (BR-DLG-04); null when the assignee holds it themself */
  readonly principal: string | null
  /** Where the DOA found the assignee: "POSITION:VP@OPS" */
  readonly resolvedFrom: string
  readonly decision: string | null
  readonly channel: Channel | null
  /** When the task was given to the assignee (ISO) */
  readonly assignedAt: string
  /** When the task falls due (ISO), by the business hours of its SLA; null without one */
  readonly dueAt: string | null
  /** When the task was decided (ISO), as the task records it — the time the confirmation card says; null while open */
  readonly decidedAt: string | null
  /**
   * The approval_task.decided event (FR-DOA-005 AC1): when (ISO), on which channel, by whom and for whom (member codes),
   * under which DOA version and rule, and whether it used a step-up
   */
  readonly decided: {
    readonly at: string
    readonly channel: Channel
    readonly by: string | null
    readonly onBehalfOf: string | null
    readonly doaVersionId: string | null
    readonly doaRuleCode: string | null
    readonly stepUp: boolean
  } | null
}

export interface RequestFacts {
  readonly id: string
  readonly number: string | null
  readonly status: string
  readonly title: string
  readonly requestType: string
  readonly requester: string
  readonly chargedDept: string
  readonly budgetLine: string | null
  readonly site: string | null
  readonly priceIncludesVat: boolean
  /** Satang as text */
  readonly net: string
  readonly vat: string
  readonly gross: string
  readonly submittedAt: string | null
  readonly route: {
    readonly ruleCode: string
    /** The band's rule the route was moved up from (BR-DOA-06: the requester would have approved it); null when not */
    readonly escalatedFromRuleCode: string | null
    readonly amountBasis: 'GROSS' | 'NET'
    readonly amount: string | null
    readonly doa: { readonly versionId: string; readonly code: string; readonly versionNo: number }
  } | null
  /** What the request asks for, line by line (its descriptions) */
  readonly lines: readonly string[]
  readonly tasks: readonly TaskFacts[]
  /** The request's own events in order, with the channel each was made on */
  readonly events: ReadonlyArray<{ readonly type: string; readonly channel: Channel }>
  /** Kinds of the files linked to the request */
  readonly files: readonly string[]
}

/** A request by its number, as the database has it */
export function requestFacts(number: string): RequestFacts {
  const facts = day<RequestFacts | null>('request', number)
  if (!facts) throw new Error(`no request ${number} in the database`)
  return facts
}

/** The latest request the member sent for this amount before VAT, or null (how a later scene finds an earlier one's) */
export const latestRequestOf = (code: string, net: bigint) => day<RequestFacts | null>('latest', code, net.toString())

/**
 * What a new form of this type fills in for the member, by the facts BR-FORM-02 reads (FR-INT-003 AC1): the budget line
 * of their latest request of the type that was sent, and the site of the latest request they started; null where none
 */
export const formDefaultsOf = (code: string, requestType: string) => day<{ budgetLine: string | null; site: string | null }>('defaults', code, requestType)

/** What is left on a budget line now (satang) */
export const availableOf = (budgetLine: string): bigint => BigInt(day<{ available: string }>('budget', budgetLine).available)

/**
 * What is left on the scene's budget line as it starts — the workbook's figure (budgetLeftAt), which the database must
 * hold: a seed or a history that left another balance fails here, before the screens are compared with it
 */
export function budgetLeftNow(sheet: DemoSheet, scene: DemoScene): bigint {
  const left = budgetLeftAt(sheet, scene)
  expect(availableOf(scene.budgetLine!), `what is left on ${scene.budgetLine}: its remaining in sheet Budget, less the earlier scenes' amounts before VAT`).toBe(left)
  return left
}

/** The DOA version in effect; its stepUpThreshold in satang as text, null when it has none */
export const doaInEffect = () => day<{ id: string; code: string; versionNo: number; amountBasis: 'GROSS' | 'NET'; stepUpThreshold: string | null }>('doa')

/**
 * The DOA version in effect, which must be the one sheet DOA_Policy names: its code, its number, its amount basis and
 * its stepUpThreshold — the premise of the scenes that approve in the chat or with the PIN
 */
export function sheetDoa(sheet: DemoSheet) {
  const doa = doaInEffect()
  expect({ code: doa.code, versionNo: doa.versionNo, amountBasis: doa.amountBasis, stepUpThreshold: doa.stepUpThreshold }, 'the DOA in effect is the version of sheet DOA_Policy').toEqual({
    code: sheet.doa.code,
    versionNo: sheet.doa.version,
    amountBasis: sheet.doa.amountBasis,
    stepUpThreshold: sheet.doa.stepUpThreshold.toString(),
  })
  return doa
}

/** The route moved up a band or not, as the row's escalated column says (BR-DOA-06: no one approves their own request) */
export function expectEscalation(scene: DemoScene, route: RequestFacts['route']) {
  if (scene.escalated === null) return
  if (scene.escalated) expect(route?.escalatedFromRuleCode ?? null, `scene ${scene.scene}: escalated = Y in Demo_Script`).not.toBeNull()
  else expect(route?.escalatedFromRuleCode ?? null, `scene ${scene.scene}: escalated = N in Demo_Script`).toBeNull()
}

/**
 * Who holds the task, as the row's delegation column says (BR-DLG-04): empty, the approver themself; "dm_con>asst_con",
 * the delegate asst_con holding it for dm_con
 */
export function expectDelegation(scene: DemoScene, task: TaskFacts) {
  if (scene.delegation === null) {
    expect(task.principal, `scene ${scene.scene}: no delegation in Demo_Script, so nobody holds the task for another`).toBeNull()
    return
  }
  const [principal, delegate] = scene.delegation.split('>')
  expect({ assignee: task.assignee, principal: task.principal }, `scene ${scene.scene}: delegation ${scene.delegation} in Demo_Script`).toEqual({ assignee: delegate, principal })
}

/** How many requests were sent, approval tasks made and notifications written in the organization so far */
export const countsNow = () => day<{ submitted: number; tasks: number; notifications: number }>('counts')

/** The open task of a request (one step at a time in the demo DOA) */
export function openTaskOf(request: RequestFacts): TaskFacts {
  const open = request.tasks.filter((t) => t.status === 'OPEN')
  if (open.length !== 1) throw new Error(`request ${request.number ?? request.id} has ${open.length} open tasks`)
  return open[0]!
}

// ---------- LINE ----------

/**
 * The LINE account of a demo member's phone: a LINE user id in LINE's format (U and 32 hexadecimal digits) derived from
 * the member's code, the same on every run, so the scenes and the scene script agree on it without storing it
 */
export function lineUserOf(code: string): string {
  if (!/^[a-z0-9_]{2,40}$/.test(code)) throw new Error(`not a member code of the Users sheet: ${code}`)
  return `U${createHash('sha256').update(`demo-line:${code}`).digest('hex').slice(0, 32)}`
}

export interface PreparedDay {
  readonly channelKey: string
  readonly liffId: string | null
  readonly active: boolean
  readonly linkedMenuId: string
  /** Linked by this call; the others were linked already */
  readonly linked: readonly string[]
  readonly already: readonly string[]
}

/** Everyone with a phone in the core scenes: each scene's actor and the approver the sheet expects (runbook §3, §4) */
export function peopleOfTheDay(sheet: DemoSheet): string[] {
  return [...new Set(coreScenes(sheet).flatMap((s) => [s.actor, ...(s.expectedApprover ? [s.expectedApprover] : [])]))]
}

/**
 * Before the day (runbook §1 items 3 and 4): the rich menus made, then every phone of the core scenes — and `more` —
 * linked to its member, through the services. Safe to call from every scene: a member linked already is left alone.
 * Linking comes before the scenes send anything, because a card's in-chat button needs the approver's LINE token, which
 * is issued when the task is assigned to a member who is linked then (BR-TOK-01)
 */
export function prepareTheDay(sheet: DemoSheet, more: readonly string[] = []): PreparedDay {
  const people = [...new Set([...peopleOfTheDay(sheet), ...more])]
  return day<PreparedDay>('prepare', ...people.map((code) => `${code}:${lineUserOf(code)}`))
}

export interface Delivered {
  readonly id: string
  readonly templateKey: string
  readonly subjectId: string | null
  readonly outcome: { readonly status: 'SENT' | 'FAILED' | 'RETRY' | 'SKIPPED'; readonly channel?: 'LINE' | 'EMAIL'; readonly why?: string; readonly code?: string }
}

/**
 * What the notification job does on the day (job notification-deliver, which the e2e app has no Inngest to run): the
 * member's pending notices — about one document when `subjectId` is given — each delivered by deliverNotification, by
 * LINE to a linked member (an approval task as its Flex card) and by e-mail otherwise (Mailpit)
 */
export const deliverPending = (code: string, subjectId?: string): Delivered[] => day<Delivered[]>('deliver', code, ...(subjectId ? [subjectId] : []))

/** A message as LINE takes it: text, or Flex with its altText and contents */
export type LineMessage = Readonly<Record<string, unknown>> & { readonly type: string }

export interface FakeLineMessage {
  readonly kind: 'push' | 'reply'
  readonly to: string | null
  readonly replyToken: string | null
  readonly messages: readonly LineMessage[]
  readonly retryKey: string | null
  readonly at: string
}

/** What the fake LINE server of the run answers on one of its test routes */
export async function fakeLine<T>(route: string): Promise<T> {
  const response = await fetch(`${E2E_FAKE_LINE_URL}${route}`)
  if (!response.ok) throw new Error(`fake LINE ${route}: ${response.status}`)
  return (await response.json()) as T
}

/** Everything LINE accepted from the app in this run, pushes and replies, oldest first */
export async function fakeMessages(): Promise<FakeLineMessage[]> {
  return (await fakeLine<{ messages: FakeLineMessage[] }>('/__fake/messages')).messages
}

/** The pushes LINE accepted for the member's LINE user */
export async function pushesTo(code: string): Promise<FakeLineMessage[]> {
  const to = lineUserOf(code)
  return (await fakeMessages()).filter((m) => m.kind === 'push' && m.to === to)
}

/** The pushes LINE accepted for the member's LINE user at or after an instant (ISO): a push counts against the quota, a reply does not (§9.3) */
export async function pushesSince(code: string, since: string): Promise<FakeLineMessage[]> {
  return (await pushesTo(code)).filter((m) => m.at >= since)
}

/** Every string a message shows (Flex texts and its altText, or a text message's text), one per line, to read it */
export function wordsOf(message: LineMessage): string {
  const words: string[] = []
  const walk = (node: unknown) => {
    if (Array.isArray(node)) node.forEach(walk)
    else if (node && typeof node === 'object') {
      for (const [key, value] of Object.entries(node)) {
        if ((key === 'text' || key === 'altText') && typeof value === 'string') words.push(value)
        else if (key !== 'action') walk(value)
      }
    }
  }
  walk(message)
  return words.join('\n')
}

export interface CardAction {
  readonly type: string
  readonly label?: string
  readonly data?: string
  readonly uri?: string
  readonly displayText?: string
}

/** The actions of a message's buttons, in order (a Flex card's footer: approve, decline, details) */
export function actionsOf(message: LineMessage): CardAction[] {
  const actions: CardAction[] = []
  const walk = (node: unknown) => {
    if (Array.isArray(node)) node.forEach(walk)
    else if (node && typeof node === 'object') {
      for (const [key, value] of Object.entries(node)) {
        if (key === 'action' && value && typeof value === 'object') actions.push(value as CardAction)
        else walk(value)
      }
    }
  }
  walk(message)
  return actions
}

/** The Flex card pushed to the member's LINE that names this document (its number), waiting a little for it */
export async function cardTo(code: string, documentLabel: string, timeout = 15_000): Promise<LineMessage> {
  let card: LineMessage | undefined
  await expect
    .poll(
      async () => {
        card = (await pushesTo(code)).flatMap((p) => p.messages).find((m) => m.type === 'flex' && wordsOf(m).includes(documentLabel))
        return card !== undefined
      },
      { timeout, message: `a card of ${documentLabel} in ${code}'s LINE chat` },
    )
    .toBe(true)
  return card!
}

/**
 * The approval card of the request a scene's row sent, as FR-LINE-002 AC1 has it: a summary only — its number, its type,
 * the requester and department, the amount the DOA counts with its basis, the budget reserved, when the task falls due
 * (the task's dueAt, in Thai time), the DOA version and rule; the PIN line exactly when the amount is at or above sheet
 * DOA_Policy's stepUpThreshold; the acting badge only when the row names a delegation — and nothing of `hidden` (the
 * title, the lines asked for, suppliers, files)
 */
export function expectApprovalCard(
  sheet: DemoSheet,
  card: LineMessage,
  of: { readonly number: string; readonly scene: DemoScene; readonly task: TaskFacts; readonly doaRef: string; readonly hidden: readonly string[] },
) {
  const { scene, task } = of
  const requester = userOf(sheet, scene.actor)
  const counted = countedOf(sheet, scene)
  expect(card.type, 'the approval card is a Flex message').toBe('flex')
  expect(task.dueAt, 'the task has a due time by its SLA').not.toBeNull()
  const shown = wordsOf(card)
  for (const fact of [
    cardRow('number', of.number),
    cardRow('type', nameIn(sheet.requestTypes, scene.requestType, 'request type')),
    cardRow('requester', `${requester.nameTh} · ${nameIn(sheet.departments, requester.department, 'department')}`),
    cardRow('amount', `${baht(counted)} บาท (${cardWord(sheet.doa.amountBasis === 'GROSS' ? 'basisGross' : 'basisNet')})`),
    cardRow('budget', cardWord('budgetReserved')),
    cardRow('due', thaiDateTime(task.dueAt!)),
    cardRow('doa', of.doaRef),
  ]) {
    expect(shown, fact).toContain(fact)
  }
  if (counted >= sheet.doa.stepUpThreshold) expect(shown, 'at or above the stepUpThreshold the card says the PIN is needed').toContain(cardWord('pinNeeded'))
  else expect(shown, 'below the stepUpThreshold the card asks for no PIN').not.toContain(cardWord('pinNeeded'))
  if (scene.delegation === null) expect(shown, 'nobody acts for another on this task').not.toContain(cardWord('acting'))
  for (const hidden of of.hidden) expect(shown, `the card does not show "${hidden}"`).not.toContain(hidden)
}

/**
 * The buttons of an approval card, as §9.3's table has them: below the stepUpThreshold "อนุมัติ" is the one postback —
 * `v=1&a=approve&k=<tokenId>`, which LINE shows in the chat as "อนุมัติ <number>" (its displayText) — and at or above it
 * "อนุมัติ (ยืนยัน PIN)" opens the task's LIFF page with approve ready, with no postback at all; "ตีกลับ / ไม่อนุมัติ"
 * opens the page with reject ready and "ดูรายละเอียด" the page itself. Returns the approve button's action.
 */
export function expectCardButtons(card: LineMessage, of: { readonly taskId: string; readonly number: string; readonly inChat: boolean }): CardAction {
  const buttons = actionsOf(card)
  const named = (label: CardLabel) => {
    const found = buttons.filter((a) => a.label === cardWord(label))
    expect(found, `one button "${cardWord(label)}" on the card`).toHaveLength(1)
    return found[0]!
  }
  const approve = named(of.inChat ? 'approve' : 'approveWithPin')
  if (of.inChat) {
    expect(approve, '§9.3: "อนุมัติ" approves in the chat, and the chat shows "อนุมัติ <number>"').toMatchObject({ type: 'postback', displayText: `${cardWord('approve')} ${of.number}` })
    expect(approve.data, 'the postback data is v, a and k only (BR-TOK-02), within 300 characters').toMatch(/^v=1&a=approve&k=[0-9a-f-]{36}$/)
  } else {
    expect(approve.type, '§9.3: at or above the stepUpThreshold the approve button opens LIFF').toBe('uri')
    expect(liffPathOf(approve.uri!), 'the task in LIFF with approve ready').toBe(`/liff/tasks/${of.taskId}?action=approve`)
  }
  expect(buttons.filter((a) => a.type === 'postback'), of.inChat ? 'approving is the only postback' : 'no postback approves at or above the stepUpThreshold').toHaveLength(of.inChat ? 1 : 0)
  const decline = named('decline')
  expect(decline.type).toBe('uri')
  expect(liffPathOf(decline.uri!), 'return or reject: the task in LIFF with reject ready, for the reason').toBe(`/liff/tasks/${of.taskId}?action=reject`)
  const details = named('details')
  expect(details.type).toBe('uri')
  expect(liffPathOf(details.uri!), 'the details: the task in LIFF').toBe(`/liff/tasks/${of.taskId}`)
  return approve
}

export interface Tap {
  /** The status the app's webhook answered (200 once the signature was right) */
  readonly status: number
  /** The reply token of the event LINE would have sent: the app answers with it while it is fresh */
  readonly replyToken: string | null
  readonly lineUserId: string
  /** When it was sent: an answer pushed instead of replied comes after it */
  readonly sentAt: string
  /** What the script printed (never a secret) */
  readonly printed: string
}

/** The webhook address of the organization's LINE channel in this run */
export function webhookUrl(): string {
  return `${E2E_BASE_URL}/api/webhooks/line/${day<{ channelKey: string }>('channel').channelKey}`
}

/**
 * The member taps a button of a card in the LINE chat: LINE's postback webhook for their LINE user, signed with the
 * channel secret of the run, sent with `pnpm exec tsx scripts/line-simulate.ts postback` (the event it sent is kept in
 * the test's output to read its reply token)
 */
export function tapPostback(testInfo: TestInfo, code: string, data: string): Tap {
  if (!/^[A-Za-z0-9=&_-]{1,300}$/.test(data)) throw new Error(`not the postback data of a card: ${data}`)
  const url = webhookUrl()
  const state = testInfo.outputPath(`line-simulate-${code}-${Date.now()}.json`)
  const lineUserId = lineUserOf(code)
  const sentAt = new Date().toISOString()
  // The data is quoted for the shell (it holds &); the secret is the run's test value of E2E_LINE, not a real channel's
  const command = `pnpm exec tsx scripts/line-simulate.ts postback --data "${data}" --user ${lineUserId} --url ${url} --secret ${E2E_LINE.LINE_MESSAGING_CHANNEL_SECRET}`
  const r = spawnSync(command, { shell: true, encoding: 'utf8', env: { ...process.env, ...e2eEnv(), LINE_SIMULATE_STATE_FILE: state } })
  const printed = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim()
  const status = Number(/→ (\d{3})/.exec(printed)?.[1] ?? Number.NaN)
  const saved = existsSync(state) ? (JSON.parse(readFileSync(state, 'utf8')) as { json?: { events?: Array<{ replyToken?: string }> } }) : null
  return { status, replyToken: saved?.json?.events?.[0]?.replyToken ?? null, lineUserId, sentAt, printed }
}

/** The app's answer to a tap: the reply with the event's reply token, or a push to the member after it (BR-LINE-07) */
export async function answerTo(tap: Tap, timeout = 20_000): Promise<FakeLineMessage> {
  let found: FakeLineMessage | undefined
  await expect
    .poll(
      async () => {
        const all = await fakeMessages()
        found =
          all.find((m) => tap.replyToken !== null && m.kind === 'reply' && m.replyToken === tap.replyToken) ??
          all.find((m) => m.kind === 'push' && m.to === tap.lineUserId && m.at >= tap.sentAt)
        return found !== undefined
      },
      { timeout, message: 'the answer to the tap in the LINE chat' },
    )
    .toBe(true)
  return found!
}

// ---------- LIFF ----------

/** The LIFF pages of this browser are opened by the member's LINE user, as in their LINE app (LIFF_MOCK) */
export const openLiffAs = (context: BrowserContext, code: string) => openAsLineUser(context, lineUserOf(code))

/** Another member's phone in the same scene (a browser of its own at 375 px), its LIFF pages opened by their LINE user */
export async function phoneOf(browser: Browser, code: string): Promise<BrowserContext> {
  const phone = await anotherPhone(browser)
  await openLiffAs(phone, code)
  return phone
}

export interface PinLeftOut {
  /** How many decisions went to the server without their PIN */
  readonly sent: () => number
  /** What went wrong with a decision it caught (never its body, which holds the PIN: NFR-SEC-09) */
  readonly problems: () => readonly string[]
  readonly stop: () => Promise<void>
}

/**
 * The next decision a task's LIFF page sends goes to the server without the PIN the member typed, as a page that skipped
 * its own check would send it: the call of the page's server action (a POST to the page with the `Next-Action` header,
 * whose arguments React sends as JSON text, [input, idempotencyKey]) is caught on its way and `pin` taken out of the
 * input — so what answers is the server, not the page. The deciding command of a task that needs a step-up asks for the
 * PIN before anything else (src/app/(workspace)/_tracking/commands.ts: VALIDATION_FAILED on the field pin, which the page
 * words as tasks.errors.PIN); STEP_UP_REQUIRED is the service's own guard below it, which a LIFF page does not reach
 * without a PIN. Only that one call is changed; any other request of the page goes on as it is.
 */
export async function leaveOutThePin(page: Page, taskId: string): Promise<PinLeftOut> {
  let sent = 0
  const problems: string[] = []
  const matches = (url: URL) => url.pathname === `/liff/tasks/${taskId}`
  const handler = async (route: Route) => {
    const request = route.request()
    if (request.method() !== 'POST' || !request.headers()['next-action'] || sent > 0) return route.fallback()
    let args: unknown = null
    try {
      args = JSON.parse(request.postData() ?? '')
    } catch {
      // not the JSON text of plain arguments
    }
    const input = Array.isArray(args) && args[0] !== null && typeof args[0] === 'object' ? (args[0] as Record<string, unknown>) : null
    if (!input || typeof input.pin !== 'string') {
      problems.push('the decision did not go as a server action whose input holds the PIN')
      return route.abort()
    }
    delete input.pin
    sent++
    return route.continue({ postData: JSON.stringify(args) })
  }
  await page.route(matches, handler)
  return { sent: () => sent, problems: () => problems, stop: () => page.unroute(matches, handler) }
}

/** The path here of a LIFF deep link (https://liff.line.me/<LIFF ID>/tasks/<id>?action=approve → /liff/tasks/<id>?action=approve) */
export function liffPathOf(deepLink: string): string {
  const url = new URL(deepLink)
  if (url.hostname !== 'liff.line.me') throw new Error(`not a LIFF deep link: ${deepLink}`)
  const [, liffId = '', ...page] = url.pathname.split('/')
  if (decodeURIComponent(liffId) !== E2E_LINE.NEXT_PUBLIC_LIFF_ID) throw new Error(`a deep link of another LIFF app: ${liffId}`)
  return `/liff/${page.join('/')}${url.search}`
}

/** Where the button with these words of the member's own rich menu leads, here (FR-LINE-004: every button opens a LIFF page) */
export async function richMenuPath(code: string, label: string): Promise<string> {
  const { richMenuId } = await fakeLine<{ richMenuId: string | null }>(`/__fake/users/${lineUserOf(code)}/richmenu`)
  if (!richMenuId) throw new Error(`${code}'s LINE has no rich menu of its own: the member is not linked`)
  const { richMenus } = await fakeLine<{ richMenus: ReadonlyArray<{ richMenuId: string; menu: { areas?: ReadonlyArray<{ action?: CardAction }> } }> }>('/__fake/state')
  const menu = richMenus.find((m) => m.richMenuId === richMenuId)
  const action = menu?.menu.areas?.map((a) => a.action).find((a) => a?.label === label)
  if (!action?.uri) throw new Error(`${code}'s rich menu has no button "${label}"`)
  return liffPathOf(action.uri)
}

// ---------- the request form and the request pages (the workspace's four steps, LIFF's three) ----------

/** The heading of a step: "ขั้นที่ 1 จาก 3: รายละเอียดคำขอ" */
export const stepHeading = (page: Page, n: number, step: 'details' | 'items' | 'documents' | 'review', total: 3 | 4) =>
  page.getByRole('heading', { level: 2, name: th('requestForm.steps.heading', { n, total, name: th(`requestForm.steps.${step}`) }) })

/** Goes on to the next step of the form */
export const nextStep = (page: Page, step: 'items' | 'documents' | 'review') => page.getByRole('button', { name: th('requestForm.steps.next', { name: th(`requestForm.steps.${step}`) }) }).click()

/** What is left on the chosen budget line, as the form says it (FR-INT-004 AC1) */
export const remainingOf = (page: Page): Locator => page.locator('div[aria-live="polite"]').filter({ hasText: th('requestForm.budget.remaining') })

/** The department that pays, beside the budget line (BR-FORM-02) */
export const chargedDepartmentOf = (page: Page): Locator => page.locator('dt').filter({ hasText: th('requestForm.budget.department') }).locator('xpath=following-sibling::dd[1]')

/** The cost center of the chosen budget line, beside it (BR-FORM-02): "CC-CON ศูนย์ต้นทุน…" */
export const costCenterOf = (page: Page): Locator => page.locator('dt').filter({ hasText: th('requestForm.budget.costCenter') }).locator('xpath=following-sibling::dd[1]')

/** The option the form chose, or the requester chose, in a select */
export const chosenIn = (page: Page, label: string): Locator => page.getByLabel(label).locator('option:checked')

export interface FormLine {
  readonly description: string
  readonly quantity: string
  readonly uom: string
  /** Baht as typed */
  readonly price: string
}

/** Fills one line of the request: what, how many, the unit and the price per unit */
export async function fillLine(group: Locator, line: FormLine) {
  await group.getByLabel('สิ่งที่ขอ').fill(line.description)
  await group.getByLabel(/^จำนวน/).fill(line.quantity)
  await group.getByLabel(/^หน่วย/).fill(line.uom)
  await group.getByLabel(/^ราคาต่อหน่วย/).fill(line.price)
}

/** The lines' total before VAT (satang), as the form adds them up */
export const netOfLines = (lines: readonly FormLine[]) => lines.reduce((sum, l) => sum + BigInt(l.quantity) * (satangOf(l.price) ?? 0n), 0n)

/** The confirmation once sent (§9.9 rule 7): the button's words, the number and who decides it now */
export async function sentNumber(page: Page, approverName: string): Promise<string> {
  const sent = page.getByRole('status').filter({ hasText: th('requestForm.sent.send') })
  await expect(sent).toContainText(th('requestForm.sent.sendWaiting', { names: approverName }))
  await expect(sent).toContainText(/PR-\d{4}-\d{5}/)
  return (/PR-\d{4}-\d{5}/.exec((await sent.textContent()) ?? '') ?? [''])[0]
}

/** The timeline of a request page (the workspace's and LIFF's) */
export const requestTimeline = (page: Page): Locator => page.getByRole('list', { name: 'ไทม์ไลน์ของคำขอ' })

/** The line of a request page that says where it is now (the same on the web and in LIFF) */
export const nowLine = (page: Page): Locator => page.locator('p').filter({ hasText: /^ตอนนี้: / })

/** What that line says while the request waits for the approver: "รอ วีระ ปฏิบัติการ (รองประธานสายงาน สายปฏิบัติการ) อนุมัติ" */
export const waitingFor = (approver: DemoUser, role: SheetApprover) => th('requestView.stage.APPROVER', { name: `${approver.nameTh} (${stampRoleOf(role)})` })

// ---------- the purchase-to-pay scenes and the executive's (7, 8, 9): what their rows name ----------

/** A row of sheet Demo_History by its ref ("H11") */
export function historyOf(sheet: DemoSheet, ref: string | null | undefined): DemoHistoryRow {
  const row = ref ? sheet.history.find((h) => h.ref === ref) : undefined
  if (!row) throw new Error(`sheet Demo_History has no row ${ref ?? '(none)'}`)
  return row
}

/** The rows of Demo_History a scene's steps name, in their order: "คำขอฉาก 1 กับ H11 (…)" → ["H11"] */
export const historyRefsIn = (scene: DemoScene): string[] => [...scene.stepsTh.matchAll(/(?<![A-Za-z0-9])(H\d{2,3})(?![A-Za-z0-9])/g)].map((m) => m[1]!)

/** The rule of the sheet's DOA for one kind of document that a scene's steps name in brackets: "COO อนุมัติ (PO-01)" */
export function ruleNamedIn(sheet: DemoSheet, scene: DemoScene, documentType: string): DoaSheetRule {
  const named = [...scene.stepsTh.matchAll(/\(([A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+)\)/g)].map((m) => m[1]!)
  const rules = sheet.doaRules.filter((r) => r.documentType === documentType && named.includes(r.ruleCode))
  if (rules.length !== 1) throw new Error(`Demo_Script row ${scene.row}: the steps name ${rules.length} rules of ${documentType} (${named.join(', ') || 'none'})`)
  return rules[0]!
}

/** A supplier of sheet Suppliers, with its code */
export function supplierOf(sheet: DemoSheet, code: string | null): { readonly code: string; readonly nameTh: string; readonly email: string } {
  const supplier = code ? sheet.suppliers.get(code) : undefined
  if (!code || !supplier) throw new Error(`sheet Suppliers has no supplier ${code ?? '(none)'}`)
  return { code, ...supplier }
}

/** A value of sheet Settings */
export function settingOf(sheet: DemoSheet, key: string): string {
  const value = sheet.settings.get(key)
  if (value === undefined) throw new Error(`sheet Settings has no ${key}`)
  return value
}

const BP_PER_WHOLE = 10_000n

/** A share as the sheet writes it ("0.07", "0.1") in basis points (700, 1000) */
export function basisPointsOf(share: string): bigint {
  const m = /^(\d{1,6})(?:\.(\d{1,4}))?$/.exec(share)
  if (!m) throw new Error(`not a share of four decimals at most: ${share}`)
  return BigInt(m[1]!) * BP_PER_WHOLE + BigInt((m[2] ?? '').padEnd(4, '0'))
}

/** Basis points as a percentage without trailing zeros: 700 → "7", 750 → "7.5" (the PO's "VAT 7%") */
export function percentOfBp(bp: bigint): string {
  const decimals = String(bp % 100n).padStart(2, '0').replace(/0+$/, '')
  return decimals ? `${bp / 100n}.${decimals}` : String(bp / 100n)
}

/**
 * The VAT of an amount before VAT at sheet Settings' vatRate, worked out once for the document (vatRounding DOCUMENT)
 * and rounded half up to the satang (BR-MONEY-02)
 */
export const vatOf = (sheet: DemoSheet, net: bigint): bigint => (net * basisPointsOf(settingOf(sheet, 'vatRate')) * 2n + BP_PER_WHOLE) / (2n * BP_PER_WHOLE)

/** The share of a budget line's planned amount still available, as the dashboard writes it: rounded down to 0.1% ("8.3") */
export function leftShareOf(planned: bigint, available: bigint): { readonly bp: bigint; readonly text: string } {
  const bp = planned > 0n && available > 0n ? (available * BP_PER_WHOLE) / planned : 0n
  return { bp, text: `${bp / 100n}.${(bp % 100n) / 10n}` }
}

const QUANTITY_SCALE = 10_000n

/** A quantity as the database writes it ("20", "12.5") in ten-thousandths */
export function scaledQuantity(quantity: string): bigint {
  const m = /^(\d{1,14})(?:\.(\d{1,4}))?$/.exec(quantity)
  if (!m) throw new Error(`not a quantity of four decimals at most: ${quantity}`)
  return BigInt(m[1]!) * QUANTITY_SCALE + BigInt((m[2] ?? '').padEnd(4, '0'))
}

/** Ten-thousandths as a person types the quantity: "12", "12.5" */
export function quantityOf(scaled: bigint): string {
  const decimals = String(scaled % QUANTITY_SCALE).padStart(4, '0').replace(/0+$/, '')
  return decimals ? `${scaled / QUANTITY_SCALE}.${decimals}` : String(scaled / QUANTITY_SCALE)
}

/** A quantity as the PO and receiving screens write it: thousands separators on the whole part ("1,000.5") */
export function shownQuantity(quantity: string): string {
  const [whole = '0', decimals] = quantityOf(scaledQuantity(quantity)).split('.')
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return decimals ? `${grouped}.${decimals}` : grouped
}

/** `pct` percent of a quantity, exactly ("20", 60 → "12"); an error when that is not a quantity of four decimals */
export function shareOfQuantity(quantity: string, pct: number): string {
  const product = scaledQuantity(quantity) * BigInt(pct)
  if (product % 100n !== 0n) throw new Error(`${pct}% of ${quantity} is not a quantity of four decimals at most`)
  return quantityOf(product / 100n)
}

/** What the steps of a receiving scene take in: "รับไม้อัด 60% และ PPE ครบ" → 60% of the plywood, all of the PPE */
export function receivingIn(scene: DemoScene): { readonly part: { readonly item: string; readonly pct: number }; readonly whole: string } {
  const m = /รับ(\S+?) (\d{1,3})% และ (\S+?) ครบ/.exec(scene.stepsTh)
  if (!m) throw new Error(`Demo_Script row ${scene.row}: the steps say no "รับ<what> <n>% และ <what> ครบ"`)
  return { part: { item: m[1]!, pct: Number(m[2]) }, whole: m[3]! }
}

/** What the board step of a scene names: "กระดานค้าง (H12 ค้างที่ VP 18 ชม.)" → the history row, the position, the hours */
export function boardStepIn(scene: DemoScene): { readonly ref: string; readonly position: string; readonly hours: number } {
  const m = /\((H\d{2,3}) ค้างที่ (\S+) (\d+) ชม\.\)/.exec(scene.stepsTh)
  if (!m) throw new Error(`Demo_Script row ${scene.row}: the steps name no "(H<nn> ค้างที่ <position> <hours> ชม.)"`)
  return { ref: m[1]!, position: m[2]!, hours: Number(m[3]) }
}

/** What the dashboard step of a scene says: "dashboard งบ (ไอทีเหลือ 8%)" → the department's word and the whole percent */
export function budgetStepIn(scene: DemoScene): { readonly department: string; readonly pct: number } {
  const m = /\((\S+?)เหลือ (\d{1,3})%\)/.exec(scene.stepsTh)
  if (!m) throw new Error(`Demo_Script row ${scene.row}: the steps say no "(<department>เหลือ <n>%)"`)
  return { department: m[1]!, pct: Number(m[2]) }
}

/** A calendar day as the PO page writes the date a price was paid: "6 ต.ค. 2569" */
export const thaiDate = (at: string | Date) => formatThaiDate(at)

/** numerator ÷ denominator as the insight screens write a share: one decimal, half up ("78.9") */
export const shareText = (numerator: number, denominator: number) => percent(numerator, denominator)

// ---------- the purchase-to-pay scenes and the executive's: what the database says ----------

/** A request of the demo history (sheet Demo_History, D-01), with the wait of its open task until now */
export type HistoryFacts = RequestFacts & {
  readonly waiting: { readonly taskId: string; readonly waitedMinutes: number; readonly overdue: boolean } | null
}

/** The request the demo history made for a row of sheet Demo_History */
export function historyRequest(ref: string): HistoryFacts {
  const facts = day<HistoryFacts | null>('history', ref)
  if (!facts) throw new Error(`the demo history made no request for ${ref}: the database is not seeded with Demo_History`)
  return facts
}

export interface PoFacts {
  readonly id: string
  readonly number: string | null
  readonly status: string
  readonly kind: string
  readonly urgency: string
  readonly supplier: { readonly code: string; readonly nameTh: string; readonly email: string | null }
  readonly site: string | null
  /** Who made the draft (member code); null when a scheduled round made it */
  readonly createdBy: string | null
  /** Satang as text */
  readonly net: string
  readonly vat: string
  readonly gross: string
  readonly vatRateBp: number | null
  readonly submittedAt: string | null
  readonly approvedAt: string | null
  readonly sentAt: string | null
  readonly sentToEmail: string | null
  /** The PDF the PO was last sent with */
  readonly pdf: { readonly fileName: string; readonly mimeType: string; readonly sha256: string | null; readonly sizeBytes: number } | null
  /** The requests it orders: who asked (member code) from which department */
  readonly requests: ReadonlyArray<{ readonly number: string | null; readonly title: string; readonly requester: string | null; readonly department: string }>
  readonly lines: ReadonlyArray<{
    readonly id: string
    readonly lineNo: number
    readonly description: string
    readonly categoryCode: string | null
    /** Decimal text ("20") */
    readonly quantity: string
    readonly uom: string
    readonly unitPrice: string
    readonly net: string
    readonly received: string
    readonly budgetLine: string
    readonly sources: ReadonlyArray<{ readonly requestNumber: string | null; readonly lineNo: number; readonly quantity: string }>
    /** The prices paid before for the same item (FR-P2P-003 AC1), newest first, three at most */
    readonly earlierPrices: ReadonlyArray<{ readonly poNumber: string | null; readonly approvedAt: string; readonly unitPrice: string }>
  }>
  readonly route: {
    readonly ruleCode: string
    readonly amountBasis: 'GROSS' | 'NET'
    readonly amount: string | null
    readonly doa: { readonly versionId: string; readonly code: string; readonly versionNo: number }
    readonly tasks: readonly TaskFacts[]
  } | null
  readonly events: ReadonlyArray<{ readonly type: string; readonly channel: Channel; readonly by: string | null }>
  readonly receipts: ReadonlyArray<{
    readonly number: string | null
    readonly status: string
    readonly receiver: string | null
    readonly deliveryNoteNo: string | null
    /** The channel its gr.posted event was recorded on */
    readonly channel: Channel | null
    readonly lines: ReadonlyArray<{ readonly poLineId: string; readonly received: string; readonly accepted: string; readonly rejected: string }>
    readonly photos: ReadonlyArray<{ readonly kind: string; readonly fileName: string | null; readonly mimeType: string | null; readonly sizeBytes: number | null }>
  }>
  /** The notices about the PO: whom, which template, how urgent, and the page each one opens */
  readonly notices: ReadonlyArray<{
    readonly recipient: string | null
    readonly templateKey: string
    readonly urgency: 'IMMEDIATE' | 'DIGEST'
    readonly status: string
    readonly data: Readonly<Record<string, unknown>>
    readonly href: string | null
  }>
}

/** The latest PO that orders a request's lines, or null when none does yet */
export const poOrdering = (requestNumber: string) => day<PoFacts | null>('po', requestNumber)

export interface BoardFacts {
  readonly memberId: string
  readonly name: string
  readonly open: number
  readonly waiting: number
  readonly overdue: number
  readonly oldestMinutes: number
  readonly averageMinutes: number
  readonly tasks: ReadonlyArray<{ readonly id: string; readonly status: string; readonly subjectType: string; readonly subjectId: string; readonly assignedAt: string; readonly dueAt: string | null; readonly waitedMinutes: number; readonly overdue: boolean }>
}

/** The open approval tasks a member holds now, as the board counts them from ApprovalTask (FR-VIS-001 AC3) */
export const boardOf = (code: string) => day<BoardFacts>('board', code)

export interface BudgetLineFacts {
  readonly code: string
  readonly nameTh: string
  readonly department: string
  readonly fiscalYear: string
  /** Satang as text */
  readonly planned: string
  readonly available: string
  readonly reserved: string
  readonly committed: string
  readonly actual: string
}

/** Every budget line with its planned amount and its balance now */
export const budgetLinesNow = () => day<BudgetLineFacts[]>('budgets')

export interface KpiFacts {
  readonly from: string
  readonly to: string
  readonly total: { readonly numerator: number; readonly denominator: number }
  readonly byKind: Readonly<Record<string, { readonly numerator: number; readonly denominator: number }>>
  readonly decisions: ReadonlyArray<{ readonly taskId: string; readonly channel: Channel; readonly kind: string; readonly onLine: boolean }>
}

/** G-5 of the Thai days from..to, counted from the decision events (§11.4) */
export const kpiOf = (from: string, to: string) => day<KpiFacts>('kpi', from, to)

/** The LIFF page a notice opens in LINE (src/channels/line/links.ts: /receiving/<id> → /gr/<id>), or null when it has none */
export const liffPageOf = (href: string | null): string | null => (href ? liffPathFor(href) : null)

/** How LINE opens a LIFF deep link (https://liff.line.me/<LIFF ID>/gr/<id>): the LIFF app's endpoint with the page as liff.state */
export const liffEntryOf = (liffPage: string) => `/liff?liff.state=${encodeURIComponent(liffPage)}`

// ---------- the purchase-to-pay scenes and the executive's: the screens ----------

export { actions as poActions, budgetRegion as poBudget, chooseSupplier, consolidateNow, expectPdfLink, exportedFile, header as poHeader, poNumberOf, poolGroup, poTimeline, requestsRegion as poRequests, rowWith, sha256, sheetRows, shownChecksum }

/**
 * Signs the member in on the web as signInAs does, each page of the way checked and photographed at the scene's 1440 px
 * and at 375 px (§9.9, checkWebScreen): the sign-in page, the authenticator step when the sheet gives them a role or a
 * position, and their home
 */
export async function signInChecked(page: Page, sheet: DemoSheet, code: string, testInfo: TestInfo, name: string): Promise<DemoUser> {
  const user = userOf(sheet, code)
  await page.goto('/login')
  await expect(page.getByRole('button', { name: 'เข้าสู่ระบบ' })).toBeVisible()
  await checkWebScreen(page, testInfo, `${name}-login`)
  await page.getByLabel('อีเมลบริษัท').fill(user.email)
  await page.getByLabel('รหัสผ่าน').fill(process.env.SEED_DEV_PASSWORD!)
  await page.getByRole('button', { name: 'เข้าสู่ระบบ' }).click()
  if (user.twoFactor) {
    await expect(page).toHaveURL(/\/login\/2fa$/)
    await expect(page.getByLabel('รหัส 6 หลักจากแอป')).toBeVisible()
    await checkWebScreen(page, testInfo, `${name}-2fa`)
    // The code of now, read after the checks (a code lives 30 seconds)
    await page.getByLabel('รหัส 6 หลักจากแอป').fill(totp(deriveSeedTotpSecret(process.env.SEED_TOTP_KEY!, user.code)))
    await page.getByRole('button', { name: 'ยืนยันและเข้าสู่ระบบ' }).click()
  }
  await expect(page.getByRole('heading', { level: 1 })).toContainText('สวัสดี')
  await checkWebScreen(page, testInfo, `${name}-home`)
  return user
}

/** Business minutes as the insight screens write hours: one decimal, half up (1,083 minutes → "18.1") */
export function hoursText(minutes: number): string {
  const tenths = Math.floor((minutes * 10 * 2 + 60) / 120)
  return `${Math.floor(tenths / 10)}.${tenths % 10}`
}

/**
 * Every way the screens may write a wait that was `from` business minutes when the test read it before the page and
 * `to` when it read it after: the page read the time in between
 */
export function hoursBetween(from: number, to: number): string[] {
  const shown = new Set<string>()
  for (let minutes = from; minutes <= Math.max(from, to); minutes++) shown.add(hoursText(minutes))
  return [...shown]
}

/** The five amounts of a budget line, a department or everything (satang) */
export interface BudgetFigures {
  readonly planned: bigint
  readonly available: bigint
  readonly reserved: bigint
  readonly committed: bigint
  readonly actual: bigint
}

/** Adds up the figures of budget lines (a department's, or the organization's) */
export const sumFigures = (lines: readonly BudgetLineFacts[]): BudgetFigures =>
  lines.reduce<BudgetFigures>(
    (sum, l) => ({
      planned: sum.planned + BigInt(l.planned),
      available: sum.available + BigInt(l.available),
      reserved: sum.reserved + BigInt(l.reserved),
      committed: sum.committed + BigInt(l.committed),
      actual: sum.actual + BigInt(l.actual),
    }),
    { planned: 0n, available: 0n, reserved: 0n, committed: 0n, actual: 0n },
  )

/**
 * A row of the budget dashboard holds these figures, each amount the link to what makes it up (FR-BUD-005 AC1 AC2) —
 * every one of the five, 0.00 too (§9.9: every number opens its list) — the links' names say the amount and whose it is
 * (`of`: a line's code, a department's name, everything)
 */
export async function expectBudgetRow(row: Locator, of: string, f: BudgetFigures) {
  const links: Array<readonly [string, bigint]> = [
    [th('budgets.table.plannedLink', { amount: baht(f.planned), code: of }), f.planned],
    [th('budgets.table.availableLink', { amount: baht(f.available), code: of }), f.available],
    ...(['reserved', 'committed', 'actual'] as const).map((bucket) => [th('budgets.table.amountLink', { bucket: th(`budgets.columns.${bucket}`), amount: baht(f[bucket]), code: of }), f[bucket]] as const),
  ]
  for (const [name, amount] of links) await expect(row.getByRole('link', { name, exact: true }), name).toHaveText(baht(amount))
}

/** Another person's computer in the same scene: a browser of its own at 1440 px and a client address of its own */
export async function anotherDesk(browser: Browser): Promise<BrowserContext> {
  const [a, b] = randomBytes(2)
  return browser.newContext({
    ...devices['Desktop Chrome'],
    viewport: { width: 1440, height: 900 },
    baseURL: E2E_BASE_URL,
    locale: 'th-TH',
    timezoneId: 'Asia/Bangkok',
    extraHTTPHeaders: { 'x-forwarded-for': `198.18.${a!}.${(b! % 254) + 1}` },
  })
}

/**
 * The first screen as the person sees it, from the top (`<name>-screen.png`): a LIFF page's bar sticks to the bottom of
 * the screen, which a full-page picture (checkLiffScreen) draws where the first screen ended
 */
export async function firstScreenShot(page: Page, testInfo: TestInfo, name: string) {
  await page.evaluate(() => window.scrollTo(0, 0))
  await page.screenshot({ path: testInfo.outputPath(`${name}-screen.png`) })
}

/** The lines of a PO page or of its decision page, one item each (the prices paid before are lists inside them) */
export const poLineItems = (page: Page): Locator => page.getByRole('list', { name: th('purchaseOrder.lines.label') }).locator(':scope > li')

/** A photo of the delivery as a phone's camera gives it: a JPEG the browser draws (1600 × 1200 px) */
export async function deliveryPhoto(page: Page): Promise<Buffer> {
  const base64 = await page.evaluate(async () => {
    const canvas = document.createElement('canvas')
    canvas.width = 1600
    canvas.height = 1200
    const ctx = canvas.getContext('2d')!
    ctx.fillStyle = '#7a6a4f'
    ctx.fillRect(0, 0, 1600, 1200)
    ctx.fillStyle = '#d9c9a3'
    ctx.fillRect(200, 300, 1200, 500)
    const blob = await new Promise<Blob>((resolve) => canvas.toBlob((b) => resolve(b!), 'image/jpeg', 0.85))
    let text = ''
    for (const byte of new Uint8Array(await blob.arrayBuffer())) text += String.fromCharCode(byte)
    return btoa(text)
  })
  return Buffer.from(base64, 'base64')
}

/**
 * The e-mail of a PO to its supplier, holding the very PDF the PO was sent with (its name and checksum, as the file
 * store keeps it): Mailpit is shared by every e2e run and PO numbers start again in each database, so the address, the
 * subject, the time and the file tell this one apart
 */
export async function supplierMail(to: string, number: string, sinceMs: number, pdf: { readonly fileName: string; readonly sha256: string | null }): Promise<MailpitMessage> {
  let found: MailpitMessage | undefined
  await expect
    .poll(
      async () => {
        for (const message of await poMails(to, number, sinceMs)) {
          const part = message.Attachments.find((a) => a.FileName === pdf.fileName && a.ContentType === 'application/pdf')
          if (part && sha256(await attachmentOf(message, part.PartID)) === pdf.sha256) found = message
        }
        return found !== undefined
      },
      { timeout: 20_000, message: `the e-mail of ${number} to ${to} with ${pdf.fileName}` },
    )
    .toBe(true)
  return found!
}
