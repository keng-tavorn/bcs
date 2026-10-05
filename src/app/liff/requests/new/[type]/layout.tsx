import type { ReactNode } from 'react'
import { LiffPartMessages } from '../../../_lib/part-messages'

// /liff/requests/new/[type]: its client components read the gate's words and the request form's, the form's for a member
// only (the page shows anyone else the gate) (§9.4: the messages are part of the page's first load;
// src/i18n/client-messages.ts). The words of the form's shell and first step: those of steps 2 and 3 come with those steps,
// loaded on demand (src/ui/liff/requests/step-words.tsx)
export default function LiffRequestFormLayout({ children }: { children: ReactNode }) {
  return <LiffPartMessages scope="liffRequestForm">{children}</LiffPartMessages>
}
