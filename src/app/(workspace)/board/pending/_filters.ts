import { createLoader, parseAsString, parseAsStringLiteral } from 'nuqs/server'
import { BOARD_SUBJECTS } from '@/server/services/board'
import type { BoardFilter } from '@/server/services/board'
import { boardFilter } from './_present'

// The board's filters in the address, read with nuqs (spec §9.10, S16-10): the holder's department and the kind of
// document, under the names the board always used (?department=…&type=…). boardFilter still checks the department is an
// id, so what reaches the service is exactly what it read before.
export const BOARD_FILTERS = {
  department: parseAsString,
  type: parseAsStringLiteral(BOARD_SUBJECTS),
}
export const loadBoardFilters = createLoader(BOARD_FILTERS)

/** The board's filter from the address: the loader's values, checked as before */
export async function readBoardFilter(searchParams: Promise<Record<string, string | string[] | undefined>>): Promise<BoardFilter> {
  const f = await loadBoardFilters(searchParams)
  return boardFilter({ department: f.department ?? undefined, type: f.type ?? undefined })
}
