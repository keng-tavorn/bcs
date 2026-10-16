// Where a LINE message points (BR-NOTI-02: every message links back to the document). The LIFF app is one app at /liff
// with its pages as paths (§9.4, ADR-024); a notification read in LINE opens the LIFF page of the same thing when there
// is one, otherwise the workspace page. These are the paths inside the LIFF app (what follows /liff); the full link is
// made on the server with the organization's LIFF ID (the one deep-link helper of §9.4, src/server/line/webhook).

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'

/** Workspace pages that have a LIFF page, and that page */
const LIFF_PAGES: ReadonlyArray<readonly [RegExp, (id: string) => string]> = [
  [new RegExp(`^/tasks/(${UUID})$`, 'i'), (id) => `/tasks/${id}`],
  [/^\/tasks$/, () => '/tasks'],
  [/^\/requests\/new$/, () => '/requests/new'],
  [new RegExp(`^/requests/(${UUID})$`, 'i'), (id) => `/requests/${id}`],
  [/^\/requests$/, () => '/track'],
  [/^\/settings\/delegation$/, () => '/delegation'],
  [new RegExp(`^/receiving/(${UUID})$`, 'i'), (id) => `/gr/${id}`],
  // S17-04 (FR-LINE-303 AC3 AC4): the lists the role buttons of the rich menu open
  [/^\/receiving$/, () => '/gr'],
  [/^\/procurement\/pool$/, () => '/procurement'],
]

/** The LIFF page of a workspace page (e.g. /requests/<id> → /requests/<id>, /settings/delegation → /delegation), or null */
export function liffPathFor(workspaceHref: string): string | null {
  for (const [pattern, page] of LIFF_PAGES) {
    const m = pattern.exec(workspaceHref)
    if (m) return page(m[1] ?? '')
  }
  return null
}

/** What the card's buttons open on the task's LIFF page (§9.3): the decision bar starts on this action */
export type LiffTaskAction = 'approve' | 'reject'

/** /tasks/<taskId>, with ?action= when a button opens the page to decide (§9.3: /liff/tasks/<taskId>?action=approve) */
export function liffTaskPath(taskId: string, action?: LiffTaskAction): string {
  return `/tasks/${encodeURIComponent(taskId)}${action ? `?action=${action}` : ''}`
}
