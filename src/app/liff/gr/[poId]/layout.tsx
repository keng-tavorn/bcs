import type { ReactNode } from 'react'
import { LiffPartMessages } from '../../_lib/part-messages'

// /liff/gr/[poId]: its client components read the gate's words and the receiving form's, these for a member only (the
// page shows anyone else the gate) (§9.4: the messages are part of the page's first load; src/i18n/client-messages.ts).
// Here and not on /liff/gr, so the list of POs (server-rendered, no words of its own in the browser) does not carry them.
export default function LiffReceivingLayout({ children }: { children: ReactNode }) {
  return <LiffPartMessages scope="liffReceiving">{children}</LiffPartMessages>
}
