import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { ESLint } from 'eslint'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { THEME_COLORS } from '@/ui/theme'

// FR-PLT-013 AC1 · §9.9 §9.10 · S16-02: the theme of Tailwind and shadcn/ui reads the tokens of the spec and nothing else.
// The values in src/app/globals.css are those of the spec's tables (read from spec.md, so a change of either shows here);
// every shadcn/ui variable is mapped onto a token as §9.10's table says; src/ui/theme.ts, which holds the few colours
// CSS cannot reach, agrees with globals.css; bcs/no-color-literal rejects a hex, arbitrary or Tailwind palette colour in
// src/app and src/ui outside the theme files; and the shadcn/ui components draw no text under 14 px, a solid --focus
// ring 2 px away from their edge, and open Dialog, Sheet and Drawer within 200 ms.

const ROOT = path.resolve(import.meta.dirname, '..', '..')
const read = (file: string) => readFileSync(path.join(ROOT, file), 'utf8')
const SPEC = read('spec.md')
const CSS = read('src/app/globals.css')
const SHADCN = path.join(ROOT, 'src', 'ui', 'shadcn')
const COMPONENTS = readdirSync(SHADCN)
  .filter((name) => name.endsWith('.tsx'))
  .map((name) => ({ name, text: readFileSync(path.join(SHADCN, name), 'utf8') }))

/** The text of a spec section: from its heading to the next heading of the same level */
function section(heading: string): string {
  const start = SPEC.indexOf(`\n### ${heading}`)
  if (start < 0) throw new Error(`spec.md has no section ${heading}`)
  const end = SPEC.indexOf('\n### ', start + 5)
  return SPEC.slice(start, end < 0 ? undefined : end)
}

/** Token → value of the colour rows of a section's tables (`| \`--a\` · \`--b\` | \`#X\` · \`#Y\` | …`) */
function colourRows(text: string): Map<string, string> {
  const tokens = new Map<string, string>()
  for (const line of text.split('\n')) {
    const cells = line.split('|').map((cell) => cell.trim())
    if (cells.length < 4) continue
    const names = [...cells[1]!.matchAll(/`(--[a-z0-9-]+)`/g)].map((m) => m[1]!)
    const values = [...cells[2]!.matchAll(/`(#[0-9A-Fa-f]{6})`/g)].map((m) => m[1]!.toLowerCase())
    if (names.length > 0 && names.length === values.length) names.forEach((name, i) => tokens.set(name, values[i]!))
  }
  return tokens
}

/** The custom properties of the :root block of globals.css */
function rootVariables(): Map<string, string> {
  const block = /:root\s*\{([\s\S]*?)\n\}/.exec(CSS)?.[1] ?? ''
  return new Map([...block.matchAll(/(--[a-z0-9-]+):\s*([^;]+);/g)].map((m) => [m[1]!, m[2]!.trim().toLowerCase()]))
}

/** shadcn/ui variable → value of §9.10's mapping table (`var(--x)`, or the token itself) */
function shadcnMapping(): Map<string, string> {
  const text = section('9.10')
  const table = text.slice(text.indexOf('**การจับคู่กับตัวแปรของ shadcn/ui**'), text.indexOf('**ขนาดของโครงหน้า**'))
  const mapping = new Map<string, string>()
  for (const line of table.split('\n')) {
    const cells = line.split('|').map((cell) => cell.trim())
    if (cells.length < 4 || !cells[1]!.startsWith('`--')) continue
    const names = [...cells[1]!.matchAll(/`(--[a-z0-9-]+)`/g)].map((m) => m[1]!)
    const values = [...cells[2]!.matchAll(/`([^`]+)`/g)].map((m) => m[1]!)
    if (values.length === 0 || names[0] === '--primary' || names[0] === '--chart-1') continue
    // One value for every name, or one value each in the same order
    names.forEach((name, i) => mapping.set(name, (values.length === names.length ? values[i]! : values[0]!).toLowerCase()))
  }
  return mapping
}

describe('[FR-PLT-013/AC1] the theme reads the tokens of §9.9 and §9.10 only', () => {
  const variables = rootVariables()

  it('every colour token of the starter set (§9.9), the extension set and the chart colours (§9.10) has its spec value in globals.css', () => {
    const spec = new Map([...colourRows(section('9.9')), ...colourRows(section('9.10'))])
    expect(spec.size).toBeGreaterThanOrEqual(9 + 19 + 9)
    const wrong = [...spec].filter(([token, value]) => variables.get(token) !== value).map(([token, value]) => `${token}: spec ${value}, css ${variables.get(token) ?? 'missing'}`)
    expect(wrong).toEqual([])
    // --budget-track is "the same value as --surface" in the spec
    expect(variables.get('--budget-track')).toBe('var(--surface)')
  })

  it('every shadcn/ui variable is mapped onto a token as §9.10 says, and --primary is the token itself', () => {
    const mapping = shadcnMapping()
    expect(mapping.size).toBeGreaterThanOrEqual(25)
    const wrong = [...mapping].filter(([name, value]) => variables.get(name) !== value).map(([name, value]) => `${name}: spec ${value}, css ${variables.get(name) ?? 'missing'}`)
    expect(wrong).toEqual([])
    expect(variables.get('--primary')).toBe('#0b6e5f')
    expect(CSS).toMatch(/--color-chart-6:\s*var\(--chart-6\)/)
  })

  it('the :root block holds no colour that is not a token: every hex is a token of the spec, every other value refers to one', () => {
    const spec = new Map([...colourRows(section('9.9')), ...colourRows(section('9.10'))])
    const stray = [...variables].filter(([name, value]) => (value.startsWith('#') ? spec.get(name) !== value : /^(rgb|hsl|oklch|oklab|lab|lch|color)\(/.test(value)))
    expect(stray).toEqual([])
  })

  it('src/ui/theme.ts, for places without the stylesheet, holds the values of globals.css', () => {
    const wrong = Object.entries(THEME_COLORS).filter(([token, value]) => variables.get(`--${token}`) !== value)
    expect(wrong).toEqual([])
  })

  it('no shadcn/ui component draws text under 14 px: no text-xs, no arbitrary size below 0.875rem or 14px', () => {
    const small = COMPONENTS.flatMap(({ name, text }) =>
      [...text.matchAll(/\btext-(?:xs|2xs|\[(\d*\.?\d+)(rem|px)\])/g)]
        .filter((m) => !m[1] || (m[2] === 'rem' ? Number(m[1]) < 0.875 : Number(m[1]) < 14))
        .map((m) => `${name}: ${m[0]}`),
    )
    expect(small).toEqual([])
  })

  it('no shadcn/ui component draws text under 16 px on a phone (§9.10 "ตัวอักษร"): every 14 px text-sm starts at md', () => {
    // text-sm/relaxed (a size with its line height) is 14 px too (P1-09: the empty state's description)
    const phoneSmall = COMPONENTS.flatMap(({ name, text }) => [...text.matchAll(/(?<=[\s"'`])text-sm(?=[\s"'`/])/g)].map(() => name))
    expect(phoneSmall).toEqual([])
  })

  it('no shadcn/ui component draws its text translucent: a faded token fails the 4.5:1 of §9.9 (the muted ink is the token for quieter words)', () => {
    const faded = COMPONENTS.flatMap(({ name, text }) =>
      [...text.matchAll(/(?:^|[\s"'`])([^\s"'`]*:)?text-(?!sm\b|base\b|lg\b|xl\b|\dxl\b)[a-z-]+\/\d+/g)].filter((m) => !/dark:/.test(m[1] ?? '')).map((m) => `${name}: ${m[0].trim()}`),
    )
    expect(faded).toEqual([])
  })

  it('every focus ring of a shadcn/ui component is solid --focus, 2 px, 2 px away from the edge', () => {
    // A translucent ring (ring-ring/50) or one of 3 px; aria-invalid keeps its own error halo, which is not focus
    const translucent = COMPONENTS.flatMap(({ name, text }) => [...text.matchAll(/(?:^|[\s"'`])([^\s"'`]*:)?ring-ring\/\d+/g)].map((m) => `${name}: ${m[0].trim()}`))
    expect(translucent).toEqual([])
    const wide = COMPONENTS.flatMap(({ name, text }) =>
      [...text.matchAll(/(?:^|[\s"'`])([^\s"'`]*:)?ring-(?:3|\[3px\])(?=[\s"'`])/g)].filter((m) => !/aria-invalid/.test(m[1] ?? '')).map((m) => `${name}: ${m[0].trim()}`),
    )
    expect(wide).toEqual([])
    const noOffset = COMPONENTS.filter(({ text }) => /focus-visible:ring-ring(?![\w/-])/.test(text) && !/focus-visible:ring-offset-2/.test(text)).map(({ name }) => name)
    expect(noOffset).toEqual([])
    expect(rootVariables().get('--ring')).toBe('var(--focus)')
  })

  it('Dialog, Alert Dialog, Sheet and Drawer open and close within 200 ms, and nothing moves under prefers-reduced-motion', () => {
    const slow = COMPONENTS.filter(({ name }) => ['dialog.tsx', 'alert-dialog.tsx', 'sheet.tsx', 'drawer.tsx'].includes(name)).flatMap(({ name, text }) =>
      [...text.matchAll(/\bduration-(\d+)\b/g)].filter((m) => Number(m[1]) > 200).map((m) => `${name}: ${m[0]}`),
    )
    expect(slow).toEqual([])
    // vaul draws the Drawer's slide from styles of its own (500 ms): globals.css holds it to 200 ms
    expect(CSS).toMatch(/\[data-vaul-drawer\][\s\S]*?transition-duration:\s*200ms !important/)
    expect(CSS).toMatch(/@media \(prefers-reduced-motion: reduce\)[\s\S]*?animation-duration:\s*0\.01ms !important/)
  })

  it('cards are drawn with a 1 px --line border and no shadow (§9.9 0.3)', () => {
    const card = COMPONENTS.find(({ name }) => name === 'card.tsx')!.text
    const classes = /data-slot="card"[\s\S]*?cn\(\s*"([^"]+)"/.exec(card)?.[1] ?? ''
    expect(classes).toMatch(/\bborder border-border\b/)
    expect(classes).not.toMatch(/\b(shadow|ring)-/)
  })
})

describe('[FR-PLT-013/AC1] bcs/no-color-literal rejects colours written outside the theme', () => {
  let eslint: ESLint
  beforeAll(() => {
    eslint = new ESLint({ cwd: ROOT })
  }, 60_000)
  vi.setConfig({ testTimeout: 60_000 })

  const colourMessages = async (file: string, code: string) => {
    const [result] = await eslint.lintText(code, { filePath: path.join(ROOT, file), warnIgnored: true })
    return (result?.messages ?? []).filter((m) => m.ruleId === 'bcs/no-color-literal')
  }

  it.each([
    ['a hex class value', 'src/ui/x/a.tsx', `export const A = () => <div className="bg-[#0B6E5F]" />`],
    ['a hex in a style', 'src/app/(workspace)/x/a.tsx', `export const A = () => <div style={{ color: '#1c2b33' }} />`],
    ['a short hex', 'src/ui/x/a.ts', `export const c = '#fff'`],
    ['an rgb() arbitrary value', 'src/ui/x/a.tsx', `export const A = () => <div className="text-[rgb(0,0,0)]" />`],
    ['an oklch() colour', 'src/ui/x/a.ts', 'export const c = `oklch(0.5 0.1 120)`'],
    ['a Tailwind palette colour', 'src/ui/x/a.tsx', `export const A = () => <div className="hover:bg-white text-gray-500" />`],
    ['a palette colour with opacity', 'src/app/x/a.tsx', `export const A = () => <div className="bg-black/10" />`],
  ])('rejects %s in src/app or src/ui', async (_what, file, code) => {
    expect((await colourMessages(file, code)).length).toBeGreaterThan(0)
  })

  it('allows the token classes, var(--token), an entity and an anchor, and the theme file', async () => {
    const tokens = `export const A = () => <a href="#top" className="bg-primary text-on-primary hover:bg-primary-hover border-line-strong bg-warn-bg text-warn-ink ring-ring ring-offset-2 bg-ink/30 bg-transparent" style={{ background: 'var(--chart-1)' }}>&#123;</a>`
    expect(await colourMessages('src/ui/x/a.tsx', tokens)).toEqual([])
    expect(await colourMessages('src/ui/theme.ts', `export const T = { primary: '#0b6e5f' }`)).toEqual([])
  })

  it('leaves LINE cards, e-mail and PDF alone (they are drawn outside src/app and src/ui)', async () => {
    expect(await colourMessages('src/channels/line/x.ts', `export const c = '#0b6e5f'`)).toEqual([])
  })
})

describe('[FR-PLT-013/AC5] bcs/liff-imports keeps the workspace out of LIFF', () => {
  let eslint: ESLint
  beforeAll(() => {
    eslint = new ESLint({ cwd: ROOT })
  }, 60_000)
  vi.setConfig({ testTimeout: 60_000 })

  const liffMessages = async (file: string, code: string) => {
    const [result] = await eslint.lintText(code, { filePath: path.join(ROOT, file), warnIgnored: true })
    return (result?.messages ?? []).filter((m) => m.ruleId === 'bcs/liff-imports')
  }

  it.each([
    ['cmdk', 'src/app/liff/x/page.tsx', `import { Command } from 'cmdk'\nexport const A = Command`],
    ['recharts', 'src/ui/liff/x.tsx', `import { BarChart } from 'recharts'\nexport const A = BarChart`],
    ['react-day-picker', 'src/ui/liff/x.tsx', `import { DayPicker } from 'react-day-picker'\nexport const A = DayPicker`],
    ['a shadcn/ui component by alias', 'src/app/liff/x/page.tsx', `import { Button } from '@/ui/shadcn/button'\nexport const A = Button`],
    ['the class merger by a relative path', 'src/ui/liff/x.tsx', `import { cn } from '../cn'\nexport const A = cn`],
    ['tailwind-merge', 'src/ui/liff/requests/x.tsx', `import { twMerge } from 'tailwind-merge'\nexport const A = twMerge`],
    ['a primitive of shadcn/ui', 'src/ui/liff/x.tsx', `import { Dialog } from 'radix-ui'\nexport const A = Dialog`],
    ['a lazy import()', 'src/ui/liff/x.tsx', `export const load = () => import('input-otp')`],
  ])('rejects %s in a LIFF file', async (_what, file, code) => {
    expect((await liffMessages(file, code)).length).toBeGreaterThan(0)
  })

  it('allows LIFF its own light set, and the workspace everything', async () => {
    expect(await liffMessages('src/ui/liff/x.tsx', `import { cn } from './cn'\nimport { LiffIcon } from '@/ui/liff/icons'\nexport const A = [cn, LiffIcon]`)).toEqual([])
    expect(await liffMessages('src/ui/liff/requests/x.tsx', `import { cn } from '../cn'\nexport const A = cn`)).toEqual([])
    expect(await liffMessages('src/app/(workspace)/x/page.tsx', `import { Command } from 'cmdk'\nimport { Button } from '@/ui/shadcn/button'\nexport const A = [Command, Button]`)).toEqual([])
  })
})
