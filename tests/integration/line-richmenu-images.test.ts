import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { LINE_RICH_MENU_IMAGE_FILES, LINE_RICH_MENU_KINDS, richMenuImageInfo, richMenuImageProblem } from '@/server/line/link-rich-menus'
import { drawLineRichMenuImage } from '../../scripts/line-richmenu'

// D-02 · FR-LINE-004 AC1: the pictures of the two rich menus are committed in assets/line, and they are exactly what
// `pnpm line:richmenu --images` draws from the definitions of src/server/line/link-rich-menus.ts — the labels of §9.5 in
// Sarabun with their icons, laid out on the areas LINE taps — rasterized by poppler in Docker (the same pixels on every
// machine). A change of a label, an area or the design shows up here until the pictures are drawn again (and looked at).

describe('[FR-LINE-004/AC1] the rich menu pictures in assets/line are the ones pnpm line:richmenu --images draws', () => {
  it.each(LINE_RICH_MENU_KINDS)('%s: a 2500 × 843 PNG under 1 MB, byte for byte', async (kind) => {
    const committed = await readFile(path.join(process.cwd(), 'assets', 'line', LINE_RICH_MENU_IMAGE_FILES[kind]))
    expect(richMenuImageInfo(committed)).toEqual({ contentType: 'image/png', width: 2500, height: 843 })
    expect(richMenuImageProblem(committed)).toBeNull()
    const drawn = await drawLineRichMenuImage(kind)
    expect(drawn.equals(committed), `assets/line/${LINE_RICH_MENU_IMAGE_FILES[kind]} differs from what pnpm line:richmenu --images draws now`).toBe(true)
  }, 180_000)
})
