import type { Page } from '@playwright/test'

/**
 * The page at rest: its document loaded (no navigation under way), its fonts ready, every transition or animation that
 * ends run to its end, and laid out again. Axe reads colours as they are drawn at that moment: a sidebar's group label
 * still fading out as a document page collapses the sidebar (src/ui/shell/shell-frame.tsx) reads as text too faint
 * (NEW-77), and so does a dialog's footer still fading in (NEW-91: on the CI runner, slower than a laptop, axe often
 * reads a page before its fade is over). An animation that never ends (a spinner) is not waited for; a round that starts
 * more is waited for in turn. Every axe check of the e2e suite waits for it.
 */
export async function settled(page: Page) {
  await page.waitForLoadState('load')
  await page.evaluate(async () => {
    await document.fonts.ready
    const frames = () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
    for (let round = 0; round < 5; round += 1) {
      await frames()
      const ending = document.getAnimations().filter((a) => a.playState === 'running' && Number.isFinite(a.effect?.getComputedTiming().endTime))
      if (ending.length === 0) return
      // A cancelled one (its element gone) rejects: it is done too
      await Promise.all(ending.map((a) => a.finished.catch(() => undefined)))
    }
    await frames()
  })
}
