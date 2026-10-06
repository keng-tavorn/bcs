import type { ReactNode } from 'react'
import { ClientMessages } from '../../_lib/client-messages'

// /liff/link: its client components read the gate's words, the link flow's and those of the e-mail sign-in, and nothing
// of another part of the LIFF app (§9.4: the messages are part of the page's first load; src/i18n/client-messages.ts)
export default function LiffLinkLayout({ children }: { children: ReactNode }) {
  return <ClientMessages scope="liffLink">{children}</ClientMessages>
}
