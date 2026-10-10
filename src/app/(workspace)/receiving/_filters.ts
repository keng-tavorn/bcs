import { createLoader, createParser } from 'nuqs/server'

// The receiving list's page in the address (spec §9.10, S16-10), read on the server with nuqs: ?page=2 → 2; anything
// else → the first page (the service keeps it within the pages there are).

const pageNumber = createParser<number>({
  parse: (value) => (/^\d{1,6}$/.test(value) && Number(value) > 0 ? Number(value) : null),
  serialize: (value) => String(value),
})

export const loadReceivingFilters = createLoader({ page: pageNumber })
