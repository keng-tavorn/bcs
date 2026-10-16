import { describe, expect, it } from 'vitest'
import { RICH_MENU_BUTTONS, RICH_MENU_MAX_BUTTONS, RICH_MENU_VARIANTS, richMenuForRoles, selectRichMenu } from '@/core/line-menu'

// S17-03 · rich menu by role beyond the golden cases (tests/golden/line-rich-menu.yaml · BR-LINE-16): members who are
// not ACTIVE, roles in any order, the nine menus `pnpm line:richmenu` makes, and every combination of flags.

describe('[FR-LINE-303/AC1] rich menu by role beyond the golden cases', () => {
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
