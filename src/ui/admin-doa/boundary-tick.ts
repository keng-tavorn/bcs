// The drafter's tick of the boundary table on the send forms of a DOA version (FR-DOA-009 AC3): the normal send and the
// initial package. The page shows the table — and the tick with it — only when the version has one; the service then
// asks for the tick and refuses the send without it (BOUNDARY_NOT_CONFIRMED). A page without a table never sends a
// tick it did not show (null), and a refusal it cannot point at a tick for — the table appeared after the page was
// opened — is said in the form's own failure notice, with what to do. Pure, so the forms and the unit tests share it.

/** What the send passes as the tick: null when the page showed no boundary table */
export const boundaryTickValue = (tableId: string | null, ticked: boolean): boolean | null => (tableId === null ? null : ticked)

/** The form stops before sending and asks for the tick */
export const boundaryTickMissing = (tableId: string | null, ticked: boolean): boolean => tableId !== null && !ticked

/** Where a BOUNDARY_NOT_CONFIRMED refusal is shown: next to the tick, or in the form's failure notice when it has none */
export const boundaryRefusalAt = (tableId: string | null): 'TICK' | 'FORM' => (tableId === null ? 'FORM' : 'TICK')
