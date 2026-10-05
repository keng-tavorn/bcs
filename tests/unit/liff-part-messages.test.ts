import { isValidElement, type ReactElement } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { LiffPage } from '@/app/liff/_lib/session'
import { CLIENT_MESSAGES, LIFF_GATE_SCOPE, type ClientMessagesScope, type LiffPartScope } from '@/i18n/client-messages'

// §9.4 · NFR-I18N-01: the provider of a LIFF part (src/app/liff/_lib/part-messages.tsx) passes the part's words to a
// member only. Anyone else — no session, a session without a membership, a role that must set up TOTP first — gets the
// page's gate and nothing of the part (src/app/liff/_lib/session.ts), so the provider holds the gate's words only: they
// are not written into a gate's HTML, the first load of most LIFF pages LINE opens. The gate signs in and refreshes the
// page, and this layout renders again with the member's session.

const session = vi.hoisted(() => ({ page: { kind: 'signed-out' } as unknown }))
vi.mock('@/app/liff/_lib/session', () => ({ liffPage: async () => session.page }))
const { LiffPartMessages } = await import('@/app/liff/_lib/part-messages')
const { ClientMessages } = await import('@/app/_lib/client-messages')

const MEMBER = { kind: 'member', ctx: {}, member: {}, session: 'liff' } as unknown as LiffPage
const OTHERS: readonly LiffPage[] = [{ kind: 'signed-out' }, { kind: 'no-membership', session: 'liff' }, { kind: 'needs-2fa-setup', session: 'web' }]
const PARTS: readonly LiffPartScope[] = ['liffTask', 'liffCatalog', 'liffRequestForm', 'liffRequest', 'liffDelegation', 'liffReceiving']

/** The scope of the provider the part's layout renders for this page's session */
async function scopeFor(page: LiffPage, scope: LiffPartScope): Promise<ClientMessagesScope> {
  session.page = page
  const element = (await LiffPartMessages({ scope, children: 'the page' })) as ReactElement<{ scope: ClientMessagesScope; children: unknown }>
  expect(isValidElement(element)).toBe(true)
  // The provider stays in every case, so the page under it keeps its place in the tree
  expect(element.type).toBe(ClientMessages)
  expect(element.props.children).toBe('the page')
  return element.props.scope
}

describe('[NFR-I18N-01] [§9.4] a LIFF part passes its words to a member only', () => {
  beforeEach(() => {
    session.page = { kind: 'signed-out' }
  })

  it.each(PARTS)('%s: the part’s words for a member', async (scope) => {
    expect(await scopeFor(MEMBER, scope)).toBe(scope)
  })

  it.each(OTHERS.map((page) => [page.kind, page] as const))('%s: the gate’s words only, for every part', async (_kind, page) => {
    for (const scope of PARTS) expect(await scopeFor(page, scope)).toBe(LIFF_GATE_SCOPE)
  })

  it('the gate’s scope is the gate’s words, which every part’s scope holds too', () => {
    expect(CLIENT_MESSAGES[LIFF_GATE_SCOPE]).toEqual(['liff.gate'])
    for (const scope of PARTS) expect(CLIENT_MESSAGES[scope] as readonly string[], scope).toContain('liff.gate')
  })
})
