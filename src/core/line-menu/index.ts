// Rich menu by role (BR-LINE-16, FR-LINE-303 AC1 · golden line-rich-menu). Pure: the service works out the flags at the
// time of the switch (DOA and workflow versions in effect, delegations, roles) and passes them in; this module only
// turns them into the menu a LINE user sees. The menu is not a permission: every page a button opens checks its own
// (BR-AUTH-05, BR-LINE-17).

/** Every button any menu may show, in the order a menu lists them (BR-LINE-16) */
export const RICH_MENU_BUTTONS = ['link', 'home', 'request', 'tasks', 'receive', 'procurement', 'track', 'help'] as const
export type RichMenuButton = (typeof RICH_MENU_BUTTONS)[number]

/** LINE fits six equal cells on one picture well enough to tap; a seventh button drops `track` (BR-LINE-16) */
export const RICH_MENU_MAX_BUTTONS = 6

/** The role buttons, each with the part it adds to the variant key, in the order of the menu */
const ROLE_BUTTONS = [
  { part: 'APPROVER', button: 'tasks' },
  { part: 'RECEIVER', button: 'receive' },
  { part: 'PROCUREMENT', button: 'procurement' },
] as const satisfies ReadonlyArray<{ part: string; button: RichMenuButton }>

export type RichMenuRole = (typeof ROLE_BUTTONS)[number]['part']

/** What the service read for one LINE user at the time of the switch */
export type RichMenuInput =
  | { readonly linked: false }
  | {
      readonly linked: true
      /** Member.status: only ACTIVE members get a menu of their own */
      readonly memberStatus: string
      /** The member's stored roles (RECEIVER and PROCUREMENT have buttons; the others change nothing) */
      readonly roles: readonly string[]
      /** Holds a position, or is named, as an approver of a DOA version in effect (committees and parallel steps too) */
      readonly doaApprover: boolean
      /** Is the delegate of an ACTIVE delegation */
      readonly activeDelegate: boolean
      /** Resolves as a reviewer or a fallback reviewer of a rule in the workflow version in effect */
      readonly workflowReviewer: boolean
    }

export interface RichMenuChoice {
  /** `UNLINKED`, `LINKED`, or `LINKED:` and the roles in menu order, e.g. `LINKED:APPROVER:RECEIVER` (LineRichMenuVariant.variantKey) */
  readonly variant: string
  /** Row by row, left to right */
  readonly buttons: readonly RichMenuButton[]
  /** Buttons per row, top first */
  readonly rows: readonly number[]
  /** The one emphasised button (§9.9) */
  readonly primary: RichMenuButton
}

/** One row up to three buttons; otherwise two rows, the top one taking the odd button (4 = 2+2 · 5 = 3+2 · 6 = 3+3) */
function rowsOf(count: number): number[] {
  return count <= 3 ? [count] : [Math.ceil(count / 2), Math.floor(count / 2)]
}

const UNLINKED: RichMenuChoice = { variant: 'UNLINKED', buttons: ['link', 'help'], rows: rowsOf(2), primary: 'link' }

/** The menu of a linked ACTIVE member who holds `roles` (any order, repeats ignored) */
export function richMenuForRoles(roles: readonly RichMenuRole[]): RichMenuChoice {
  const held = ROLE_BUTTONS.filter((r) => roles.includes(r.part))
  const all: RichMenuButton[] = ['home', 'request', ...held.map((r) => r.button), 'track', 'help']
  const buttons = all.length > RICH_MENU_MAX_BUTTONS ? all.filter((b) => b !== 'track') : all
  return {
    variant: ['LINKED', ...held.map((r) => r.part)].join(':'),
    buttons,
    rows: rowsOf(buttons.length),
    primary: held[0]?.button ?? 'request',
  }
}

/** The menu of one LINE user (BR-LINE-16): UNLINKED unless linked to an ACTIVE member, otherwise by role */
export function selectRichMenu(input: RichMenuInput): RichMenuChoice {
  if (!input.linked || input.memberStatus !== 'ACTIVE') return UNLINKED
  const roles: RichMenuRole[] = []
  if (input.doaApprover || input.activeDelegate || input.workflowReviewer) roles.push('APPROVER')
  if (input.roles.includes('RECEIVER')) roles.push('RECEIVER')
  if (input.roles.includes('PROCUREMENT')) roles.push('PROCUREMENT')
  return richMenuForRoles(roles)
}

/** Every menu that may be shown, UNLINKED first: what `pnpm line:richmenu` makes and the connection test checks */
export const RICH_MENU_VARIANTS: readonly RichMenuChoice[] = [
  UNLINKED,
  // Every subset of the role buttons, as bits of their position in ROLE_BUTTONS
  ...Array.from({ length: 2 ** ROLE_BUTTONS.length }, (_, bits) => richMenuForRoles(ROLE_BUTTONS.filter((_, i) => (bits >> i) & 1).map((r) => r.part))),
]
