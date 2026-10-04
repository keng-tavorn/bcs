import { boundaryRefusalAt } from '../../admin-doa/boundary-tick'
import type { LiffTaskFailure } from './result'

// Where a refusal of approving a DOA version or an authority change goes on its LIFF page (./policy-decision.tsx,
// FR-DOA-009 AC3), apart from a wrong PIN (at the PIN field). A missing tick of the boundary table is said at the tick
// when the page shows the table. When the page shows none, the service asked for a tick the member never saw: the table
// appeared after the page was opened, and the bar says so in the words the web decision page uses
// (tasks.errors.BOUNDARY_TABLE_CHANGED: reload and check the table) — never "tick the table", as there is no tick to
// press. Everything else is said in the bar. Pure, so a unit test reads it.

export type PolicyRefusalPlace = { readonly at: 'tick'; readonly text: string } | { readonly at: 'bar'; readonly failure: LiffTaskFailure }

export function placePolicyRefusal(failure: LiffTaskFailure, boundaryTableId: string | null, tableChanged: string): PolicyRefusalPlace {
  if (failure.at !== 'tick') return { at: 'bar', failure }
  if (boundaryRefusalAt(boundaryTableId) === 'TICK') return { at: 'tick', text: failure.text }
  return { at: 'bar', failure: { ok: false, at: 'form', text: tableChanged } }
}
