import type { ReactNode } from 'react'
import { LiffPartMessages } from '../../../_lib/part-messages'

// /liff/requests/[id]: its client components read the gate's words and those of the requester's bar and of the files,
// these for a member only (the page shows anyone else the gate) (§9.4: the messages are part of the page's first load;
// src/i18n/client-messages.ts). A route group of its own: the form of a draft or a returned request (../edit) is not
// under this layout, so its page carries the form's words alone, not these as well (a nested provider replaces the one
// above it, but both are written into the page)
export default function LiffRequestLayout({ children }: { children: ReactNode }) {
  return <LiffPartMessages scope="liffRequest">{children}</LiffPartMessages>
}
