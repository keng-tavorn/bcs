import { deskAs } from '../p1demo/money-steps'
import { p1Sheet } from '../p1demo/support'
import { test } from '../fixtures'
import { expectG8, p2Expected, p2SceneOf, p2Sheet, type G8Figures } from './support'

// Scene 15 of the day of phase 2 (S10-18 · docs/sub-specs/S10.md "Demo ของขั้น" 7 · BR-RFX-15 · §11.4 G-8): after scene 9
// was played live to its approved award, the row's actor (dm_proc) reads /reports/sourcing: three awards, the savings of
// the RFQ added (expectJson.afterScene9). The figures before scene 9 (afterSeed) are checked first thing in
// 09-rfq-steel.spec.ts, the files running in their names' order on one database.

test('@p2demo [FR-SRC-204/AC8] scene 15: the G-8 report counts the award of scene 9 with the two of the seed', async ({ browser }) => {
  const [sheet, p1] = await Promise.all([p2Sheet(), p1Sheet()])
  const scene = p2SceneOf(sheet, 15)
  const page = await deskAs(browser, p1, scene.actor)
  await expectG8(page, p2Expected<G8Figures>(scene, 'afterScene9'))
  await page.context().close()
})
