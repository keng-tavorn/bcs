import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { RICH_MENU_BUTTONS, RICH_MENU_MAX_BUTTONS, RICH_MENU_VARIANTS, richMenuForRoles, selectRichMenu, type RichMenuInput } from '@/core/line-menu'

// Draft of S17-03 (spec §16.18 lets lane 3 write src/core/line-menu before S6 is in main, without putting the golden
// in the spec). Until S17-03 adds the block to spec §7.20 and tests/golden/line-rich-menu.yaml with its runner, the
// cases are read from the draft block of docs/sub-specs/S17.md (`# draft: tests/golden/line-rich-menu.yaml`), so
// they are the same cases word for word and no expect is copied by hand. S17-03 moves this runner to tests/golden and
// adds 'line-menu' to COVERAGE_ENGINES (scripts/lib/verify-gates.ts) once S6's change of that line is in main.

interface LineMenuCase {
  id: string
  title?: string
  input: RichMenuInput
  expect: { variant: string; buttons: string[]; rows: number[]; primary: string }
}

function draftSuite(): { suite: string; cases: LineMenuCase[] } {
  const text = readFileSync(path.resolve(import.meta.dirname, '../../docs/sub-specs/S17.md'), 'utf8').replace(/\r\n/g, '\n')
  const block = /```yaml\n(# draft: tests\/golden\/line-rich-menu\.yaml\n[\s\S]*?)```/.exec(text)
  if (!block) throw new Error('the draft block of line-rich-menu is missing from docs/sub-specs/S17.md')
  return parse(block[1]!) as { suite: string; cases: LineMenuCase[] }
}

const suite = draftSuite()

describe('draft golden line-rich-menu (docs/sub-specs/S17.md)', () => {
  it('has the cases of the draft', () => {
    expect(suite.suite).toBe('line-rich-menu')
    expect(suite.cases.length).toBeGreaterThan(0)
  })
  for (const c of suite.cases) {
    it(`[${c.id}] ${c.title ?? ''}`.trim(), () => {
      expect(selectRichMenu(c.input)).toEqual(c.expect)
    })
  }
})

describe('[FR-LINE-303/AC1] rich menu by role beyond the draft cases', () => {
  const linked = { linked: true, memberStatus: 'ACTIVE', roles: [], doaApprover: false, activeDelegate: false, workflowReviewer: false } as const

  it('gives a member who is only invited the menu of someone not linked', () => {
    expect(selectRichMenu({ ...linked, memberStatus: 'INVITED', doaApprover: true }).variant).toBe('UNLINKED')
  })

  it('reads the roles in any order and ignores repeats', () => {
    expect(selectRichMenu({ ...linked, roles: ['PROCUREMENT', 'AUDITOR', 'RECEIVER', 'PROCUREMENT'] })).toEqual(richMenuForRoles(['RECEIVER', 'PROCUREMENT']))
    expect(richMenuForRoles(['PROCUREMENT', 'APPROVER', 'APPROVER']).variant).toBe('LINKED:APPROVER:PROCUREMENT')
  })

  it('makes one menu per subset of the role buttons, each with home, request and help in at most six cells', () => {
    const keys = RICH_MENU_VARIANTS.map((v) => v.variant)
    expect(keys).toHaveLength(9)
    expect(new Set(keys).size).toBe(keys.length)
    expect(keys[0]).toBe('UNLINKED')
    for (const v of RICH_MENU_VARIANTS.slice(1)) {
      expect(v.buttons).toEqual(expect.arrayContaining(['home', 'request', 'help']))
      expect(v.buttons.length).toBeLessThanOrEqual(RICH_MENU_MAX_BUTTONS)
      expect(v.rows.reduce((a, b) => a + b, 0)).toBe(v.buttons.length)
      expect(v.buttons).toContain(v.primary)
      // Buttons keep the one order of the menu
      expect([...v.buttons].sort((a, b) => RICH_MENU_BUTTONS.indexOf(a) - RICH_MENU_BUTTONS.indexOf(b))).toEqual(v.buttons)
    }
  })

  it('selects for every combination of flags a menu that the variants list holds', () => {
    const keys = new Set(RICH_MENU_VARIANTS.map((v) => v.variant))
    for (let bits = 0; bits < 2 ** 5; bits++) {
      const roles = [bits & 1 ? 'RECEIVER' : 'FINANCE', bits & 2 ? 'PROCUREMENT' : 'EXECUTIVE']
      const choice = selectRichMenu({ ...linked, roles, doaApprover: !!(bits & 4), activeDelegate: !!(bits & 8), workflowReviewer: !!(bits & 16) })
      expect(keys.has(choice.variant)).toBe(true)
      expect(choice.buttons.includes('tasks')).toBe((bits & 28) !== 0)
    }
  })
})
