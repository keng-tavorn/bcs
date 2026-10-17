import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { expect, test } from '../fixtures'
import { budgetLineOf, coreScenes, historyOf, p1Sheet, userOf } from './support'

// P1-08 (spec §16.13): `pnpm test:e2e --grep @p1demo` passes every scene of sheet Demo_Script_P1 whose core is Y, each
// scene a test of its own in a file of this folder named after it (01-…, 02-…; files run in name order, so the scenes
// build on each other as on the day). This test holds the sheet and the folder together, the sheet being the only list
// of the scenes: the core scenes are the rows with core = Y, whatever their number — no list of scenes is typed here —
// and each has exactly one scene file `<nn>-….spec.ts` with a test titled "@p1demo … scene <n>: …"; a scene file names a
// scene the sheet has; and every member, history row, document sample and budget key a core row names is in the workbook
// (budget keys in the fiscal year of the day the run happens). Whether the topics of P1-08 all have a core scene, the
// amounts, the DOA routes and the reviewers are right is validate_inputs.py --profile p1's (pnpm inputs:check).

/** A scene file of this folder: "08-invoice-email.spec.ts" → scene 8; this file (00-) is the sheet's, no scene's */
const SCENE_FILE = /^(\d{2})-.+\.spec\.ts$/

test('@p1demo the core scenes of Demo_Script_P1 each have one scene test', async () => {
  const sheet = await p1Sheet()
  const core = coreScenes(sheet)
  expect(core.length, 'Demo_Script_P1 has scenes with core = Y').toBeGreaterThan(0)
  expect(new Set(sheet.scenes.map((s) => s.scene)).size, 'each scene of Demo_Script_P1 has a number of its own').toBe(sheet.scenes.length)

  const folder = import.meta.dirname
  const specs = readdirSync(folder).filter((f) => SCENE_FILE.test(f) && !f.startsWith('00-'))
  for (const scene of core) {
    const prefix = `${String(scene.scene).padStart(2, '0')}-`
    const files = specs.filter((f) => f.startsWith(prefix))
    expect.soft(files, `scene ${scene.scene} "${scene.titleTh}" (Demo_Script_P1 row ${scene.row}, core = Y) has exactly one file ${prefix}….spec.ts`).toHaveLength(1)
    if (files.length === 1) {
      const source = readFileSync(path.join(folder, files[0]!), 'utf8')
      expect.soft(source, `${files[0]} has a test titled "@p1demo … scene ${scene.scene}: …"`).toMatch(new RegExp(`test\\(\\s*['"\`]@p1demo [^'"\`]*scene ${scene.scene}: `))
    }

    // Everything the row names is in the workbook
    for (const code of [scene.actor, ...scene.others, ...scene.expectedReviewers.map((r) => r.member)]) userOf(sheet, code)
    if (scene.expectedApprover) userOf(sheet, scene.expectedApprover)
    if (scene.historyRef) historyOf(sheet, scene.historyRef)
    if (scene.docSample) expect.soft(sheet.docSamples.has(scene.docSample), `scene ${scene.scene}: DocSamples has ${scene.docSample}`).toBe(true)
    if (scene.budgetKey) budgetLineOf(sheet, scene.budgetKey)
    if (scene.requestType) expect.soft(sheet.requestTypes.has(scene.requestType), `scene ${scene.scene}: RequestTypes has ${scene.requestType}`).toBe(true)
    if (scene.chargedDept) expect.soft(sheet.departments.has(scene.chargedDept), `scene ${scene.scene}: Departments has ${scene.chargedDept}`).toBe(true)
    if (scene.site) expect.soft(sheet.sites.has(scene.site), `scene ${scene.scene}: Sites has ${scene.site}`).toBe(true)
    if (scene.supplier) expect.soft(sheet.suppliers.has(scene.supplier), `scene ${scene.scene}: Suppliers has ${scene.supplier}`).toBe(true)
    if (scene.itemCode) expect.soft(sheet.items.has(scene.itemCode), `scene ${scene.scene}: Items has ${scene.itemCode}`).toBe(true)
  }

  // A scene file of this folder is the file of a scene of the sheet
  for (const file of specs) {
    const n = Number(SCENE_FILE.exec(file)![1])
    expect.soft(sheet.scenes.some((s) => s.scene === n), `${file} is the file of scene ${n}, a row of Demo_Script_P1`).toBe(true)
  }
})
