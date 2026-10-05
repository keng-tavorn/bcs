import type { ReactNode } from 'react'
import { LiffPartMessages } from '../../../_lib/part-messages'

// /liff/requests/new: its client components read the gate's words and the catalogue's, the catalogue's for a member only
// (the page shows anyone else the gate) (§9.4: the messages are part of the page's first load;
// src/i18n/client-messages.ts). A route group of its own: the form of a type (../[type]) is not under this layout, so its
// page carries the form's words alone, not the catalogue's as well (a nested provider replaces the one above it, but
// both are written into the page)
export default function LiffCatalogLayout({ children }: { children: ReactNode }) {
  return <LiffPartMessages scope="liffCatalog">{children}</LiffPartMessages>
}
