import { TZDate } from '@date-fns/tz'

// Document numbers (spec §7.3, BR-NUM-02, BR-NUM-03). The pure part: the number text and the sequence scope at the
// moment of issue, in Thai time. Issuing (row lock on DocumentSequence, INV-NUM-01) is the service's job.

export const NUMBERING_TIME_ZONE = 'Asia/Bangkok'
const BE_OFFSET = 543
export type ResetPeriod = 'YEARLY' | 'MONTHLY' | 'NEVER'

const TOKEN = /\{(BE|YY|CE|MM|DEPT|SEQ(\d+))\}/g

export interface NumberContext {
  readonly at: Date
  readonly seq: number
  /** Code of the charged department; needed when the pattern has {DEPT} */
  readonly department?: string | null
}

function localParts(at: Date): { be: number; ce: number; month: string } {
  const local = new TZDate(at.getTime(), NUMBERING_TIME_ZONE)
  return { be: local.getFullYear() + BE_OFFSET, ce: local.getFullYear(), month: String(local.getMonth() + 1).padStart(2, '0') }
}

/** Tokens a pattern may use; anything else in braces is refused so a typo never prints literally. */
export function patternProblems(pattern: string): string[] {
  const problems: string[] = []
  const unknown = pattern.replace(TOKEN, '').match(/\{[^}]*\}/g)
  if (unknown) problems.push(...unknown.map((t) => `unknown token ${t}`))
  const seqs = [...pattern.matchAll(/\{SEQ(\d+)\}/g)]
  if (seqs.length !== 1) problems.push('the pattern needs exactly one {SEQn}')
  else if (Number(seqs[0]![1]) < 1) problems.push('{SEQn} needs a width of at least 1')
  return problems
}

/** BR-NUM-02: the number for sequence value `seq` (wider than SEQn when it outgrows it, GC-NUM-04). */
export function formatDocumentNumber(pattern: string, context: NumberContext): string {
  const problems = patternProblems(pattern)
  if (problems.length > 0) throw new RangeError(`invalid number pattern ${pattern}: ${problems.join('; ')}`)
  if (!Number.isInteger(context.seq) || context.seq < 1) throw new RangeError(`invalid sequence value ${context.seq}`)
  const { be, ce, month } = localParts(context.at)
  return pattern.replace(TOKEN, (_, token: string, width?: string) => {
    if (width !== undefined) return String(context.seq).padStart(Number(width), '0')
    if (token === 'BE') return String(be)
    if (token === 'YY') return String(be % 100).padStart(2, '0')
    if (token === 'CE') return String(ce)
    if (token === 'MM') return month
    if (!context.department) throw new RangeError('the pattern needs the charged department ({DEPT})')
    return context.department
  })
}

/** BR-NUM-03: "<type>:<period>[:<department>]" — the period is the BE year, BE year-month, or NEVER. */
export function scopeKey(documentType: string, pattern: string, reset: ResetPeriod, context: Omit<NumberContext, 'seq'>): string {
  const { be, month } = localParts(context.at)
  const period = reset === 'YEARLY' ? String(be) : reset === 'MONTHLY' ? `${be}-${month}` : 'NEVER'
  if (!pattern.includes('{DEPT}')) return `${documentType}:${period}`
  if (!context.department) throw new RangeError('the pattern needs the charged department ({DEPT})')
  return `${documentType}:${period}:${context.department}`
}
