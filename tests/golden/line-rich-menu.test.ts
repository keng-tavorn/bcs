import { describe, expect, it } from 'vitest'
import { selectRichMenu, type RichMenuInput } from '@/core/line-menu'
import { loadGolden } from './support'

// tests/golden/line-rich-menu.yaml (spec §7.20 · BR-LINE-16 · FR-LINE-303 AC1): the menu of a LINE user from the flags
// the service works out at the time of the switch — every linked ACTIVE member has home, request and help; an approver
// (DOA, an ACTIVE delegation or a workflow reviewer) adds tasks, RECEIVER receive, PROCUREMENT procurement; six buttons
// at most (track goes first); anyone else gets UNLINKED.

describe('[FR-LINE-303/AC1] golden line-rich-menu.yaml', () => {
  const suite = loadGolden('line-rich-menu') as unknown as { cases: Array<{ id: string; title?: string; input: RichMenuInput; expect: Record<string, unknown> }> }
  it('has cases', () => expect(suite.cases.length).toBeGreaterThan(0))
  for (const c of suite.cases) {
    it(`[${c.id}] ${c.title ?? ''}`, () => {
      expect(selectRichMenu(c.input)).toEqual(c.expect)
    })
  }
})
