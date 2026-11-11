import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

// S7-18 found /suppliers/applications/[id]/edit failing on the server: its page (a server module) read ON_BEHALF_STEPS
// from the 'use client' form, and a value of a client module reaches a server module as a client reference, not the
// value ("includes is not a function"). A server module may take components from a client module (they render as
// client references), and types; any other value it imports from one is this bug. Read from the sources: a module
// without 'use client' (or 'use server') at its top is a server module here.

const ROOT = path.resolve(import.meta.dirname, '../..')
const SRC = path.join(ROOT, 'src')
const EXTENSIONS = ['.ts', '.tsx']

function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name)
    if (statSync(full).isDirectory()) return name === 'node_modules' ? [] : filesUnder(full)
    return EXTENSIONS.includes(path.extname(name)) && !/\.test\.tsx?$/.test(name) ? [full] : []
  })
}

const directiveOf = (text: string) => /^\s*(?:\/\/[^\n]*\n|\/\*[\s\S]*?\*\/\s*)*\s*['"]use (client|server)['"]/.exec(text)?.[1] ?? null

function resolve(from: string, specifier: string): string | null {
  const base = specifier.startsWith('@/') ? path.join(SRC, specifier.slice(2)) : specifier.startsWith('.') ? path.resolve(path.dirname(from), specifier) : null
  if (!base) return null
  for (const candidate of [base, ...EXTENSIONS.map((e) => base + e), ...EXTENSIONS.map((e) => path.join(base, `index${e}`))]) {
    try {
      if (statSync(candidate).isFile()) return candidate
    } catch {
      // not this one
    }
  }
  return null
}

/** The values (not types) a module imports by name from each specifier */
function namedValueImports(text: string): { specifier: string; names: string[] }[] {
  return [...text.matchAll(/import\s+(type\s+)?(?:[A-Za-z_$][\w$]*\s*,\s*)?\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g)]
    .filter((m) => !m[1])
    .map((m) => ({
      specifier: m[3]!,
      names: m[2]!
        .split(',')
        .map((n) => n.trim())
        .filter((n) => n !== '' && !n.startsWith('type '))
        .map((n) => n.split(/\s+as\s+/)[0]!.trim()),
    }))
}

/** A component's name starts with a capital and is not all capitals (ON_BEHALF_STEPS is a value, OnBehalfForm a component) */
const isComponentName = (name: string) => /^[A-Z]/.test(name) && /[a-z]/.test(name)

function serverReadsOfClientValues(): string[] {
  const files = filesUnder(SRC)
  const directive = new Map(files.map((f) => [f, directiveOf(readFileSync(f, 'utf8'))]))
  const found: string[] = []
  for (const file of files) {
    if (directive.get(file) !== null) continue
    for (const { specifier, names } of namedValueImports(readFileSync(file, 'utf8'))) {
      const target = resolve(file, specifier)
      if (!target || directive.get(target) !== 'client') continue
      for (const name of names.filter((n) => !isComponentName(n))) found.push(`${path.relative(ROOT, file).split(path.sep).join('/')}: ${name} from ${specifier}`)
    }
  }
  return found
}

describe('[§9.9] a server module takes only components and types from a client module', () => {
  it('no server module of src imports another value from a module that starts with use client', () => {
    expect(serverReadsOfClientValues()).toEqual([])
  }, 60_000)

  it('the reading sees the case S7-18 found: a constant beside a component, and a component alone', () => {
    const text = "import { ON_BEHALF_STEPS, OnBehalfForm, type OnBehalfStep } from '@/ui/x'\nimport type { A } from './a'\n"
    expect(namedValueImports(text)).toEqual([{ specifier: '@/ui/x', names: ['ON_BEHALF_STEPS', 'OnBehalfForm'] }])
    expect(['ON_BEHALF_STEPS', 'OnBehalfForm', 'useThing', 'cn'].filter((n) => !isComponentName(n))).toEqual(['ON_BEHALF_STEPS', 'useThing', 'cn'])
    expect(directiveOf("// a note\n'use client'\nexport const a = 1")).toBe('client')
    expect(directiveOf("import x from 'y'\n'use client'")).toBeNull()
  })
})
