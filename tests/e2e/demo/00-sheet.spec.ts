import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { expect, test } from '../fixtures'

// D-04 (spec §16.10): `pnpm test:e2e --grep @demo` passes every scene of sheet Demo_Script whose core is Y, each scene a
// test of its own in a file of this folder named after it (01-…, 02-…; files run in name order, so the scenes build on
// each other as on the day). This test holds the sheet and the folder together: the core scenes are the sheet's rows
// with core = Y — the ones the presenter's runbook walks through (docs/DEMO_RUNBOOK.md §4 names them in its heading) —
// each has its file with a test titled "@demo … scene <n>: …", and every member, request type, department, budget line
// and site a core row names is in the workbook. Every missing scene is listed at once. (./support.ts is imported inside
// the test: to the demo project every file of this folder is a test file — see there.)

/** The core scenes the runbook's scene list names: "## 4. ลำดับฉาก (… ฉากหลัก core = Y คือ 1 2 3 4 5 7 8 9)" */
function runbookCoreScenes(): number[] {
  const runbook = readFileSync(path.resolve(import.meta.dirname, '../../../docs/DEMO_RUNBOOK.md'), 'utf8')
  const listed = /^## 4\..*core = Y คือ ([\d ]+)\)/m.exec(runbook)?.[1]
  if (!listed) throw new Error('docs/DEMO_RUNBOOK.md §4 names no core scenes ("core = Y คือ …")')
  return listed.trim().split(/\s+/).map(Number)
}

test('@demo the core scenes of Demo_Script each have a scene test', async () => {
  const { coreScenes, demoSheet, nameIn, userOf } = await import('./support')
  const sheet = await demoSheet()
  const core = coreScenes(sheet)
  expect(core.length, 'Demo_Script has core scenes').toBeGreaterThan(0)
  expect(core.map((s) => s.scene), 'the core scenes of Demo_Script are the ones docs/DEMO_RUNBOOK.md §4 walks through').toEqual(runbookCoreScenes())

  const folder = import.meta.dirname
  const specs = readdirSync(folder).filter((f) => f.endsWith('.spec.ts'))
  for (const scene of core) {
    const prefix = `${String(scene.scene).padStart(2, '0')}-`
    const files = specs.filter((f) => f.startsWith(prefix))
    expect.soft(files, `scene ${scene.scene} "${scene.titleTh}" has one file ${prefix}….spec.ts`).toHaveLength(1)
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
})
