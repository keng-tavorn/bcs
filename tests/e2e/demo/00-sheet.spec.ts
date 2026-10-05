import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { expect, test } from '../fixtures'

// D-04 (spec §16.10): `pnpm test:e2e --grep @demo` passes every scene of sheet Demo_Script whose core is Y, each scene a
// test of its own in a file of this folder named after it (01-…, 02-…; files run in name order, so the scenes build on
// each other as on the day). This test holds the sheet and the folder together, the sheet being the only list of the
// scenes: the core scenes are the rows of Demo_Script with core = Y, whatever their number and however many there are —
// no list of scenes is typed here or read from another document — and each of them has exactly one scene file
// `<nn>-….spec.ts` with a test titled "@demo … scene <n>: …"; a scene file names a scene the sheet has; and every member,
// request type, department, budget line and site a core row names is in the workbook. Every missing scene is listed at
// once. (./support.ts is imported inside the test: to the demo project every file of this folder is a test file — see
// there.)

/** A scene file of this folder: "07-consolidate-po.spec.ts" → scene 7; this file (00-) is the sheet's, no scene's */
const SCENE_FILE = /^(\d{2})-.+\.spec\.ts$/

test('@demo the core scenes of Demo_Script each have one scene test', async () => {
  const { coreScenes, demoSheet, nameIn, userOf } = await import('./support')
  const sheet = await demoSheet()
  const core = coreScenes(sheet)
  expect(core.length, 'Demo_Script has scenes with core = Y').toBeGreaterThan(0)
  expect(new Set(core.map((s) => s.scene)).size, 'each core scene of Demo_Script has a number of its own').toBe(core.length)

  const folder = import.meta.dirname
  const specs = readdirSync(folder).filter((f) => SCENE_FILE.test(f) && !f.startsWith('00-'))
  for (const scene of core) {
    const prefix = `${String(scene.scene).padStart(2, '0')}-`
    const files = specs.filter((f) => f.startsWith(prefix))
    expect.soft(files, `scene ${scene.scene} "${scene.titleTh}" (Demo_Script row ${scene.row}, core = Y) has exactly one file ${prefix}….spec.ts`).toHaveLength(1)
    if (files.length === 1) {
      const source = readFileSync(path.join(folder, files[0]!), 'utf8')
      expect.soft(source, `${files[0]} has a test titled "@demo … scene ${scene.scene}: …"`).toMatch(new RegExp(`test\\(\\s*['"\`]@demo [^'"\`]*scene ${scene.scene}: `))
    }

    // Everything the row names is in the workbook
    userOf(sheet, scene.actor)
    if (scene.expectedApprover) userOf(sheet, scene.expectedApprover)
    if (scene.requestType) nameIn(sheet.requestTypes, scene.requestType, 'request type')
    if (scene.chargedDept) nameIn(sheet.departments, scene.chargedDept, 'department')
    if (scene.budgetLine) nameIn(sheet.budgetLines, scene.budgetLine, 'budget line')
    if (scene.site) nameIn(sheet.sites, scene.site, 'site')
    if (scene.expectedOutcome !== 'NA') expect(scene.net, `scene ${scene.scene} asks for an amount`).not.toBeNull()
  }

  // A scene file of this folder is the file of a scene of the sheet
  for (const file of specs) {
    const n = Number(SCENE_FILE.exec(file)![1])
    expect.soft(sheet.scenes.some((s) => s.scene === n), `${file} is the file of scene ${n}, a row of Demo_Script`).toBe(true)
  }
})
