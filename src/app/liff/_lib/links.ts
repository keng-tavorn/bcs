import { liffPathFor, liffTaskPath, type LiffTaskAction } from '@/channels/line/links'
import { LIFF_BASE_PATH } from '@/ui/liff/bootstrap'

// Links between LIFF pages (§9.4: one LIFF app at /liff, its pages as paths). The one mapping from a workspace page to
// its LIFF page is src/channels/line/links.ts, which the LINE messages use too (with the LIFF ID, as
// https://liff.line.me/<LIFF ID>/<path>); inside the LIFF app the same path is a page of this site under /liff. src/ui
// may not import channels, so LIFF pages build their hrefs here and hand them to the components.

/** The LIFF page of a workspace page (e.g. /requests/<id> → /liff/requests/<id>), or null when it has none */
export function liffHref(workspaceHref: string): string | null {
  const path = liffPathFor(workspaceHref)
  return path === null ? null : `${LIFF_BASE_PATH}${path}`
}

/** A task's LIFF page, opening its decision on `action` (§9.3: /liff/tasks/<taskId>?action=approve) */
export function liffTaskHref(taskId: string, action?: LiffTaskAction): string {
  return `${LIFF_BASE_PATH}${liffTaskPath(taskId, action)}`
}

/**
 * Where a link of the workspace (a notification, a timeline entry) leads from a LIFF page: its LIFF page when there is
 * one; otherwise the workspace page, which a LIFF page opens outside LINE (useLiff().openExternal).
 */
export function liffDestination(workspaceHref: string): { readonly href: string; readonly inLiff: boolean } {
  const inLiff = liffHref(workspaceHref)
  return inLiff ? { href: inLiff, inLiff: true } : { href: workspaceHref, inLiff: false }
}
