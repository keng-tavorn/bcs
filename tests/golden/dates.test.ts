import { describe, expect, it } from 'vitest'
import { buddhistYear, formatThaiDate, formatThaiDateTime } from '@/core/thai'
import { loadGolden } from './support'

const suite = loadGolden('dates')
const FUNCTIONS: Record<string, (input: string) => unknown> = { buddhistYear, formatThaiDate, formatThaiDateTime }

describe(`golden ${suite.suite} (BR-DATE-01)`, () => {
  it.each(suite.cases.map((c) => [c.id, c] as const))('[%s]', (_id, c) => {
    const fn = FUNCTIONS[String(c.fn)]
    expect(fn, `no function ${String(c.fn)}`).toBeTypeOf('function')
    expect(fn!(c.input as string)).toEqual(c.expect)
  })
})
