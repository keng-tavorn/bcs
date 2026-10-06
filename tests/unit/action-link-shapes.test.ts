import { describe, expect, it } from 'vitest'
import { EmailSendError, createSmtpProvider } from '@/integrations/email-provider'
import { safeNextPath } from '@/lib/next-path'
import { hashLinkSecret, linkSecretMatches, parseEmailLink } from '@/server/tokens/action-tokens'

// The shapes around e-mail decision links (spec BR-TOK-03): the link "<tokenId>.<secret>", the hash compare, the
// page to return to after signing in (never another site), and how a send failure is told apart.

const TOKEN = '01928c4e-7d2a-7b3c-8d4e-5f6a7b8c9d0e'
const SECRET = 'Q2hhbmdlTWVJc0FTZWNyZXRPZkZvcnR5VGhyZWVDaGE'

describe('[FR-NOTI-002/AC2] e-mail link shapes', () => {
  it('reads "<tokenId>.<secret>" and nothing else', () => {
    expect(parseEmailLink(`${TOKEN}.${SECRET}`)).toEqual({ tokenId: TOKEN, secret: SECRET })
    for (const bad of ['', TOKEN, `${TOKEN}.`, `${TOKEN}.${SECRET}x`, `${TOKEN}.${SECRET.slice(1)}`, `${TOKEN.toUpperCase()}.${SECRET}`, `x${TOKEN}.${SECRET}`, `${TOKEN}.${SECRET.slice(0, -1)}=`, `../${TOKEN}.${SECRET}`]) {
      expect(parseEmailLink(bad), bad).toBeNull()
    }
  })

  it('compares the secret with the stored sha256 only', () => {
    expect(linkSecretMatches(SECRET, hashLinkSecret(SECRET))).toBe(true)
    expect(linkSecretMatches(`${SECRET.slice(0, -1)}A`, hashLinkSecret(SECRET))).toBe(false)
    expect(linkSecretMatches(SECRET, null)).toBe(false)
    expect(linkSecretMatches(SECRET, 'not-a-hash')).toBe(false)
    expect(hashLinkSecret(SECRET)).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe('[FR-NOTI-002/AC2] where signing in returns to', () => {
  it('a path of this site', () => {
    for (const ok of ['/', `/a/${TOKEN}.${SECRET}`, '/tasks/123?tab=history', '/requests/a-b_c.d~e%20f']) expect(safeNextPath(ok), ok).toBe(ok)
  })

  it('never another site, a script or anything unexpected', () => {
    for (const bad of ['//evil.example', '/\\evil.example', 'https://evil.example/a', 'javascript:alert(1)', 'a/b', '', ' /a', '/a b', '/a<script>', `/${'a'.repeat(400)}`, null, undefined, 42]) {
      expect(safeNextPath(bad), String(bad)).toBeNull()
    }
  })
})

describe('[FR-P2P-005/AC2] a failed send says whether trying again can help', () => {
  it('a server that cannot be reached is not a bounce', async () => {
    const provider = createSmtpProvider('smtp://127.0.0.1:9', 'BCS <no-reply@bcs.local>')
    const error = await provider.send({ to: 'x@example.test', subject: 's', text: 't' }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(EmailSendError)
    expect(error).toMatchObject({ permanent: false })
    expect((error as EmailSendError).code).toMatch(/^[A-Z_]+$/)
  })
})
