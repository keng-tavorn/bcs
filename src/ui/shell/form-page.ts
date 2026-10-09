// The step-by-step request form fills the screen without the menu (FR-INT-011 AC1, §9.10 "เต็มจอไม่มีแถบเมนู"). Like the
// door (./new-request-door.tsx), the shell steps aside by what the page shows, not by its address: the form's root
// carries FORM_PAGE, and while the page holds it the sidebar, the top bar and the content's frame are hidden. The ⌘K
// search stays mounted, so its shortcut still opens it (FR-PLT-014). Types only, so server and client both read it.

/** What the form's root carries (spread on it): while the page shows it, the shell steps aside */
export const FORM_PAGE = { 'data-form-page': '' } as const

/** Hidden while the page holds FORM_PAGE. Tailwind reads each class whole, so the selector is written out */
export const SHELL_HIDDEN = '[body:has([data-form-page])_&]:hidden'

/** The content's frame (its width and sides) gives the form the whole screen */
export const SHELL_UNFRAMED = '[body:has([data-form-page])_&]:max-w-none [body:has([data-form-page])_&]:p-0'
