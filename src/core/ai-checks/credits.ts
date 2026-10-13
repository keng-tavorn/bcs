// AI credits (BR-AI-23, golden ai-credits, OQ-143). 1 credit = 0.001 USD = 1,000 micro-USD. A call costs
// ceil(Σ tokens × price per million tokens in micro-USD ÷ (1,000,000 × 1,000)), rounded up once, at the end. A model
// with a long-prompt rate bills the whole call at that rate when its prompt (input + cache write + cache read) is
// above `longPromptAbove`. No tokens, no charge and no ledger row. The prices come from src/lib/ai-config.ts.

import { AI_PRICE_UNITS_PER_CREDIT, BP_PER_WHOLE } from '../money/constants'

export interface TokenRates {
  /** Micro-USD per million tokens */
  readonly input: number
  readonly output: number
  readonly cacheWrite: number
  readonly cacheRead: number
}

export interface CreditPrice extends TokenRates {
  readonly longPromptAbove?: number
  readonly long?: TokenRates
}

export interface TokenUse {
  readonly input?: number
  readonly output?: number
  readonly cacheWrite?: number
  readonly cacheRead?: number
}

const count = (n: number | undefined): bigint => {
  const v = n ?? 0
  if (!Number.isSafeInteger(v) || v < 0) throw new RangeError(`token count must be a non-negative integer: ${v}`)
  return BigInt(v)
}

/** Credits of one call, and whether it writes a USE row (only when it used tokens) */
export function creditsForCall(price: CreditPrice, tokens: TokenUse): { readonly credits: number; readonly ledgerRow: boolean } {
  const input = count(tokens.input)
  const output = count(tokens.output)
  const cacheWrite = count(tokens.cacheWrite)
  const cacheRead = count(tokens.cacheRead)
  if (input + output + cacheWrite + cacheRead === 0n) return { credits: 0, ledgerRow: false }
  const prompt = input + cacheWrite + cacheRead
  const rates = price.long !== undefined && price.longPromptAbove !== undefined && prompt > BigInt(price.longPromptAbove) ? price.long : price
  const microUsdMillions =
    input * BigInt(rates.input) + output * BigInt(rates.output) + cacheWrite * BigInt(rates.cacheWrite) + cacheRead * BigInt(rates.cacheRead)
  const credits = (microUsdMillions + AI_PRICE_UNITS_PER_CREDIT - 1n) / AI_PRICE_UNITS_PER_CREDIT
  return { credits: Number(credits), ledgerRow: true }
}

/** Credits left in the month: Σ GRANT − Σ USE (may be negative: the last call may overdraw) */
export const creditsRemaining = (granted: number, used: number): number => granted - used

/** A call may start while credits remain (> 0); the call that crosses zero still finishes (BR-AI-23) */
export const mayStartCall = (remaining: number): boolean => remaining > 0

/**
 * Whether a use takes the month's spending to `alertAtBp` of the month's grants for the first time: the spending before
 * was below the mark and the spending after reaches it. The service also keeps it to once a month (a top-up can drop the
 * share below the mark again).
 */
export function crossesAlert(granted: number, alertAtBp: number, usedBefore: number, usedAfter: number): boolean {
  if (granted <= 0) return false
  const mark = BigInt(granted) * BigInt(alertAtBp)
  return BigInt(usedBefore) * BP_PER_WHOLE < mark && BigInt(usedAfter) * BP_PER_WHOLE >= mark
}
