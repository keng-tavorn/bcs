#!/usr/bin/env node
// D-05 (spec §16.10, §9.9 step 4): gathers the pictures the demo scenes took of every screen they show, at 375 px and at
// 1440 px, into one folder of the design review, with shots.json saying which page each screen is.
//
// Usage: node scripts/design-review-shots.mjs <playwright-output-dir> <target-dir>
//    e.g. node scripts/design-review-shots.mjs .e2e-runs/d5/capture-1 docs/design-review/demo
//
// Each scene's test writes design-review.jsonl in its own output folder (tests/e2e/demo/support.ts: checkWebScreen and
// checkLiffScreen), one line {name, path, kind} per screen in the order the scene showed them. A workspace page ("web")
// was photographed at the scene's 1440 px as <name>.png and again at 375 px as <name>-375.png; a LIFF page at the
// phone's 375 px as <name>.png and at 1440 px as <name>-1440.png. The older pictures of the target folder are removed,
// every screen is copied there as <name>-375.png and <name>-1440.png, and <target>/shots.json lists the screens by
// scene, then in each scene's order: [{name, scene, path, route, kind, shot375, shot1440}] — route is the path with its
// ids written [id], a shot is the picture's path from the folder this runs in (null when it is missing). Exits 1 naming
// every screen without a picture at either width.
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const JOURNAL = 'design-review.jsonl'
const WIDTHS = [375, 1440]
/** A screen's name is the base name of its pictures */
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
/** The ids of the app's pages are UUIDs (prisma: uuid(7)) */
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
/** Which picture of a screen's test folder is which width: a workspace page's own picture is its 1440 px, a LIFF page's its 375 px */
const PICTURE = {
  web: { 375: (name) => `${name}-375.png`, 1440: (name) => `${name}.png` },
  liff: { 375: (name) => `${name}.png`, 1440: (name) => `${name}-1440.png` },
}

function stop(message) {
  console.error(message)
  process.exit(1)
}

const [outputArg, targetArg, ...extra] = process.argv.slice(2)
if (!outputArg || !targetArg || extra.length > 0) stop('usage: node scripts/design-review-shots.mjs <playwright-output-dir> <target-dir>')
const outputDir = path.resolve(outputArg)
const targetDir = path.resolve(targetArg)
if (!existsSync(outputDir) || !statSync(outputDir).isDirectory()) stop(`${outputArg} is not a folder: give the output folder of the demo run (E2E_OUTPUT_DIR)`)

/** A path as shots.json and the messages write it: from the folder this runs in, with forward slashes */
const shown = (file) => path.relative(process.cwd(), file).split(path.sep).join('/')
const byName = (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)

/** Every design-review.jsonl under a folder, in the order of the folders' names (the scene files': demo-01-…, demo-02-…) */
function journalsUnder(dir) {
  return readdirSync(dir, { withFileTypes: true })
    .sort(byName)
    .flatMap((entry) => {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) return journalsUnder(full)
      return entry.isFile() && entry.name === JOURNAL ? [full] : []
    })
}

/** The scene of a screen: its name says it ("scene7-pool"), or else the scene file its test folder is named after ("demo-07-…") */
function sceneOf(name, journal) {
  const named = /^scene(\d+)-/.exec(name)
  if (named) return Number(named[1])
  const folder = path.relative(outputDir, path.dirname(journal)).split(path.sep)[0] ?? ''
  const filed = /^demo-(\d+)-/.exec(folder)
  return filed ? Number(filed[1]) : null
}

/** A page's path with its ids written [id]: /liff/tasks/0199…-…/ → /liff/tasks/[id] */
const routeOf = (pagePath) => pagePath.split('/').map((segment) => (ID.test(segment) ? '[id]' : segment)).join('/')

const journals = journalsUnder(outputDir)
if (journals.length === 0) stop(`no ${JOURNAL} under ${outputArg}: run the demo scenes into it first (E2E_OUTPUT_DIR=${outputArg} pnpm test:e2e --grep @demo)`)

const problems = []
const screens = new Map()
let order = 0
for (const journal of journals) {
  const lines = readFileSync(journal, 'utf8').split(/\r?\n/)
  for (const [i, line] of lines.entries()) {
    if (line.trim() === '') continue
    const where = `${shown(journal)} line ${i + 1}`
    let entry
    try {
      entry = JSON.parse(line)
    } catch {
      problems.push(`${where} is not JSON`)
      continue
    }
    const { name, path: pagePath, kind } = entry && typeof entry === 'object' ? entry : {}
    if (typeof name !== 'string' || !NAME.test(name)) {
      problems.push(`${where}: the name ${JSON.stringify(name)} cannot name a picture`)
      continue
    }
    if (kind !== 'web' && kind !== 'liff') {
      problems.push(`${where}: kind ${JSON.stringify(kind)} is neither "web" nor "liff"`)
      continue
    }
    if (typeof pagePath !== 'string' || !pagePath.startsWith('/')) {
      problems.push(`${where}: ${JSON.stringify(pagePath)} is not the path of a page`)
      continue
    }
    const scene = sceneOf(name, journal)
    if (scene === null) problems.push(`${where}: no scene for ${name} — its name does not start with scene<n>- and its test folder is not demo-<nn>-…`)
    const known = screens.get(name)
    if (known) console.warn(`${name} was checked again (${where}): its later pictures are kept, in the place of the first`)
    screens.set(name, { name, scene, path: pagePath, kind, folder: path.dirname(journal), order: known?.order ?? order++ })
  }
}
if (screens.size === 0) stop(`no screen in the ${JOURNAL} files under ${outputArg}${problems.length ? `:\n${problems.join('\n')}` : ''}`)

const sorted = [...screens.values()].sort((a, b) => (a.scene ?? Number.MAX_SAFE_INTEGER) - (b.scene ?? Number.MAX_SAFE_INTEGER) || a.order - b.order)

// The pictures of an earlier review go first, so the folder holds this run's alone
mkdirSync(targetDir, { recursive: true })
for (const entry of readdirSync(targetDir, { withFileTypes: true })) {
  if (entry.isFile() && entry.name.toLowerCase().endsWith('.png')) rmSync(path.join(targetDir, entry.name))
}

const missing = []
let copied = 0
const shots = sorted.map((screen) => {
  const shot = {}
  for (const width of WIDTHS) {
    const source = path.join(screen.folder, PICTURE[screen.kind][width](screen.name))
    if (existsSync(source)) {
      const target = path.join(targetDir, `${screen.name}-${width}.png`)
      copyFileSync(source, target)
      shot[width] = shown(target)
      copied++
    } else {
      shot[width] = null
      missing.push(`${screen.name} (scene ${screen.scene ?? '?'}, ${screen.kind} ${screen.path}) has no picture at ${width} px: ${shown(source)} is missing`)
    }
  }
  return { name: screen.name, scene: screen.scene, path: screen.path, route: routeOf(screen.path), kind: screen.kind, shot375: shot[375], shot1440: shot[1440] }
})
writeFileSync(path.join(targetDir, 'shots.json'), `${JSON.stringify(shots, null, 2)}\n`)

const scenes = new Set(shots.map((s) => s.scene)).size
console.log(`${shots.length} screens of ${scenes} scenes, ${copied} pictures → ${shown(targetDir)} (shots.json)`)
if (missing.length > 0 || problems.length > 0) {
  for (const line of [...problems, ...missing]) console.error(line)
  stop(`missing pictures: ${missing.length}, unread lines: ${problems.length} — every screen needs its picture at 375 px and at 1440 px`)
}
