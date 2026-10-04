import type { ReactNode } from 'react'
import { LiffPartMessages } from '../../_lib/part-messages'

// /liff/tasks/[id]: its client components read the gate's words and those of the decisions (a request, PO or variance
// task, a DOA version); the list of tasks above it reads the gate's only. The decisions' words go to a member only: the
// page shows anyone else the gate (§9.4: the messages are part of the page's first load; src/i18n/client-messages.ts)
export default function LiffTaskLayout({ children }: { children: ReactNode }) {
  return <LiffPartMessages scope="liffTask">{children}</LiffPartMessages>
}
