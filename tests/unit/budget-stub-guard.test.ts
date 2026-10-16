import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

// S3-05 "the test that keeps the stub out of production" (spec §16.4): until S3 the submit had no budget check. The
// check is now part of the one submit path every channel uses, and nothing in the request or budget code reads the
// environment, so no setting (APP_ENV=production included) can skip it. FR-BUD-003 AC2 tests the same at runtime.

const ROOT = path.resolve(import.meta.dirname, '..', '..')
const read = (file: string) => readFileSync(path.join(ROOT, file), 'utf8')

describe('[FR-BUD-003/AC2] the budget check has no stub and no switch', () => {
  const requests = read('src/server/services/requests/index.ts')
  const budget = read('src/server/services/requests/budget.ts')
  const ledger = read('src/server/budget/ledger.ts')

  it('the shared submit step resolves the budget lines of every line and reserves before the route (S6-17)', () => {
    const prepare = requests.slice(requests.indexOf('async function prepareRoute'), requests.indexOf('export const submitCommand'))
    const check = prepare.indexOf('requestBudgetLines(')
    const reserve = prepare.indexOf('reserveForRequest(')
    const route = prepare.indexOf('startRoute(')
    expect(check).toBeGreaterThan(0)
    expect(reserve).toBeGreaterThan(check)
    expect(route).toBeGreaterThan(reserve)
    // submit and resubmit both go through it
    expect(requests.match(/await prepareRoute\(/g)?.length).toBe(2)
  })

  it('no stub is left and nothing reads the environment to skip it', () => {
    for (const [name, text] of [['requests', requests], ['budget', budget], ['ledger', ledger]] as const) {
      expect(text, name).not.toMatch(/\bstub\b/i)
      expect(text, name).not.toMatch(/APP_ENV|getEnv\(|process\.env/)
    }
  })
})
