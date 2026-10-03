import { z } from 'zod'
import { formatDocumentNumber, scopeKey, type ResetPeriod } from '@/core/numbering'
import { err, ok, type Result } from '@/core/result'
import { authorize } from '@/server/authz'
import type { Ctx } from '@/server/context'
import { forTenant, type TenantTx } from '@/server/db/tenant'
import { departmentCodes, issuedDocumentNumbers, nextSequenceValue, readNumberingRules, type NumberingRules } from '@/server/queries/settings'
import type { NumberedDocument } from './index'

// The number patterns page (FR-ADM-004): the next number of each document before and after an edit (AC1), what is
// wrong with a pattern (AC2, BR-NUM-02) and whether a change keeps numbers unique (AC3, INV-NUM-01). The same checks
// run again when organization.save_settings saves the numbering section, inside its transaction.
//
// A change of pattern or reset period never re-issues a number: within one scope (BR-NUM-03: type, period and
// department) the counter goes on, and a scope the change opens starts at 1 only when none of its numbers was issued
// before. A rule is refused when
//  - it names a token BR-NUM-02 does not know (a stray brace too: it would print into the number), or has not
//    exactly one {SEQn} of width ≥ 1;
//  - it resets yearly or monthly but the number does not show the year (or the month): the next period would issue
//    the numbers of this one again;
//  - PR and RQ, which share Request.number, could issue the same number (OVERLAPS_OTHER_DOCUMENT);
//  - it would issue a number that already exists, now that its scope starts again (NUMBER_COLLISION).

export const NUMBERED_DOCUMENTS = ['PR', 'PO', 'GR', 'RQ'] as const satisfies readonly NumberedDocument[]
export const RESET_PERIODS = ['YEARLY', 'MONTHLY', 'NEVER'] as const satisfies readonly ResetPeriod[]

/** Documents whose numbers live in one unique column: Request.number holds PR and RQ (unique per organization) */
const SHARED_NUMBERS: Readonly<Record<NumberedDocument, readonly NumberedDocument[]>> = { PR: ['RQ'], RQ: ['PR'], PO: [], GR: [] }
const KNOWN_TOKEN = /\{(BE|YY|CE|MM|DEPT|SEQ(\d+))\}/g
const YEAR_TOKENS = ['{BE}', '{YY}', '{CE}'] as const
type PeriodToken = 'BE' | 'YY' | 'CE' | 'MM'
/** Sample sequence values around every power of ten up to this exponent, to find two patterns that can meet */
const SAMPLE_POWERS = 8

export type NumberingRefusal =
  | { readonly reason: 'UNKNOWN_TOKEN'; readonly tokens: readonly string[] }
  | { readonly reason: 'SEQ_MISSING' | 'SEQ_REPEATED' | 'SEQ_WIDTH' | 'YEAR_MISSING' | 'MONTH_MISSING' }
  | { readonly reason: 'NUMBER_COLLISION'; readonly example: string }
  | { readonly reason: 'OVERLAPS_OTHER_DOCUMENT'; readonly other: NumberedDocument; readonly example: string }

export interface NumberingRule {
  readonly pattern: string
  readonly reset: ResetPeriod
}

/** BR-NUM-02 and the period rule: everything about one rule that needs no data. */
export function patternRefusal(rule: NumberingRule): NumberingRefusal | null {
  // Known tokens become a mark, so what is left in braces (or a brace on its own) is unknown
  const rest = rule.pattern.replace(KNOWN_TOKEN, '\u0000')
  const unknown = [...new Set(rest.match(/\{[^{}\u0000]*\}?|\}/g) ?? [])]
  if (unknown.length) return { reason: 'UNKNOWN_TOKEN', tokens: unknown }
  const seqs = [...rule.pattern.matchAll(/\{SEQ(\d+)\}/g)]
  if (seqs.length === 0) return { reason: 'SEQ_MISSING' }
  if (seqs.length > 1) return { reason: 'SEQ_REPEATED' }
  if (Number(seqs[0]![1]) < 1) return { reason: 'SEQ_WIDTH' }
  if (rule.reset !== 'NEVER' && !YEAR_TOKENS.some((t) => rule.pattern.includes(t))) return { reason: 'YEAR_MISSING' }
  if (rule.reset === 'MONTHLY' && !rule.pattern.includes('{MM}')) return { reason: 'MONTH_MISSING' }
  return null
}

/** What the checks read; the save command reads inside its transaction, the preview through the queries. */
export interface NumberingReader {
  /** Numbers issued in the document's uniqueness domain that start and end with one of the given texts */
  issuedNumbers(document: NumberedDocument, around: readonly NumberAffixes[]): Promise<string[]>
  nextValue(document: NumberedDocument, scopeKey: string): Promise<number | null>
  departmentCodes(): Promise<string[]>
}

export function txNumberingReader(tx: TenantTx): NumberingReader {
  return {
    async issuedNumbers(document, around) {
      // The same domain and filter as issuedDocumentNumbers in src/server/queries/settings.ts (PR and RQ share
      // Request.number). TODO(S4-01): read PurchaseOrder.number for PO and GoodsReceipt.number for GR once they exist.
      if ((document !== 'PR' && document !== 'RQ') || around.length === 0) return []
      const rows = await tx.request.findMany({ where: { OR: around.map((a) => ({ number: { startsWith: a.prefix, endsWith: a.suffix } })) }, select: { number: true } })
      return rows.flatMap((r) => (r.number ? [r.number] : []))
    },
    async nextValue(document, key) {
      return (await tx.documentSequence.findFirst({ where: { documentType: document, scopeKey: key }, select: { nextValue: true } }))?.nextValue ?? null
    },
    async departmentCodes() {
      return (await tx.department.findMany({ where: { active: true }, select: { code: true }, orderBy: { code: 'asc' } })).map((d) => d.code)
    },
  }
}

export function queryNumberingReader(ctx: Ctx): NumberingReader {
  return {
    issuedNumbers: (document, around) => issuedDocumentNumbers(ctx, document, around),
    nextValue: (document, key) => nextSequenceValue(ctx, document, key),
    departmentCodes: () => departmentCodes(ctx),
  }
}

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** {BE} {YY} {CE} {MM} of the instant in Thai time, read through core/numbering itself (BR-NUM-02). */
function periodValues(at: Date): Readonly<Record<PeriodToken, string>> {
  const [BE, YY, CE, MM] = formatDocumentNumber('{BE}|{YY}|{CE}|{MM}|{SEQ1}', { at, seq: 1 }).split('|') as [string, string, string, string]
  return { BE, YY, CE, MM }
}

/** The fixed texts before and after the running number of the numbers one pattern issues for one department */
export interface NumberAffixes {
  readonly prefix: string
  readonly suffix: string
}

interface Matcher extends NumberAffixes {
  readonly department: string | null
  readonly regex: RegExp
  /** n of {SEQn} */
  readonly width: number
}

/**
 * One matcher per department of the numbers a valid pattern issues in the period of `at`: in that period every token
 * but the running number prints a fixed text, so a number is `prefix` + digits + `suffix`. The database is asked only
 * for numbers with those ends (the regular expression then decides), never for every number of the organization.
 */
function matchersOf(pattern: string, at: Date, codes: readonly string[]): Matcher[] {
  const period = periodValues(at)
  const departments: ReadonlyArray<string | null> = pattern.includes('{DEPT}') ? codes : [null]
  return departments.map((department) => {
    let prefix = ''
    let suffix = ''
    let width = 1
    let afterSeq = false
    let last = 0
    for (const m of pattern.matchAll(KNOWN_TOKEN)) {
      const text = pattern.slice(last, m.index)
      last = m.index + m[0].length
      if (m[2] !== undefined) {
        // The one running number (patternRefusal passed): what came before it is the prefix, what follows the suffix
        prefix += text
        width = Number(m[2])
        afterSeq = true
        continue
      }
      const value = m[1] === 'DEPT' ? (department ?? '') : period[m[1] as PeriodToken]
      if (afterSeq) suffix += text + value
      else prefix += text + value
    }
    suffix += pattern.slice(last)
    return { department, prefix, suffix, regex: new RegExp(`^${escapeRegex(prefix)}(\\d+)${escapeRegex(suffix)}$`), width }
  })
}

/** SQL LIKE (startsWith/endsWith) treats these as special */
const LIKE_SPECIAL = /[%_\\]/

/** The start of `text` up to its first LIKE character: a filter on it can only find more numbers, never fewer */
function plainStart(text: string): string {
  const at = text.search(LIKE_SPECIAL)
  return at < 0 ? text : text.slice(0, at)
}

/** The end of `text` after its last LIKE character, for the same reason */
function plainEnd(text: string): string {
  const last = Math.max(text.lastIndexOf('%'), text.lastIndexOf('_'), text.lastIndexOf('\\'))
  return last < 0 ? text : text.slice(last + 1)
}

/** The sequence value the pattern would have printed as `text`, or null when it never prints it that way. */
function sequenceOf(text: string, width: number): number | null {
  const value = Number(text)
  return Number.isSafeInteger(value) && value >= 1 && String(value).padStart(width, '0') === text ? value : null
}

/** Whether the matchers' rule issues exactly this number, and with which sequence value and department. */
function producedBy(matchers: readonly Matcher[], number: string): { seq: number; department: string | null } | null {
  for (const m of matchers) {
    const match = m.regex.exec(number)
    const seq = match ? sequenceOf(match[1]!, m.width) : null
    if (seq !== null) return { seq, department: m.department }
  }
  return null
}

/** Numbers of a rule around every power of ten (1, 9, 10, 11, 99, 100, 101 …) for each department. */
function sampleNumbers(pattern: string, at: Date, codes: readonly string[]): string[] {
  const seqs = new Set<number>()
  for (let k = 0; k <= SAMPLE_POWERS; k++) for (const s of [10 ** k - 1, 10 ** k, 10 ** k + 1]) if (s >= 1) seqs.add(s)
  const departments: ReadonlyArray<string | null> = pattern.includes('{DEPT}') ? codes : [null]
  return departments.flatMap((department) => [...seqs].map((seq) => formatDocumentNumber(pattern, { at, seq, department })))
}

/**
 * Every check of one rule as it would apply from `at`: the pattern itself, then whether it can meet the rule of a
 * document that shares its numbers, then whether it would issue a number that already exists.
 */
export async function ruleRefusal(reader: NumberingReader, document: NumberedDocument, rule: NumberingRule, rules: NumberingRules, at: Date): Promise<NumberingRefusal | null> {
  const own = patternRefusal(rule)
  if (own) return own
  const codes = await reader.departmentCodes()
  // Without departments a {DEPT} pattern issues nothing; the submit refuses such a document anyway
  if (rule.pattern.includes('{DEPT}') && codes.length === 0) return null
  const mine = matchersOf(rule.pattern, at, codes)
  for (const other of SHARED_NUMBERS[document]) {
    const theirs = rules[other]
    if (patternRefusal(theirs) || (theirs.pattern.includes('{DEPT}') && codes.length === 0)) continue
    const theirMatchers = matchersOf(theirs.pattern, at, codes)
    const example =
      sampleNumbers(rule.pattern, at, codes).find((n) => producedBy(theirMatchers, n)) ?? sampleNumbers(theirs.pattern, at, codes).find((n) => producedBy(mine, n))
    if (example) return { reason: 'OVERLAPS_OTHER_DOCUMENT', other, example }
  }
  const nextValues = new Map<string, number>()
  const around = mine.map((m) => ({ prefix: plainStart(m.prefix), suffix: plainEnd(m.suffix) }))
  for (const number of await reader.issuedNumbers(document, around)) {
    const produced = producedBy(mine, number)
    if (!produced) continue
    const key = scopeKey(document, rule.pattern, rule.reset, { at, department: produced.department })
    if (!nextValues.has(key)) nextValues.set(key, (await reader.nextValue(document, key)) ?? 1)
    // A value below the scope's counter was issued already and is never issued again; one at or above it would be
    if (produced.seq >= nextValues.get(key)!) return { reason: 'NUMBER_COLLISION', example: number }
  }
  return null
}

const sameRule = (a: NumberingRule | undefined, b: NumberingRule) => a !== undefined && a.pattern === b.pattern && a.reset === b.reset

/** The first changed rule that may not be saved (FR-ADM-004 AC2–AC3), checked inside organization.save_settings. */
export async function numberingChangeRefusal(
  reader: NumberingReader,
  before: NumberingRules | null,
  after: NumberingRules,
  at: Date,
): Promise<{ document: NumberedDocument; refusal: NumberingRefusal } | null> {
  for (const document of NUMBERED_DOCUMENTS) {
    if (sameRule(before?.[document], after[document])) continue
    const refusal = await ruleRefusal(reader, document, after[document], after, at)
    if (refusal) return { document, refusal }
  }
  return null
}

export interface NumberPreviewDto {
  readonly document: NumberedDocument
  readonly pattern: string
  readonly reset: ResetPeriod
  /** The number the rule would issue next, now; null when the pattern cannot issue one */
  readonly nextNumber: string | null
  /** true: the counter of this scope already issued numbers and goes on; false: the scope starts at 1 */
  readonly continues: boolean
  /** The department the example uses when the pattern has {DEPT} */
  readonly department: string | null
  readonly refusal: NumberingRefusal | null
}

async function preview(reader: NumberingReader, document: NumberedDocument, rule: NumberingRule, rules: NumberingRules, at: Date, wanted: string | null): Promise<NumberPreviewDto> {
  const base = { document, pattern: rule.pattern, reset: rule.reset }
  const refusal = await ruleRefusal(reader, document, rule, { ...rules, [document]: rule }, at)
  if (patternRefusal(rule)) return { ...base, nextNumber: null, continues: false, department: null, refusal }
  const codes = await reader.departmentCodes()
  const department = rule.pattern.includes('{DEPT}') ? (wanted && codes.includes(wanted) ? wanted : (codes[0] ?? null)) : null
  if (rule.pattern.includes('{DEPT}') && department === null) return { ...base, nextNumber: null, continues: false, department, refusal }
  const next = await reader.nextValue(document, scopeKey(document, rule.pattern, rule.reset, { at, department }))
  return { ...base, nextNumber: formatDocumentNumber(rule.pattern, { at, seq: next ?? 1, department }), continues: next !== null, department, refusal }
}

async function allowNumbering(ctx: Ctx): Promise<Result<true>> {
  const allowed = await forTenant(ctx.organizationId).$transaction((tx) => authorize(tx, ctx, 'admin.numbering'))
  return allowed.ok ? ok(true) : err(allowed.error.code, allowed.error.message, allowed.error.details)
}

export interface NumberingAdminView {
  readonly documents: readonly NumberPreviewDto[]
  readonly departments: readonly string[]
}

/** The numbering page: every document's rule and the next number it issues now (admin.numbering). */
export async function getNumberingAdminView(ctx: Ctx): Promise<Result<NumberingAdminView>> {
  const allowed = await allowNumbering(ctx)
  if (!allowed.ok) return allowed
  const reader = queryNumberingReader(ctx)
  const rules = await readNumberingRules(ctx)
  const documents: NumberPreviewDto[] = []
  for (const document of NUMBERED_DOCUMENTS) documents.push(await preview(reader, document, rules[document], rules, ctx.now, null))
  return ok({ documents, departments: await reader.departmentCodes() })
}

const PreviewInput = z.strictObject({
  document: z.enum(NUMBERED_DOCUMENTS),
  pattern: z.string().trim().min(1).max(100),
  reset: z.enum(RESET_PERIODS),
  department: z.string().max(50).optional(),
})

/** FR-ADM-004 AC1: the next number of a rule being edited, before it is saved, with what would stop the save. */
export async function previewNumbering(ctx: Ctx, input: z.input<typeof PreviewInput>): Promise<Result<NumberPreviewDto>> {
  const allowed = await allowNumbering(ctx)
  if (!allowed.ok) return allowed
  const parsed = PreviewInput.safeParse(input)
  if (!parsed.success) return err('VALIDATION_FAILED', 'invalid preview input', { field: parsed.error.issues[0]?.path.join('.') ?? '(input)' })
  const { document, pattern, reset, department } = parsed.data
  return ok(await preview(queryNumberingReader(ctx), document, { pattern, reset }, await readNumberingRules(ctx), ctx.now, department ?? null))
}
