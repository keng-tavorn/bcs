import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { ERROR_CODES, HTTP_STATUS, err, isErrorCode, ok } from '@/core/result'

const ROOT = path.resolve(import.meta.dirname, '..', '..')
const spec = readFileSync(path.join(ROOT, 'spec.md'), 'utf8')
const section = spec.slice(spec.indexOf('### 14.2 '), spec.indexOf('### 14.3 '))
// Rows of the §14.2 table: | `CODE` | 409 | template |
const specRows = [...section.matchAll(/^\| `([A-Z_]+)` \| (\d{3}) \| (.+?) \|$/gm)].map((m) => ({
  code: m[1]!,
  http: Number(m[2]),
  template: m[3]!.trim(),
}))
const messages = (locale: string) =>
  JSON.parse(readFileSync(path.join(ROOT, 'messages', 'src', locale, 'errors.json'), 'utf8')) as Record<string, string>
const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort()

describe('error codes match spec §14.2', () => {
  it('lists exactly the codes of the spec table, counted from the spec', () => {
    expect(specRows.length).toBeGreaterThan(0)
    expect([...ERROR_CODES].sort()).toEqual(specRows.map((r) => r.code).sort())
  })

  it('maps every code to the HTTP status of the spec table', () => {
    for (const row of specRows) expect.soft(HTTP_STATUS[row.code as keyof typeof HTTP_STATUS], row.code).toBe(row.http)
  })

  it('has the Thai template of the spec verbatim and an English text with the same placeholders', () => {
    const th = messages('th')
    const en = messages('en')
    for (const row of specRows) {
      expect.soft(th[row.code], row.code).toBe(row.template)
      expect.soft(placeholders(en[row.code] ?? ''), row.code).toEqual(placeholders(row.template))
    }
  })
})

describe('Result helpers (spec §14.1)', () => {
  it('builds success and failure results', () => {
    expect(ok(5)).toEqual({ ok: true, data: 5 })
    expect(err('NOT_FOUND')).toEqual({ ok: false, error: { code: 'NOT_FOUND', message: 'NOT_FOUND' } })
    expect(err('BUDGET_INSUFFICIENT', 'short', { available: '25000.00', shortfall: '35000.00' })).toEqual({
      ok: false,
      error: { code: 'BUDGET_INSUFFICIENT', message: 'short', details: { available: '25000.00', shortfall: '35000.00' } },
    })
  })

  it('recognises error codes', () => {
    expect(isErrorCode('SOD_VIOLATION')).toBe(true)
    expect(isErrorCode('SOMETHING_ELSE')).toBe(false)
  })
})
