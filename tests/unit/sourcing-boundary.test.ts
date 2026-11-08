import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

// FR-SRC-202 AC4 · BR-RFX-06 · INV-RFX-01: the prices of a sealed RFx reach nobody inside before its close, so Bid and
// BidLine are read only by the code that knows the envelope — the sourcing services (sealed reader bidForMember), the
// portal's own query (a supplier's own bid) and the sourcing queries and reports of later items. Insight's tools, the
// shared queries, exports and AI agents never read them; a new reader elsewhere fails here until it is reviewed.

const ROOT = path.resolve(import.meta.dirname, '..', '..')
const ALLOWED = [/^src\/server\/services\/sourcing\//, /^src\/server\/portal\/queries-rfx\.ts$/, /^src\/server\/queries\/sourcing-[a-z-]+\.ts$/, /^src\/server\/queries\/reports\/sourcing\.ts$/, /^src\/server\/db\//]
// a read of the delegates, or a nested read of an RFx's bids
const READS = [/\.(bid|bidLine)\.(findUnique|findUniqueOrThrow|findFirst|findFirstOrThrow|findMany|count|aggregate|groupBy)\b/, /\bbids\s*:\s*(true|\{)/, /\bbidLines\s*:\s*(true|\{)/]

function files(dir: string): string[] {
  return readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((e) => {
    const rel = `${dir}/${e.name}`
    if (e.isDirectory()) return e.name === 'generated' ? [] : files(rel)
    return /\.(ts|tsx)$/.test(e.name) ? [rel] : []
  })
}

describe('[FR-SRC-202/AC4] [INV-RFX-01] Bid and BidLine are read only where the sealed envelope is known', () => {
  it('no file outside the sourcing services, the portal RFx query and the sourcing queries reads a bid', () => {
    const offenders = files('src')
      .filter((f) => !ALLOWED.some((a) => a.test(f)))
      .filter((f) => READS.some((r) => r.test(readFileSync(path.join(ROOT, f), 'utf8'))))
    expect(offenders).toEqual([])
  })

  it('the rule catches a read (canary)', () => {
    expect(READS.some((r) => r.test('await db.bid.findMany({ where: {} })'))).toBe(true)
    expect(READS.some((r) => r.test('include: { bids: { select: { netSatang: true } } }'))).toBe(true)
  })
})
