import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// FR-VIS-007 AC5: charts load lazily — recharts is never in a page's first JavaScript. Only the chart files import it
// (the shadcn/ui chart and the two chart bodies), and those bodies are reached through import() alone, never a static
// import, so the home page and /insights ship without it until a chart is drawn in the browser.

const SRC = join(process.cwd(), 'src')
const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return name === 'generated' ? [] : files(path)
    return /\.(ts|tsx)$/.test(name) ? [path] : []
  })
const rel = (path: string) => path.slice(SRC.length + 1).replaceAll('\\', '/')
const sources = files(SRC).map((path) => ({ path: rel(path), text: readFileSync(path, 'utf8') }))
/** A static import that stays in the bundle (a type-only import is erased) */
const staticImport = (spec: RegExp) => new RegExp(`^\\s*import\\s(?!type\\s)(?:(?!\\bimport\\b)[^;])*?from\\s+['"]${spec.source}['"]`, 'm')

describe('[FR-VIS-007/AC5] charts are loaded lazily', () => {
  it('only the chart files import recharts', () => {
    expect(sources.filter((f) => staticImport(/recharts/).test(f.text)).map((f) => f.path).sort()).toEqual(['ui/dev/ui-chart.tsx', 'ui/insight/insight-charts.tsx', 'ui/shadcn/chart.tsx'])
  })

  it('the chart bodies are reached through import() only, and the shadcn/ui chart only from them', () => {
    const importers = (spec: RegExp) => sources.filter((f) => staticImport(spec).test(f.text)).map((f) => f.path)
    expect(importers(/(\.\/|@\/ui\/insight\/)insight-charts/)).toEqual([])
    expect(importers(/(\.\/|@\/ui\/dev\/)ui-chart/)).toEqual([])
    expect(importers(/@\/ui\/shadcn\/chart/).sort()).toEqual(['ui/dev/ui-chart.tsx', 'ui/insight/insight-charts.tsx'])
    expect(sources.find((f) => f.path === 'ui/insight/insight-chart.tsx')!.text).toMatch(/dynamic\(\(\) => import\('\.\/insight-charts'\)/)
  })
})
