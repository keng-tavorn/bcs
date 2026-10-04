import type { ReactNode } from 'react'
import { LiffPartMessages } from '../../_lib/part-messages'

// /liff/requests/new: its client components read the gate's words and the catalogue's, the catalogue's for a member only
// (the page shows anyone else the gate); the form of a type (./[type]) has a provider of its own (§9.4: the messages are
// part of the page's first load; src/i18n/client-messages.ts)
export default function LiffCatalogLayout({ children }: { children: ReactNode }) {
  return <LiffPartMessages scope="liffCatalog">{children}</LiffPartMessages>
}
