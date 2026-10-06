import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { escapeLike } from '@/server/db/like'

// Prisma 7 puts the value of startsWith, contains and endsWith into a LIKE (ILIKE) pattern without escaping it
// (src/server/db/like.ts): `_` and `%` in the value would be wildcards. escapeLike makes a value match itself only, as
// Postgres reads a LIKE pattern (a backslash escapes the next character); and every such filter in src uses it. The same
// against Postgres, on the paths that use it: tests/integration/like-escape.test.ts.

/** A LIKE pattern as Postgres reads it with its default escape (a backslash), as a regular expression */
function likePattern(pattern: string): RegExp {
  let source = ''
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]!
    if (c === '\\' && i + 1 < pattern.length) source += pattern[++i]!.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')
    else if (c === '%') source += '.*'
    else if (c === '_') source += '.'
    else source += c.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')
  }
  return new RegExp(`^${source}$`, 'su')
}

/** Texts made of the characters that matter here: the three LIKE characters, letters, Thai and a line break */
const text = fc.string({ unit: fc.constantFrom('a', 'B', '_', '%', '\\', 'ก', '-', '\n'), maxLength: 8 })

describe('[§4.10] a value given to a LIKE filter matches itself only', () => {
  it('puts a backslash before \\, % and _, and leaves every other character as it is', () => {
    expect(escapeLike('POSITION:VP_OPS@')).toBe('POSITION:VP\\_OPS@')
    expect(escapeLike('50%')).toBe('50\\%')
    expect(escapeLike('C:\\temp')).toBe('C:\\\\temp')
    expect(escapeLike('liff_')).toBe('liff\\_')
    expect(escapeLike('ปูน ซีเมนต์-PR 2569')).toBe('ปูน ซีเมนต์-PR 2569')
    expect(escapeLike('')).toBe('')
  })

  it('contains, startsWith and endsWith with an escaped value find exactly the texts that hold it there', () => {
    fc.assert(
      fc.property(text, text, (value, candidate) => {
        const v = escapeLike(value)
        expect(likePattern(`%${v}%`).test(candidate)).toBe(candidate.includes(value))
        expect(likePattern(`${v}%`).test(candidate)).toBe(candidate.startsWith(value))
        expect(likePattern(`%${v}`).test(candidate)).toBe(candidate.endsWith(value))
      }),
      { numRuns: 2000 },
    )
  })

  it('without it a `_` or a `%` would find other texts (what Prisma does with the bare value)', () => {
    expect(likePattern('POSITION:VP_OPS@%').test('POSITION:VPXOPS@OPS')).toBe(true)
    expect(likePattern(`${escapeLike('POSITION:VP_OPS@')}%`).test('POSITION:VPXOPS@OPS')).toBe(false)
    expect(likePattern('%50%%').test('ส่วนลด 500 บาท')).toBe(true)
    expect(likePattern(`%${escapeLike('50%')}%`).test('ส่วนลด 500 บาท')).toBe(false)
  })
})

const SRC = path.resolve(import.meta.dirname, '../../src')
/** The Prisma client Prisma generates: its comments show filters, it has none of ours */
const GENERATED = path.join(SRC, 'server', 'db', 'generated')

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) return full === GENERATED ? [] : sourceFiles(full)
    return /\.(ts|tsx)$/.test(entry.name) ? [full] : []
  })
}

/** A line that is a comment (a filter named in words, not in code) */
const isComment = (line: string) => /^\s*(\/\/|\/\*|\*)/.test(line)

describe('[§4.10] every LIKE filter in src escapes its value', () => {
  it('passes the value of every startsWith, contains and endsWith through escapeLike()', () => {
    const unescaped: string[] = []
    for (const file of sourceFiles(SRC)) {
      const where = (i: number, what: string) => `${path.relative(SRC, file).replaceAll('\\', '/')}:${i + 1} ${what.trim()}`
      const lines = readFileSync(file, 'utf8').split(/\r?\n/)
      lines.forEach((line, i) => {
        if (isComment(line)) return
        // `name: value`, the value on the same line or the next (a type annotation `name: string` is no filter)
        for (const m of line.matchAll(/\b(startsWith|contains|endsWith)\s*:\s*([^,}]*)/g)) {
          const value = m[2]!.trim() || (lines[i + 1] ?? '').trim()
          if (value.startsWith('escapeLike(') || /^string\b/.test(value)) continue
          unescaped.push(where(i, m[0]))
        }
        // The shorthand `{ contains }`: a variable named so, never escaped on the way
        for (const m of line.matchAll(/[{,]\s*(startsWith|contains|endsWith)\s*[,}]/g)) unescaped.push(where(i, m[0]))
      })
    }
    expect(unescaped).toEqual([])
  })
})
