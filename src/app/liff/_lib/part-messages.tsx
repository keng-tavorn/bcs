import type { ReactNode } from 'react'
import { LIFF_GATE_SCOPE, type LiffPartScope } from '@/i18n/client-messages'
import { ClientMessages } from '../../_lib/client-messages'
import { liffPage } from './session'

/**
 * The message provider of a part of the LIFF app whose pages show their own client components to a member only and to
 * anyone else the gate (./session.ts): the part's words for a member, the gate's for anyone else (§9.4: the words a page
 * passes to its client components are written into its HTML, and LINE opens most pages before there is a session). The
 * gate signs in with LINE and then refreshes the page (src/ui/liff/liff-gate.tsx, router.refresh): the server renders
 * this layout again with the session, and the part's words come with the page's content. The session is the one the
 * page reads (liffPage, one lookup per request), so the words and the page always agree. The provider stays in both
 * cases, so the page under it keeps its place in the tree.
 */
export async function LiffPartMessages({ scope, children }: { readonly scope: LiffPartScope; readonly children: ReactNode }) {
  const page = await liffPage()
  return <ClientMessages scope={page.kind === 'member' ? scope : LIFF_GATE_SCOPE}>{children}</ClientMessages>
}
